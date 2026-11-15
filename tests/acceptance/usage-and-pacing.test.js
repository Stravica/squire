'use strict';

// Squire knows the owner's Claude plan and usage, and paces itself
// (AC-1301-1), through the real entry points: set-up's app as Finder runs it
// (the installer world), Claude Code's status line command exactly as core's
// settings set it, the safety floor (core/hooks/pre-tool-use.py) for a big
// job's start, and the prompt hook (core/hooks/user-prompt-submit.py) on the
// owner's messages. The design record for plan awareness and the heavy-job
// gate (ADR-006) names the paths, the records and the key words read here;
// the rest of the wording is the builder's.
//
// Usage model for the thresholds (every figure an assumption, none measured;
// ADR-006's consequences):
//   typical  a Pro owner with a few light conversations a day and about one
//            big job a week: five-hour window 30 to 60%, weekly 20 to 50%.
//            Cases use five-hour 35% and weekly 40%: nothing deferred, no
//            weekly line.
//   heavy    a deep research and an app build on the same day beside everyday
//            chat: five-hour 85 to 100% two or three times a week, weekly past
//            70% by mid-week. Cases use five-hour 85% and weekly 75%: the big
//            job deferred with the reset time, the weekly line once a day.
//   unknown  no snapshot, or one older than an hour (a session idle for an
//            hour, or a status line that never ran): every big job asks and
//            says Squire cannot see the plan's usage.
// The thresholds are strictly above: 80% of the five-hour window, 70% of the
// weekly window. A job that can wait is a big job (ADR-006 line 4).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const w = require('../fixtures/squire-world.js');
const I = require('../fixtures/installer-world.js');
const U = require('../fixtures/usage-world.js');

const { TITLES } = I;

test("the plan the owner declares at set-up is asked once and kept in the owner's squire.json", { timeout: 180000 }, async (t) => {
  // The owner's answer is Max, not the world's default Pro, so the kept value can only be the one declared.
  const iw = I.makeInstallerWorld(t, { mac: { answers: { [TITLES.plan]: 'Max' } } });
  const run = await I.runApp(iw, { killWhen: (x) => I.doneSteps(x).includes('ownerFolder') });
  assert.ok(I.doneSteps(iw).includes('ownerFolder'), `set-up must reach the owner's folder; got ${I.describeRun(run)}`);
  const config = I.ownerConfig(iw);
  assert.ok(config, `the owner's squire.json must exist in ~/Squire; got ${I.describeRun(run)}`);
  assert.equal(config.claudePlan, 'Max',
    `the owner's squire.json must keep the plan the owner declared as claudePlan (the design record's line 1); it holds ${JSON.stringify(config)}`);
  assert.equal(I.dialogsTitled(run, TITLES.plan).length, 1, `the plan must be asked once in set-up; got ${I.describeRun(run)}`);
  assert.equal(config.squireName, 'Juniper', 'the name kept beside it');
});

test("the usage snapshot: the status line command core's settings set writes runtime/usage.json with the model, the context used, both windows and their resets and the time, and nothing else", { timeout: 60000 }, (t) => {
  const world = U.usageWorld(t);
  const fiveReset = U.now() + 3 * 3600;
  const weekReset = U.now() + 4 * U.DAY;
  const before = U.now();
  const r = U.runStatusLine(world, U.statusInput(world, {
    context: 41, rateLimits: { fiveHour: { used: 23.5, resetsAt: fiveReset }, sevenDay: { used: 41.2, resetsAt: weekReset } },
  }));
  assert.equal(r.status, 0, `the status line command must exit 0; got ${w.describe(r)}`);
  const snap = U.readSnapshot(world);
  assert.ok(snap, `the status line command must write runtime/usage.json in the Squire home; got ${w.describe(r)}`);
  assert.deepEqual(Object.keys(snap).sort(), ['at', 'contextUsedPercent', 'fiveHour', 'model', 'sevenDay'],
    `the snapshot holds exactly the model, the context used, both windows and the time; got ${JSON.stringify(snap)}`);
  assert.equal(snap.model, 'claude-opus-5-5');
  assert.equal(snap.contextUsedPercent, 41);
  assert.deepEqual(snap.fiveHour, { usedPercent: 23.5, resetsAt: fiveReset });
  assert.deepEqual(snap.sevenDay, { usedPercent: 41.2, resetsAt: weekReset });
  assert.ok(snap.at >= before - 1 && snap.at <= U.now() + 1, `at is when it was written, in seconds since 1970; got ${snap.at}`);
  const text = fs.readFileSync(U.snapshotFile(world), 'utf8');
  for (const kept of ['job-status', world.transcript, world.owner, '550e8400', 'total_cost_usd', '0.01234', 'Juniper']) {
    assert.ok(!text.includes(kept), `the snapshot must hold no session id, path, prompt, name or cost; it holds ${JSON.stringify(kept)}`);
  }
  assert.equal(fs.statSync(U.snapshotFile(world)).mode & 0o777, 0o600, 'the snapshot is readable by its user only');

  // Before the first response (or on a plan without it) rate_limits is absent: both windows unknown.
  U.runStatusLine(world, U.statusInput(world, { context: 3, rateLimits: null }));
  let now = U.readSnapshot(world);
  assert.equal(now.fiveHour, null, `an absent five-hour window is null; got ${JSON.stringify(now)}`);
  assert.equal(now.sevenDay, null, `an absent weekly window is null; got ${JSON.stringify(now)}`);
  assert.equal(now.contextUsedPercent, 3);
  // A window can be absent on its own.
  U.runStatusLine(world, U.statusInput(world, { context: 12, rateLimits: { fiveHour: { used: 64, resetsAt: fiveReset } } }));
  now = U.readSnapshot(world);
  assert.deepEqual(now.fiveHour, { usedPercent: 64, resetsAt: fiveReset });
  assert.equal(now.sevenDay, null, `the weekly window absent on its own is null; got ${JSON.stringify(now)}`);

  // Input it cannot read changes nothing and still exits 0: the snapshot only ages.
  const bytes = fs.readFileSync(U.snapshotFile(world));
  const bad = U.runStatusLine(world, '{"model": {"id": "claude-opus-5-5"}, "rate_limits": ');
  assert.equal(bad.status, 0, `input that is not JSON must still exit 0; got ${w.describe(bad)}`);
  assert.deepEqual(fs.readFileSync(U.snapshotFile(world)), bytes, 'input that is not JSON leaves the snapshot as it was');
});

test('pacing: above 80% of the five-hour window or 70% of the weekly window a big job that can wait is deferred, its warning saying when the allowance resets; below both nothing is deferred', { timeout: 60000 }, (t) => {
  const fiveReset = U.onMinute(U.now() + 2 * 3600 + 600);
  const weekReset = U.onMinute(U.now() + 3 * U.DAY + 1200);

  // Typical: five-hour 35%, weekly 40%.
  const calm = U.usageWorld(t);
  U.writeSnapshot(calm, { fiveHour: { used: 35, resetsAt: fiveReset }, sevenDay: { used: 40, resetsAt: weekReset } });
  const quiet = w.attempt(calm, 'job-calm', U.heavyJob(calm, 'research'), { env: U.UTC });
  w.assertBlocked(quiet, 'a big job asks first, whatever the usage');
  assert.doesNotMatch(quiet.stderr, /can wait/i, `below both thresholds a big job is not deferred; got ${w.describe(quiet)}`);

  // Heavy, five-hour: 85%, the weekly window calm.
  const busy = U.usageWorld(t);
  U.writeSnapshot(busy, { fiveHour: { used: 85, resetsAt: fiveReset }, sevenDay: { used: 40, resetsAt: weekReset } });
  const deferred = w.attempt(busy, 'job-busy', U.heavyJob(busy, 'research'), { env: U.UTC });
  w.assertBlocked(deferred, 'a big job at 85% of the five-hour window');
  assert.match(deferred.stderr, /can wait/i, `above 80% of the five-hour window the big job is deferred: its warning says it can wait; got ${w.describe(deferred)}`);
  assert.ok(deferred.stderr.includes(U.hhmm(fiveReset)),
    `the deferral says when the five-hour allowance resets (${U.hhmm(fiveReset)}, local time); got ${w.describe(deferred)}`);
  assert.ok(deferred.stderr.includes('85%'), `the deferral names the five-hour usage; got ${w.describe(deferred)}`);

  // Heavy, weekly: 75%, the five-hour window calm.
  const week = U.usageWorld(t);
  U.writeSnapshot(week, { fiveHour: { used: 20, resetsAt: fiveReset }, sevenDay: { used: 75, resetsAt: weekReset } });
  const weekly = w.attempt(week, 'job-week', U.heavyJob(week, 'app'), { env: U.UTC });
  w.assertBlocked(weekly, 'a big job at 75% of the weekly window');
  assert.match(weekly.stderr, /can wait/i, `above 70% of the weekly window the big job is deferred; got ${w.describe(weekly)}`);
  assert.ok(weekly.stderr.includes(U.hhmm(weekReset)),
    `the deferral says when the weekly allowance resets (${U.hhmm(weekReset)}, local time); got ${w.describe(weekly)}`);
  assert.ok(weekly.stderr.includes('75%'), `the deferral names the weekly usage; got ${w.describe(weekly)}`);
});

test('pacing: above 70% of the weekly window Squire tells the owner once a day, on their message, and not below it', { timeout: 60000 }, (t) => {
  const weekReset = U.onMinute(U.now() + 3 * U.DAY);
  // Typical: weekly 40%.
  const calm = U.usageWorld(t);
  U.writeSnapshot(calm, { fiveHour: { used: 35, resetsAt: U.now() + 3600 }, sevenDay: { used: 40, resetsAt: weekReset } });
  const quiet = w.ownerSays(calm, 'job-calm', 'What is on the list for today?', { env: U.UTC });
  assert.doesNotMatch(quiet.stdout, /weekly/i, `below 70% of the weekly window there is no weekly line; got ${w.describe(quiet)}`);

  // Heavy: weekly 75%.
  const busy = U.usageWorld(t);
  U.writeSnapshot(busy, { fiveHour: { used: 35, resetsAt: U.now() + 3600 }, sevenDay: { used: 75, resetsAt: weekReset } });
  const first = w.ownerSays(busy, 'job-busy', 'What is on the list for today?', { env: U.UTC });
  assert.match(first.stdout, /weekly/i, `above 70% of the weekly window Squire says so on the owner's message; got ${w.describe(first)}`);
  assert.ok(first.stdout.includes('75%'), `the weekly line names the usage; got ${w.describe(first)}`);
  assert.match(first.stdout, /Squire's own code/, `the weekly line is Squire's own note, not a message from anyone; got ${w.describe(first)}`);
  const second = w.ownerSays(busy, 'job-busy', 'And after that?', { env: U.UTC });
  assert.doesNotMatch(second.stdout, /weekly/i, `the weekly line comes once a day, not on every message; got ${w.describe(second)}`);
  const otherJob = w.ownerSays(busy, 'job-later', 'Anything else today?', { env: U.UTC });
  assert.doesNotMatch(otherJob.stdout, /weekly/i, `once a day means once a day, in any job; got ${w.describe(otherJob)}`);
});

test("usage that is stale (older than an hour) or missing is unknown: a big job still asks, saying Squire cannot see the plan's usage, and a stale reading defers nothing", { timeout: 60000 }, (t) => {
  const fiveReset = U.onMinute(U.now() + 3600);
  // Fresh and known: no "cannot see".
  const known = U.usageWorld(t);
  U.writeSnapshot(known, { fiveHour: { used: 35, resetsAt: fiveReset }, sevenDay: { used: 40, resetsAt: U.now() + 3 * U.DAY }, age: 600 });
  const fresh = w.attempt(known, 'job-known', U.heavyJob(known, 'site'), { env: U.UTC });
  w.assertBlocked(fresh, 'a big job with fresh usage');
  assert.doesNotMatch(fresh.stderr, /cannot see/i, `a snapshot ten minutes old is known; got ${w.describe(fresh)}`);

  // Missing: no snapshot at all.
  const missing = U.usageWorld(t);
  const none = w.attempt(missing, 'job-missing', U.heavyJob(missing, 'site'), { env: U.UTC });
  w.assertBlocked(none, 'a big job with no usage snapshot');
  assert.match(none.stderr, /cannot see/i, `with no snapshot the big job's warning says Squire cannot see the plan's usage; got ${w.describe(none)}`);

  // Stale: 85% two hours ago.
  const old = U.usageWorld(t);
  U.writeSnapshot(old, { fiveHour: { used: 85, resetsAt: fiveReset }, sevenDay: { used: 40, resetsAt: U.now() + 3 * U.DAY }, age: 2 * 3600 });
  const stale = w.attempt(old, 'job-stale', U.heavyJob(old, 'site'), { env: U.UTC });
  w.assertBlocked(stale, 'a big job with a snapshot two hours old');
  assert.match(stale.stderr, /cannot see/i, `a snapshot older than an hour is unknown; got ${w.describe(stale)}`);
  assert.doesNotMatch(stale.stderr, /can wait/i, `a stale reading defers nothing; got ${w.describe(stale)}`);

  // Just past the hour is stale too.
  const edge = U.usageWorld(t);
  U.writeSnapshot(edge, { fiveHour: { used: 35, resetsAt: fiveReset }, sevenDay: { used: 40, resetsAt: U.now() + 3 * U.DAY }, age: 3600 + 120 });
  const late = w.attempt(edge, 'job-edge', U.heavyJob(edge, 'site'), { env: U.UTC });
  assert.match(late.stderr, /cannot see/i, `a snapshot an hour and two minutes old is unknown; got ${w.describe(late)}`);
});
