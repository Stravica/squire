'use strict';

// Self-fix first: the health check's known fixes (the design record's line
// 17), each checked by the health check itself. The runner not running: reload
// Squire's agents. A floor file changed: lay core down again from the release
// set-up recorded in set-up.json. Not signed in: open Squire's installer to
// sign in again, a fix the owner makes. A moved settings file: named only.
// A fix that changes anything is a command the health check prints,
// /usr/bin/python3 <Squire home>/core/tools/health.py --fix runner|floor,
// which the session runs only after the owner's yes (driven here through the
// real floor hook); the fix then runs the check again and says plainly when
// the fault is still there. A fault not on the list is named and nothing is
// offered. The ticket half is a later round's; no case reads tickets.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const w = require('../fixtures/squire-world.js');
const s = require('../fixtures/session-world.js');
const I = require('../fixtures/installer-world.js');

function fixWorld(t) {
  const world = w.makeWorld();
  t.after(() => { s.killFakes(world); w.cleanUp(world); });
  world.system = path.join(world.root, 'system');
  fs.mkdirSync(world.system, { recursive: true });
  // The release set-up laid core down from, as set-up records it.
  world.release = path.join(world.root, 'release', 'core');
  w.copyTree(w.CORE, world.release);
  s.layDownCore(world, world.release);
  fs.writeFileSync(path.join(world.home, 'set-up.json'),
    JSON.stringify({ done: I.STEPS, added: [], release: world.release }, null, 2) + '\n');
  return world;
}

const healthScript = (world) => path.join(world.home, 'core', 'tools', 'health.py');
const fixCommand = (world, which) => `${w.PYTHON} ${healthScript(world)} --fix ${which}`;

function health(world, args = []) {
  return w.runPython(world, healthScript(world), args, { cwd: world.root, env: { SQUIRE_SYSTEM_ROOT: world.system } });
}

const linesWith = (r, re) => r.stdout.split('\n').filter((l) => re.test(l));

// The session runs the fix the health check printed: the floor asks the owner,
// and lets it through only after the owner's yes.
function throughTheFloorAfterYes(world, command, what) {
  const session = 'session-fix';
  const call = w.tools.bash(command);
  w.assertBlocked(w.attempt(world, session, call), `${what}, with no yes`);
  w.ownerSays(world, session, 'yes');
  w.assertAllowed(w.attempt(world, session, call), `${what}, after the owner said yes`);
}

test('a changed floor file is named and its fix offered; the fix runs only after the owner\'s yes, lays core down again from the release, and the check then finds it gone', { timeout: 120000 }, (t) => {
  const world = fixWorld(t);
  const changed = path.join(world.home, 'core', 'hooks', 'config-change.py');
  fs.appendFileSync(changed, '# one line more\n');
  const h = health(world);
  assert.ok(linesWith(h, /config-change\.py/).length >= 1, `the health check must name the changed floor file; got ${w.describe(h)}`);
  assert.ok(h.stdout.includes(fixCommand(world, 'floor')), `the health check must offer its fix, ${fixCommand(world, 'floor')}; got ${w.describe(h)}`);
  throughTheFloorAfterYes(world, fixCommand(world, 'floor'), 'the floor fix');
  const fixed = health(world, ['--fix', 'floor']);
  assert.doesNotMatch(fixed.stderr, /Traceback/, `the fix must run; got ${w.describe(fixed)}`);
  assert.ok(fs.readFileSync(changed).equals(fs.readFileSync(path.join(world.release, 'hooks', 'config-change.py'))),
    'the fix must lay core down again from the release set-up recorded');
  assert.deepEqual(linesWith(health(world), /config-change\.py/), [], 'after the fix the check must no longer name the floor file');
});

test('the runner not running is named and its fix offered; the fix runs only after the owner\'s yes, and when it cannot bring the runner back it says plainly the fault is still there', { timeout: 120000 }, (t) => {
  const world = fixWorld(t);
  const h = health(world);
  assert.ok(linesWith(h, /runner/i).some((l) => /not running/i.test(l)), `the health check must name the runner not running; got ${w.describe(h)}`);
  assert.ok(h.stdout.includes(fixCommand(world, 'runner')), `the health check must offer its fix, ${fixCommand(world, 'runner')}; got ${w.describe(h)}`);
  throughTheFloorAfterYes(world, fixCommand(world, 'runner'), 'the runner fix');
  // A world's agents never reach launchd, so the reload cannot bring it back.
  const fixed = health(world, ['--fix', 'runner']);
  assert.match(fixed.stdout, /still/i, `the fix must say plainly that the runner is still not running; got ${w.describe(fixed)}`);
  assert.ok(linesWith(health(world), /runner/i).some((l) => /not running/i.test(l)), 'the check still names it');
});

test('not signed in is named with the way on, opening Squire\'s installer to sign in again, and no command is offered for it', { timeout: 120000 }, (t) => {
  const world = fixWorld(t);
  s.installFakeClaudeCode(world, { signedIn: false });
  const h = health(world);
  const lines = linesWith(h, /sign in again/i);
  assert.ok(lines.length >= 1 && lines.every((l) => /installer/i.test(l)), `the health check must say to open Squire's installer to sign in again; got ${w.describe(h)}`);
  assert.ok(lines.every((l) => !l.includes('--fix')), 'no command is offered for the sign-in: it is the owner\'s to make');
});

test('a moved settings file and a fault not on the list are named, and nothing is offered for either', { timeout: 120000 }, (t) => {
  // A regression guard: the health check named both, with no fix, at the
  // round's base; it stays so the known fixes never grow onto the owner's
  // own files or onto faults Squire cannot fix.
  const world = fixWorld(t);
  const moved = path.join(world.home, 'moved-settings', 'settings.local.json');
  fs.mkdirSync(path.dirname(moved), { recursive: true });
  fs.writeFileSync(moved, '{"hooks": {}}\n');
  w.plantOverlays(world.owner, [w.CORE]);
  const h = health(world);
  const movedLines = linesWith(h, /settings\.local\.json/);
  const overlayLines = linesWith(h, /^ignored: overlay\//);
  assert.ok(movedLines.length >= 1, `the health check must name the moved settings file; got ${w.describe(h)}`);
  assert.ok(overlayLines.length >= 1, `the health check must name the ignored overlays; got ${w.describe(h)}`);
  for (const l of [...movedLines, ...overlayLines]) assert.ok(!l.includes('--fix'), `nothing may be offered for: ${l}`);
  assert.ok(!/--fix (?!runner\b|floor\b)/.test(h.stdout), `no fix beyond the known list may be offered; got ${w.describe(h)}`);
});
