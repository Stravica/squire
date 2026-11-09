'use strict';

// The Squire's name and personality: set by set-up's naming step in the
// owner's squire.json (the owner's own file), and written by lay-down, at
// every lay-down, and by the runner, before every start, into CLAUDE.md in
// Squire's Claude Code config folder, which Claude Code loads as the user's
// own instructions for Squire's session (measured under Remote Control: the
// design record's line 15). The name is also the session's --name.
//
// In round 3 "after Squire is updated" reads "after core is laid down again":
// a second release, a changed core, is laid down over the first. The reply
// that names the Squire is the first-run journey's.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const w = require('../fixtures/squire-world.js');
const s = require('../fixtures/session-world.js');
const I = require('../fixtures/installer-world.js');

const NAME = 'Juniper';
const PERSONALITY = 'Warm, brief and dry';

function personaWorld(t) {
  const world = w.makeWorld();
  t.after(() => { s.killFakes(world); w.cleanUp(world); });
  fs.writeFileSync(path.join(world.owner, 'squire.json'), JSON.stringify({ squireName: NAME, personality: PERSONALITY }, null, 2) + '\n');
  return world;
}

const loaded = (world) => path.join(s.configDir(world), 'CLAUDE.md');
const readLoaded = (world) => (fs.existsSync(loaded(world)) ? fs.readFileSync(loaded(world), 'utf8') : '');

function assertInLoaded(world, what) {
  const text = readLoaded(world);
  assert.ok(text.includes(NAME), `${what}: what the session loads (claude-config/CLAUDE.md) must hold the name ${NAME}; got ${JSON.stringify(text.slice(0, 300))}`);
  assert.ok(text.includes(PERSONALITY), `${what}: what the session loads must hold the personality "${PERSONALITY}"; got ${JSON.stringify(text.slice(0, 300))}`);
}

// A second release: this repository's core with one file more, as a changed
// core would be.
function secondRelease(world) {
  const release = path.join(world.root, 'release-2', 'core');
  w.copyTree(w.CORE, release);
  fs.writeFileSync(path.join(release, 'tools', 'release-note.txt'), 'A later release of core.\n');
  return release;
}

async function startedName(world, t) {
  const fake = s.installFakeClaudeCode(world);
  const runner = s.startRunner(world);
  t.after(() => runner.stop());
  const call = await s.waitFor(() => fake.serverCalls().slice(-1)[0], 30000);
  await runner.stop();
  assert.ok(call, `the runner must start a session; runner output: ${runner.output()}`);
  const i = call.argv.indexOf('--name');
  return i >= 0 ? call.argv[i + 1] : null;
}

test('set-up\'s naming step writes the name and personality the owner gives into the owner\'s squire.json', { timeout: 120000 }, async (t) => {
  const iw = I.makeInstallerWorld(t);
  const run = await I.runApp(iw, { killWhen: (x) => I.doneSteps(x).includes('ownerFolder') });
  const config = I.ownerConfig(iw);
  assert.ok(config, `the owner's squire.json must exist in ~/Squire; got ${I.describeRun(run)}`);
  assert.equal(config.squireName, NAME, 'the owner\'s squire.json must hold the name given');
  assert.equal(config.personality, PERSONALITY, 'the owner\'s squire.json must hold the personality given');
});

test('lay-down writes the name and personality into what Squire\'s session loads', { timeout: 60000 }, (t) => {
  const world = personaWorld(t);
  s.layDownCore(world);
  assertInLoaded(world, 'after lay-down');
});

test('after a fresh start the name and personality are present and unchanged in what the session loads, and the session carries the name', { timeout: 120000 }, async (t) => {
  const world = personaWorld(t);
  s.layDownCore(world);
  const owner = fs.readFileSync(path.join(world.owner, 'squire.json'));
  fs.rmSync(loaded(world), { force: true });
  const name = await startedName(world, t);
  assertInLoaded(world, 'after a fresh start');
  assert.equal(name, NAME, 'the session\'s --name must be the Squire\'s name');
  assert.ok(fs.readFileSync(path.join(world.owner, 'squire.json')).equals(owner), 'the owner\'s squire.json must be unchanged');
});

test('after core is laid down again from a changed release, the name and personality are unchanged in what the session loads and in its name', { timeout: 120000 }, async (t) => {
  const world = personaWorld(t);
  s.layDownCore(world);
  const owner = fs.readFileSync(path.join(world.owner, 'squire.json'));
  s.layDownCore(world, secondRelease(world));
  assert.ok(fs.existsSync(path.join(s.installedCore(world), 'tools', 'release-note.txt')), 'the changed core must be the one laid down');
  assertInLoaded(world, 'after core is laid down again');
  const name = await startedName(world, t);
  assertInLoaded(world, 'after core is laid down again and the session starts');
  assert.equal(name, NAME, 'the session\'s --name must still be the Squire\'s name');
  assert.ok(fs.readFileSync(path.join(world.owner, 'squire.json')).equals(owner), 'the owner\'s squire.json must be unchanged');
});
