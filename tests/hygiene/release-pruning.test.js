'use strict';

// Code hygiene for the releases Squire keeps (the design record's line 6: the
// current release and the previous one, a third only briefly during an
// install). Bound to no criterion. A finished install clears the release
// before the previous one; these cases cover the two other ways an install
// ends: a rollback, whose rolled-back release goes whether or not the check
// after it passes, and an install that did not finish, settled at the next
// start, after which Squire keeps the release it is on and the one
// current-release.json names before it.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const w = require('../fixtures/squire-world.js');
const s = require('../fixtures/session-world.js');
const R = require('../fixtures/updates-world.js');

const NEXT = '0.2.0';
const LATER = '0.3.0';
const LONG = { timeout: 600000 };
const ON = /did not finish.*Squire is on (\d+\.\d+\.\d+)/;

// Squire on NEXT, installed from Squire Update over the app's release, and
// LATER (of the shape given) staged by the next weekly check: three releases
// known, two of them kept.
async function onNextWithLaterStaged(t, shape) {
  const rw = R.makeReleaseWorld(t);
  await R.startSquire(rw);
  assert.equal(R.health(rw).status, 0, 'the world\'s Squire must start healthy');
  const good = R.buildRelease(rw, { version: NEXT });
  R.tick(rw);
  assert.ok(R.staged(rw).includes(NEXT), `the weekly check must stage ${NEXT}; staging holds ${JSON.stringify(R.stagingFiles(rw))}`);
  const { sent } = await R.installAtMac(rw, good);
  assert.ok(sent.some((x) => x.includes(`Squire is updated to ${NEXT}; all checks passed`)), `${NEXT} must install; sent ${JSON.stringify(sent)}`);
  assert.deepEqual(R.keptReleases(rw), [R.INSTALLED, NEXT], 'after the first install the app\'s release and the installed one are kept');
  const later = R.buildRelease(rw, { version: LATER, shape });
  R.moveRecordTimes(path.join(rw.home, 'update.json'), -8 * 86400, ['lastCheck']);
  R.tick(rw);
  assert.ok(R.staged(rw).includes(LATER), `the next weekly check must stage ${LATER}; staging holds ${JSON.stringify(R.stagingFiles(rw))}`);
  return { rw, later };
}

// At most two releases kept: the one current-release.json names and the one
// it names before it.
function assertTwoKept(rw, on, what) {
  const current = R.currentRelease(rw) || {};
  assert.equal(current.current, on, `${what}: current-release.json must name ${on}; got ${JSON.stringify(current)}`);
  const kept = R.keptReleases(rw);
  assert.ok(kept.length <= 2, `${what}: at most two releases are kept; releases/ holds ${JSON.stringify(kept)}`);
  assert.deepEqual(kept, [on, current.previous].filter(Boolean).sort(),
    `${what}: releases/ holds the current release and the previous one current-release.json names (${JSON.stringify(current)}), nothing else; it holds ${JSON.stringify(kept)}`);
}

for (const [shape, how] of [['runnerExits', 'whose check passes'], ['runnerExitsAndSignsOut', 'whose check fails too']]) {
  test(`after a rollback ${how}, releases/ keeps the release rolled back to and the one before it, and the rolled-back release goes`, LONG, async (t) => {
    const { rw, later } = await onNextWithLaterStaged(t, shape);
    const { sent } = await R.installAtMac(rw, later);
    assert.ok(sent.some((x) => x.includes(`Squire rolled ${LATER} back to ${NEXT}`)), `${LATER} must be rolled back to ${NEXT}; sent ${JSON.stringify(sent)}`);
    assertTwoKept(rw, NEXT, `after the rollback ${how}`);
    assert.deepEqual(R.keptReleases(rw), [R.INSTALLED, NEXT], `after the rollback ${how}: ${LATER} is no longer kept`);
  });
}

test('after an install killed at its check is settled at the next start, releases/ keeps the release Squire is on and the one before it', LONG, async (t) => {
  const { rw } = await onNextWithLaterStaged(t);
  const seen = await R.killInstallAt(rw, 'check');
  assert.equal(seen, 'check', `the install must be killed at its check; the record named ${JSON.stringify(seen)}`);
  assert.deepEqual(R.keptReleases(rw), [R.INSTALLED, NEXT, LATER], 'killed at its check, the install has three releases kept');
  const sentBefore = R.wakeUpIds(rw);
  R.stopSquire(rw);
  R.launchSquire(rw);
  const done = () => !fs.existsSync(R.installRecordFile(rw)) && R.newWakeUps(rw, sentBefore).some((x) => ON.test(x));
  await s.waitFor(done, 60000, 250);
  R.tick(rw);
  const settled = await s.waitFor(done, 180000, 250);
  const said = R.newWakeUps(rw, sentBefore).filter((x) => ON.test(x));
  assert.ok(settled && said.length === 1, `the unfinished install must be settled and one wake-up say which version Squire is on; sent ${JSON.stringify(R.newWakeUps(rw, sentBefore))}; health: ${w.describe(R.health(rw))}`);
  assertTwoKept(rw, ON.exec(said[0])[1], 'after the unfinished install is settled');
});
