'use strict';

// Code hygiene for the session runner's set-up gate, through its entry point:
// during the first set-up (set-up's record short of the phone step, and no
// session ever recorded in the Squire home) the runner holds and starts no
// server; once a session has been recorded, a record cut back by a re-run
// that paused never holds it. Bound to no criterion.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const w = require('../fixtures/squire-world.js');
const s = require('../fixtures/session-world.js');

// A record cut back to the steps before the owner's folder, as a re-run that
// paused there leaves it.
const SHORT = ['yes', 'claudeCode', 'signIn', 'appleTools', 'naming'];

function gateWorld(t, { sessionRecorded }) {
  const world = w.makeWorld();
  let runner = null;
  t.after(async () => { if (runner) await runner.stop(); s.killFakes(world); w.cleanUp(world); });
  s.layDownCore(world);
  const fake = s.installFakeClaudeCode(world);
  fs.writeFileSync(path.join(world.home, 'set-up.json'), JSON.stringify({ done: SHORT, added: [] }, null, 2) + '\n');
  if (sessionRecorded) {
    const sessions = path.join(world.home, 'sessions');
    fs.mkdirSync(sessions, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(sessions, 'an-earlier-session.json'), JSON.stringify({ sessionId: 'an-earlier-session', recordedAt: 1 }) + '\n');
  }
  runner = s.startRunner(world);
  return { world, fake, runner };
}

const problems = (world) => {
  try { return JSON.parse(fs.readFileSync(path.join(world.home, 'runner.json'), 'utf8')).problems || []; } catch (e) { return []; }
};

test('during the first set-up, short of the phone step with no session ever recorded, the runner holds and starts no server', { timeout: 60000 }, async (t) => {
  const { world, fake, runner } = gateWorld(t, { sessionRecorded: false });
  const held = await s.waitFor(() => problems(world).some((p) => /first conversation/.test(p)), 20000);
  assert.ok(held, `the runner must say set-up has not reached its first conversation; output: ${runner.output().slice(-600)}`);
  await s.sleep(3000);
  assert.equal(fake.serverCalls().length, 0, 'the runner must start no server during the first set-up');
  assert.equal(runner.exited(), null, 'the runner must keep holding, not exit');
});

test('once a session has been recorded, a set-up record cut back by a re-run that paused does not hold the runner', { timeout: 60000 }, async (t) => {
  const { world, fake, runner } = gateWorld(t, { sessionRecorded: true });
  const started = await s.waitFor(() => fake.sessions()[0], 20000);
  assert.ok(started, `the runner must start a session; runner.json says ${JSON.stringify(problems(world))}; output: ${runner.output().slice(-600)}`);
});
