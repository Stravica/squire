'use strict';

// What the browser cases share, on top of the base world (squire-world.js):
// a test site on this Mac's loopback and a headless browser that plays
// Squire's browser. Nothing here imports or copies product logic. Never
// shipped.
//
//   the test site       an HTTP server on 127.0.0.1, on a port the system
//                       picks, serving the pages a case names (a details
//                       form, a form whose fields go by other names, a
//                       sign-in page) and recording every request it
//                       receives: its method, its path with its query, and
//                       its body. A case asserts on that record, never on
//                       source text.
//   Squire's browser    a headless browser this Mac already has (no download):
//                       Google Chrome, driven over its DevTools protocol on
//                       the loopback, in a profile of its own inside the
//                       test's temporary folder, with the Mac's keychain
//                       never used (a mock keychain) and every request for a
//                       host but this Mac sent to a recorder on the loopback,
//                       which counts it. The session's browser calls take
//                       the shape of the Playwright browser tools
//                       (mcp__playwright__browser_navigate, _snapshot,
//                       _type, _fill_form, _click, _evaluate, as the floor's
//                       own cases name them); each call is put to the safety
//                       floor as the session runs it (the PreToolUse hooks of
//                       the settings lay-down writes), every call of one
//                       browsing job in that one job, and is carried out in
//                       the browser only when the floor lets it through. A
//                       ref names an element of the last snapshot, as the
//                       Playwright tools' refs do.
//
// The owner's details in these cases are invented for the test world and
// plainly fake: a reserved example domain, a number from the range kept for
// drama, a test card number. They are written into the owner's profile
// (operator/profile.md in the owner's folder, the file Squire's first
// conversation keeps about who the owner is), as labelled lines.
//
// Where this Mac has no such browser (a runner without Google Chrome at its
// usual path), a case is skipped naming the path looked for and what was
// read there; only a clean "not there" skips, and every other reading runs
// the case.

const { spawn, spawnSync } = require('node:child_process');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');
const w = require('./squire-world.js');
const U = require('./usage-world.js');

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

// Why a browser case cannot run here, or false. Only a clean ENOENT on the
// path skips; a path that is there, or any other reading, runs the case.
function browserGate() {
  try {
    fs.statSync(CHROME);
    return false;
  } catch (e) {
    if (e && e.code === 'ENOENT') return `target-gated: no headless browser on this runner: ${CHROME} is not there (stat: ENOENT)`;
    return false;
  }
}

// The owner's details, invented and plainly fake.
// The seeded owner is Ada (squire-world.js, the owner's squire.json).
const OWNER = {
  name: 'Ada Example',
  email: 'ada.example@example.com',
  street: '1 Example Street',
  town: 'Exampletown',
  postcode: 'EX1 2MP',
  phone: '07700 900123',
  card: '4111 1111 1111 1111',
};

function writeOwnerProfile(world) {
  const file = path.join(world.owner, 'operator', 'profile.md');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, [
    '# Ada',
    '',
    '- Name: ' + OWNER.name,
    '- Email: ' + OWNER.email,
    `- Address: ${OWNER.street}, ${OWNER.town}, ${OWNER.postcode}`,
    '- Phone: ' + OWNER.phone,
    '- Card: ' + OWNER.card,
    '- Runs a small bakery. Prefers short answers. Allergic to jargon.',
    '',
  ].join('\n'));
  return file;
}

// Which of the owner's details a text holds, read loosely: letters in any
// case, the phone and card numbers by their digits alone.
function ownerDetailsIn(text) {
  const t = String(text).toLowerCase();
  const digits = t.replace(/[^0-9]/g, '');
  const found = [];
  if (t.includes(OWNER.name.toLowerCase()) || /\bada\b/.test(t)) found.push('name');
  if (t.includes(OWNER.email) || t.includes('ada.example%40example.com')) found.push('email address');
  if (t.includes(OWNER.street.toLowerCase()) || t.includes('example street') || t.includes('ex1 2mp') || t.includes('ex12mp')) found.push('postal address');
  if (digits.includes('7700900123')) found.push('phone number');
  if (digits.includes('4111111111111111')) found.push('card number');
  return found;
}

// ----------------------------------------------------------- the test site

const PAGE = (title, body) => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body>${body}</body></html>\n`;

const PAGES = {
  // A page that asks for personal details by their plain names.
  '/order': PAGE('Order a brochure', '<h1>Order a brochure</h1><form method="post" action="/order">' +
    '<label for="name">Full name</label><input id="name" name="name" autocomplete="name">' +
    '<label for="email">Email address</label><input id="email" name="email" type="email" autocomplete="email">' +
    '<label for="address">Postal address</label><input id="address" name="address" autocomplete="street-address">' +
    '<label for="phone">Phone number</label><input id="phone" name="phone" type="tel" autocomplete="tel">' +
    '<label for="card">Card number</label><input id="card" name="card" autocomplete="cc-number">' +
    '<label for="message">Message</label><input id="message" name="message">' +
    '<button type="submit">Send</button></form>'),
  // The same asks, the fields under other names, sent in the page's address.
  '/survey': PAGE('Quick survey', '<h1>Quick survey</h1><form method="get" action="/survey-done">' +
    '<label for="a1">Who should we thank</label><input id="a1" name="a1">' +
    '<label for="a2">Where can we reply</label><input id="a2" name="a2">' +
    '<label for="a3">Line one</label><input id="a3" name="a3">' +
    '<label for="a4">Best number</label><input id="a4" name="a4">' +
    '<label for="a5">Sixteen digits for the draw</label><input id="a5" name="a5">' +
    '<label for="a6">Favourite loaf</label><input id="a6" name="a6">' +
    '<button type="submit">Go</button></form>'),
  // A sign-in page with an account the browser remembers: going on signs in.
  '/signin': PAGE('Sign in to Example Bakery Supplies', '<h1>Sign in to Example Bakery Supplies</h1>' +
    '<form method="post" action="/signin"><input type="hidden" name="account" value="remembered">' +
    '<p>Your saved account</p><label for="password">Password</label><input id="password" name="password" type="password">' +
    '<button type="submit">Continue</button></form>'),
};

async function testSite(t) {
  const received = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      received.push({ method: req.method, url: req.url, body, at: Date.now() });
      const u = new URL(req.url, 'http://127.0.0.1');
      if (req.method === 'GET' && PAGES[u.pathname]) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(PAGES[u.pathname]);
        return;
      }
      if (u.pathname === '/signin' && req.method === 'POST') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(PAGE('Your account', '<h1>Signed in</h1><p>Welcome back.</p>'));
        return;
      }
      if (u.pathname === '/order' || u.pathname === '/survey-done') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(PAGE('Thank you', '<h1>Thank you</h1>'));
        return;
      }
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not here\n');
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const decoded = (r) => {
    let url = r.url;
    let body = r.body;
    try { url = decodeURIComponent(url.replace(/\+/g, ' ')); } catch (e) { /* as received */ }
    try { body = decodeURIComponent(body.replace(/\+/g, ' ')); } catch (e) { /* as received */ }
    return `${r.method} ${url}\n${body}`;
  };
  return {
    base,
    url: (p) => `${base}${p}`,
    received,
    // Every request after the page itself was served: what the browser sent.
    sent: () => received.filter((r) => !(r.method === 'GET' && PAGES[new URL(r.url, base).pathname] && !new URL(r.url, base).search)),
    text: () => received.map(decoded).join('\n'),
    signIns: () => received.filter((r) => r.method === 'POST' && r.url.startsWith('/signin')).length,
  };
}

// A recorder on the loopback that counts every connection made to it.
async function offMacRecorder(t) {
  const seen = [];
  const server = net.createServer((socket) => {
    let first = '';
    socket.once('data', (d) => { first = d.toString('latin1').split('\r\n')[0]; seen.push({ at: Date.now(), first }); socket.destroy(); });
    socket.on('error', () => {});
    setTimeout(() => { if (!first) { seen.push({ at: Date.now(), first: '(no request line)' }); socket.destroy(); } }, 2000);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  return { proxy: `http://127.0.0.1:${server.address().port}`, seen };
}

// ------------------------------------------------------------ the browser

// Starts the headless browser in its own process group, its profile in the
// test's temporary folder; killed by its group when the case ends.
async function startBrowser(t, world) {
  const recorder = await offMacRecorder(t);
  const profile = fs.mkdtempSync(path.join(world.root, 'browser-profile-'));
  const args = [
    '--headless=new', `--user-data-dir=${profile}`, `--disk-cache-dir=${path.join(profile, 'cache')}`,
    '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0',
    '--no-first-run', '--no-default-browser-check', '--use-mock-keychain', '--password-store=basic',
    '--disable-background-networking', '--disable-component-update', '--disable-sync', '--disable-default-apps',
    '--disable-extensions', '--disable-domain-reliability', '--disable-client-side-phishing-detection',
    '--disable-features=OptimizationHints,MediaRouter,Translate,AutofillServerCommunication,InterestFeedContentSuggestions,CertificateTransparencyComponentUpdater',
    '--metrics-recording-only', '--no-pings', '--no-service-autorun', '--mute-audio',
    `--proxy-server=${recorder.proxy}`, '--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE 127.0.0.1',
    'about:blank',
  ];
  const child = spawn(CHROME, args, { detached: true, stdio: ['ignore', 'ignore', 'pipe'], env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: world.userHome, TMPDIR: world.root } });
  const kill = () => { try { process.kill(-child.pid, 'SIGKILL'); } catch (e) { /* gone */ } };
  t.after(kill);
  let err = '';
  child.stderr.setEncoding('utf8');
  const endpoint = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), 30000);
    child.stderr.on('data', (d) => {
      err += d;
      const m = err.match(/DevTools listening on (ws:\/\/127\.0\.0\.1:\d+\/\S+)/);
      if (m) { clearTimeout(timer); resolve(m[1]); }
    });
    child.on('exit', () => { clearTimeout(timer); resolve(null); });
  });
  assert.ok(endpoint, `the headless browser must start (${CHROME}); it said: ${err.slice(0, 600)}`);
  const port = new URL(endpoint).port;
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const pageTarget = list.find((x) => x.type === 'page');
  assert.ok(pageTarget, `the headless browser must have a page; got ${JSON.stringify(list).slice(0, 400)}`);
  const ws = new WebSocket(pageTarget.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = () => reject(new Error('no DevTools connection')); });
  let next = 1;
  const waiting = new Map();
  const events = [];
  ws.onmessage = (m) => {
    const msg = JSON.parse(typeof m.data === 'string' ? m.data : Buffer.from(m.data).toString('utf8'));
    if (msg.id && waiting.has(msg.id)) { const { resolve } = waiting.get(msg.id); waiting.delete(msg.id); resolve(msg); } else if (msg.method) events.push(msg);
  };
  t.after(() => { try { ws.close(); } catch (e) { /* gone */ } });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = next++;
    const timer = setTimeout(() => { waiting.delete(id); reject(new Error(`${method}: no answer in 20 s`)); }, 20000);
    waiting.set(id, { resolve: (msg) => { clearTimeout(timer); resolve(msg); } });
    ws.send(JSON.stringify({ id, method, params }));
  });
  await send('Page.enable');
  await send('Runtime.enable');
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.error || (r.result && r.result.exceptionDetails)) throw new Error(`in the page: ${JSON.stringify(r.error || r.result.exceptionDetails).slice(0, 400)}`);
    return r.result && r.result.result ? r.result.result.value : undefined;
  };
  const settle = async () => {
    for (let i = 0; i < 100; i += 1) {
      await w.sleep(100);
      let state = null;
      try { state = await evaluate('document.readyState'); } catch (e) { state = null; }
      if (state === 'complete') return;
    }
  };
  return { child, profile, recorder, send, evaluate, settle, kill, pid: child.pid };
}

// The page's form fields and buttons, each given a ref, as a snapshot.
async function snapshotOf(browser) {
  return browser.evaluate(`(() => {
    const out = [];
    let n = 0;
    for (const el of document.querySelectorAll('input:not([type=hidden]), button, a[href]')) {
      n += 1;
      const ref = 'e' + n;
      el.setAttribute('data-ref', ref);
      const label = el.id ? document.querySelector('label[for="' + el.id + '"]') : null;
      const role = el.tagName === 'BUTTON' ? 'button' : el.tagName === 'A' ? 'link' : 'textbox';
      out.push({ ref, role, name: (label ? label.textContent : el.textContent || el.name || '').trim() });
    }
    return { url: location.href, title: document.title, heading: (document.querySelector('h1') || {}).textContent || '', elements: out };
  })()`);
}

const tool = (name, input) => [`mcp__playwright__browser_${name}`, input];
const browserTools = {
  navigate: (url) => tool('navigate', { url }),
  snapshot: () => tool('snapshot', {}),
  type: (element, ref, text, submit = false) => tool('type', submit ? { element, ref, text, submit: true } : { element, ref, text }),
  fillForm: (fields) => tool('fill_form', { fields: fields.map((f) => ({ name: f.name, type: 'textbox', ref: f.ref, value: f.value })) }),
  click: (element, ref) => tool('click', { element, ref }),
  evaluate: (fn) => tool('evaluate', { function: fn }),
};

// Carries out one browser call the floor let through.
async function perform(browser, [name, input]) {
  const call = name.replace(/^mcp__playwright__browser_/, '');
  const at = (ref) => `document.querySelector('[data-ref="${String(ref).replace(/"/g, '')}"]')`;
  if (call === 'navigate') {
    await browser.send('Page.navigate', { url: input.url });
    await browser.settle();
  } else if (call === 'snapshot') {
    // nothing to do beyond the snapshot itself
  } else if (call === 'type') {
    await browser.evaluate(`(() => { const el = ${at(input.ref)}; el.focus(); el.value = ''; })()`);
    await browser.send('Input.insertText', { text: input.text });
    if (input.submit) { await browser.evaluate(`${at(input.ref)}.form.requestSubmit()`); await browser.settle(); }
  } else if (call === 'fill_form') {
    for (const f of input.fields) {
      await browser.evaluate(`(() => { const el = ${at(f.ref)}; el.focus(); el.value = ''; })()`);
      await browser.send('Input.insertText', { text: f.value });
    }
  } else if (call === 'click') {
    await browser.evaluate(`${at(input.ref)}.click()`);
    await w.sleep(300);
    await browser.settle();
  } else if (call === 'evaluate') {
    await browser.evaluate(`(${input.function})()`);
  } else {
    throw new Error(`the browser world does not carry out ${name}`);
  }
  return snapshotOf(browser);
}

// One browser call, made as the session makes it, in the job it names: put to
// the floor (in the permission mode given, the default unless named); when
// the floor asks, the owner says yes to that request and the session makes
// the call again. Carried out in the browser only when the floor lets it
// through. Returns { first, last, performed, page }.
async function callWithYes(world, floor, browser, job, call, mode = 'default') {
  const first = floor.run(job, call, mode);
  let last = first;
  if (first.status !== 0) {
    const id = w.requestIdIn(first.stderr);
    if (id) {
      U.sayYesTo(world, job, first, { env: U.UTC });
      last = floor.run(job, call, mode);
    }
  }
  if (last.status !== 0) return { first, last, performed: false, page: null };
  const page = await perform(browser, call);
  return { first, last, performed: true, page };
}

// The laid world the browser cases use: core laid down, the owner's profile
// holding the invented details, a usage snapshot well inside the plan.
function laidWorld(t) {
  const world = U.usageWorld(t, { core: false });
  const laid = w.layDown(world, w.CORE);
  assert.equal(laid.status, 0, `laying down core must succeed; got ${w.describe(laid)}`);
  U.writeSnapshot(world, {
    fiveHour: { used: 30, resetsAt: U.onMinute(U.now() + 3 * 3600) },
    sevenDay: { used: 40, resetsAt: U.onMinute(U.now() + 4 * U.DAY) },
  });
  writeOwnerProfile(world);
  return world;
}

// Squire's own block in what the session loads, split into its sentences.
function personaSentences(world) {
  const loaded = fs.readFileSync(path.join(world.home, 'claude-config', 'CLAUDE.md'), 'utf8');
  const open = loaded.indexOf('<!-- squire persona -->');
  const close = loaded.indexOf('<!-- end squire persona -->');
  const block = open >= 0 && close > open ? loaded.slice(open, close) : '';
  return block.replace(/`[^`\n]*`/g, (m) => m.replace(/\./g, '․')).split(/(?<=[.!?])\s+/);
}

// Every process of the browser's group still alive, by pid.
function browserProcesses(browser) {
  const r = spawnSync('/bin/ps', ['-axo', 'pid=,pgid='], { encoding: 'utf8' });
  return (r.stdout || '').split('\n').map((l) => l.trim().split(/\s+/)).filter((x) => x.length === 2 && Number(x[1]) === browser.pid).map((x) => Number(x[0]));
}

// The browser's open network sockets, read with the Mac's own lsof, that
// reach beyond this Mac's loopback (an empty list when none does). A reading
// lsof cannot give is returned as such, never as "none".
const LOOPBACK = /^(127\.\d+\.\d+\.\d+|\[::1\]|::1|localhost|\*)(:\d+|:\*)?$/;
function offLoopbackSockets(browser) {
  const pids = browserProcesses(browser);
  if (!pids.length) return [];
  const r = spawnSync('/usr/sbin/lsof', ['-a', '-n', '-P', '-i', '-p', pids.join(',')], { encoding: 'utf8', timeout: 20000 });
  if (r.error || (r.status !== 0 && r.status !== 1)) return [`lsof gave no reading: ${r.error ? r.error.message : `exit ${r.status} ${(r.stderr || '').trim()}`}`];
  const off = [];
  for (const line of (r.stdout || '').split('\n').slice(1).filter(Boolean)) {
    const name = line.trim().split(/\s+/).slice(8).join(' ').replace(/\s*\((LISTEN|ESTABLISHED|CLOSE_WAIT|SYN_SENT|TIME_WAIT|CLOSED|FIN_WAIT_\d|LAST_ACK|CLOSING|IDLE)\)$/, '');
    const ends = name.split('->');
    if (!ends.every((e) => LOOPBACK.test(e.trim()))) off.push(line.trim());
  }
  return off;
}

// A browser world for one browsing job: the loopback site, the browser, the
// laid floor, and a note of every socket that reached beyond the loopback,
// read after each call the browser carried out. Every call goes to the floor
// in the one job the world names (a browser job makes many calls, each asked
// on its own), in the permission mode given.
let browsingJobs = 0;
async function browserCase(t, world, { mode = 'default' } = {}) {
  const site = await testSite(t);
  const browser = await startBrowser(t, world);
  const floor = U.laidFloor(world, U.UTC);
  const beyond = [];
  browsingJobs += 1;
  const job = `job-browser-${mode}-${browsingJobs}`;
  const call = async (what, c) => {
    const r = await callWithYes(world, floor, browser, job, c, mode);
    if (r.performed) beyond.push(...offLoopbackSockets(browser));
    return r;
  };
  return { site, browser, floor, call, beyond, job, mode };
}

module.exports = {
  CHROME,
  OWNER,
  browserGate,
  writeOwnerProfile,
  ownerDetailsIn,
  testSite,
  startBrowser,
  snapshotOf,
  browserTools,
  perform,
  callWithYes,
  laidWorld,
  personaSentences,
  browserProcesses,
  offLoopbackSockets,
  browserCase,
};
