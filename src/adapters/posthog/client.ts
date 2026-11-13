// PostHog REST client (spec 6.5.1, 6.13, T5.1): `pull`'s only network path. GET only (POST only to
// `query/` when the HogQL opt-in is on), paged, polite (at most 3 requests in flight and 240 a
// minute, 429 waits for `Retry-After`), and key-safe: the key is sent only in the Authorization
// header and every line the client writes or throws is passed through `redact` first.
//
// Fields that are not definitions (cached insight results, alert values and check history, people)
// are dropped from every response on arrival (6.5.2), so nothing after the client ever holds them.

export const MAX_IN_FLIGHT = 3;
export const PER_MINUTE = 240;
export const MAX_429_RETRIES = 3;
export const MAX_RETRY_AFTER_SECONDS = 120;
export const DEFAULT_RETRY_AFTER_SECONDS = 60;
export const MAX_TRANSIENT_RETRIES = 2;
export const PAGE_LIMIT = 100;
export const REQUEST_TIMEOUT_MS = 30_000;

const MINUTE_MS = 60_000;
const TRANSIENT_STATUSES = new Set([502, 503, 504]);

/** A failure `pull` reports with its exit code (6.9.2): 2 usage or config, 3 a bug, 4 pull failed. */
export class PullError extends Error {
  constructor(
    message: string,
    readonly exitCode: 2 | 3 | 4,
  ) {
    super(message);
    this.name = 'PullError';
  }
}

/**
 * The key named by the config's `key: env:NAME` (G12). A literal key is a usage error; an unset or
 * empty variable means `pull` cannot authenticate (exit 4). The value is never part of a message.
 */
export function resolveKey(
  spec: string,
  env: Readonly<Record<string, string | undefined>>,
): string {
  const m = /^env:([A-Za-z_][A-Za-z0-9_]*)$/.exec(spec);
  if (!m)
    throw new PullError('Put the key in an environment variable and write `key: env:NAME`.', 2);
  const name = m[1] as string;
  const value = env[name];
  if (value === undefined || value.trim() === '')
    throw new PullError(`no PostHog key: the environment variable ${name} is not set or empty`, 4);
  return value.trim();
}

/** Keys removed at any depth outside definition payloads: results, alert values, people. */
const DROPPED = new Set([
  'result',
  'hasMore',
  'columns',
  'types',
  'last_value',
  'checks',
  'created_by',
  'last_modified_by',
  'updated_by',
  'verified_by',
  'owner',
  'user',
  'subscribed_users',
]);
/** PostHog's own query and filter definitions are kept exactly as sent. */
const KEPT_WHOLE = new Set(['query', 'filters', 'filters_overrides']);

export function dropOnArrival(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(dropOnArrival);
  if (value === null || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    if (DROPPED.has(k)) continue;
    out[k] = KEPT_WHOLE.has(k) ? v : dropOnArrival(v);
  }
  return out;
}

export interface ClientOptions {
  /** `https://us.posthog.com`, `https://eu.posthog.com` or a self-hosted URL. */
  host: string;
  project: string | number;
  key: string;
  /** The HogQL recency opt-in (6.5.1): allows POST to `query/` and nothing else. */
  hogql?: boolean;
  fetch?: typeof globalThis.fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** Progress lines (the host being called); stderr by default. */
  info?: (line: string) => void;
  /** Debug lines (each request, its headers and status); off unless given. */
  debug?: (line: string) => void;
  timeoutMs?: number;
}

export interface Page {
  /** The page's path relative to `/api/projects/{id}/`. */
  path: string;
  body: unknown;
}

function parseHost(host: string): string {
  let url: URL;
  try {
    url = new URL(host);
  } catch {
    throw new PullError(`platforms.posthog.host is not a URL: ${host}`, 2);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:')
    throw new PullError(`platforms.posthog.host must be an https URL: ${host}`, 2);
  if (url.username || url.password || url.search || url.hash)
    throw new PullError(
      'platforms.posthog.host must be a plain URL with no credentials, query or fragment',
      2,
    );
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

function retryAfterSeconds(header: string | null, detail: string, now: number): number {
  if (header !== null && /^\d+$/.test(header.trim())) return Number(header.trim());
  if (header !== null) {
    const at = Date.parse(header);
    if (!Number.isNaN(at)) return Math.max(0, Math.ceil((at - now) / 1000));
  }
  const m = /available in (\d+) seconds?/i.exec(detail);
  return m ? Number(m[1]) : DEFAULT_RETRY_AFTER_SECONDS;
}

function detailOf(body: unknown): string {
  if (body && typeof body === 'object' && 'detail' in body)
    return String((body as { detail: unknown }).detail);
  return '';
}

export class PostHogClient {
  readonly host: string;
  readonly project: string;
  private readonly base: string;
  private readonly key: string;
  private readonly hogql: boolean;
  private readonly fetchFn: typeof globalThis.fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly info: (line: string) => void;
  private readonly debugFn: ((line: string) => void) | undefined;
  private readonly timeoutMs: number;
  private announced = false;
  private active = 0;
  private readonly waiters: (() => void)[] = [];
  private readonly started: number[] = [];
  /** Requests sent, retries included. */
  requests = 0;

  constructor(options: ClientOptions) {
    this.host = parseHost(options.host);
    this.project = String(options.project);
    if (!/^\d+$/.test(this.project))
      throw new PullError(
        `platforms.posthog.project must be the numeric project id, not ${this.project}`,
        2,
      );
    if (options.key.length === 0) throw new PullError('no PostHog key', 4);
    this.key = options.key;
    this.base = `${this.host}/api/projects/${this.project}/`;
    this.hogql = options.hogql ?? false;
    this.fetchFn = options.fetch ?? globalThis.fetch;
    this.sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.now = options.now ?? Date.now;
    this.info = options.info ?? ((line) => process.stderr.write(`${line}\n`));
    this.debugFn = options.debug;
    this.timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
  }

  /** Replaces every occurrence of the key; applied to every line the client writes or throws. */
  redact(text: string): string {
    return text.split(this.key).join('[redacted]');
  }

  /** One GET of a path relative to `/api/projects/{id}/`. */
  async get(path: string): Promise<unknown> {
    return this.request('GET', path);
  }

  /** Every page of a list endpoint, following `next` on the same host and project only. */
  async *pages(path: string): AsyncGenerator<Page> {
    let next: string | null = this.withLimit(path);
    while (next !== null) {
      const body = await this.request('GET', next);
      yield { path: next, body };
      const link = body && typeof body === 'object' ? (body as { next?: unknown }).next : undefined;
      next = typeof link === 'string' && link !== '' ? this.relative(link) : null;
    }
  }

  /** The `results` of every page of a list endpoint, in order. */
  async getAll(path: string): Promise<unknown[]> {
    const rows: unknown[] = [];
    for await (const page of this.pages(path)) {
      const results =
        page.body && typeof page.body === 'object'
          ? (page.body as { results?: unknown }).results
          : undefined;
      if (!Array.isArray(results))
        throw new PullError(
          this.redact(`GET ${this.label(page.path)} did not return a list (no "results")`),
          4,
        );
      rows.push(...results);
    }
    return rows;
  }

  /** POST to `query/`: only with the HogQL opt-in (6.5.1). */
  async query(body: unknown): Promise<unknown> {
    return this.request('POST', 'query/', body);
  }

  /**
   * The one place a request is made. Anything but GET is refused before it reaches the network,
   * except POST `query/` with the HogQL opt-in.
   */
  async request(method: string, path: string, body?: unknown): Promise<unknown> {
    const verb = method.toUpperCase();
    const rel = this.checkPath(path);
    if (verb !== 'GET' && !(verb === 'POST' && this.hogql && rel === 'query/'))
      throw new PullError(
        `refused ${verb} ${this.label(rel)}: dashlint pull only reads (GET), and POSTs only to query/ when hogql is on`,
        3,
      );
    if (!this.announced) {
      this.announced = true;
      this.info(
        this.redact(
          `pull: reading definitions from ${this.host}, project ${this.project} (GET only${this.hogql ? ', and POST query/ for HogQL recency' : ''})`,
        ),
      );
    }
    const url = this.base + rel;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.key}`,
      Accept: 'application/json',
    };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    let throttled = 0;
    let transient = 0;
    for (;;) {
      const release = await this.slot();
      const t0 = this.now();
      this.debug(`${verb} ${url} headers ${JSON.stringify(headers)}`);
      let status: number;
      let retryHeader: string | null;
      let parsed: unknown;
      let text: string;
      try {
        this.requests++;
        const res = await this.fetchFn(url, {
          method: verb,
          headers,
          redirect: 'error',
          signal: AbortSignal.timeout(this.timeoutMs),
          ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        });
        status = res.status;
        retryHeader = res.headers.get('retry-after');
        text = await res.text();
      } catch (e) {
        release();
        const reason = e instanceof Error ? e.message : String(e);
        if (transient < MAX_TRANSIENT_RETRIES) {
          transient++;
          this.debug(
            `${verb} ${url} failed (${reason}); retry ${transient} of ${MAX_TRANSIENT_RETRIES}`,
          );
          await this.sleep(1000 * 2 ** (transient - 1));
          continue;
        }
        throw new PullError(
          this.redact(`could not reach ${this.host} for ${verb} ${this.label(rel)}: ${reason}`),
          4,
        );
      }
      release();
      try {
        parsed = text === '' ? null : JSON.parse(text);
      } catch {
        parsed = undefined;
      }
      this.debug(`${verb} ${url} -> HTTP ${status} (${this.now() - t0} ms)`);
      if (status >= 200 && status < 300) {
        if (parsed === undefined)
          throw new PullError(
            this.redact(`${verb} ${this.label(rel)} returned HTTP ${status} but not JSON`),
            4,
          );
        return dropOnArrival(parsed);
      }
      const detail = detailOf(parsed);
      if (status === 429) {
        const wait = retryAfterSeconds(retryHeader, detail, this.now());
        if (throttled >= MAX_429_RETRIES)
          throw new PullError(
            this.redact(
              `${verb} ${this.label(rel)} was still rate limited (HTTP 429) after ${MAX_429_RETRIES} waits`,
            ),
            4,
          );
        if (wait > MAX_RETRY_AFTER_SECONDS)
          throw new PullError(
            this.redact(
              `${verb} ${this.label(rel)} was rate limited (HTTP 429) for ${wait} s, more than ${MAX_RETRY_AFTER_SECONDS} s; try again later`,
            ),
            4,
          );
        throttled++;
        this.info(
          this.redact(`pull: rate limited on ${this.label(rel)}, waiting ${wait} s (Retry-After)`),
        );
        await this.sleep(wait * 1000);
        continue;
      }
      if (TRANSIENT_STATUSES.has(status) && transient < MAX_TRANSIENT_RETRIES) {
        transient++;
        this.debug(
          `${verb} ${url} -> HTTP ${status}; retry ${transient} of ${MAX_TRANSIENT_RETRIES}`,
        );
        await this.sleep(1000 * 2 ** (transient - 1));
        continue;
      }
      throw new PullError(this.redact(this.failure(verb, rel, status, detail)), 4);
    }
  }

  private failure(verb: string, rel: string, status: number, detail: string): string {
    const where = `${verb} ${this.label(rel)}`;
    const scope = /missing required scope '([^']+)'/i.exec(detail);
    if (status === 403 && scope)
      return `the PostHog key is missing the scope ${scope[1]} (${where} returned HTTP 403); add ${scope[1]} to the personal API key`;
    if (status === 401)
      return `PostHog refused the key (${where} returned HTTP 401); check the personal API key`;
    if (status === 403)
      return `PostHog denied access (${where} returned HTTP 403)${detail ? `: ${detail}` : ''}`;
    if (status === 404)
      return `not found (${where} returned HTTP 404); check the host and the project id`;
    return `${where} returned HTTP ${status}${detail ? `: ${detail}` : ''}`;
  }

  /** `GET /api/projects/{id}/insights/` style label: the path without its query string. */
  private label(rel: string): string {
    return `/api/projects/${this.project}/${rel.split('?')[0] ?? ''}`;
  }

  /** A path relative to the project, refusing anything that could leave it. */
  private checkPath(path: string): string {
    if (
      path.startsWith('/') ||
      path.includes('://') ||
      /(^|\/)\.\.?(\/|$|\?)/.test(path) ||
      path.includes('\\')
    )
      throw new PullError(`refused path ${JSON.stringify(path)}: not relative to the project`, 3);
    return path;
  }

  /** A `next` link made relative; a link to another host or project stops the pull. */
  private relative(link: string): string {
    let url: URL;
    try {
      url = new URL(link, this.base);
    } catch {
      throw new PullError(this.redact(`a next-page link is not a URL: ${link}`), 4);
    }
    const href = url.href;
    if (!href.startsWith(this.base) || new URL(this.base).origin !== url.origin)
      throw new PullError(
        this.redact(`a next-page link points away from ${this.base}; stopping`),
        4,
      );
    return this.checkPath(href.slice(this.base.length));
  }

  private withLimit(path: string): string {
    if (/[?&]limit=/.test(path)) return path;
    return `${path}${path.includes('?') ? '&' : '?'}limit=${PAGE_LIMIT}`;
  }

  private debug(line: string): void {
    this.debugFn?.(this.redact(line));
  }

  /** Waits for one of MAX_IN_FLIGHT slots and for room in the rolling minute; returns the release. */
  private async slot(): Promise<() => void> {
    while (this.active >= MAX_IN_FLIGHT) await new Promise<void>((r) => this.waiters.push(r));
    this.active++;
    for (;;) {
      const t = this.now();
      while (this.started.length > 0 && (this.started[0] as number) <= t - MINUTE_MS)
        this.started.shift();
      if (this.started.length < PER_MINUTE) break;
      await this.sleep((this.started[0] as number) + MINUTE_MS - t);
    }
    this.started.push(this.now());
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active--;
      this.waiters.shift()?.();
    };
  }
}
