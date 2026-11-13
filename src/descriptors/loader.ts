// Loads SDK descriptors (spec 6.3.3, T3.1): `descriptors/<sdk>.yml` with its builtins file and type
// stub. Each file is plain YAML, validated by its JSON Schema (an unknown key is refused with its
// name) and by the rules below; every member a descriptor names must be declared in its stub.
import { readdirSync, readFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readYaml, withLines, type YamlText } from '../formats/yaml.js';
import {
  type GeneratedValidator,
  runSchema,
  type ValidationError,
  type ValidationResult,
} from '../formats/validate.js';
import { descriptorErrors as msg, validation } from '../report/messages.js';
import {
  builtins as builtinsSchema,
  descriptor as descriptorSchema,
} from './generated/validators.js';
import {
  type BuiltinCondition,
  type Builtins,
  type CallEntry,
  type Descriptor,
  type DescriptorFile,
  isHook,
  type MemberCall,
  type StubSurface,
} from './model.js';
import { readStubSurface } from './stub.js';

/** The descriptors shipped with dashlint: `descriptors/` at the package root. */
export const DESCRIPTORS_DIR = fileURLToPath(new URL('../../descriptors/', import.meta.url));

export interface DescriptorError extends ValidationError {
  /** The file the error is in. */
  file: string;
}

export type DescriptorResult<T> = { ok: true; value: T } | { ok: false; errors: DescriptorError[] };

// ---------------------------------------------------------------------------------------------
// Versions: comparators joined by spaces, all of which must hold (no external semver, G5).

function parseVersion(v: string): number[] {
  return v.split('.').map(Number);
}

function compareVersions(a: number[], b: number[]): number {
  for (let i = 0; i < 3; i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

export function satisfies(version: string, range: string): boolean {
  const v = parseVersion(version);
  return range.split(' ').every((comparator) => {
    const [, op = '=', target = ''] = /^(>=|<=|>|<|=)?(.*)$/.exec(comparator) ?? [];
    const d = compareVersions(v, parseVersion(target));
    return op === '>='
      ? d >= 0
      : op === '<='
        ? d <= 0
        : op === '>'
          ? d > 0
          : op === '<'
            ? d < 0
            : d === 0;
  });
}

// ---------------------------------------------------------------------------------------------
// Rules the schemas cannot express.

const EVENT_ONLY = ['properties', 'addProperties'] as const;
const PERSON_KEYS = ['personSet', 'personSetOnce', 'personSetFallback'] as const;

function callRules(call: CallEntry, at: string): ValidationError[] {
  const keys = Object.keys(call);
  const has = (k: string) => keys.includes(k);
  if (has('member') === has('hook')) return [{ path: at, message: msg.memberOrHook }];
  if (isHook(call)) {
    const extra = keys.find((k) => k !== 'hook');
    return extra === undefined ? [] : [{ path: `${at}/${extra}`, message: msg.hookAlone(extra) }];
  }
  const errors: ValidationError[] = [];
  if (!has('on')) errors.push({ path: at, message: msg.onMissing });
  const person = PERSON_KEYS.find(has);
  const roles = [
    has('event') ? 'event' : undefined,
    has('superProperties') ? 'superProperties' : undefined,
    has('identity') ? 'identity' : undefined,
    // identify may also set person properties; anything else that sets them is its own role.
    person !== undefined && !has('identity') ? person : undefined,
  ].filter((r): r is string => r !== undefined);
  const [first, second] = roles;
  if (first === undefined) errors.push({ path: at, message: msg.noRole });
  else if (second !== undefined)
    errors.push({ path: `${at}/${second}`, message: msg.roleConflict(first, second) });
  if (!has('event'))
    for (const k of EVENT_ONLY)
      if (has(k)) errors.push({ path: `${at}/${k}`, message: msg.onlyWithEvent(k) });
  if (has('personSetFallback') && !has('personSet'))
    errors.push({ path: `${at}/personSetFallback`, message: msg.fallbackNeedsPersonSet });
  return errors;
}

function descriptorRules(d: DescriptorFile): ValidationError[] {
  const errors = d.calls.flatMap((c, i) => callRules(c, `/calls/${i}`));
  const seen = new Set<string>();
  d.calls.forEach((c, i) => {
    if (isHook(c)) {
      if (seen.has(`hook:${c.hook}`))
        errors.push({ path: `/calls/${i}/hook`, message: msg.duplicateHook(c.hook) });
      seen.add(`hook:${c.hook}`);
      return;
    }
    (c.on ?? []).forEach((container, j) => {
      const key = `${container}#${c.member}`;
      if (seen.has(key))
        errors.push({
          path: `/calls/${i}/on/${j}`,
          message: msg.duplicateCall(container, c.member),
        });
      seen.add(key);
    });
  });
  if (!d.declaredIn.includes(d.package))
    errors.push({ path: '/declaredIn', message: msg.packageNotDeclaredIn(d.package) });
  if (!satisfies(d.verified, d.versions))
    errors.push({ path: '/verified', message: msg.verifiedOutsideRange(d.verified, d.versions) });
  return errors;
}

function conditionOk(when: BuiltinCondition): boolean {
  if (typeof when === 'string') return true;
  const keys = Object.keys(when).sort().join(',');
  return keys === 'not,option' || keys === 'is,option' || keys === 'unknown';
}

function builtinsRules(b: Builtins): ValidationError[] {
  const errors: ValidationError[] = [];
  for (const list of ['events', 'properties', 'personProperties'] as const) {
    const seen = new Set<string>();
    b[list].forEach((entry, i) => {
      if (seen.has(entry.name))
        errors.push({ path: `/${list}/${i}/name`, message: msg.duplicateName(entry.name) });
      seen.add(entry.name);
      if (!conditionOk(entry.when))
        errors.push({ path: `/${list}/${i}/when`, message: msg.conditionShape });
    });
  }
  return errors;
}

// ---------------------------------------------------------------------------------------------
// Files.

function readText(file: string): { ok: true; text: string } | { ok: false; error: string } {
  try {
    return { ok: true, text: readFileSync(file, 'utf8') };
  } catch (e) {
    return { ok: false, error: msg.unreadable(basename(file), (e as Error).message) };
  }
}

function inFile(file: string, errors: ValidationError[]): DescriptorError[] {
  return errors.map((e) => ({ ...e, file }));
}

type Parsed<T> = { ok: true; value: T; text: YamlText } | { ok: false; errors: ValidationError[] };

// Parse, validate with the schema, then the rules; errors carry their line.
function parseFile<T>(
  source: string,
  schema: GeneratedValidator,
  rules: (value: T) => ValidationError[],
): Parsed<T> {
  const read = readYaml(source);
  if (!read.ok) return read;
  const schemaErrors = runSchema(schema, read.text.value);
  const errors = schemaErrors.length ? schemaErrors : rules(read.text.value as T);
  return errors.length
    ? { ok: false, errors: withLines(errors, read.text) }
    : { ok: true, value: read.text.value as T, text: read.text };
}

function result<T>(parsed: Parsed<T>): ValidationResult<T> {
  return parsed.ok ? { ok: true, value: parsed.value } : parsed;
}

export function parseDescriptor(source: string): ValidationResult<DescriptorFile> {
  return result(parseFile(source, descriptorSchema as GeneratedValidator, descriptorRules));
}

export function parseBuiltins(source: string): ValidationResult<Builtins> {
  return result(parseFile(source, builtinsSchema as GeneratedValidator, builtinsRules));
}

// Every module the stub declares belongs to the package; every member and hook is declared.
function stubRules(d: DescriptorFile, surface: StubSurface): ValidationError[] {
  const errors: ValidationError[] = [];
  if (!surface.modules.includes(d.package))
    errors.push({ path: '/stub', message: msg.stubPackageMissing(d.package, d.stub) });
  for (const m of surface.modules)
    if (m !== d.package && !m.startsWith(`${d.package}/`))
      errors.push({ path: '/stub', message: msg.stubForeignModule(m, d.package, d.stub) });
  d.calls.forEach((c, i) => {
    if (isHook(c)) {
      if (!surface.functions.has(c.hook))
        errors.push({ path: `/calls/${i}/hook`, message: msg.hookNotInStub(c.hook, d.stub) });
      return;
    }
    const call: MemberCall = c;
    call.on.forEach((container, j) => {
      const members = surface.containers.get(container);
      if (!members)
        errors.push({
          path: `/calls/${i}/on/${j}`,
          message: msg.containerNotInStub(container, d.stub),
        });
      else if (!members.has(call.member))
        errors.push({
          path: `/calls/${i}/member`,
          message: msg.memberNotInStub(call.member, container, d.stub),
        });
    });
  });
  return errors;
}

/** Loads one descriptor file with its builtins and stub; every error names its file. */
export function loadDescriptor(file: string): DescriptorResult<Descriptor> {
  const source = readText(file);
  if (!source.ok) return { ok: false, errors: [{ file, path: '', message: source.error }] };
  const parsed = parseFile(source.text, descriptorSchema as GeneratedValidator, descriptorRules);
  if (!parsed.ok) return { ok: false, errors: inFile(file, parsed.errors) };
  const { value: d, text } = parsed;
  const dir = dirname(file);
  const errors: DescriptorError[] = [];

  const builtinsFile = resolve(dir, d.builtins);
  let builtins: Builtins | undefined;
  const builtinsText = readText(builtinsFile);
  if (!builtinsText.ok) {
    errors.push(
      ...inFile(file, withLines([{ path: '/builtins', message: builtinsText.error }], text)),
    );
  } else {
    const b = parseBuiltins(builtinsText.text);
    if (!b.ok) errors.push(...inFile(builtinsFile, b.errors));
    else if (b.value.sdk !== d.sdk)
      errors.push({
        file: builtinsFile,
        path: '/sdk',
        message: msg.sdkMismatch(b.value.sdk, d.sdk),
      });
    else builtins = b.value;
  }

  const stubFile = resolve(dir, d.stub);
  let modules: string[] = [];
  const stubText = readText(stubFile);
  if (!stubText.ok) {
    errors.push(...inFile(file, withLines([{ path: '/stub', message: stubText.error }], text)));
  } else {
    const surface = readStubSurface(stubText.text, stubFile);
    modules = surface.modules;
    errors.push(...inFile(file, withLines(stubRules(d, surface), text)));
  }

  if (errors.length || !builtins) return { ok: false, errors };
  return { ok: true, value: { ...d, file, builtins, stub: { file: stubFile, modules } } };
}

/** Loads every `*.yml` descriptor in `dir` (not its subfolders), in file name order. */
export function loadDescriptors(dir: string = DESCRIPTORS_DIR): DescriptorResult<Descriptor[]> {
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.yml'))
    .sort()
    .map((f) => resolve(dir, f));
  const errors: DescriptorError[] = [];
  const loaded: Descriptor[] = [];
  const sdks = new Set<string>();
  for (const file of files) {
    const r = loadDescriptor(file);
    if (!r.ok) {
      errors.push(...r.errors);
      continue;
    }
    if (sdks.has(r.value.sdk))
      errors.push({ file, path: '/sdk', message: msg.duplicateSdk(r.value.sdk) });
    sdks.add(r.value.sdk);
    loaded.push(r.value);
  }
  return errors.length ? { ok: false, errors } : { ok: true, value: loaded };
}

export function formatDescriptorErrors(errors: DescriptorError[]): string[] {
  return errors.map((e) =>
    msg.inFile(
      e.file,
      e.line === undefined
        ? validation.error(e.path, e.message)
        : validation.errorAt(e.line, e.path, e.message),
    ),
  );
}
