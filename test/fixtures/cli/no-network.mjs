// Loaded with `node --import` by the end-to-end tests (T7.6, G4): every way out to the network
// throws, and says so on stderr first, so a caller that swallows the error is still caught.
import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import { syncBuiltinESMExports } from 'node:module';
import net from 'node:net';
import tls from 'node:tls';

export const BLOCKED = 'dashlint-test: network blocked';

function refuse(what) {
  return function blocked() {
    process.stderr.write(`${BLOCKED} (${what})\n`);
    throw new Error(`${BLOCKED} (${what})`);
  };
}

net.Socket.prototype.connect = refuse('net.Socket.connect');
net.connect = refuse('net.connect');
net.createConnection = refuse('net.createConnection');
tls.connect = refuse('tls.connect');
http.request = refuse('http.request');
http.get = refuse('http.get');
https.request = refuse('https.request');
https.get = refuse('https.get');
dns.lookup = refuse('dns.lookup');
dns.resolve = refuse('dns.resolve');
dns.promises.lookup = refuse('dns.promises.lookup');
globalThis.fetch = refuse('fetch');
// `import { connect } from 'node:net'` sees the replacements too.
syncBuiltinESMExports();
