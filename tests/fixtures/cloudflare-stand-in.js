'use strict';

// A loopback stand-in of the parts of Cloudflare's API that Squire's website
// set-up and deploy call. Test equipment only, never shipped. It listens on
// 127.0.0.1 on a port the system picks, in a process of its own (so the
// product's command lines, run with spawnSync, can reach it), and records
// every call it answers: the method, the path, the token it carried, whether
// it was refused and the body's shape. Its account, token, script and site
// names are invented and plainly fake. Nothing here is fetched from an
// account; the shapes come from Cloudflare's public API reference, read
// without credentials, and each assumption is named where it is made:
//
//   The response envelope { success, errors: [{ code, message }], messages,
//     result } (https://developers.cloudflare.com/fundamentals/api/troubleshooting/).
//   Account-owned tokens: POST /accounts/{account}/tokens with name and
//     policies [{ effect, resources, permission_groups: [{ id }] }], whose
//     answer carries the new token's id and its value, shown once;
//     GET /accounts/{account}/tokens/verify; GET and DELETE
//     /accounts/{account}/tokens/{id}; GET
//     /accounts/{account}/tokens/permission_groups
//     (https://developers.cloudflare.com/fundamentals/api/how-to/create-via-api/,
//     https://developers.cloudflare.com/api/resources/accounts/subresources/tokens/methods/create,
//     https://developers.cloudflare.com/api/resources/accounts/subresources/tokens/methods/get).
//   Creating account tokens takes "Account API Tokens Write"; reading one
//     back takes that or "Account API Tokens Read" (the same pages).
//   An account's subscriptions: GET /accounts/{account}/subscriptions, which
//     takes "Billing Read" (or "Billing Write"); each has id, rate_plan
//     { id, public_name, ... }, price, currency, frequency and state; no field
//     says a subscription is free
//     (https://developers.cloudflare.com/api/resources/accounts/subresources/subscriptions/methods/get).
//   A Worker with static assets: POST
//     /accounts/{account}/workers/scripts/{script}/assets-upload-session with
//     { manifest: { "/<path>": { hash, size } } }, answered with a jwt and the
//     buckets of hashes to upload; POST /accounts/{account}/workers/assets/upload?base64=true,
//     multipart, the session's jwt as the bearer, answered 201 with a
//     completion jwt; PUT /accounts/{account}/workers/scripts/{script},
//     multipart with a metadata part holding assets.jwt and compatibility_date
//     (https://developers.cloudflare.com/workers/static-assets/direct-upload/,
//     https://developers.cloudflare.com/api/resources/workers/subresources/scripts/methods/update).
//     These take "Workers Scripts Write". The stand-in accepts any 32-hex
//     hash with the right size; the real hash is not pinned here.
//   workers.dev: GET /accounts/{account}/workers/subdomain (the account's
//     subdomain) and POST /accounts/{account}/workers/scripts/{script}/subdomain
//     with { enabled: true } (https://developers.cloudflare.com/api/,
//     https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/subdomain/methods/get;
//     the POST's shape is not confirmed in the pages read).
//   A refusal: the stand-in answers 403 with code 10000, "Authentication
//     error", to any call a token's rights do not cover, and 401 with code
//     1000, "Invalid API Token", to a token it does not hold or has deleted
//     (the status and codes are the stand-in's own: not found in the pages read).
//   A new workers.dev address answers only after its certificate is ready,
//     about 30 seconds on the test account (seen on a real account, not
//     documented); the stand-in waits certificateWaitMs (2 seconds unless a
//     case says otherwise) after a script is first put on workers.dev, and
//     until then answers its address with 503.
//
// The sites: the stand-in serves each script put on workers.dev at
// /__sites/<script>.<subdomain>.workers.dev/<path>, the address template a
// case gives Squire in place of https://<script>.<subdomain>.workers.dev/.
//
// Leaving the loopback: the cases give Squire's processes this stand-in as
// their web proxy (HTTPS_PROXY and HTTP_PROXY, loopback excepted), so any
// call to another host reaches the stand-in instead, which records it as off
// the loopback and refuses it. A case asserts there were none.
//
// Run as a program: node cloudflare-stand-in.js <folder>. It reads
// <folder>/options.json at start and again on each call (so a case may change
// what it answers), writes <folder>/port once it listens, appends each call to
// <folder>/calls.jsonl and writes its state (tokens, scripts) to
// <folder>/state.json after each call.

const { spawn, spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const ACCOUNT_SCOPE = 'com.cloudflare.api.account';

// The permission groups the stand-in knows, by the names the API reference
// gives them (the dashboard says Edit where the API says Write). Ids are the
// stand-in's own; Squire looks a group up by name in the list it is given.
const GROUPS = [
  { id: 'standin-pg-account-api-tokens-write', name: 'Account API Tokens Write', scopes: [ACCOUNT_SCOPE] },
  { id: 'standin-pg-account-api-tokens-read', name: 'Account API Tokens Read', scopes: [ACCOUNT_SCOPE] },
  { id: 'standin-pg-billing-read', name: 'Billing Read', scopes: [ACCOUNT_SCOPE] },
  { id: 'standin-pg-billing-write', name: 'Billing Write', scopes: [ACCOUNT_SCOPE] },
  { id: 'standin-pg-workers-scripts-write', name: 'Workers Scripts Write', scopes: [ACCOUNT_SCOPE] },
  { id: 'standin-pg-workers-scripts-read', name: 'Workers Scripts Read', scopes: [ACCOUNT_SCOPE] },
  { id: 'standin-pg-account-settings-read', name: 'Account Settings Read', scopes: [ACCOUNT_SCOPE] },
  { id: 'standin-pg-account-settings-write', name: 'Account Settings Write', scopes: [ACCOUNT_SCOPE] },
  { id: 'standin-pg-workers-kv-write', name: 'Workers KV Storage Write', scopes: [ACCOUNT_SCOPE] },
  { id: 'standin-pg-pages-write', name: 'Pages Write', scopes: [ACCOUNT_SCOPE] },
  { id: 'standin-pg-dns-write', name: 'DNS Write', scopes: [`${ACCOUNT_SCOPE}.zone`] },
  { id: 'standin-pg-zone-write', name: 'Zone Write', scopes: [`${ACCOUNT_SCOPE}.zone`] },
];
const groupNamed = (name) => GROUPS.find((g) => g.name === name);

// A policy for these group names on one account, as a token's record holds it.
function policyFor(accountId, names) {
  return {
    id: `standin-policy-${crypto.randomBytes(4).toString('hex')}`,
    effect: 'allow',
    resources: { [`${ACCOUNT_SCOPE}.${accountId}`]: '*' },
    permission_groups: names.map((n) => ({ id: groupNamed(n).id, name: n })),
  };
}

// ------------------------------------------------------------ the server

function serve(folder) {
  const read = () => JSON.parse(fs.readFileSync(path.join(folder, 'options.json'), 'utf8'));
  const first = read();
  const state = {
    accountId: first.accountId,
    subdomain: first.subdomain,
    tokens: (first.tokens || []).map((t) => ({ status: 'active', ...t })),
    sessions: {},
    completions: {},
    blobs: {},
    scripts: {},
  };
  const save = () => fs.writeFileSync(path.join(folder, 'state.json'), JSON.stringify(state, null, 2));
  const record = (entry) => fs.appendFileSync(path.join(folder, 'calls.jsonl'), JSON.stringify({ at: Date.now(), ...entry }) + '\n');
  save();

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const options = read();
      let answer;
      try {
        answer = route(state, options, req, body);
      } catch (e) {
        answer = { status: 500, json: envelope(false, null, [{ code: 10001, message: `stand-in fault: ${e.message}` }]) };
      }
      record({
        method: req.method,
        path: req.url,
        token: bearerOf(req),
        status: answer.status,
        refused: answer.status === 401 || answer.status === 403,
        offLoopback: answer.offLoopback || null,
        bodyShape: shapeOf(req, body),
        body: jsonBody(req, body),
      });
      save();
      res.writeHead(answer.status, { 'content-type': answer.type || 'application/json' });
      res.end(answer.text !== undefined ? answer.text : JSON.stringify(answer.json));
    });
  });
  // A proxied call to another host over https: recorded and refused.
  server.on('connect', (req, socket) => {
    record({ method: 'CONNECT', path: req.url, token: null, status: 403, refused: true, offLoopback: req.url, bodyShape: null, body: null });
    socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
  });
  server.listen(0, '127.0.0.1', () => {
    fs.writeFileSync(path.join(folder, 'port'), String(server.address().port));
  });
}

const envelope = (success, result, errors = []) => ({ success, errors, messages: [], result });
const ok = (result, status = 200) => ({ status, json: envelope(true, result) });
const refused = () => ({ status: 403, json: envelope(false, null, [{ code: 10000, message: 'Authentication error' }]) });
const invalid = () => ({ status: 401, json: envelope(false, null, [{ code: 1000, message: 'Invalid API Token' }]) });
const notFound = () => ({ status: 404, json: envelope(false, null, [{ code: 7003, message: 'Could not route to this path' }]) });
const fault = () => ({ status: 500, json: envelope(false, null, [{ code: 10013, message: 'An unknown error has occurred' }]) });

function bearerOf(req) {
  const m = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || '');
  return m ? m[1].trim() : null;
}

function jsonBody(req, body) {
  if (!/json/i.test(req.headers['content-type'] || '')) return null;
  try { return JSON.parse(body.toString('utf8')); } catch (e) { return null; }
}

function shapeOf(req, body) {
  const type = req.headers['content-type'] || '';
  if (/multipart\/form-data/i.test(type)) return { multipart: multipart(req, body).map((p) => p.name) };
  const parsed = jsonBody(req, body);
  if (parsed && typeof parsed === 'object') return { json: Object.keys(parsed).sort() };
  return body.length ? { bytes: body.length } : null;
}

// The parts of a multipart body: [{ name, filename, type, data }].
function multipart(req, body) {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(req.headers['content-type'] || '');
  if (!m) return [];
  const boundary = Buffer.from(`--${m[1] || m[2]}`);
  const parts = [];
  let at = body.indexOf(boundary);
  while (at !== -1) {
    const start = at + boundary.length;
    if (body.slice(start, start + 2).toString() === '--') break;
    const next = body.indexOf(boundary, start);
    if (next === -1) break;
    const chunk = body.slice(start + 2, next - 2);
    const split = chunk.indexOf('\r\n\r\n');
    const head = chunk.slice(0, split).toString('utf8');
    const data = chunk.slice(split + 4);
    const name = (/name="([^"]*)"/i.exec(head) || [])[1] || '';
    const filename = (/filename="([^"]*)"/i.exec(head) || [])[1] || null;
    const type = (/content-type:\s*([^\r\n]+)/i.exec(head) || [])[1] || null;
    parts.push({ name, filename, type, data });
    at = next;
  }
  return parts;
}

// The token a call carried, if the stand-in holds it and it is active.
function tokenOf(state, req) {
  const value = bearerOf(req);
  return state.tokens.find((t) => t.value === value && t.status === 'active') || null;
}

// True when the token holds one of these groups on this account (or on
// every account).
function holds(token, accountId, names) {
  return (token.policies || []).some((p) => p.effect === 'allow'
    && Object.keys(p.resources || {}).some((r) => r === `${ACCOUNT_SCOPE}.${accountId}` || r === `${ACCOUNT_SCOPE}.*`)
    && (p.permission_groups || []).some((g) => names.includes((GROUPS.find((x) => x.id === g.id) || {}).name)));
}

const publicToken = (t) => ({
  id: t.id, name: t.name, status: t.status, policies: t.policies,
  issued_on: t.issuedOn || '2026-01-01T00:00:00Z', expires_on: t.expiresOn || null, not_before: null,
});

function route(state, options, req, body) {
  // A call meant for another host, sent here as its proxy.
  if (/^https?:\/\//i.test(req.url)) return { ...refused(), offLoopback: req.url };
  const url = new URL(req.url, 'http://127.0.0.1');
  const parts = url.pathname.split('/').filter(Boolean);

  if (parts[0] === '__sites') return site(state, options, parts.slice(1));
  if (parts[0] !== 'client' || parts[1] !== 'v4') return notFound();
  const p = parts.slice(2);
  const fail = options.fail || {};

  // The assets upload is authorised by the upload session's jwt.
  if (p[0] === 'accounts' && p[2] === 'workers' && p[3] === 'assets' && p[4] === 'upload' && req.method === 'POST') {
    const session = state.sessions[bearerOf(req)];
    if (!session || p[1] !== state.accountId) return invalid();
    for (const part of multipart(req, body)) {
      const content = url.searchParams.get('base64') === 'true' ? Buffer.from(part.data.toString('utf8'), 'base64') : part.data;
      state.blobs[part.name] = content.toString('base64');
      session.uploaded[part.name] = true;
    }
    if (!Object.values(session.manifest).every((f) => session.uploaded[f.hash])) return ok({ jwt: null }, 202);
    const completion = `standin-complete-${crypto.randomBytes(12).toString('hex')}`;
    state.completions[completion] = { script: session.script, manifest: session.manifest };
    return ok({ jwt: completion }, 201);
  }

  const token = tokenOf(state, req);
  if (!token) return invalid();

  if (p[0] === 'user') return token.scope === 'user' ? notFound() : refused();
  if (p[0] === 'zones') return holdsZone(token) ? ok([]) : refused();
  if (p[0] !== 'accounts' || !p[1]) return refused();
  const account = p[1];
  if (account !== state.accountId) return refused();
  const rest = p.slice(2);

  if (rest.length === 0) return holds(token, account, ['Account Settings Read', 'Account Settings Write']) ? ok({ id: account, name: 'Stand-in Bakery (invented)' }) : refused();

  if (rest[0] === 'tokens') {
    if (rest[1] === 'verify' && req.method === 'GET') return ok({ id: token.id, status: token.status, not_before: null, expires_on: token.expiresOn || null });
    const reads = ['Account API Tokens Read', 'Account API Tokens Write'];
    if (rest[1] === 'permission_groups' && req.method === 'GET') return holds(token, account, reads) ? ok(GROUPS) : refused();
    if (rest.length === 1 && req.method === 'GET') return holds(token, account, reads) ? ok(state.tokens.filter((t) => t.status === 'active').map(publicToken)) : refused();
    if (rest.length === 1 && req.method === 'POST') {
      if (!holds(token, account, ['Account API Tokens Write'])) return refused();
      if (fail.createToken) return fault();
      const asked = jsonBody(req, body) || {};
      const made = {
        id: `standin-token-${crypto.randomBytes(8).toString('hex')}`,
        value: `standin-kept-${crypto.randomBytes(20).toString('hex')}`,
        name: String(asked.name || ''),
        status: 'active',
        scope: 'account',
        createdBy: token.id,
        policies: (Array.isArray(asked.policies) ? asked.policies : []).map((pol) => ({
          id: `standin-policy-${crypto.randomBytes(4).toString('hex')}`,
          effect: pol.effect,
          resources: pol.resources,
          permission_groups: (pol.permission_groups || []).map((g) => ({ id: g.id, name: (GROUPS.find((x) => x.id === g.id) || {}).name || null })),
        })),
      };
      widen(made, options.widen, account);
      state.tokens.push(made);
      return ok({ ...publicToken(made), value: made.value });
    }
    const target = state.tokens.find((t) => t.id === rest[1] && t.status === 'active');
    if (rest.length === 2 && req.method === 'GET') {
      if (!holds(token, account, reads)) return refused();
      if (fail.readToken) return fault();
      return target ? ok(publicToken(target)) : notFound();
    }
    if (rest.length === 2 && req.method === 'DELETE') {
      if (!holds(token, account, ['Account API Tokens Write'])) return refused();
      if (fail.deleteToken) return fault();
      if (!target) return notFound();
      target.status = 'deleted';
      return ok({ id: target.id });
    }
    return refused();
  }

  if (rest[0] === 'subscriptions') {
    if (req.method === 'GET') {
      if (!holds(token, account, ['Billing Read', 'Billing Write'])) return refused();
      if (fail.subscriptions) return fault();
      return ok(options.subscriptions || []);
    }
    return holds(token, account, ['Billing Write']) ? ok({}) : refused();
  }

  if (rest[0] === 'workers') {
    const writes = ['Workers Scripts Write'];
    if (rest[1] === 'subdomain' && req.method === 'GET') {
      if (!holds(token, account, ['Workers Scripts Read', 'Workers Scripts Write'])) return refused();
      if (fail.subdomain) return fault();
      return ok({ subdomain: state.subdomain });
    }
    if (rest[1] === 'scripts' && rest[2]) {
      if (!holds(token, account, writes)) return refused();
      const name = rest[2];
      if (rest[3] === 'assets-upload-session' && req.method === 'POST') {
        const manifest = (jsonBody(req, body) || {}).manifest;
        if (!manifest || typeof manifest !== 'object' || !Object.values(manifest).every((f) => f && /^[0-9a-f]{32}$/.test(String(f.hash)) && Number.isInteger(f.size))) {
          return { status: 400, json: envelope(false, null, [{ code: 10021, message: 'The manifest must name each file with a 32-hex hash and its size' }]) };
        }
        const jwt = `standin-upload-${crypto.randomBytes(12).toString('hex')}`;
        state.sessions[jwt] = { script: name, manifest, uploaded: {} };
        return ok({ jwt, buckets: [Object.values(manifest).map((f) => f.hash)] });
      }
      if (rest.length === 3 && req.method === 'PUT') {
        const meta = multipart(req, body).find((x) => x.name === 'metadata');
        let metadata = null;
        try { metadata = meta ? JSON.parse(meta.data.toString('utf8')) : null; } catch (e) { metadata = null; }
        const done = metadata && metadata.assets && state.completions[metadata.assets.jwt];
        if (!done || done.script !== name || !metadata.compatibility_date) {
          return { status: 400, json: envelope(false, null, [{ code: 10021, message: 'metadata must carry assets.jwt from a finished upload and a compatibility_date' }]) };
        }
        const files = {};
        for (const [file, f] of Object.entries(done.manifest)) files[file] = state.blobs[f.hash] || null;
        state.scripts[name] = { ...(state.scripts[name] || {}), files, uploadedAt: Date.now(), token: token.id };
        return ok({ id: name });
      }
      if (rest[3] === 'subdomain' && req.method === 'POST') {
        const asked = jsonBody(req, body) || {};
        if (!state.scripts[name]) return notFound();
        if (asked.enabled === true && !state.scripts[name].enabledAt) state.scripts[name].enabledAt = Date.now();
        return ok({ enabled: asked.enabled === true });
      }
      return refused();
    }
    return refused();
  }

  return refused();
}

function holdsZone(token) {
  return (token.policies || []).some((p) => Object.keys(p.resources || {}).some((r) => r.startsWith(`${ACCOUNT_SCOPE}.zone`)));
}

// A token made wider than it was asked for, as a case sets it: one more
// group, every account, or every zone as well.
function widen(made, how, accountId) {
  if (!how) return;
  if (how === 'extraGroup') made.policies.push(policyFor(accountId, ['Account Settings Write']));
  if (how === 'allAccounts') for (const p of made.policies) p.resources = { [`${ACCOUNT_SCOPE}.*`]: '*' };
  if (how === 'allZones') {
    made.policies.push({ ...policyFor(accountId, ['DNS Write']), resources: { [`${ACCOUNT_SCOPE}.zone.*`]: '*' } });
  }
}

// A site's address: 404 until its script is on workers.dev, 503 while its
// certificate is not ready, then its files.
function site(state, options, parts) {
  const host = parts[0] || '';
  const suffix = `.${state.subdomain}.workers.dev`;
  const name = host.endsWith(suffix) ? host.slice(0, -suffix.length) : null;
  const script = name ? state.scripts[name] : null;
  if (!script || !script.enabledAt) return { status: 404, type: 'text/plain', text: 'There is nothing here yet.\n' };
  const wait = options.certificateWaitMs === undefined ? 2000 : options.certificateWaitMs;
  if (Date.now() - script.enabledAt < wait) return { status: 503, type: 'text/plain', text: 'The certificate for this address is not ready yet.\n' };
  const file = `/${parts.slice(1).join('/')}`.replace(/\/$/, '/index.html');
  const content = script.files[file === '/' ? '/index.html' : file];
  if (!content) return { status: 404, type: 'text/plain', text: 'Not found.\n' };
  return { status: 200, type: 'text/html', text: Buffer.from(content, 'base64').toString('utf8') };
}

// ------------------------------------------------------------ for the cases

// Starts a stand-in for one case, in a folder of the world's, and stops it
// when the case ends. options: accountId, subdomain, tokens (each { id,
// value, name, policies }), subscriptions, certificateWaitMs, fail
// ({ createToken, readToken, deleteToken, subdomain, subscriptions }: answer
// 500; deleteToken, a token's removal, leaving the token on the account),
// widen ('extraGroup' | 'allAccounts' | 'allZones').
function startStandIn(t, world, options) {
  const folder = path.join(world.root, `cloudflare-stand-in-${crypto.randomBytes(3).toString('hex')}`);
  fs.mkdirSync(folder, { recursive: true });
  const optionsFile = path.join(folder, 'options.json');
  fs.writeFileSync(optionsFile, JSON.stringify(options));
  const child = spawn(process.execPath, [__filename, folder], { stdio: 'ignore' });
  const stop = () => { try { child.kill('SIGKILL'); } catch (e) { /* gone */ } };
  t.after(stop);
  const portFile = path.join(folder, 'port');
  const end = Date.now() + 10000;
  while (!fs.existsSync(portFile) && Date.now() < end) spawnSync('/bin/sleep', ['0.05']);
  if (!fs.existsSync(portFile)) throw new Error('the Cloudflare stand-in did not start');
  const port = Number(fs.readFileSync(portFile, 'utf8'));
  const origin = `http://127.0.0.1:${port}`;
  const calls = () => {
    const file = path.join(folder, 'calls.jsonl');
    return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  };
  return {
    folder,
    origin,
    api: `${origin}/client/v4`,
    sites: `${origin}/__sites/{name}.{subdomain}.workers.dev/`,
    // Every process of Squire's in a case sends any call to another host
    // here, where it is recorded and refused.
    proxyEnv: {
      HTTPS_PROXY: origin, https_proxy: origin, HTTP_PROXY: origin, http_proxy: origin, ALL_PROXY: origin, all_proxy: origin,
      NO_PROXY: '127.0.0.1,localhost,::1', no_proxy: '127.0.0.1,localhost,::1',
    },
    calls,
    offLoopback: () => calls().filter((c) => c.offLoopback),
    state: () => JSON.parse(fs.readFileSync(path.join(folder, 'state.json'), 'utf8')),
    set: (changes) => fs.writeFileSync(optionsFile, JSON.stringify({ ...JSON.parse(fs.readFileSync(optionsFile, 'utf8')), ...changes })),
    // One call straight to the stand-in, as the case makes it: the Mac's
    // own curl, to the loopback only.
    call: (method, apiPath, token, json) => {
      const args = ['-s', '-o', '-', '-w', '\n%{http_code}', '-X', method, '--noproxy', '*'];
      if (token) args.push('-H', `Authorization: Bearer ${token}`);
      if (json !== undefined) args.push('-H', 'Content-Type: application/json', '--data', JSON.stringify(json));
      args.push(apiPath.startsWith('/__sites') ? `${origin}${apiPath}` : `${origin}/client/v4${apiPath}`);
      const r = spawnSync('/usr/bin/curl', args, { encoding: 'utf8', timeout: 15000 });
      const out = r.stdout || '';
      const cut = out.lastIndexOf('\n');
      return { status: Number(out.slice(cut + 1)), body: out.slice(0, cut) };
    },
    stop,
  };
}

module.exports = { GROUPS, groupNamed, policyFor, startStandIn, ACCOUNT_SCOPE };

if (require.main === module) serve(process.argv[2]);
