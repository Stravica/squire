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

// Lay-down refuses with exit 1 and a reason on stderr.
function assertRefused(r, what) {
  const why = `${what}: lay-down must refuse (exit 1, a reason on stderr); got ${w.describe(r)}`;
  assert.doesNotMatch(r.stderr, /can't open file|Traceback \(most recent call last\)/, why);
  assert.equal(r.status, 1, why);
  assert.ok(r.stderr.trim().length > 0, why);
}

function assertUnchanged(before, dir, what) {
  const diffs = w.snapshotDifferences(before, w.snapshot(dir));
  assert.deepEqual(diffs, [], `${what}: ${dir} must be unchanged; it changed: ${diffs.join(', ')}`);
}

test('a release missing a floor entry point, or one that is or lies inside the installed core or the Squire home, is refused and changes nothing', { timeout: 120000 }, (t) => {
  const world = w.makeWorld();
  t.after(() => w.cleanUp(world));
  let r = layDown(world, w.CORE);
  assert.equal(r.status, 0, `laying down core must succeed; got ${w.describe(r)}`);
  const installed = fs.realpathSync(path.join(world.home, 'core'));
  const coreBefore = w.snapshot(installed);
  const ownerBefore = w.snapshot(world.owner);

  for (const entryPoint of w.FLOOR_ENTRY_POINTS) {
    const release = path.join(world.root, `release-without-${path.basename(entryPoint, '.py')}`);
    w.copyTree(w.CORE, release);
    fs.rmSync(path.join(release, entryPoint));
    r = layDown(world, release);
    assertRefused(r, `a release without ${entryPoint}`);
    assert.equal(fs.realpathSync(path.join(world.home, 'core')), installed, `a release without ${entryPoint}: the installed core must stay where it was`);
    assertUnchanged(coreBefore, installed, `a release without ${entryPoint}`);
    assertUnchanged(ownerBefore, world.owner, `a release without ${entryPoint}`);
  }

  const inside = path.join(world.home, 'incoming-release');
  w.copyTree(w.CORE, inside);
  const linkToCore = path.join(world.root, 'release-link-to-core');
  fs.symlinkSync(path.join(world.home, 'core'), linkToCore);
  const linkInside = path.join(world.root, 'release-link-inside-home');
  fs.symlinkSync(inside, linkInside);
  for (const [what, release] of [
    ['the installed core given as the release', path.join(world.home, 'core')],
    ['the installed core by its real path', installed],
    ['a link to the installed core', linkToCore],
    ['the Squire home given as the release', world.home],
    ['a release inside the Squire home', inside],
    ['a link to a release inside the Squire home', linkInside],
  ]) {
    r = layDown(world, release);
    assertRefused(r, what);
    assert.equal(fs.realpathSync(path.join(world.home, 'core')), installed, `${what}: the installed core must stay where it was`);
    assertUnchanged(coreBefore, installed, what);
    assertUnchanged(ownerBefore, world.owner, what);
  }
});

test('lay-down refuses a layout where the owner folder and core overlap, inside each other or through a link, and changes nothing', { timeout: 120000 }, (t) => {
  const world = w.makeWorld();
  t.after(() => w.cleanUp(world));
  let r = layDown(world, w.CORE);
  assert.equal(r.status, 0, `laying down core must succeed; got ${w.describe(r)}`);
  const installed = fs.realpathSync(path.join(world.home, 'core'));

  // The owner's folder inside the installed core, named directly or through a link.
  const ownerInCore = path.join(installed, 'owner-files');
  w.seedOwnerFolder(ownerInCore);
  const linkIntoCore = path.join(world.root, 'owner-link-into-core');
  fs.symlinkSync(ownerInCore, linkIntoCore);
  for (const [what, ownerFolder] of [
    ['an owner folder inside the installed core', ownerInCore],
    ['an owner folder that is a link into the installed core', linkIntoCore],
  ]) {
    w.writeConfigFile(world.home, { ownerFolder, approvalTimeoutSeconds: 600 });
    const coreBefore = w.snapshot(installed);
    r = layDown(world, w.CORE);
    assertRefused(r, what);
    assertUnchanged(coreBefore, installed, what);
  }

  // The Squire home, and so core, inside the owner's folder, named directly
  // or through a link.
  const homeInOwner = path.join(world.owner, '.squire');
  w.writeConfigFile(homeInOwner, { ownerFolder: world.owner, approvalTimeoutSeconds: 600 });
  const linkIntoOwner = path.join(world.root, 'home-link-into-owner');
  fs.symlinkSync(homeInOwner, linkIntoOwner);
  const ownerBefore = w.snapshot(world.owner);
  for (const [what, squireHome] of [
    ['a Squire home inside the owner\'s folder', homeInOwner],
    ['a Squire home that is a link into the owner\'s folder', linkIntoOwner],
  ]) {
    r = w.runPython(world, LAY_DOWN, [w.CORE], { cwd: world.root, env: { SQUIRE_HOME: squireHome } });
    assertRefused(r, what);
    assertUnchanged(ownerBefore, world.owner, what);
  }
});

test('the installed core is a copy inside the Squire home: changing the release afterwards leaves it unchanged', { timeout: 120000 }, (t) => {
  const world = w.makeWorld();
  t.after(() => w.cleanUp(world));
  let r = layDown(world, w.CORE);
  assert.equal(r.status, 0, `laying down core must succeed; got ${w.describe(r)}`);
  const release = path.join(world.root, 'release-a');
  w.copyTree(w.CORE, release);
  r = layDown(world, release);
  assert.equal(r.status, 0, `laying down release A must succeed; got ${w.describe(r)}`);
  const home = fs.realpathSync(world.home);
  const installed = fs.realpathSync(path.join(world.home, 'core'));
  assert.ok(installed.startsWith(home + path.sep), `the installed core must live inside the Squire home (${home}); it is ${installed}`);
  const walk = (dir) => {
    for (const name of fs.readdirSync(dir)) {
      const abs = path.join(dir, name);
      const st = fs.lstatSync(abs);
      if (st.isSymbolicLink()) {
        assert.ok(fs.realpathSync(abs).startsWith(home + path.sep), `the installed core must hold no link out of the Squire home: ${abs}`);
      } else if (st.isDirectory()) walk(abs);
    }
  };
  walk(installed);
  const before = w.treeOf(installed);

  fs.appendFileSync(path.join(release, 'hooks', 'pre-tool-use.py'), '\n# changed after the lay-down\n');
  fs.writeFileSync(path.join(release, 'tools', 'added-later.py'), 'print("added")\n');
  fs.rmSync(path.join(release, 'tools', 'secret.py'));
  assert.deepEqual(w.treeOf(installed), before, 'changing the release folder after a lay-down must leave the installed core unchanged');
});
