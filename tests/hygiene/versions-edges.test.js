'use strict';

// Code hygiene for Squire's versions command (core/tools/versions.py),
// through its entry point: what it refuses changes nothing, a folder's links
// and subfolders come back as they were kept, and going back to the version
// the folder is already as keeps no copy of it. Bound to no criterion.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const w = require('../fixtures/squire-world.js');

const VERSIONS = path.join(w.CORE, 'tools', 'versions.py');

function world(t) {
  const it = w.makeWorld();
  t.after(() => w.cleanUp(it));
  return it;
}

const numbersIn = (r) => r.stdout.split('\n').map((l) => (l.trim().match(/^(\d+)\b/) || [])[1]).filter(Boolean).map(Number);

test('the versions command refuses a folder that is not there, a verb it does not take, a version not kept and a number that is not one, and changes nothing', { timeout: 60000 }, (t) => {
  const it = world(t);
  const run = (args) => w.runPython(it, VERSIONS, args, { timeout: 30000 });
  const folder = path.join(it.owner, 'workspace', 'apps', 'till');
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, 'index.html'), 'one\n');
  for (const [args, what] of [
    [['keep', path.join(it.owner, 'workspace', 'apps', 'not-there')], 'a folder that is not there'],
    [['push', folder], 'a verb it does not take'],
    [['keep', folder, 'extra'], 'an extra word'],
    [['back', folder, '1'], 'a version not kept yet'],
  ]) {
    const r = run(args);
    assert.equal(r.status, 1, `${what}: refused with exit 1; got ${w.describe(r)}`);
    assert.doesNotMatch(r.stderr, /Traceback/, `${what}: never a crash; got ${w.describe(r)}`);
  }
  assert.equal(fs.existsSync(path.join(it.home, 'versions')), false, 'nothing is kept by a refused command');
  assert.equal(run(['keep', folder]).status, 0, 'a version is kept');
  for (const number of ['2', 'one', '-1', '¹']) {
    const r = run(['back', folder, number]);
    assert.equal(r.status, 1, `going back to ${JSON.stringify(number)} is refused; got ${w.describe(r)}`);
  }
  assert.equal(fs.readFileSync(path.join(folder, 'index.html'), 'utf8'), 'one\n', 'the folder is unchanged');
  assert.deepEqual(numbersIn(run(['list', folder])), [1], 'one version is kept');
});

test('a folder with a link and a subfolder comes back as it was kept, and going back to the version the folder is already as keeps no copy of it', { timeout: 60000 }, (t) => {
  const it = world(t);
  const run = (args) => w.runPython(it, VERSIONS, args, { timeout: 30000 });
  const folder = path.join(it.owner, 'workspace', 'apps', 'shelf');
  fs.mkdirSync(path.join(folder, 'parts'), { recursive: true });
  fs.writeFileSync(path.join(folder, 'parts', 'list.js'), 'export const items = [];\n');
  fs.symlinkSync('parts/list.js', path.join(folder, 'list.js'));
  assert.equal(run(['keep', folder]).status, 0, 'version 1 is kept');
  fs.rmSync(path.join(folder, 'parts'), { recursive: true });
  fs.rmSync(path.join(folder, 'list.js'));
  fs.writeFileSync(path.join(folder, 'other.txt'), 'later\n');
  assert.equal(run(['keep', folder]).status, 0, 'version 2 is kept');
  assert.equal(run(['back', folder, '1']).status, 0, 'version 1 is got back');
  assert.deepEqual(fs.readdirSync(folder).sort(), ['list.js', 'parts'], 'the folder is whole as version 1 was');
  assert.equal(fs.readlinkSync(path.join(folder, 'list.js')), 'parts/list.js', 'the link comes back as a link to the same place');
  assert.equal(fs.readFileSync(path.join(folder, 'parts', 'list.js'), 'utf8'), 'export const items = [];\n', 'the subfolder comes back');
  assert.equal(run(['back', folder, '1']).status, 0, 'going back to version 1 again succeeds');
  assert.deepEqual(numbersIn(run(['list', folder])), [1, 2], 'going back to the version the folder is already as keeps no copy of it');
});
