import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  type DescriptorError,
  formatDescriptorErrors,
  loadDescriptor,
  loadDescriptors,
  parseBuiltins,
  parseDescriptor,
  satisfies,
} from '../../../src/descriptors/loader.js';
import { readStubSurface } from '../../../src/descriptors/stub.js';

// A small, valid descriptor set for an invented SDK; each test breaks one thing.
const DESCRIPTOR = `sdk: shelf-sdk
package: shelf-sdk
versions: '>=2.0.0 <3.0.0'
verified: 2.4.1
declaredIn: [shelf-sdk, '@shelf/core']
platforms: [web]
calls:
  - member: track
    on: [Shelf]
    event: args[0]
    properties: args[1]
  - member: register
    on: [Shelf, ShelfCore]
    superProperties: args[0]
  - member: identify
    on: [Shelf]
    identity: identify
    personSet: args[1].$set
    personSetFallback:
      from: args[1]
      omit: [$set_once]
  - member: set
    on: [Shelf.people]
    personSet: args[0]
  - member: reset
    on: [Shelf]
    identity: reset
  - hook: useShelf
builtins: builtins/shelf-sdk.yml
stub: stubs/shelf-sdk.d.ts
unknownNames:
  personProperties: [$initial_]
`;

const BUILTINS = `sdk: shelf-sdk
events:
  - { name: $pageview, when: { option: capturePageview, not: false } }
  - { name: $click, when: { option: clicks, is: true } }
  - { name: $vitals, when: { unknown: remote config } }
properties:
  - { name: $lib, events: '*', presence: always, when: always }
  - { name: $prev_page, events: [$pageview], presence: sometimes, when: { unknown: state } }
personProperties: []
`;

const STUB = `declare module 'shelf-sdk' {
  export class ShelfCore {
    register(properties: Record<string, unknown>): void;
  }
  export class Shelf extends ShelfCore {
    private secret: string;
    track(event: string, properties?: Record<string, unknown>): void;
    register(properties: Record<string, unknown>): void;
    identify(id: string, properties?: Record<string, unknown>): void;
    reset(): void;
    people: { set: (prop: string | Record<string, unknown>, to?: string) => void };
  }
}
declare module 'shelf-sdk/react' {
  import type { Shelf } from 'shelf-sdk';
  export const useShelf: () => Shelf;
}
`;

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function writeSet(files: { descriptor?: string; builtins?: string; stub?: string } = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'dashlint-descriptor-'));
  dirs.push(dir);
  mkdirSync(join(dir, 'builtins'));
  mkdirSync(join(dir, 'stubs'));
  writeFileSync(join(dir, 'shelf-sdk.yml'), files.descriptor ?? DESCRIPTOR);
  if (files.builtins !== '')
    writeFileSync(join(dir, 'builtins/shelf-sdk.yml'), files.builtins ?? BUILTINS);
  if (files.stub !== '') writeFileSync(join(dir, 'stubs/shelf-sdk.d.ts'), files.stub ?? STUB);
  return dir;
}

function errorsOf(dir: string): DescriptorError[] {
  const r = loadDescriptor(join(dir, 'shelf-sdk.yml'));
  if (r.ok) throw new Error('expected the descriptor to be refused');
  return r.errors;
}

function descriptorErrors(source: string) {
  const r = parseDescriptor(source);
  if (r.ok) throw new Error('expected the descriptor to be refused');
  return r.errors;
}

function builtinsErrors(source: string) {
  const r = parseBuiltins(source);
  if (r.ok) throw new Error('expected the builtins to be refused');
  return r.errors;
}

// The descriptor with one call replaced by `call` (YAML lines at call indentation).
function withCall(call: string): string {
  return DESCRIPTOR.replace(
    '  - member: track\n    on: [Shelf]\n    event: args[0]\n    properties: args[1]\n',
    call,
  );
}

describe('loadDescriptor', () => {
  it('loads a valid descriptor with its builtins and stub', () => {
    const dir = writeSet();
    const r = loadDescriptor(join(dir, 'shelf-sdk.yml'));
    if (!r.ok) throw new Error(formatDescriptorErrors(r.errors).join('\n'));
    expect(r.value.sdk).toBe('shelf-sdk');
    expect(r.value.calls).toHaveLength(6);
    expect(r.value.builtins.events.map((e) => e.name)).toEqual(['$pageview', '$click', '$vitals']);
    expect(r.value.stub.modules).toEqual(['shelf-sdk', 'shelf-sdk/react']);
    expect(r.value.stub.file).toBe(join(dir, 'stubs/shelf-sdk.d.ts'));
    expect(r.value.unknownNames).toEqual({ personProperties: ['$initial_'] });
  });

  it('refuses an unknown top-level key and names it with its line (negative control)', () => {
    const errors = errorsOf(writeSet({ descriptor: `${DESCRIPTOR}colour: blue\n` }));
    expect(errors).toEqual([
      expect.objectContaining({
        path: '/colour',
        line: 33,
        file: expect.stringContaining('shelf-sdk.yml'),
      }),
    ]);
    expect(formatDescriptorErrors(errors)[0]).toMatch(
      /shelf-sdk\.yml: line 33, \/colour: must NOT have additional properties/,
    );
  });

  it('refuses an unknown key inside a call and names it', () => {
    const errors = descriptorErrors(
      withCall('  - member: track\n    on: [Shelf]\n    evnt: args[0]\n'),
    );
    expect(errors.map((e) => e.path)).toContain('/calls/0/evnt');
  });

  it('refuses a member the stub does not declare, naming member, container and stub (negative control)', () => {
    const dir = writeSet({
      descriptor: withCall('  - member: trackEvent\n    on: [Shelf]\n    event: args[0]\n'),
    });
    const errors = errorsOf(dir);
    expect(errors).toEqual([
      expect.objectContaining({
        path: '/calls/0/member',
        message: 'member trackEvent is not declared on Shelf in stubs/shelf-sdk.d.ts',
        line: 8,
      }),
    ]);
  });

  it('refuses a container the stub does not declare', () => {
    const errors = errorsOf(
      writeSet({
        descriptor: withCall('  - member: track\n    on: [Bookcase]\n    event: args[0]\n'),
      }),
    );
    expect(errors[0]).toMatchObject({
      path: '/calls/0/on/0',
      message: 'container Bookcase is not declared in stubs/shelf-sdk.d.ts',
    });
  });

  it('refuses a member declared only privately in the stub', () => {
    const errors = errorsOf(
      writeSet({
        descriptor: withCall('  - member: secret\n    on: [Shelf]\n    event: args[0]\n'),
      }),
    );
    expect(errors[0]?.message).toBe(
      'member secret is not declared on Shelf in stubs/shelf-sdk.d.ts',
    );
  });

  it('refuses a member declared on a base class only when the descriptor names the subclass', () => {
    const errors = errorsOf(
      writeSet({
        descriptor: withCall('  - member: track\n    on: [ShelfCore]\n    event: args[0]\n'),
      }),
    );
    expect(errors[0]?.message).toBe(
      'member track is not declared on ShelfCore in stubs/shelf-sdk.d.ts',
    );
  });

  it('refuses a hook the stub does not declare', () => {
    const errors = errorsOf(
      writeSet({ descriptor: DESCRIPTOR.replace('hook: useShelf', 'hook: useBookcase') }),
    );
    expect(errors[0]).toMatchObject({
      path: '/calls/5/hook',
      message: 'hook useBookcase is not declared in stubs/shelf-sdk.d.ts',
    });
  });

  describe('init entries (ADR-027)', () => {
    const INIT_STUB = STUB.replace(
      '    reset(): void;\n',
      '    reset(): void;\n    constructor(token: string, options?: Record<string, unknown>);\n',
    ).replace(
      '  export const useShelf: () => Shelf;\n',
      '  export const useShelf: () => Shelf;\n  export function ShelfProvider(props: { options?: object }): unknown;\n',
    );
    const withInit = (init: string) =>
      DESCRIPTOR.replace('builtins: builtins/', `init:\n${init}builtins: builtins/`);

    it('loads a constructor and a provider component declared in the stub', () => {
      const dir = writeSet({
        descriptor: withInit(
          '  - member: constructor\n    on: [Shelf]\n    options: args[1]\n  - component: ShelfProvider\n    options: options\n',
        ),
        stub: INIT_STUB,
      });
      const r = loadDescriptor(join(dir, 'shelf-sdk.yml'));
      if (!r.ok) throw new Error(formatDescriptorErrors(r.errors).join('\n'));
      expect(r.value.init).toEqual([
        { member: 'constructor', on: ['Shelf'], options: 'args[1]' },
        { component: 'ShelfProvider', options: 'options' },
      ]);
    });

    it('refuses a constructor or component the stub does not declare (negative control)', () => {
      const errors = errorsOf(
        writeSet({
          descriptor: withInit(
            '  - member: constructor\n    on: [ShelfCore]\n    options: args[1]\n  - component: BookcaseProvider\n    options: options\n',
          ),
          stub: INIT_STUB,
        }),
      );
      expect(errors.map((e) => e.message)).toEqual([
        'member constructor is not declared on ShelfCore in stubs/shelf-sdk.d.ts',
        'component BookcaseProvider is not declared in stubs/shelf-sdk.d.ts',
      ]);
    });

    it('refuses an init entry that mixes the two forms or misses its options', () => {
      const errors = descriptorErrors(
        withInit('  - member: init\n    on: [Shelf]\n    component: ShelfProvider\n'),
      );
      expect(errors.map((e) => e.path)).toContain('/init/0');
    });
  });

  it('refuses a stub without the package module, or with a module of another package', () => {
    const errors = errorsOf(
      writeSet({
        stub: STUB.replace("'shelf-sdk/react'", "'other-sdk'").replace(
          "module 'shelf-sdk' {",
          "module 'shelf' {",
        ),
      }),
    );
    const messages = errors.map((e) => e.message);
    expect(messages).toContain('stubs/shelf-sdk.d.ts does not declare module "shelf-sdk"');
    expect(messages).toContain(
      'stubs/shelf-sdk.d.ts declares module "other-sdk", which is not shelf-sdk or one of its subpaths',
    );
  });

  it('refuses a missing builtins file or stub, naming the file', () => {
    const noBuiltins = errorsOf(writeSet({ builtins: '' }));
    expect(noBuiltins[0]).toMatchObject({ path: '/builtins' });
    expect(noBuiltins[0]?.message).toMatch(/^cannot read shelf-sdk\.yml: /);
    const noStub = errorsOf(writeSet({ stub: '' }));
    expect(noStub[0]).toMatchObject({ path: '/stub' });
    expect(noStub[0]?.message).toMatch(/^cannot read shelf-sdk\.d\.ts: /);
  });

  it('refuses a missing descriptor file', () => {
    const r = loadDescriptor(join(tmpdir(), 'no-such-dashlint-descriptor.yml'));
    expect(r.ok).toBe(false);
    if (!r.ok)
      expect(r.errors[0]?.message).toMatch(/^cannot read no-such-dashlint-descriptor\.yml/);
  });

  it('reports builtins errors against the builtins file', () => {
    const errors = errorsOf(
      writeSet({ builtins: BUILTINS.replace('sdk: shelf-sdk', 'sdk: other-sdk') }),
    );
    expect(errors).toEqual([
      expect.objectContaining({
        file: expect.stringContaining(join('builtins', 'shelf-sdk.yml')),
        path: '/sdk',
        message: 'sdk is other-sdk but the descriptor is shelf-sdk',
      }),
    ]);
    const unknownKey = errorsOf(writeSet({ builtins: `${BUILTINS}extra: 1\n` }));
    expect(unknownKey[0]).toMatchObject({ path: '/extra', line: 10 });
  });

  it('refuses YAML it does not read: a duplicate key', () => {
    const errors = errorsOf(writeSet({ descriptor: `sdk: a\n${DESCRIPTOR}` }));
    expect(errors[0]?.message).toBe('duplicate key "sdk"');
  });

  describe('ingestion rows (ADR-029)', () => {
    const INGESTION = `sdk: shelf-vendor
events: []
properties:
  - { name: $geo_city, events: '*', presence: sometimes, when: { unknown: added on ingestion } }
personProperties:
  - { name: $geo_city, when: { unknown: added on ingestion } }
`;
    const withIngestion = DESCRIPTOR.replace(
      'stub: stubs/shelf-sdk.d.ts\n',
      'ingestion: builtins/shelf-vendor.yml\nstub: stubs/shelf-sdk.d.ts\n',
    );
    function ingestionSet(ingestion: string): string {
      const dir = writeSet({ descriptor: withIngestion });
      if (ingestion !== '') writeFileSync(join(dir, 'builtins/shelf-vendor.yml'), ingestion);
      return dir;
    }

    it('appends the ingestion rows to the SDK builtins', () => {
      const r = loadDescriptor(join(ingestionSet(INGESTION), 'shelf-sdk.yml'));
      if (!r.ok) throw new Error(formatDescriptorErrors(r.errors).join('\n'));
      expect(r.value.builtins.sdk).toBe('shelf-sdk');
      expect(r.value.builtins.properties.map((p) => p.name)).toEqual([
        '$lib',
        '$prev_page',
        '$geo_city',
      ]);
      expect(r.value.builtins.personProperties).toEqual([
        { name: '$geo_city', when: { unknown: 'added on ingestion' } },
      ]);
      expect('ingestion' in r.value).toBe(false);
    });

    it('refuses an ingestion row switched by an init option (negative control)', () => {
      const errors = errorsOf(
        ingestionSet(
          INGESTION.replace(
            'when: { unknown: added on ingestion } }\nperson',
            'when: { option: geo, not: false } }\nperson',
          ),
        ),
      );
      expect(errors).toEqual([
        expect.objectContaining({
          file: expect.stringContaining(join('builtins', 'shelf-vendor.yml')),
          path: '/properties/0/when',
          line: 4,
          message:
            'an ingestion row is always or { unknown }: the SDK init options cannot switch it',
        }),
      ]);
    });

    it('refuses an ingestion row that repeats an SDK builtin', () => {
      const errors = errorsOf(ingestionSet(INGESTION.replace('$geo_city, events', '$lib, events')));
      expect(errors).toEqual([
        expect.objectContaining({
          path: '/properties/0/name',
          message: '"$lib" is also listed in builtins/shelf-sdk.yml',
        }),
      ]);
    });

    it('refuses a missing ingestion file, naming it, and checks the file without SDK builtins', () => {
      const missing = errorsOf(ingestionSet(''));
      expect(missing[0]).toMatchObject({ path: '/ingestion' });
      expect(missing[0]?.message).toMatch(/^cannot read shelf-vendor\.yml: /);
      const dir = ingestionSet(`${INGESTION}extra: 1\n`);
      rmSync(join(dir, 'builtins/shelf-sdk.yml'));
      const both = errorsOf(dir);
      expect(both.map((e) => e.path)).toEqual(['/builtins', '/extra']);
    });
  });
});

describe('descriptor rules', () => {
  it('needs exactly one of member or hook', () => {
    expect(descriptorErrors(withCall('  - on: [Shelf]\n    event: args[0]\n'))[0]?.message).toBe(
      'a call needs exactly one of member or hook',
    );
    expect(
      descriptorErrors(
        withCall('  - member: track\n    hook: useShelf\n    on: [Shelf]\n    event: args[0]\n'),
      )[0]?.message,
    ).toBe('a call needs exactly one of member or hook');
  });

  it('takes no other key on a hook entry', () => {
    expect(descriptorErrors(withCall('  - hook: useShelf\n    on: [Shelf]\n'))[0]).toMatchObject({
      path: '/calls/0/on',
      message: 'a hook entry takes no other key, found on',
    });
  });

  it('needs on and a role on a member call', () => {
    const errors = descriptorErrors(withCall('  - member: track\n'));
    expect(errors.map((e) => e.message)).toEqual([
      'a member call needs on: the containers that declare it',
      'a member call needs a role: event, superProperties, identity, or personSet or personSetOnce',
    ]);
  });

  it('refuses two roles on one call', () => {
    expect(
      descriptorErrors(
        withCall(
          '  - member: track\n    on: [Shelf]\n    event: args[0]\n    superProperties: args[1]\n',
        ),
      )[0],
    ).toMatchObject({
      path: '/calls/0/superProperties',
      message: 'event and superProperties cannot be on the same call',
    });
    expect(
      descriptorErrors(
        withCall(
          '  - member: track\n    on: [Shelf]\n    event: args[0]\n    personSet: args[1]\n',
        ),
      )[0]?.message,
    ).toBe('event and personSet cannot be on the same call');
    expect(
      descriptorErrors(
        withCall('  - member: track\n    on: [Shelf]\n    identity: reset\n    event: args[0]\n'),
      )[0]?.message,
    ).toBe('event and identity cannot be on the same call');
  });

  it('allows person properties on identify, and alone', () => {
    expect(parseDescriptor(DESCRIPTOR).ok).toBe(true);
    expect(
      parseDescriptor(withCall('  - member: track\n    on: [Shelf]\n    personSetOnce: args[0]\n'))
        .ok,
    ).toBe(true);
  });

  it('allows properties and addProperties only with event', () => {
    const errors = descriptorErrors(
      withCall(
        '  - member: track\n    on: [Shelf]\n    superProperties: args[0]\n    properties: args[1]\n    addProperties:\n      $x: args[0]\n',
      ),
    );
    expect(errors.map((e) => e.message)).toEqual([
      'properties is only allowed on a call with event',
      'addProperties is only allowed on a call with event',
    ]);
  });

  // ADR-055: Amplitude's track takes a name or an event object.
  it('allows objectForm only with event, reading a key of the event object', () => {
    const form =
      '    objectForm:\n      event: args[0].event_type\n      properties: args[0].props\n';
    expect(
      parseDescriptor(withCall(`  - member: track\n    on: [Shelf]\n    event: args[0]\n${form}`))
        .ok,
    ).toBe(true);
    expect(
      descriptorErrors(
        withCall(`  - member: track\n    on: [Shelf]\n    identity: reset\n${form}`),
      ).map((e) => e.message),
    ).toEqual(['objectForm is only allowed on a call with event']);
    const bare = descriptorErrors(
      withCall(
        '  - member: track\n    on: [Shelf]\n    event: args[0]\n    objectForm:\n      event: args[0]\n',
      ),
    );
    expect(bare[0]).toMatchObject({ path: '/calls/0/objectForm/event' });
  });

  // ADR-056: Segment's identify takes the traits in place of the id.
  it('allows an objectForm with personSet only on a call that sets person properties', () => {
    const identify = (form: string, personSet = '    personSet: args[1]\n') =>
      withCall(
        `  - member: track\n    on: [Shelf]\n    identity: identify\n${personSet}    objectForm:\n${form}`,
      );
    expect(parseDescriptor(identify('      personSet: args[0]\n')).ok).toBe(true);
    expect(descriptorErrors(identify('      personSet: args[0]\n', ''))).toEqual([
      expect.objectContaining({
        path: '/calls/0/objectForm/personSet',
        message: 'objectForm.personSet needs personSet on the call',
      }),
    ]);
    expect(
      descriptorErrors(identify('      personSet: args[0]\n      properties: args[0].x\n')).map(
        (e) => e.message,
      ),
    ).toEqual(['objectForm.properties needs objectForm.event']);
    const empty = descriptorErrors(
      withCall(
        '  - member: track\n    on: [Shelf]\n    identity: identify\n    personSet: args[1]\n    objectForm: {}\n',
      ),
    );
    expect(empty).toEqual([expect.objectContaining({ path: '/calls/0/objectForm' })]);
  });

  it('takes init options as one position or a list of positions', () => {
    const init = (options: string) =>
      `${DESCRIPTOR}init:\n  - member: init\n    on: [Shelf]\n    options: ${options}\n`;
    expect(parseDescriptor(init('args[1]')).ok).toBe(true);
    expect(parseDescriptor(init('\n      - args[1]\n      - args[2]')).ok).toBe(true);
    expect(parseDescriptor(init('\n      - args[1]')).ok).toBe(false);
    expect(parseDescriptor(init('\n      - args[1]\n      - opts')).ok).toBe(false);
  });

  it('needs personSet for personSetFallback', () => {
    const errors = descriptorErrors(
      withCall(
        '  - member: track\n    on: [Shelf]\n    identity: identify\n    personSetFallback:\n      from: args[1]\n      omit: []\n',
      ),
    );
    expect(errors[0]?.message).toBe('personSetFallback needs personSet');
  });

  it('refuses a member described twice on one container', () => {
    const errors = descriptorErrors(
      DESCRIPTOR.replace(
        '  - hook: useShelf\n',
        '  - member: reset\n    on: [Shelf]\n    identity: reset\n',
      ),
    );
    expect(errors[0]).toMatchObject({
      path: '/calls/5/on/0',
      message: 'Shelf.reset is described twice',
    });
    const hooks = descriptorErrors(
      DESCRIPTOR.replace('  - hook: useShelf\n', '  - hook: useShelf\n  - hook: useShelf\n'),
    );
    expect(hooks[0]?.message).toBe('hook useShelf is described twice');
  });

  it('needs the package in declaredIn and the verified version in range', () => {
    const errors = descriptorErrors(
      DESCRIPTOR.replace(
        "declaredIn: [shelf-sdk, '@shelf/core']",
        "declaredIn: ['@shelf/core']",
      ).replace('verified: 2.4.1', 'verified: 3.0.0'),
    );
    expect(errors.map((e) => e.message)).toEqual([
      'declaredIn must include the package shelf-sdk',
      'verified version 3.0.0 is outside versions >=2.0.0 <3.0.0',
    ]);
  });

  it('refuses a malformed argument path, platform or version range', () => {
    expect(
      descriptorErrors(DESCRIPTOR.replace('event: args[0]', 'event: arguments[0]'))[0]?.path,
    ).toBe('/calls/0/event');
    expect(
      descriptorErrors(DESCRIPTOR.replace('platforms: [web]', 'platforms: [desktop]'))[0]?.path,
    ).toBe('/platforms/0');
    expect(descriptorErrors(DESCRIPTOR.replace("'>=2.0.0 <3.0.0'", "'^2'"))[0]?.path).toBe(
      '/versions',
    );
  });
});

describe('builtins rules', () => {
  it('needs a condition on every builtin (negative control)', () => {
    const errors = builtinsErrors(BUILTINS.replace(', when: always }', ' }'));
    expect(errors[0]).toMatchObject({ path: '/properties/0/when', line: 7 });
  });

  it('needs one test per condition', () => {
    for (const when of [
      '{ option: x }',
      '{ option: x, not: false, is: true }',
      '{ unknown: r, option: x }',
      '{ call: track, unknown: r }',
      '{ auto: [{ component: ShelfProvider, prop: auto, option: pages }] }',
      '{}',
    ]) {
      const errors = builtinsErrors(BUILTINS.replace('{ unknown: remote config }', when));
      expect(errors[0]).toMatchObject({
        path: '/events/2/when',
        message:
          'a condition is always, { option, not }, { option, is }, { unknown } or { call, auto }, with nothing else',
      });
    }
  });

  it('refuses an unknown key in a condition, a value other than always, and a duplicate name', () => {
    expect(
      builtinsErrors(
        BUILTINS.replace('{ unknown: remote config }', '{ unknwon: remote config }'),
      ).map((e) => e.path),
    ).toContain('/events/2/when/unknwon');
    expect(builtinsErrors(BUILTINS.replace('when: always', 'when: never'))[0]?.path).toBe(
      '/properties/0/when',
    );
    expect(builtinsErrors(BUILTINS.replace('name: $click', 'name: $pageview'))[0]).toMatchObject({
      path: '/events/1/name',
      message: '"$pageview" is listed twice',
    });
  });
});

// ADR-047: a `call` condition names a described member; its `auto` callers are in the stub.
describe('builtins rules: call conditions', () => {
  const STUB_WITH_PROVIDER = STUB.replace(
    '  export const useShelf: () => Shelf;\n',
    '  export const useShelf: () => Shelf;\n  export const ShelfProvider: (props: { auto?: unknown }) => unknown;\n',
  );
  const withCondition = (when: string) =>
    BUILTINS.replace('{ unknown: state }', when).replace('events: [$pageview]', "events: '*'");
  const VALID =
    '{ call: track, auto: [{ component: ShelfProvider, prop: auto, option: pages }, { member: reset, on: [Shelf], options: "args[0]", option: pages }] }';

  it('loads a call condition with a provider and a member caller', () => {
    const dir = writeSet({ builtins: withCondition(VALID), stub: STUB_WITH_PROVIDER });
    const r = loadDescriptor(join(dir, 'shelf-sdk.yml'));
    if (!r.ok) throw new Error(formatDescriptorErrors(r.errors).join('\n'));
    expect(r.value.builtins.properties[1]?.when).toEqual({
      call: 'track',
      auto: [
        { component: 'ShelfProvider', prop: 'auto', option: 'pages' },
        { member: 'reset', on: ['Shelf'], options: 'args[0]', option: 'pages' },
      ],
    });
    // `auto` is optional.
    expect(
      loadDescriptor(
        join(writeSet({ builtins: withCondition('{ call: track }') }), 'shelf-sdk.yml'),
      ).ok,
    ).toBe(true);
  });

  it('refuses a call no described call names (negative control)', () => {
    const errors = errorsOf(writeSet({ builtins: withCondition('{ call: screen }') }));
    expect(errors).toEqual([
      expect.objectContaining({
        path: '/properties/1/when/call',
        message: "the condition's call screen is not a member the descriptor's calls describe",
        file: expect.stringContaining('builtins'),
      }),
    ]);
    // A hook is not a member.
    expect(errorsOf(writeSet({ builtins: withCondition('{ call: useShelf }') }))).toHaveLength(1);
  });

  it('refuses auto callers the stub does not declare (negative control)', () => {
    const errors = errorsOf(
      writeSet({
        builtins: withCondition(
          '{ call: track, auto: [{ component: PagesProvider, prop: auto, option: pages }, { member: follow, on: [Shelf, ShelfCore], options: "args[0]", option: pages }] }',
        ),
        stub: STUB_WITH_PROVIDER,
      }),
    );
    expect(errors.map((e) => [e.path, e.message])).toEqual([
      ['/properties/1/when/auto/0/component', expect.stringContaining('PagesProvider')],
      ['/properties/1/when/auto/1/member', expect.stringMatching(/follow.*Shelf\b/)],
      ['/properties/1/when/auto/1/member', expect.stringMatching(/follow.*ShelfCore/)],
    ]);
  });

  it('refuses a malformed auto caller', () => {
    for (const auto of [
      '[]',
      '[{ component: ShelfProvider, prop: auto }]',
      '[{ member: reset, on: [Shelf], options: "args[0]" }]',
      '[{ member: reset, on: [Shelf], options: options, option: pages }]',
      '[{ component: ShelfProvider, member: reset, prop: auto, option: pages }]',
    ])
      expect(builtinsErrors(withCondition(`{ call: track, auto: ${auto} }`))[0]?.path).toMatch(
        /^\/properties\/1\/when/,
      );
  });

  it('refuses a call that is not a member name', () => {
    for (const call of ['1', '"Shelf.track"'])
      expect(builtinsErrors(withCondition(`{ call: ${call} }`))[0]?.path).toMatch(
        /^\/properties\/1\/when/,
      );
  });
});

describe('loadDescriptors', () => {
  it('refuses two descriptors of one sdk', () => {
    const dir = writeSet();
    writeFileSync(join(dir, 'shelf-copy.yml'), DESCRIPTOR);
    const r = loadDescriptors(dir);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]?.message).toBe('sdk shelf-sdk is described by two descriptors');
  });

  it('collects the errors of every descriptor', () => {
    const dir = writeSet({ descriptor: `${DESCRIPTOR}colour: blue\n` });
    writeFileSync(join(dir, 'other.yml'), 'sdk: other\n');
    const r = loadDescriptors(dir);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(new Set(r.errors.map((e) => e.file)).size).toBe(2);
  });
});

describe('readStubSurface', () => {
  it('reads modules, containers with their public members, object-typed properties and hooks', () => {
    const s = readStubSurface(STUB, 'shelf.d.ts');
    expect(s.modules).toEqual(['shelf-sdk', 'shelf-sdk/react']);
    expect([...(s.containers.get('Shelf') ?? [])].sort()).toEqual([
      'identify',
      'people',
      'register',
      'reset',
      'track',
    ]);
    expect([...(s.containers.get('Shelf.people') ?? [])]).toEqual(['set']);
    expect([...(s.containers.get('ShelfCore') ?? [])]).toEqual(['register']);
    expect([...s.functions]).toEqual(['useShelf']);
  });

  it('ignores declarations outside an ambient module', () => {
    const s = readStubSurface('export declare class Shelf { track(): void }', 'x.d.ts');
    expect(s.modules).toEqual([]);
    expect(s.containers.size).toBe(0);
  });

  it('reads interfaces and function declarations', () => {
    const s = readStubSurface(
      "declare module 'm' { interface Api { track(e: string): void; 'quoted'(): void } function useApi(): Api; }",
      'x.d.ts',
    );
    expect([...(s.containers.get('Api') ?? [])]).toEqual(['track', 'quoted']);
    expect([...s.functions]).toEqual(['useApi']);
  });
});

describe('satisfies', () => {
  it.each([
    ['4.86.0', '>=4.0.0 <5.0.0', true],
    ['5.0.0', '>=4.0.0 <5.0.0', false],
    ['3.9.9', '>=4.0.0 <5.0.0', false],
    ['1.2.3', '1.2.3', true],
    ['1.2.3', '=1.2.4', false],
    ['1.2.3', '>1.2.2 <=1.2.3', true],
    ['1.2.3', '>1.2.3', false],
    ['1.2.3', '<=1.2.2', false],
  ])('%s in %s is %s', (version, range, expected) => {
    expect(satisfies(version, range)).toBe(expected);
  });
});
