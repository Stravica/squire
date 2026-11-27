'use strict';

// One Squire session stays running whatever words Claude Code's Remote
// Control server prints: the runner judges a server live by evidence (its
// process alive, and a bridge pointer written after its start naming its
// pid, or a session record written since its start; a connected word is a
// fast path only), and replaces a server only when its process dies, when 60
// seconds after its start it has shown none of that evidence, or when a
// disconnection line is not followed by a connected word within 60 seconds.
//
// Every case runs the installed runner (<Squire home>/core/tools/runner.py)
// as its launchd agent does, with the world's fake Claude Code under both
// measured profiles (tests/fixtures/session-world.js): 2.1.319, whose server
// makes its session at start and prints Connected, and 2.1.332, whose server
// prints Ready and an environment address, writes a bridge pointer naming
// its own pid with an empty sessionId, and makes its session only when a
// client sends a first message at that address. Cases under both profiles
// run their worlds side by side, the 2.1.332 one first.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const w = require('../fixtures/squire-world.js');
const s = require('../fixtures/session-world.js');

const STOPPED = "no session: Claude Code's Remote Control server stopped before any session";

function liveWorld(t, behaviour) {
  const world = w.makeWorld();
  t.after(() => { s.killFakes(world); w.cleanUp(world); });
  s.layDownCore(world);
  const fake = s.installFakeClaudeCode(world, { signedIn: true, ...behaviour });
  const runner = s.startRunner(world);
  t.after(() => runner.stop());
  return { world, fake, runner, behaviour };
}

async function firstServer(x, what) {
  await s.waitFor(() => x.fake.serverCalls()[0] || x.runner.exited(), 20000);
  const call = x.fake.serverCalls()[0];
  assert.ok(call, `${what}: the runner must start one Remote Control server within 20 seconds; runner ${x.runner.exited() ? `exited ${JSON.stringify(x.runner.exited())}` : 'still running'}; output: ${x.runner.output().slice(-600) || '(none)'}`);
  return call;
}

const describeServers = (x) => JSON.stringify(x.fake.serverCalls().map((c) => ({ pid: c.pid, at: c.at })));

test('a Remote Control server that prints Ready and an environment address, with a bridge pointer naming its own process and no session yet, is judged live and kept: the runner does not replace it over 75 seconds, nor a 2.1.332 server whose client made the session and then left, which prints nothing, and the eager server that prints Connected is kept too', { timeout: 240000 }, async (t) => {
  const lazy = liveWorld(t, { profile: '2.1.332' });
  const left = liveWorld(t, { profile: '2.1.332' });
  const eager = liveWorld(t, { profile: '2.1.319' });
  const lazyServer = await firstServer(lazy, 'the 2.1.332 server');
  const leftServer = await firstServer(left, 'the 2.1.332 server whose client leaves');
  const eagerServer = await firstServer(eager, 'the 2.1.319 server');
  const pointer = await s.waitFor(() => s.bridgePointers(lazy.world).find((p) => p.pid === lazyServer.pid), 10000);
  assert.ok(pointer, `the 2.1.332 server must write a bridge pointer naming its own pid (the world's profile); pointers: ${JSON.stringify(s.bridgePointers(lazy.world))}`);
  assert.equal(pointer.sessionId, '', 'the 2.1.332 profile\'s pointer names no session');
  // The client makes the session, then leaves: measured on 2.1.332, the
  // server prints nothing when a client leaves and the session stays.
  await s.waitFor(() => s.environmentOf(left.world), 10000);
  s.clientConnects(left.world);
  assert.ok(await s.waitFor(() => s.sessionRecords(left.world)[0], 15000), `the client's first message must make the session; session.log: ${JSON.stringify(s.sessionLog(left.world).slice(-400))}`);
  await s.sleep(2000);
  s.clientLeaves(left.world);
  await s.sleep(75000);
  assert.equal(left.fake.serverCalls().length, 1, `a 2.1.332 server whose client left must be kept: one server over 75 seconds; servers started: ${describeServers(left)}`);
  assert.ok(!w.processGone(leftServer.pid), 'the 2.1.332 server whose client left must still be running');
  assert.deepEqual(s.sessionRecords(lazy.world), [], 'no client connected, so the 2.1.332 server has made no session');
  assert.equal(lazy.fake.serverCalls().length, 1,
    `a live 2.1.332 server (Ready, an environment address, a bridge pointer naming its pid, no session) must never be replaced for its wording: one server over 75 seconds; servers started: ${describeServers(lazy)}; ` +
    `session.log: ${JSON.stringify(s.sessionLog(lazy.world).slice(-600))}`);
  assert.ok(!w.processGone(lazyServer.pid), 'the live 2.1.332 server must still be running after 75 seconds');
  assert.equal(eager.fake.serverCalls().length, 1, `a connected 2.1.319 server must be kept: one server over 75 seconds; servers started: ${describeServers(eager)}`);
  assert.ok(!w.processGone(eagerServer.pid), 'the connected 2.1.319 server must still be running after 75 seconds');
});

test('a server that has shown, 60 seconds after its start, no bridge pointer naming its own process, no session record and no connected word is replaced, under both profiles, and a pointer an earlier server left does not keep it', { timeout: 240000 }, async (t) => {
  const noPointer = liveWorld(t, { profile: '2.1.332', pointer: false });
  // A pointer left by an earlier server, naming a process that is gone.
  const stale = w.makeWorld();
  t.after(() => { s.killFakes(stale); w.cleanUp(stale); });
  s.layDownCore(stale);
  const staleFake = s.installFakeClaudeCode(stale, { signedIn: true, profile: '2.1.332', pointer: false });
  const leftDir = path.join(s.configDir(stale), 'projects', fs.realpathSync(stale.owner).replace(/[^A-Za-z0-9]/g, '-'));
  fs.mkdirSync(leftDir, { recursive: true });
  fs.writeFileSync(path.join(leftDir, 'bridge-pointer.json'), JSON.stringify({ sessionId: '', environmentId: 'env_FAKEOLDERSERVER', source: 'standalone', pid: s.deadPid(), procStart: '', dir: stale.owner }));
  const staleRunner = s.startRunner(stale);
  t.after(() => staleRunner.stop());
  const staleWorld = { world: stale, fake: staleFake, runner: staleRunner };
  const silent = liveWorld(t, { profile: '2.1.319', neverConnects: true });
  const worlds = [['a 2.1.332 server with no bridge pointer', noPointer], ['a 2.1.332 server beside a pointer an earlier server left', staleWorld],
    ['a 2.1.319 server that never prints a connected word', silent]];
  for (const [what, x] of worlds) await firstServer(x, what);
  await s.waitFor(() => worlds.every(([, x]) => x.fake.serverCalls().length >= 2), 100000, 500);
  for (const [what, x] of worlds) {
    const calls = x.fake.serverCalls();
    assert.ok(calls.length >= 2, `${what}: with no evidence it is live, the server must be replaced about 60 seconds after its start; servers started: ${describeServers(x)}`);
    const after = calls[1].at - calls[0].at;
    assert.ok(after >= 55000 && after <= 95000, `${what}: it must be replaced about 60 seconds after its start, never sooner; replaced after ${after} ms`);
    assert.ok(w.processGone(calls[0].pid), `${what}: the replaced server must be gone`);
  }
});

// A network drop, not a client leaving (a client leaving prints nothing,
// measured on 2.1.332): the 2.1.332 leg's words are a HYPOTHESIS, 2.1.319's.
test("a server whose connection drops, a disconnection line with no connected word after it, is replaced about a minute after the drop, under both profiles (the 2.1.332 words taken to be 2.1.319's)", { timeout: 240000 }, async (t) => {
  const lazy = liveWorld(t, { profile: '2.1.332', disconnectAfterMs: 5000 });
  const eager = liveWorld(t, { profile: '2.1.319', disconnectAfterMs: 5000 });
  await firstServer(lazy, 'the 2.1.332 server');
  await firstServer(eager, 'the 2.1.319 server');
  await s.waitFor(() => s.environmentOf(lazy.world), 10000);
  s.clientConnects(lazy.world);
  const made = await s.waitFor(() => s.sessionRecords(lazy.world)[0], 15000);
  assert.ok(made, `the 2.1.332 world's client must make the session (the world's profile); session.log: ${JSON.stringify(s.sessionLog(lazy.world).slice(-400))}`);
  const dropped = (x) => /\breconnecting\b/i.test(s.sessionLog(x.world));
  await s.waitFor(() => dropped(lazy) && dropped(eager), 20000);
  const dropAt = Date.now();
  await s.waitFor(() => lazy.fake.serverCalls().length >= 2 && eager.fake.serverCalls().length >= 2, 100000, 500);
  for (const [what, x] of [['the 2.1.332 server', lazy], ['the 2.1.319 server', eager]]) {
    const calls = x.fake.serverCalls();
    assert.ok(calls.length >= 2, `${what}: a disconnection line with no connected word after it must replace the server about a minute after the drop; servers started: ${describeServers(x)}; session.log: ${JSON.stringify(s.sessionLog(x.world).slice(-400))}`);
    const after = calls[1].at - dropAt;
    assert.ok(after >= 45000 && after <= 90000, `${what}: replaced about 60 seconds after the drop; replaced ${after} ms after it was seen`);
  }
});

test("a 2.1.332 server stopped from outside, as an update's install stops it, before any client made a session is not recorded as stopped before any session started and the health check names no fault for it; under 2.1.319 the same; a server that dies before it was ever live is still named", { timeout: 180000 }, async (t) => {
  const stopFromOutside = async (x, what) => {
    const call = await firstServer(x, what);
    if (x.behaviour.profile === '2.1.332') {
      const live = await s.waitFor(() => s.bridgePointers(x.world).find((p) => p.pid === call.pid), 10000);
      assert.ok(live, `${what}: the world's server must write its bridge pointer first`);
    } else {
      assert.ok(await s.waitFor(() => s.sessionRecords(x.world)[0], 15000), `${what}: the world's eager server must make its session first`);
    }
    // As Squire Update's install ends it: SIGTERM to the server's process group.
    try { process.kill(-call.pid, 'SIGTERM'); } catch (e) { /* gone */ }
    await s.waitFor(() => w.processGone(call.pid), 10000);
    await s.sleep(4000);
  };
  const lazy = liveWorld(t, { profile: '2.1.332' });
  const eager = liveWorld(t, { profile: '2.1.319' });
  await stopFromOutside(lazy, 'the live 2.1.332 server');
  await stopFromOutside(eager, 'the 2.1.319 server');
  for (const [what, x] of [['the live 2.1.332 server', lazy], ['the 2.1.319 server', eager]]) {
    const h = s.health(x.world);
    const named = h.stdout.split('\n').filter((l) => l.startsWith(STOPPED));
    assert.deepEqual(named, [], `${what}, live by evidence when it was stopped from outside, must not be recorded as stopped before any session started; the health check said: ${w.describe(h)}`);
  }
  // A 2.1.332 server that was never live (no pointer) and died is still named.
  const never = liveWorld(t, { profile: '2.1.332', pointer: false, lastLine: 'The world\'s own last line: this server was never live' });
  const call = await firstServer(never, 'a 2.1.332 server never live');
  await s.sleep(3000);
  try { process.kill(-call.pid, 'SIGTERM'); } catch (e) { /* gone */ }
  await s.waitFor(() => w.processGone(call.pid), 10000);
  await s.sleep(4000);
  const h = s.health(never.world);
  assert.ok(h.stdout.split('\n').some((l) => l.startsWith(STOPPED)),
    `a server that stopped before it was ever live is still named by the health check; got ${w.describe(h)}`);
});

// Weak evidence: each world's 2.1.332 server writes no bridge pointer of its
// own and makes no session, and beside it the case plants one fault, as soon
// as the server has started. None of them is evidence that this server is
// live (ADR-003 point 16: a pointer written after its start naming its pid,
// or a session record written since its start), so each server is replaced
// as one with no evidence is. The other process is the case's own, neither
// the server nor one of its children; the earlier server's record names that
// process too, so only its time tells it apart. The pointer that cannot be
// read is cut short, its pid still in its text.
test('a server with only weak evidence beside it, a bridge pointer naming another live process, a pointer naming its pid written before it started, a pointer that cannot be read, or a session record an earlier server left, is replaced about 60 seconds after its start', { timeout: 240000 }, async (t) => {
  const { spawn } = require('node:child_process');
  const other = spawn('/bin/sleep', ['600'], { stdio: 'ignore', detached: true });
  t.after(() => { try { process.kill(-other.pid, 'SIGKILL'); } catch (e) { /* gone */ } });
  const pointerFile = (x) => {
    const dir = path.join(s.configDir(x.world), 'projects', fs.realpathSync(x.world.owner).replace(/[^A-Za-z0-9]/g, '-'));
    fs.mkdirSync(dir, { recursive: true });
    return path.join(dir, 'bridge-pointer.json');
  };
  const before = (call) => (call.at - 120000) / 1000;
  const faults = [
    ['a bridge pointer naming another live process', (x) => {
      fs.writeFileSync(pointerFile(x), JSON.stringify({ sessionId: '', environmentId: 'env_FAKEANOTHERPROCESS', source: 'standalone', pid: other.pid,
        procStart: s.startTimeOf(other.pid) || '', dir: x.world.owner }));
    }],
    ['a bridge pointer naming its pid written before it started', (x, call) => {
      const file = pointerFile(x);
      fs.writeFileSync(file, JSON.stringify({ sessionId: '', environmentId: 'env_FAKEWRITTENBEFORE', source: 'standalone', pid: call.pid, procStart: '', dir: x.world.owner }));
      fs.utimesSync(file, before(call), before(call));
    }],
    ['a bridge pointer that cannot be read', (x, call) => {
      fs.writeFileSync(pointerFile(x), `{"sessionId": "", "environmentId": "env_FAKECUTSHORT", "source": "standalone", "pid": ${call.pid}, "dir": `);
    }],
    ['a session record an earlier server left', (x, call) => {
      const record = s.seedSessionRecord(x.world, { sessionId: 'a-session-an-earlier-server-left', socket: path.join(x.world.root, 'earlier-server.sock'),
        pid: other.pid, recordedAt: before(call) });
      fs.utimesSync(path.join(s.sessionsDir(x.world), `${record.sessionId}.json`), before(call), before(call));
    }],
  ];
  const worlds = faults.map(([what, plant]) => [what, liveWorld(t, { profile: '2.1.332', pointer: false }), plant]);
  for (const [what, x, plant] of worlds) plant(x, await firstServer(x, `a 2.1.332 server beside ${what}`));
  await s.waitFor(() => worlds.every(([, x]) => x.fake.serverCalls().length >= 2), 100000, 500);
  for (const [what, x] of worlds) {
    const calls = x.fake.serverCalls();
    assert.ok(calls.length >= 2, `a 2.1.332 server beside ${what} has no evidence it is live, so it must be replaced about 60 seconds after its start; servers started: ${describeServers(x)}`);
    const after = calls[1].at - calls[0].at;
    assert.ok(after >= 55000 && after <= 95000, `a 2.1.332 server beside ${what}: it must be replaced about 60 seconds after its start, never sooner; replaced after ${after} ms`);
    assert.ok(w.processGone(calls[0].pid), `a 2.1.332 server beside ${what}: the replaced server must be gone`);
  }
});
