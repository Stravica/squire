'use strict';

// Approved deep research ends with a result the owner can see, and a network
// or time-out failure is explained with the work so far kept so the job can
// resume (AC-1302-2, its research half; the app half is a later spec's).
// Research is the session's own work: the model reads and writes, through
// tools the safety floor judges. What code decides is bound here, through the
// real entry points: lay-down (what the session loads, Squire's own block),
// the safety floor as the session runs it (the PreToolUse hooks of the
// settings lay-down writes, the event on stdin, in the default mode and in
// auto mode), and the page server by a real request on this Mac.
//
// What the builder provides (none of it at the base head; a case fails at its
// own first assertion while it is absent):
//   Squire's own block in what the session loads tells the session, for a
//   deep research job the owner said yes to:
//     - to keep its work as it goes in workspace/research in the owner's
//       folder (its notes and sources, one folder per job);
//     - to end it with the result as a page in workspace/pages and give the
//       owner its link from the link command (page-server.py --where), run
//       at that moment;
//     - when the network fails or a step times out, to tell the owner in
//       plain words what happened and that the work so far is kept, and to
//       pick up from what workspace/research holds when the owner asks to
//       resume; a resumed job is a new start, which the floor asks for again.
//   The floor lets the session keep its notes and write the result page in
//   the owner's folder within the job the owner said yes to, and the page
//   server serves the page under the link and lists it on the dashboard.
//
// Usage model (assumptions, none measured): typical, one question, a few
// searches and fetches, one page; heavy, a job that fails part-way and is
// resumed once, which needs the owner's yes again (a yes covers one start).
//
// The class is open (any research question, any failure on the way); these
// are instances. No case reaches a model, the network beyond this Mac's
// loopback or any host but this Mac.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const w = require('../fixtures/squire-world.js');
const U = require('../fixtures/usage-world.js');

const MODES = ['default', 'auto'];

function laidWorld(t) {
  const world = U.usageWorld(t, { core: false });
  const laid = w.layDown(world, w.CORE);
  assert.equal(laid.status, 0, `laying down core must succeed; got ${w.describe(laid)}`);
  U.writeSnapshot(world, {
    fiveHour: { used: 30, resetsAt: U.onMinute(U.now() + 3 * 3600) },
    sevenDay: { used: 40, resetsAt: U.onMinute(U.now() + 4 * U.DAY) },
  });
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

// The owner's yes to a big research job, through the laid floor.
function startResearch(world, floor, job, mode) {
  const first = floor.run(job, U.heavyJob(world, 'research'), mode);
  w.assertBlocked(first, `deep research, in ${mode} mode, with no yes`);
  assert.match(first.stderr, /deep research/i, `the floor warns of deep research as a big job, in ${mode} mode; got ${w.describe(first)}`);
  U.sayYesTo(world, job, first, { env: U.UTC });
  w.assertAllowed(floor.run(job, U.heavyJob(world, 'research'), mode), `deep research, in ${mode} mode, once the owner said yes`);
}

function startServer(t, world) {
  const child = spawn(w.PYTHON, [path.join(world.home, 'core', 'tools', 'page-server.py'), '--port', '0'], {
    cwd: world.home, env: w.productEnv(world), stdio: ['ignore', 'pipe', 'pipe'], detached: true,
  });
  t.after(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch (e) { /* gone */ } });
  let out = '';
  child.stdout.setEncoding('utf8');
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), 10000);
    child.stdout.on('data', (d) => { out += d; if (out.includes('\n')) { clearTimeout(timer); resolve(out.split('\n')[0]); } });
    child.on('exit', () => { clearTimeout(timer); resolve(null); });
  });
}

// A GET from this Mac to the page server, following the link as a browser
// would: the link's own query kept, and any cookie it set sent back.
function get(url, cookies = []) {
  return new Promise((resolve) => {
    const u = new URL(url);
    const req = http.request({ host: u.hostname.replace(/^\[|\]$/g, ''), port: u.port, path: `${u.pathname}${u.search}`, method: 'GET',
      headers: cookies.length ? { cookie: cookies.join('; ') } : {}, timeout: 5000 }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('timeout', () => req.destroy(new Error('no answer in 5 s')));
    req.on('error', (e) => resolve({ status: 0, headers: {}, body: '', error: String(e.message) }));
    req.end();
  });
}
const cookiesOf = (r) => [].concat(r.headers['set-cookie'] || []).map((c) => c.split(';')[0]);
function at(link, rel) {
  const u = new URL(rel, link);
  const l = new URL(link);
  if (!u.search && l.search) u.search = l.search;
  return u.toString();
}

test("approved deep research ends with its result as a page the owner can see: what the session loads says to keep the work in workspace/research and end with a page and its link, the floor lets the job do both on the owner's yes, and the page server serves the page under the link and lists it on the dashboard", { timeout: 180000 }, async (t) => {
  const world = laidWorld(t);
  const sentences = personaSentences(world);
  const ends = sentences.filter((x) => /research/i.test(x) && /workspace\/pages|a page/i.test(x) && /link/i.test(x));
  assert.ok(ends.length > 0, `Squire's own block must tell the session that a deep research job the owner said yes to ends with its result as a page in workspace/pages and its link; got ${JSON.stringify(sentences.filter((x) => /research/i.test(x)))}`);
  const keeps = sentences.filter((x) => /research/i.test(x) && /workspace\/research/.test(x));
  assert.ok(keeps.length > 0, `Squire's own block must tell the session to keep a research job's work as it goes in workspace/research; got ${JSON.stringify(sentences.filter((x) => /research/i.test(x)))}`);

  const floor = U.laidFloor(world, U.UTC);
  const page = path.join(world.owner, 'workspace', 'pages', 'research-three-ovens.html');
  const html = '<!doctype html><html><head><title>Three ovens compared</title><link rel="stylesheet" href="/squire/style.css"></head>' +
    '<body><h1>Three ovens compared</h1><p>The deck oven wins on price per loaf.</p></body></html>\n';
  for (const mode of MODES) {
    const job = `job-research-${mode}`;
    startResearch(world, floor, job, mode);
    w.assertAllowed(floor.run(job, w.tools.webSearch('deck oven against rack oven for a small bakery'), mode), `a search in the research job, in ${mode} mode`);
    const notes = path.join(world.owner, 'workspace', 'research', `three-ovens-${mode}`, 'notes.md');
    w.assertAllowed(floor.run(job, w.tools.write(notes, '# Three ovens\n\n- deck oven: 14 loaves a tray\n'), mode), `the job's notes kept in workspace/research, in ${mode} mode`);
    w.assertAllowed(floor.run(job, w.tools.write(page, html), mode), `the result written as a page in workspace/pages, in ${mode} mode`);
  }
  fs.mkdirSync(path.dirname(page), { recursive: true });
  fs.writeFileSync(page, html);

  const first = await startServer(t, world);
  assert.ok(first, 'the page server must start');
  const where = w.runPython(world, path.join(world.home, 'core', 'tools', 'page-server.py'), ['--where'], { cwd: world.home, timeout: 15000 });
  assert.equal(where.status, 0, `the link command must give the link; got ${w.describe(where)}`);
  const link = where.stdout.trim();
  const dashboard = await get(link);
  assert.equal(dashboard.status, 200, `the dashboard must be served under the link; got ${dashboard.status} ${dashboard.body.slice(0, 200)}`);
  assert.match(dashboard.body, /Three ovens compared/, 'the dashboard must list the research result');
  const shown = await get(at(link, 'pages/research-three-ovens.html'), cookiesOf(dashboard));
  assert.equal(shown.status, 200, `the research result must be served as a page under the link; got ${shown.status} ${shown.body.slice(0, 200)}`);
  assert.match(shown.body, /deck oven wins/, 'the page shows the result');
});

test("when the network fails or a step times out, what the session loads says to tell the owner plainly what happened, that the work so far is kept, and to pick up from workspace/research to resume; the kept work stays, and a resumed job is a new start the floor asks the owner for again", { timeout: 180000 }, (t) => {
  const world = laidWorld(t);
  const sentences = personaSentences(world);
  const failing = sentences.filter((x) => /network|connection/i.test(x) && /time(s|d)? out|timed out|time-out/i.test(x));
  assert.ok(failing.length > 0, `Squire's own block must tell the session what to do when the network fails or a step times out in a research job; got ${JSON.stringify(sentences.filter((x) => /research/i.test(x)))}`);
  assert.ok(failing.some((x) => /kept|keep/i.test(x) && /plain/i.test(x)), `it must say to tell the owner in plain words what happened and that the work so far is kept; got ${JSON.stringify(failing)}`);
  assert.ok(sentences.some((x) => /resume|pick up/i.test(x) && /workspace\/research/.test(x)), `it must say to pick up from what workspace/research holds when the owner asks to resume; got ${JSON.stringify(sentences.filter((x) => /resume|pick up/i.test(x)))}`);

  const floor = U.laidFloor(world, U.UTC);
  for (const mode of MODES) {
    const job = `job-research-failing-${mode}`;
    startResearch(world, floor, job, mode);
    const notes = path.join(world.owner, 'workspace', 'research', `flour-prices-${mode}`, 'notes.md');
    w.assertAllowed(floor.run(job, w.tools.write(notes, '# Flour prices\n\n- mill A: 25 kg at 18 pounds\n'), mode), `the work so far kept in workspace/research, in ${mode} mode`);
    w.assertAllowed(floor.run(job, w.tools.read(notes), mode), `the kept work read back to resume, in ${mode} mode`);
    w.assertBlocked(floor.run(job, U.heavyJob(world, 'research'), mode), `resuming the research job, in ${mode} mode, is a new start: the floor asks again`);
  }
});
