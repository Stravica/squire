'use strict';

// Core and the Squire owner's folder kept apart: laying core down, laying it
// down again and replacing it with a different core all go through core's own
// lay-down command, and the owner's folder is byte for byte the same after
// each, down to modification times and inodes.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const w = require('../fixtures/squire-world.js');

const LAY_DOWN = path.join(w.CORE, 'tools', 'lay-down.py');

function layDown(world, releaseDir) {
  return w.runPython(world, LAY_DOWN, [releaseDir], { cwd: world.root });
}

function assertCoreIs(world, releaseDir, what) {
  const installed = path.join(world.home, 'core');
  assert.ok(fs.existsSync(installed), `${what}: core must be laid down at SQUIRE_HOME/core`);
  assert.deepEqual(w.treeOf(installed), w.treeOf(releaseDir),
    `${what}: the core in SQUIRE_HOME/core must be exactly the release, file for file`);
}

function assertOwnerFolderUntouched(world, before, what) {
  const diffs = w.snapshotDifferences(before, w.snapshot(world.owner));
  assert.deepEqual(diffs, [], `${what}: the owner's folder must be byte for byte the same; it changed: ${diffs.join(', ')}`);
}

test('laying core down again or replacing it with a different core leaves the owner folder byte for byte the same', { timeout: 120000 }, (t) => {
  const world = w.makeWorld();
  t.after(() => w.cleanUp(world));
  const before = w.snapshot(world.owner);

  // Two releases of core: the real core tree with release-specific files, so
  // the second differs from the first by a changed file, a removed file and
  // an added file.
  const releaseA = path.join(world.root, 'release-a');
  const releaseB = path.join(world.root, 'release-b');

  // First lay-down of the real core, straight from this repository.
  let r = layDown(world, w.CORE);
  assert.equal(r.status, 0, `laying down core must succeed; got ${w.describe(r)}`);
  assertCoreIs(world, w.CORE, 'first lay-down');
  assertOwnerFolderUntouched(world, before, 'first lay-down');

  w.copyTree(w.CORE, releaseA);
  fs.mkdirSync(path.join(releaseA, 'extras'), { recursive: true });
  fs.writeFileSync(path.join(releaseA, 'extras', 'notes.md'), 'Release A notes.\n');
  fs.writeFileSync(path.join(releaseA, 'extras', 'only-in-a.md'), 'Only in release A.\n');
  w.copyTree(w.CORE, releaseB);
  fs.mkdirSync(path.join(releaseB, 'extras'), { recursive: true });
  fs.writeFileSync(path.join(releaseB, 'extras', 'notes.md'), 'Release B notes, changed.\n');
  fs.writeFileSync(path.join(releaseB, 'extras', 'only-in-b.md'), 'Only in release B.\n');

  r = layDown(world, releaseA);
  assert.equal(r.status, 0, `laying down release A must succeed; got ${w.describe(r)}`);
  assertCoreIs(world, releaseA, 'lay-down of release A');
  assertOwnerFolderUntouched(world, before, 'lay-down of release A');

  // Laid down again: the same core.
  r = layDown(world, releaseA);
  assert.equal(r.status, 0, `laying release A down again must succeed; got ${w.describe(r)}`);
  assertCoreIs(world, releaseA, 'release A laid down again');
  assertOwnerFolderUntouched(world, before, 'release A laid down again');

  // Replaced with a different core: replaced whole, nothing of A left behind.
  r = layDown(world, releaseB);
  assert.equal(r.status, 0, `replacing core with release B must succeed; got ${w.describe(r)}`);
  assertCoreIs(world, releaseB, 'core replaced with release B');
  assert.ok(!fs.existsSync(path.join(world.home, 'core', 'extras', 'only-in-a.md')),
    'core replaced with release B: a file only release A had must be gone');
  assertOwnerFolderUntouched(world, before, 'core replaced with release B');
});
