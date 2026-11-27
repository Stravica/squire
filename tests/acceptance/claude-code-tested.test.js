'use strict';

// When the Claude Code on the Mac is newer than the newest version this
// Squire release was tested with, the health check says so in one plain line
// naming both versions; Squire keeps working, pins and installs nothing, and
// the line goes once Claude Code is at or below the tested version. The
// tested version is a field of the release, claudeCodeTested in the laid
// core's release.json, as an update's signed manifest names it; a release
// without it shows no line.
//
// Every case runs an installed Squire in the release world
// (tests/fixtures/updates-world.js), the field planted in the core the world
// lays, and sets what the world's claude --version answers.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const w = require('../fixtures/squire-world.js');
const s = require('../fixtures/session-world.js');
const R = require('../fixtures/updates-world.js');

const LONG = { timeout: 300000 };
const TESTED = '2.1.322';
const NEWER = '2.1.340';
const NOT_TESTED = /\bnot (?:yet )?(?:been )?tested\b/i;

const lineFor = (h, version) => h.stdout.split('\n').filter((l) => l.includes(version) && /tested/i.test(l));
const launcherTarget = (rw) => fs.readlinkSync(path.join(rw.world.userHome, '.local', 'bin', 'claude'));
const versionsHeld = (rw) => fs.readdirSync(path.join(rw.world.userHome, '.local', 'share', 'claude', 'versions')).sort();
// The Claude Code on the Mac becomes this version: the launcher points at it
// and --version answers it.
const newer = (rw, version) => { R.setLauncherTarget(rw, version); R.setVersionAnswer(rw, version); };

async function world(t, releaseFields) {
  const rw = R.makeReleaseWorld(t, { releaseFields });
  await R.startSquire(rw);
  return rw;
}

test('with a Claude Code newer than the version this Squire release was tested with, the health check shows one plain line naming both versions and saying this Squire has not yet been tested with it; Squire keeps working, pins and installs nothing, and the line goes once Claude Code is back at the tested version', LONG, async (t) => {
  const rw = await world(t, { claudeCodeTested: TESTED });
  // Claude Code updates itself, as it does outside Squire.
  newer(rw, NEWER);
  const target = launcherTarget(rw);
  const held = versionsHeld(rw);
  const release = fs.readFileSync(path.join(rw.home, 'core', 'release.json'), 'utf8');
  const h = R.health(rw);
  const lines = lineFor(h, NEWER);
  assert.equal(lines.length, 1, `the health check must show one line naming the newer Claude Code (${NEWER}) and the version this release was tested with (${TESTED}); it said: ${w.describe(h)}`);
  assert.ok(lines[0].includes(TESTED) && NOT_TESTED.test(lines[0]), `the line must name both versions and say this Squire has not yet been tested with the newer one; it said: ${lines[0]}`);
  assert.ok(s.sessionRecords(rw.world).some((r) => !w.processGone(r.pid)), 'Squire keeps working: its session still runs');
  assert.equal(launcherTarget(rw), target, 'nothing is pinned: the claude launcher still points where Claude Code put it');
  assert.deepEqual(versionsHeld(rw), held, 'nothing is installed: Claude Code\'s versions folder is as it was');
  assert.equal(fs.readFileSync(path.join(rw.home, 'core', 'release.json'), 'utf8'), release, 'the release is as it was');
  newer(rw, TESTED);
  const after = R.health(rw);
  assert.deepEqual(after.stdout.split('\n').filter((l) => NOT_TESTED.test(l)), [], `once Claude Code is at the tested version the line goes; the health check said: ${w.describe(after)}`);
});

test('with Claude Code at or below the version this Squire release was tested with, or a release that names no tested version, the health check shows no not-tested line', LONG, async (t) => {
  const named = await world(t, { claudeCodeTested: TESTED });
  for (const version of [TESTED, '2.1.319']) {
    newer(named, version);
    const h = R.health(named);
    assert.deepEqual(h.stdout.split('\n').filter((l) => NOT_TESTED.test(l)), [], `Claude Code ${version}, at or below ${TESTED}: no not-tested line; the health check said: ${w.describe(h)}`);
  }
  const unnamed = await world(t, null);
  newer(unnamed, NEWER);
  const h = R.health(unnamed);
  assert.deepEqual(h.stdout.split('\n').filter((l) => NOT_TESTED.test(l)), [], `a release that names no tested version shows no line, whatever Claude Code is; the health check said: ${w.describe(h)}`);
});
