'use strict';

// Code hygiene for Claude Code's own update channel in Squire's session.
// Bound to no criterion. Claude Code updates itself outside Squire; core's
// settings keep it on the stable channel, and lay-down lays the same
// settings into Squire's config folder, where the floor's equality guards
// them.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const w = require('../fixtures/squire-world.js');
const s = require('../fixtures/session-world.js');

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

test('core\'s settings keep Claude Code on its stable update channel, and lay-down lays the same settings into Squire\'s config folder', { timeout: 60000 }, (t) => {
  const world = w.makeWorld();
  t.after(() => { s.killFakes(world); w.cleanUp(world); });
  const core = readJson(path.join(w.CORE, 'settings.json'));
  assert.equal(core.autoUpdatesChannel, 'stable', 'core/settings.json must set autoUpdatesChannel to "stable"');
  s.layDownCore(world);
  const laid = readJson(path.join(s.configDir(world), 'settings.json'));
  assert.equal(laid.autoUpdatesChannel, 'stable', 'Squire\'s config folder must carry the stable update channel');
  assert.deepEqual(laid, core, 'the config folder\'s settings must equal core\'s');
});
