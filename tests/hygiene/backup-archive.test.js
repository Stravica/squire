'use strict';

// Code hygiene for the nightly backup, through its entry point
// (core/tools/backup.py): runs within one second each get an archive folder
// of their own, a half-written copy left by a stopped run at the top of the
// destination (where the backup writes its copies, never among the owner's
// files) is cleared at the next start, and a link in the owner's folder is
// copied as a link, never followed. Bound to no criterion.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const w = require('../fixtures/squire-world.js');
const s = require('../fixtures/session-world.js');

function backupWorld(t) {
  const world = w.makeWorld();
  t.after(() => w.cleanUp(world));
  s.layDownCore(world);
  world.destination = path.join(world.root, 'backups', 'Squire Backup');
  fs.mkdirSync(path.dirname(world.destination), { recursive: true });
  w.writeConfig(world, { backupFolder: world.destination });
  return world;
}

function backup(world) {
  const r = w.runPython(world, path.join(s.installedCore(world), 'tools', 'backup.py'), [], { cwd: '/' });
  assert.doesNotMatch(r.stderr, /Traceback/, `the backup job must run; got ${w.describe(r)}`);
  assert.equal(r.status, 0, `the backup must pass; got ${w.describe(r)}`);
  return r;
}

test('runs within one second each move earlier copies into an archive folder of their own', { timeout: 60000 }, (t) => {
  const world = backupWorld(t);
  const file = path.join(world.owner, 'list.md');
  for (const text of ['one\n', 'one two\n', 'one two three\n']) {
    fs.writeFileSync(file, text);
    backup(world);
  }
  const archives = fs.readdirSync(path.join(world.destination, 'archive')).sort();
  assert.equal(archives.length, 2, `two runs moved an earlier copy, so two archive folders; got ${archives.join(', ')}`);
  for (const name of archives) assert.match(name, /^\d{4}-\d{2}-\d{2}T\d{6}Z(-\d+)?$/, `an archive folder is named by its run's UTC time; got ${name}`);
  const kept = archives.map((name) => fs.readFileSync(path.join(world.destination, 'archive', name, 'list.md'), 'utf8')).sort();
  assert.deepEqual(kept, ['one\n', 'one two\n'], 'each earlier copy must be kept whole');
});

test('a half-written copy left by a stopped run, at the top of the destination where the backup writes its copies, is cleared at the next start, no copy is written among the owner\'s files, and a link is copied as a link', { timeout: 60000 }, (t) => {
  const world = backupWorld(t);
  backup(world);
  const partial = path.join(world.destination, '.squire-partial-left-behind');
  fs.writeFileSync(partial, 'half');
  fs.symlinkSync('/nonexistent/elsewhere', path.join(world.owner, 'pointer'));
  fs.writeFileSync(path.join(world.owner, 'letter.md'), 'Dear Mr Hale, about Thursday.\n');
  backup(world);
  assert.ok(!fs.existsSync(partial), 'the half-written copy must be cleared');
  assert.deepEqual(fs.readdirSync(world.destination).filter((n) => n !== 'current' && n !== 'archive'), [],
    'after a run, the top of the destination holds only current/ and archive/');
  assert.equal(fs.readFileSync(path.join(world.destination, 'current', 'letter.md'), 'utf8'), 'Dear Mr Hale, about Thursday.\n',
    'a file copied through the top of the destination must land whole in current/');
  const copied = path.join(world.destination, 'current', 'pointer');
  assert.ok(fs.lstatSync(copied).isSymbolicLink(), 'the link must be copied as a link');
  assert.equal(fs.readlinkSync(copied), '/nonexistent/elsewhere', 'the link must keep its target');
});
