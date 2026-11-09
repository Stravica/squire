'use strict';

// Code hygiene for the session runner, through its entry point: one runner at
// a time, and the 60-second rule (a server is replaced only on evidence, and
// a quiet, connected server never is). Bound to no criterion.
//
// The 60-second cases each wait out the rule's own minute, so they run side
// by side, each in its own world with its own stub of Claude Code: a server
// that prints the lines it is given at the times it is given, with a session
// process in its process group that ignores SIGTERM, as Claude Code's does.

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const w = require('../fixtures/squire-world.js');
const s = require('../fixtures/session-world.js');

function readLines(file) {
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
}

// A world with core laid down and a stub claude at ~/.local/bin/claude whose
// server prints `lines` ({ afterMs, line }) and records itself and its
// session process in servers.jsonl.
function stubWorld(t, lines) {
  const world = w.makeWorld();
  const servers = path.join(world.root, 'servers.jsonl');
  const kill = () => {
    for (const r of readLines(servers)) {
      for (const pid of [r.pid, r.session]) {
        try { process.kill(pid, 'SIGKILL'); } catch (e) { /* gone */ }
      }
    }
  };
  let runner = null;
  // The runner stops first, so nothing it writes races the world's removal.
  t.after(async () => { if (runner) await runner.stop(); kill(); w.cleanUp(world); });
  s.layDownCore(world);
  const bin = path.join(world.userHome, '.local', 'bin', 'claude');
  fs.mkdirSync(path.dirname(bin), { recursive: true });
  fs.writeFileSync(bin, `#!${process.execPath}
'use strict';
const fs = require('fs');
const { spawn } = require('child_process');
const argv = process.argv.slice(2);
if (argv[0] === 'auth') {
  process.stdout.write(JSON.stringify({ loggedIn: true }) + '\\n');
  process.exit(0);
}
if (argv[0] !== 'remote-control') process.exit(1);
const session = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);"], { stdio: 'ignore' });
fs.appendFileSync(${JSON.stringify(servers)}, JSON.stringify({ pid: process.pid, session: session.pid, at: Date.now() }) + '\\n');
for (const { afterMs, line } of ${JSON.stringify(lines)}) setTimeout(() => process.stdout.write(line + '\\n'), afterMs);
process.on('SIGTERM', () => process.exit(0));
setInterval(() => {}, 1000);
`, { mode: 0o755 });
  runner = s.startRunner(world);
  return { world, runner, servers: () => readLines(servers) };
}

async function firstServer(it) {
  const first = await s.waitFor(() => it.servers()[0] || it.runner.exited(), 20000);
  assert.ok(first && it.servers()[0], `the runner must start a server; output: ${it.runner.output().slice(-600) || '(none)'}`);
  return it.servers()[0];
}

const alive = (pid) => !w.processGone(pid);

test('a second runner on the same Squire home exits and starts nothing, while the first keeps its one session', { timeout: 60000 }, async (t) => {
  const world = w.makeWorld();
  const runners = [];
  t.after(async () => {
    for (const r of runners) await r.stop();
    s.killFakes(world);
    w.cleanUp(world);
  });
  s.layDownCore(world);
  const fake = s.installFakeClaudeCode(world);
  const first = s.startRunner(world);
  runners.push(first);
  assert.ok(await s.waitFor(() => fake.sessions()[0], 20000), `the first runner must start a session; output: ${first.output().slice(-600)}`);
  const second = s.startRunner(world);
  runners.push(second);
  const exited = await s.waitFor(() => second.exited(), 10000);
  assert.ok(exited, 'a second runner must exit');
  assert.notEqual(exited.status, 0, `a second runner must exit non-zero; got ${JSON.stringify(exited)}`);
  assert.equal(fake.serverCalls().length, 1, `only the first runner may start a server; servers: ${fake.serverCalls().length}`);
  assert.equal(first.exited(), null, 'the first runner must keep running');
  assert.ok(alive(fake.sessions()[0].pid), 'the first session must keep running');
});

describe('the 60-second rule', { concurrency: true }, () => {
  test('a server that shows Connected once and stays quiet past 60 seconds is never replaced', { timeout: 150000 }, async (t) => {
    const it = stubWorld(t, [{ afterMs: 200, line: 'Connected · owner' }]);
    const first = await firstServer(it);
    await new Promise((resolve) => setTimeout(resolve, 75000));
    assert.equal(it.servers().length, 1, `a quiet, connected server must not be replaced; servers: ${JSON.stringify(it.servers())}`);
    assert.ok(alive(first.pid) && alive(first.session), 'the quiet server and its session must still run');
    assert.equal(it.runner.exited(), null, 'the runner must keep running');
  });

  test('a server that shows Reconnected after a disconnection line counts as connected and is never replaced', { timeout: 150000 }, async (t) => {
    const it = stubWorld(t, [{ afterMs: 200, line: 'Connected · owner' }, { afterMs: 1500, line: 'Reconnecting… retrying in 5s' },
      { afterMs: 3000, line: 'Reconnected · owner' }]);
    const first = await firstServer(it);
    await new Promise((resolve) => setTimeout(resolve, 75000));
    assert.equal(it.servers().length, 1, `a reconnected server must not be replaced; servers: ${JSON.stringify(it.servers())}`);
    assert.ok(alive(first.pid) && alive(first.session), 'the reconnected server and its session must still run');
  });

  test('a disconnection line not followed by Connected within 60 seconds replaces the server: its whole process group gone and a new server up inside two minutes', { timeout: 150000 }, async (t) => {
    const it = stubWorld(t, [{ afterMs: 200, line: 'Connected · owner' }, { afterMs: 1500, line: 'Reconnecting… retrying in 5s' }]);
    const first = await firstServer(it);
    const second = await s.waitFor(() => it.servers()[1], 125000, 500);
    assert.ok(second, `a server disconnected for 60 seconds must be replaced within two minutes; output: ${it.runner.output().slice(-600)}`);
    assert.ok(second.at - first.at >= 60000, `the server must be given 60 seconds to reconnect; it was replaced after ${second.at - first.at} ms`);
    assert.ok(second.at - first.at <= 120000, `the new server must be up within two minutes; it took ${second.at - first.at} ms`);
    assert.ok(w.processGone(first.pid) && w.processGone(first.session), 'the replaced server\'s whole process group must be gone, its session process too');
  });

  test('a server that shows no Connected within 60 seconds of its start is replaced: its whole process group gone and a new server up inside two minutes', { timeout: 150000 }, async (t) => {
    const it = stubWorld(t, [{ afterMs: 200, line: 'Session started: "Session cse_stub" (cse_stub)' }]);
    const first = await firstServer(it);
    const second = await s.waitFor(() => it.servers()[1], 125000, 500);
    assert.ok(second, `a server never connected must be replaced within two minutes; output: ${it.runner.output().slice(-600)}`);
    assert.ok(second.at - first.at >= 60000, `the server must be given 60 seconds to connect; it was replaced after ${second.at - first.at} ms`);
    assert.ok(second.at - first.at <= 120000, `the new server must be up within two minutes; it took ${second.at - first.at} ms`);
    assert.ok(w.processGone(first.pid) && w.processGone(first.session), 'the replaced server\'s whole process group must be gone, its session process too');
  });
});
