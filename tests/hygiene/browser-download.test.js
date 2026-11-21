'use strict';

// Code hygiene for set-up's download of Squire's built-in browser
// (sq_browser and sq_browser_unpack in the app's executable), through set-up's
// own entry point: an archive whose entry climbs out of its place, whose link
// points outside its own folder, or whose links climb out only together, is
// not kept, nothing of it lands outside the browser's place or is placed in
// it, and set-up pauses with the claudeCode step not done; and one whose
// links stay inside its folder is kept with them. The world's curl here
// serves the case's archive for the browser server's address and leaves
// every other download to the installer world's own curl. Bound to no
// criterion.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const I = require('../fixtures/installer-world.js');

const SERVER = /@playwright\/mcp\/-\/mcp-[^/]+\.tgz$/;

// The world's curl: the case's own archive for the browser server, made here
// with the Mac's own tar, and the world's own curl for everything else.
function serveServerPart(iw, how) {
  const curl = path.join(iw.system, 'usr', 'bin', 'curl');
  const theirs = path.join(iw.system, 'usr', 'bin', 'curl-of-the-world');
  fs.renameSync(curl, theirs);
  const made = path.join(iw.root, `hostile-${how}`);
  fs.mkdirSync(path.join(made, 'package'), { recursive: true });
  fs.writeFileSync(path.join(made, 'package', 'cli.js'), 'nothing\n');
  fs.writeFileSync(path.join(made, 'escaped.txt'), 'out of its place\n');
  if (how === 'link') fs.symlinkSync('../../../../escaped.txt', path.join(made, 'package', 'outside'));
  if (how === 'inside') {
    // Links as a real runtime and browser build hold them: up first, then
    // down, and never above the part's own folder.
    fs.mkdirSync(path.join(made, 'package', 'bin'), { recursive: true });
    fs.symlinkSync('../cli.js', path.join(made, 'package', 'bin', 'cli'));
    fs.symlinkSync('bin/cli', path.join(made, 'package', 'current'));
  }
  if (how === 'chain') {
    // Two links that each name a place inside the folder by their words, but
    // climb out together: B is the folder's own a/, so B/../../../.. from
    // a/b/c is three folders above the part.
    fs.mkdirSync(path.join(made, 'package', 'a', 'b', 'c'), { recursive: true });
    fs.symlinkSync('../../../a', path.join(made, 'package', 'a', 'b', 'c', 'B'));
    fs.symlinkSync('B/../../../../escaped.txt', path.join(made, 'package', 'a', 'b', 'c', 'A'));
  }
  const archive = path.join(iw.root, `hostile-${how}.tgz`);
  const args = how === 'climb'
    ? ['-czPf', archive, '-C', made, '-s', ',^escaped.txt,package/../../../escaped.txt,', 'package', 'escaped.txt']
    : ['-czf', archive, '-C', made, 'package'];
  const r = require('node:child_process').spawnSync('/usr/bin/tar', args);
  assert.equal(r.status, 0, `the hostile archive must be made; tar said ${r.stderr}`);
  fs.writeFileSync(curl, `#!${process.execPath}
const fs = require('fs');
const argv = process.argv.slice(2);
const url = argv.find((a) => /^https?:\\/\\//.test(a)) || '';
const i = argv.indexOf('-o');
if (${SERVER}.test(url) && i >= 0) { fs.copyFileSync(${JSON.stringify(archive)}, argv[i + 1]); process.exit(0); }
const r = require('child_process').spawnSync(${JSON.stringify(theirs)}, argv, { stdio: 'inherit' });
process.exit(r.status === null ? 1 : r.status);
`);
  fs.chmodSync(curl, 0o755);
}

const WHAT = {
  climb: 'whose entry climbs out of its place',
  link: 'whose link points outside its own folder',
  chain: 'whose two links climb out of its folder only together',
};

for (const how of Object.keys(WHAT)) {
  test(`an archive for the browser ${WHAT[how]} is not kept: nothing of it is placed or lands outside, and set-up pauses with the claudeCode step not done`, { timeout: 180000 }, async (t) => {
    const iw = I.makeInstallerWorld(t, { mac: { toolsPresent: false } });
    serveServerPart(iw, how);
    const run = await I.runApp(iw);
    const place = path.join(iw.squireHome, 'browser');
    assert.ok(!I.doneSteps(iw).includes('claudeCode'), `the claudeCode step must not be done; got ${I.describeRun(run)}`);
    assert.equal(fs.existsSync(path.join(place, 'server', 'node_modules', '@playwright', 'mcp')), false, 'the refused part must not be placed');
    const landed = Object.keys(I.contentOf(iw.root)).filter((rel) => path.basename(rel) === 'escaped.txt' && !rel.startsWith('hostile-'));
    assert.deepEqual(landed, [], 'nothing of the refused archive may land anywhere');
    const left = fs.existsSync(place) ? fs.readdirSync(place).filter((n) => n.startsWith('.')) : [];
    assert.deepEqual(left, [], 'no download or unpacking folder may be left behind in the browser\'s place');
  });
}

test("an archive for the browser whose links stay inside its own folder is kept with its links, and set-up finishes", { timeout: 180000 }, async (t) => {
  const iw = I.makeInstallerWorld(t, { mac: { toolsPresent: false } });
  serveServerPart(iw, 'inside');
  const run = await I.runApp(iw);
  assert.deepEqual(I.doneSteps(iw), I.STEPS, `set-up must finish; got ${I.describeRun(run)}`);
  const placed = path.join(iw.squireHome, 'browser', 'server', 'node_modules', '@playwright', 'mcp');
  assert.equal(fs.readlinkSync(path.join(placed, 'bin', 'cli')), '../cli.js', 'the part\'s own link is kept as it was');
  assert.equal(fs.readFileSync(path.join(placed, 'current'), 'utf8'), 'nothing\n', 'the part\'s links lead to its own files in its place');
});
