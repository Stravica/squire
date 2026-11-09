'use strict';

// Claude Code's auto-compact window for Squire's session: 500k tokens, set
// in core's settings and laid into Squire's config folder by lay-down (the
// design record's line 14: a settings key that reaches a session started as
// the runner starts it, measured), and guarded by the health check, which
// reads every source it knows and names any value other than 500000, or says
// it cannot confirm the window when a source it should read cannot be read.
//
// The system places (the managed settings file, its drop-in folder, the
// managed preferences) are read under SQUIRE_SYSTEM_ROOT, the world's own
// folder: the one way a test reaches a place only an administrator writes.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const w = require('../fixtures/squire-world.js');
const s = require('../fixtures/session-world.js');

const WINDOW = 500000;
const MANAGED = path.join('Library', 'Application Support', 'ClaudeCode');
const PREFERENCES = path.join('Library', 'Managed Preferences', 'com.anthropic.claudecode.plist');

function windowWorld(t) {
  const world = w.makeWorld();
  t.after(() => { s.killFakes(world); w.cleanUp(world); });
  world.system = path.join(world.root, 'system');
  fs.mkdirSync(world.system, { recursive: true });
  s.layDownCore(world);
  return world;
}

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const writeJson = (file, data) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n'); };
const configSettings = (world) => path.join(s.configDir(world), 'settings.json');

function writePlist(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const r = spawnSync('/usr/bin/plutil', ['-convert', 'binary1', '-o', file, '-'], { input: JSON.stringify(data) });
  assert.equal(r.status, 0, `plutil must write ${file}`);
}

// The installed health check, with the system places under the world's.
function health(world) {
  return w.runPython(world, path.join(s.installedCore(world), 'tools', 'health.py'), [],
    { cwd: world.root, env: { SQUIRE_SYSTEM_ROOT: world.system } });
}

// The health check's lines about the compaction window.
const windowLines = (r) => r.stdout.split('\n').filter((l) => /compact/i.test(l));

function assertNamed(world, value, source, what) {
  const r = health(world);
  const lines = windowLines(r);
  assert.ok(lines.some((l) => l.includes(String(value)) && l.includes(source)),
    `${what}: the health check must name the window ${value} and its source (${source}); got ${w.describe(r)}`);
  assert.notEqual(r.status, 0, `${what}: a window other than ${WINDOW} is never a pass; got ${w.describe(r)}`);
}

// ------------------------------------------------- the window is 500k

test("core's settings carry an auto-compact window of 500000 tokens, and lay-down lays the same settings into Squire's config folder", { timeout: 60000 }, (t) => {
  const core = readJson(path.join(w.CORE, 'settings.json'));
  assert.equal(core.autoCompactWindow, WINDOW, 'core/settings.json must set autoCompactWindow to 500000');
  const world = windowWorld(t);
  const laid = readJson(configSettings(world));
  assert.deepEqual(laid, core, 'the config folder\'s settings must be core\'s settings as laid down');
  assert.equal(laid.autoCompactWindow, WINDOW, 'Squire\'s session reads a window of 500000 from its config folder');
});

test("the window reaches Squire's session only from its config folder: the owner's own settings, a window variable around the runner and a stray --autocompact never reach it", { timeout: 120000 }, async (t) => {
  const world = windowWorld(t);
  writeJson(path.join(world.userHome, '.claude', 'settings.json'), { autoCompactWindow: 200000 });
  const fake = s.installFakeClaudeCode(world);
  const runner = s.startRunner(world, { env: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '200000', CLAUDE_CODE_AUTOCOMPACT: '200000' } });
  t.after(() => runner.stop());
  const started = await s.waitFor(() => fake.serverCalls()[0], 30000);
  assert.ok(started, `the runner must start the session; runner output: ${runner.output()}`);
  assert.ok(!started.envNames.some((n) => /AUTO_?COMPACT/i.test(n)), `no window variable may reach the session; it was given ${started.envNames.join(', ')}`);
  assert.ok(!started.argv.some((a) => /autocompact/i.test(a)), `no --autocompact may reach the session; its command line was ${started.argv.join(' ')}`);
  assert.equal(started.env.CLAUDE_CONFIG_DIR, s.configDir(world), 'the session reads Squire\'s config folder, never the owner\'s ~/.claude');
  assert.equal(readJson(configSettings(world)).autoCompactWindow, WINDOW, 'the config folder the session reads sets the window to 500000');
  await runner.stop();
});

// ------------------------------------------- the health check guards it

test("the health check names a window other than 500000 in Squire's config folder, at the top level and per model, and in the runner's environment", { timeout: 120000 }, (t) => {
  const world = windowWorld(t);
  const file = configSettings(world);
  const laid = readJson(file);
  writeJson(file, { ...laid, autoCompactWindow: 200000 });
  assertNamed(world, 200000, 'claude-config', 'the config folder\'s top-level window');
  writeJson(file, { ...laid, modelSettings: { 'claude-opus-5-5': { autoCompactWindow: 300000 } } });
  assertNamed(world, 300000, 'claude-opus-5-5', 'the config folder\'s window for one model');
  writeJson(file, laid);
  const agent = s.launchAgents(world).find((a) => a.plist.Label === 'com.stravica.squire.runner');
  assert.ok(agent, 'lay-down writes the runner\'s agent');
  writePlist(agent.file, { ...agent.plist, EnvironmentVariables: { ...agent.plist.EnvironmentVariables, CLAUDE_CODE_AUTO_COMPACT_WINDOW: '400000' } });
  assertNamed(world, 400000, 'CLAUDE_CODE_AUTO_COMPACT_WINDOW', 'a window variable in the runner\'s agent');
});

test("the health check names a window other than 500000 in the Mac's managed settings file, its drop-in folder and the managed preferences", { timeout: 120000 }, (t) => {
  const world = windowWorld(t);
  const managed = path.join(world.system, MANAGED, 'managed-settings.json');
  writeJson(managed, { autoCompactWindow: 250000 });
  assertNamed(world, 250000, 'managed-settings.json', 'the managed settings file');
  fs.rmSync(managed);
  writeJson(path.join(world.system, MANAGED, 'managed-settings.d', '50-team.json'), { autoCompactWindow: 260000 });
  assertNamed(world, 260000, '50-team.json', 'a managed settings drop-in');
  fs.rmSync(path.join(world.system, MANAGED), { recursive: true });
  writePlist(path.join(world.system, PREFERENCES), { autoCompactWindow: 270000 });
  assertNamed(world, 270000, 'com.anthropic.claudecode', 'the managed preferences');
});

test('a model whose context window is smaller than 500k is not drift: the health check names nothing about the window', { timeout: 60000 }, (t) => {
  // A regression guard: with no window line at all yet, this holds at the
  // round's base; it stays to keep the model's own cap from reading as drift.
  const world = windowWorld(t);
  writeJson(configSettings(world), { ...readJson(configSettings(world)), model: 'claude-haiku-4-5' });
  const r = health(world);
  assert.doesNotMatch(r.stderr, /can't open file|Traceback/, `the health check must run; got ${w.describe(r)}`);
  assert.deepEqual(windowLines(r), [], `a smaller model must not be named as window drift; got ${w.describe(r)}`);
});

// ------------------------------------------------ cannot confirm the window

// A source the health check should read that exists but cannot be read.
function unreadable(what, place, make) {
  return (t) => {
    const world = windowWorld(t);
    const file = make(world);
    if (file.endsWith('.plist')) writePlist(file, { autoCompactWindow: WINDOW });
    else writeJson(file, { autoCompactWindow: WINDOW });
    fs.chmodSync(file, 0o000);
    t.after(() => { try { fs.chmodSync(file, 0o600); } catch (e) { /* gone */ } });
    const r = health(world);
    const lines = windowLines(r);
    assert.ok(lines.some((l) => /cannot confirm the compaction window/i.test(l) && l.includes(place)),
      `${what} unreadable: the health check must say it cannot confirm the compaction window, naming ${place}; got ${w.describe(r)}`);
    assert.notEqual(r.status, 0, `${what} unreadable: never a pass; got ${w.describe(r)}`);
  };
}

test('when the managed settings file exists but cannot be read, the health check says it cannot confirm the compaction window and names it, never a pass and never silence', { timeout: 60000 },
  unreadable('the managed settings file', 'managed-settings.json', (world) => path.join(world.system, MANAGED, 'managed-settings.json')));
test('when a managed settings drop-in exists but cannot be read, the health check says it cannot confirm the compaction window and names it, never a pass and never silence', { timeout: 60000 },
  unreadable('a managed settings drop-in', '50-team.json', (world) => path.join(world.system, MANAGED, 'managed-settings.d', '50-team.json')));
test('when the managed preferences exists but cannot be read, the health check says it cannot confirm the compaction window and names it, never a pass and never silence', { timeout: 60000 },
  unreadable('the managed preferences', 'com.anthropic.claudecode', (world) => path.join(world.system, PREFERENCES)));
