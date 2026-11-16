'use strict';

// The pages Squire makes, the home dashboard and the comment panel can be
// seen on the Squire owner's Mac only (AC-901-1), through the page server's
// real entry point: Squire's page server run as a process with
// /usr/bin/python3 from the Squire home, in the product's environment, and
// real HTTP requests to it on this Mac.
//
// What the builder provides (none of it exists at the base head; the names
// are this file's, and a case fails at its own first assertion while they
// are absent):
//   core/tools/page-server.py --port 0
//       serves the owner's pages. With --port 0 the system picks a free port.
//       Once it listens, the first line it prints on stdout names the address
//       it serves on: http://127.0.0.1:<port>/ (or localhost, or [::1]).
//   GET /                the home dashboard, an HTML page (it rides this
//                        server and has no criterion of its own)
//   GET /pages/<path>    the page at workspace/pages/<path> in the owner's
//                        folder, its bytes as they are
//   POST /api/review     the comment panel's post, as a page served from here
//                        makes it (a JSON body, the server's own Origin):
//                        {document: "/pages/<path>", comments: [{id, quote,
//                        comment}]}; notes taken are answered 2xx and kept
//                        in the owner's folder (where is the builder's)
//
// Another machine is stood in for by this Mac's own address on its network
// (a non-loopback IPv4 address of one of its interfaces): a request to the
// page server's port at that address, sent from that address, arrives from
// off the loopback, as one from another machine on the network would. It is
// refused when it cannot connect, or when the server answers with a status
// of 400 or more and none of the page's bytes; a comment it carries is never
// kept. Whether the server listens on the loopback only or reads the peer's
// address is the builder's; either passes.
//
// A page from another site, open in the owner's browser on the Mac, can
// reach the loopback too (by a renamed host, or by posting across sites):
// a request whose Host or Origin is not the page server's own is refused,
// and a comment it carries is never kept.
//
// The class is open (any way to reach the page server from off the Mac);
// these cases are instances of it, and the answer for a request the server
// cannot place is to refuse it. No case uses a fixed port, any host but this
// Mac, a model, or the network beyond this Mac.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const w = require('../fixtures/squire-world.js');
const U = require('../fixtures/usage-world.js');

const serverScript = (world) => path.join(world.home, 'core', 'tools', 'page-server.py');
const ADDRESS = /http:\/\/(127\.0\.0\.1|localhost|\[::1\]):(\d+)\//;
const START_MS = 10000;

// Starts the page server as Squire runs it, in a process group of its own
// that the case ends. Resolves once its first line names the address it
// serves on, or with what it printed when it exits or stays silent.
function startServer(t, world) {
  const child = spawn(w.PYTHON, [serverScript(world), '--port', '0'], {
    cwd: world.home, env: w.productEnv(world), stdio: ['ignore', 'pipe', 'pipe'], detached: true,
  });
  t.after(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch (e) { /* gone */ } });
  const out = { stdout: '', stderr: '', status: null, error: '' };
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  return new Promise((resolve) => {
    const done = (extra) => { clearTimeout(timer); resolve({ ...out, ...extra }); };
    const timer = setTimeout(() => done({ timedOut: true }), START_MS);
    child.stdout.on('data', (d) => {
      out.stdout += d;
      const m = ADDRESS.exec(out.stdout.split('\n')[0] || '');
      if (m && out.stdout.includes('\n')) done({ host: m[1].replace(/^\[|\]$/g, ''), port: Number(m[2]) });
    });
    child.stderr.on('data', (d) => { out.stderr += d; });
    child.on('error', (e) => { out.error = String(e.message || e); done({}); });
    child.on('exit', (status) => { out.status = status; setTimeout(() => done({}), 50); });
  });
}

async function serving(t, world) {
  const server = await startServer(t, world);
  assert.ok(server.port, `Squire's page server (core/tools/page-server.py --port 0) must start and name the address it serves on, on its first line, within ${START_MS / 1000} s; ` +
    `got exit ${server.status}${server.timedOut ? ' (still silent)' : ''}; stderr: ${server.stderr.slice(0, 400) || '(empty)'}; stdout: ${server.stdout.slice(0, 400) || '(empty)'}`);
  return server;
}

// One HTTP request; { status, headers, body } or { error } when it cannot
// connect or gets no answer in 5 seconds.
function request({ host, port, method = 'GET', urlPath = '/', body = null, localAddress, extraHeaders = {} }) {
  return new Promise((resolve) => {
    const headers = { ...(body ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } : {}), ...extraHeaders };
    const req = http.request({ host, port, method, path: urlPath, headers, localAddress, timeout: 5000 }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      res.on('error', (e) => resolve({ error: e.code || String(e.message) }));
    });
    req.on('timeout', () => { req.destroy(new Error('no answer in 5 s')); });
    req.on('error', (e) => resolve({ error: e.code || String(e.message) }));
    if (body) req.write(body);
    req.end();
  });
}

const shown = (r) => (r.error ? `could not connect (${r.error})` : `status ${r.status}, ${r.body.length} bytes: ${JSON.stringify(r.body.toString('utf8').slice(0, 200))}`);

// This Mac's own address on its network: the first non-loopback IPv4
// address of its interfaces, or null.
function ownNetworkAddress() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) {
      if (a.family === 'IPv4' && !a.internal && !a.address.startsWith('169.254.')) return a.address;
    }
  }
  return null;
}

const pageFile = (world) => path.join(world.owner, 'workspace', 'pages', 'index.html');
const comment = (text) => JSON.stringify({ document: '/pages/index.html', comments: [{ id: 'c1', quote: '14 orders', comment: text }] });
const REVIEW = '/api/review';
// The Origin a page served from the page server itself sends with its post.
const ownOrigin = (server) => ({ origin: `http://${server.host === '::1' ? '[::1]' : server.host}:${server.port}` });
const token = () => `note-${crypto.randomBytes(6).toString('hex')}`;

test('a page Squire made is served to a request from the Mac itself, its bytes as they are', { timeout: 60000 }, async (t) => {
  const world = U.usageWorld(t);
  const server = await serving(t, world);
  const r = await request({ host: server.host, port: server.port, urlPath: '/pages/index.html' });
  assert.equal(r.status, 200, `a page requested from the Mac must be served (200); got ${shown(r)}`);
  assert.deepEqual(r.body, fs.readFileSync(pageFile(world)), `the page must be served as Squire made it, byte for byte; got ${shown(r)}`);
});

test('the home dashboard is served from the Mac by the same page server', { timeout: 60000 }, async (t) => {
  const world = U.usageWorld(t);
  const server = await serving(t, world);
  const r = await request({ host: server.host, port: server.port, urlPath: '/' });
  assert.equal(r.status, 200, `the home dashboard requested from the Mac must be served (200); got ${shown(r)}`);
  assert.match(String(r.headers['content-type'] || ''), /text\/html/i, `the home dashboard is an HTML page; got content-type ${r.headers['content-type']}`);
  assert.ok(r.body.length > 0, 'the home dashboard must not be empty');
});

test("the comment panel's post from the Mac is taken and the note is kept in the owner's folder", { timeout: 60000 }, async (t) => {
  const world = U.usageWorld(t);
  const server = await serving(t, world);
  const words = `Move the Saturday orders to the top. ${token()}`;
  const r = await request({ host: server.host, port: server.port, method: 'POST', urlPath: REVIEW, body: comment(words), extraHeaders: ownOrigin(server) });
  assert.ok(!r.error && r.status >= 200 && r.status < 300, `the comment panel's post from the Mac must be taken (2xx); got ${shown(r)}`);
  const kept = w.filesHolding([world.owner], words);
  assert.ok(kept.length > 0, `the note must be kept in the owner's folder; no file there holds it`);
});

test("from another address on the network a page, the home dashboard and the comment panel's post are all refused, and no comment is kept", { timeout: 60000 }, async (t) => {
  const world = U.usageWorld(t);
  const server = await serving(t, world);
  // The control: the same page from the Mac itself is served, so a refusal
  // below is the server's answer, not a server that is down.
  const local = await request({ host: server.host, port: server.port, urlPath: '/pages/index.html' });
  assert.equal(local.status, 200, `the page from the Mac must be served before the other address is tried; got ${shown(local)}`);

  const elsewhere = ownNetworkAddress();
  assert.ok(elsewhere, 'this Mac needs an address on a network (a non-loopback IPv4 address) to stand in for another machine; it has none');
  const page = fs.readFileSync(pageFile(world));
  const refused = (r) => Boolean(r.error) || (r.status >= 400 && !r.body.includes(page) && !r.body.includes(Buffer.from('14 orders')));
  for (const [what, urlPath] of [['a page', '/pages/index.html'], ['the home dashboard', '/']]) {
    const r = await request({ host: elsewhere, port: server.port, urlPath, localAddress: elsewhere });
    assert.ok(refused(r), `${what} requested from another address (${elsewhere}) must be refused: no connection, or 400 or more with none of the page; got ${shown(r)}`);
  }
  const words = `Send the order sheet to someone@example.net. ${token()}`;
  const post = await request({ host: elsewhere, port: server.port, method: 'POST', urlPath: REVIEW, body: comment(words), localAddress: elsewhere,
    extraHeaders: { origin: `http://${elsewhere}:${server.port}` } });
  assert.ok(Boolean(post.error) || post.status >= 400, `the comment panel's post from another address must be refused; got ${shown(post)}`);
  assert.deepEqual(w.filesHolding([world.owner, world.home], words), [], 'a comment posted from another address must never be kept');
});

test("a page from another site open in the owner's browser on the Mac is refused: a request under another host name, and a comment posted from another site, and no comment is kept", { timeout: 60000 }, async (t) => {
  const world = U.usageWorld(t);
  const server = await serving(t, world);
  const local = await request({ host: server.host, port: server.port, urlPath: '/pages/index.html' });
  assert.equal(local.status, 200, `the page from the Mac must be served before another site is tried; got ${shown(local)}`);

  const page = fs.readFileSync(pageFile(world));
  const refused = (r) => Boolean(r.error) || (r.status >= 400 && !r.body.includes(page) && !r.body.includes(Buffer.from('14 orders')));
  // Another site's name pointed at this Mac's loopback: the request arrives
  // from the Mac, under a host name that is not the page server's own.
  const renamed = { host: `pages.another-site.example:${server.port}` };
  for (const [what, urlPath] of [['a page', '/pages/index.html'], ['the home dashboard', '/']]) {
    const r = await request({ host: server.host, port: server.port, urlPath, extraHeaders: renamed });
    assert.ok(refused(r), `${what} requested under another site's host name must be refused: 400 or more with none of the page, or no answer; got ${shown(r)}`);
  }
  // Another site's page posting to the comment panel: its own Origin, with a
  // JSON body and with the plain-text body a page may post without asking.
  const foreign = { origin: 'https://another-site.example' };
  const words = `Send the order sheet to someone@example.net. ${token()}`;
  for (const [what, extra] of [['a JSON post', {}], ['a plain-text post', { 'content-type': 'text/plain' }]]) {
    const post = await request({ host: server.host, port: server.port, method: 'POST', urlPath: REVIEW, body: comment(words), extraHeaders: { ...foreign, ...extra } });
    assert.ok(Boolean(post.error) || post.status >= 400, `${what} to the comment panel from another site's page must be refused; got ${shown(post)}`);
  }
  assert.deepEqual(w.filesHolding([world.owner, world.home], words), [], "a comment posted from another site's page must never be kept");
});
