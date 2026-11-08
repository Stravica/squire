'use strict';

// Round 2's journey, end to end on a laid-down core: core is laid down into a
// Squire home beside the owner's folder, the INSTALLED runner starts the
// session, and from then on only installed entry points run. Claude Code is
// the fixture's fake at ~/.local/bin/claude under the world's home folder: its
// session runs the hooks of the settings the runner gives it, as Claude Code
// does, and takes wake-ups on its own messaging socket. No test reaches a
// real model or a real session.
//
// The target is a parameter: SQUIRE_RELEASE_DIR names the core release to lay
// down (a release folder holding hooks/, tools/ and the rest of core). Unset,
// it is this repository's core/.
//
//   SQUIRE_RELEASE_DIR=/path/to/release node --test tests/e2e/

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const w = require('../fixtures/squire-world.js');
const s = require('../fixtures/session-world.js');

const { tools } = w;

test('on a laid-down core the runner starts a session that runs the floor, a wake-up saying yes reaches it without answering its request, and after a settings file appears the new session is the one woken', { timeout: 180000 }, async (t) => {
  const release = process.env.SQUIRE_RELEASE_DIR ? path.resolve(process.env.SQUIRE_RELEASE_DIR) : w.CORE;
  const world = w.makeWorld();
  t.after(() => { s.killFakes(world); w.cleanUp(world); });
  const r = w.runPython(world, path.join(release, 'tools', 'lay-down.py'), [release], { cwd: world.root });
  assert.equal(r.status, 0, `laying down core from the release must succeed; got ${w.describe(r)}`);
  const installed = fs.realpathSync(path.join(world.home, 'core'));
  const ownerConfig = path.join(world.owner, 'squire.json');
  fs.writeFileSync(ownerConfig, JSON.stringify({ ...JSON.parse(fs.readFileSync(ownerConfig, 'utf8')), wakeUps: [] }, null, 2) + '\n');
  const fake = s.installFakeClaudeCode(world);
  const on = { coreDir: installed };

  // The installed runner starts one session, and its SessionStart hook, run
  // from the settings the runner gave it, records the session.
  const runner = s.startRunner(world, { coreDir: installed });
  t.after(() => runner.stop());
  const session = await s.waitFor(() => fake.sessions()[0], 20000);
  assert.ok(session, `the installed runner must start a session within 20 seconds; runner output: ${runner.output().slice(-600) || '(none)'}`);
  assert.ok(session.hookRuns.length >= 1 && session.hookRuns.every((h) => h.status === 0),
    `the session's SessionStart hooks, from the settings the runner gave it, must run and let it start; got ${JSON.stringify(session.hookRuns)}`);
  const record = await s.waitFor(() => s.sessionRecords(world).find((x) => x.pid === session.pid), 10000);
  assert.ok(record, `the session must be recorded in the Squire home; records: ${JSON.stringify(s.sessionRecords(world))}`);

  // The floor is on in that session: a send is asked.
  const send = tools.gmailSend('someone@example.com', 'Saturday', 'The cake is ready.');
  const asked = w.attempt(world, record.sessionId, send, on);
  w.assertBlocked(asked, 'a send in the session the runner started');
  assert.ok(w.requestIdIn(asked.stderr), `the send must be asked with a request id; got ${w.describe(asked)}`);

  // A wake-up saying yes reaches the session, whose prompt hook takes it, and
  // the request stays open.
  let fired = s.fireWakeUp(world, 'yes', on);
  assert.equal(fired.status, 0, `the wake-up must be delivered (exit 0); got ${w.describe(fired)}`);
  const prompt = await s.waitFor(() => fake.prompts().find((p) => p.pid === session.pid), 10000);
  assert.ok(prompt, 'the wake-up must reach the session on its messaging socket');
  assert.ok(prompt.hookRuns.length >= 1 && prompt.hookRuns.every((h) => h.status === 0),
    `the session's prompt hook must take the wake-up; got ${JSON.stringify(prompt.hookRuns)}`);
  const still = w.attempt(world, record.sessionId, send, on);
  w.assertBlocked(still, 'the send after a wake-up saying yes');
  assert.ok(w.requestIdIn(still.stderr), `the send must still be asked after a wake-up saying yes (posted as ${JSON.stringify(prompt.content)}); got ${w.describe(still)}`);

  // The Squire owner's own yes answers it.
  w.ownerSays(world, record.sessionId, 'yes', on);
  w.assertAllowed(w.attempt(world, record.sessionId, send, on), 'the send after the owner said yes');

  // A settings file appears in the owner's folder: the session stops, the
  // file is moved, a new session starts and is the one the next wake-up reaches.
  fs.mkdirSync(path.join(world.owner, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(world.owner, '.claude', 'settings.local.json'), '{"disableAllHooks": true}\n');
  const gone = await s.waitFor(() => w.processGone(session.pid), 5000, 50);
  assert.ok(gone, 'the session must stop within 5 seconds of a settings file appearing in the owner\'s folder');
  const next = await s.waitFor(() => fake.sessions().find((x) => x.pid !== session.pid), 15000);
  assert.ok(next, 'a new session must start once the settings file is moved');
  assert.ok(!fs.existsSync(path.join(world.owner, '.claude', 'settings.local.json')), 'the settings file must be gone from the owner\'s folder');
  await s.waitFor(() => s.sessionRecords(world).length === 1 && s.sessionRecords(world)[0].pid === next.pid, 10000);
  fired = s.fireWakeUp(world, 'Time for the morning brief.', on);
  assert.equal(fired.status, 0, `the wake-up after the restart must be delivered (exit 0); got ${w.describe(fired)}`);
  const reached = await s.waitFor(() => fake.prompts().find((p) => p.pid === next.pid), 10000);
  assert.ok(reached && reached.content.includes('Time for the morning brief.'), `the wake-up must reach the new session; prompts: ${JSON.stringify(fake.prompts().map((p) => [p.pid, p.content]))}`);
  assert.equal(fake.prompts().filter((p) => p.pid === session.pid).length, 1, 'the old session must not be woken again');
});
