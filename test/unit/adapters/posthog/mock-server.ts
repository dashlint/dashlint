// A local PostHog stand-in for the client tests: routes by method and path (with query string), and
// records every request it receives with its Authorization header.
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface MockReply {
  status?: number;
  headers?: Record<string, string>;
  /** JSON-encoded unless it is a string. */
  body?: unknown;
  delayMs?: number;
}

export interface Received {
  method: string;
  url: string;
  authorization: string | undefined;
  body: string;
}

export type Route = (req: Received, base: string) => MockReply;

export interface MockServer {
  base: string;
  received: Received[];
  maxInFlight: number;
  close(): Promise<void>;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let s = '';
    req.on('data', (c: Buffer) => (s += c.toString('utf8')));
    req.on('end', () => resolve(s));
  });
}

/** Routes are keyed `METHOD /path?query`; a missing route answers 404. */
export async function startMock(
  routes: Record<string, Route | MockReply | MockReply[]>,
): Promise<MockServer> {
  const received: Received[] = [];
  const queues = new Map<string, MockReply[]>();
  let inFlight = 0;
  const state = { maxInFlight: 0 };
  let base = '';
  const server: Server = createServer((req, res) => {
    inFlight++;
    state.maxInFlight = Math.max(state.maxInFlight, inFlight);
    void readBody(req).then((body) => {
      const r: Received = {
        method: req.method ?? '',
        url: req.url ?? '',
        authorization: req.headers.authorization,
        body,
      };
      received.push(r);
      const key = `${r.method} ${r.url}`;
      const route = routes[key];
      let reply: MockReply;
      if (route === undefined) reply = { status: 404, body: { detail: 'Not found.' } };
      else if (typeof route === 'function') reply = route(r, base);
      else if (Array.isArray(route)) {
        if (!queues.has(key)) queues.set(key, [...route]);
        const q = queues.get(key) as MockReply[];
        reply = q.length > 1 ? (q.shift() as MockReply) : (q[0] as MockReply);
      } else reply = route;
      setTimeout(() => {
        const text = typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body ?? {});
        res.writeHead(reply.status ?? 200, {
          'content-type': 'application/json',
          ...reply.headers,
        });
        res.end(text);
        inFlight--;
      }, reply.delayMs ?? 0);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    base,
    received,
    get maxInFlight() {
      return state.maxInFlight;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}
