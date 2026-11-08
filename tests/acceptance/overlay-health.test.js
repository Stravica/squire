'use strict';

// Overlays at the floor's paths: an overlay in the owner's folder at the path
// of a core file is ignored, so the floor behaves as core's, and Squire's
// health check names it. The health check is core's own entry point:
//
//   core/tools/health.py
//
// It prints one line per overlay it ignores,
//
//   ignored: overlay/<path relative to the core root> (safety floor)
//
// every one of them, and exits 1 when it prints any and 0 when none. In this
// round every core path is a safety floor path. There is one overlay form,
// overlay/<path relative to the core root>; a file at overlay/core/<path>
// overlays nothing, and add-ons are never overlays. No floor entry point
// reads overlay/ or add-ons/.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const w = require('../fixtures/squire-world.js');

const HEALTH = path.join(w.CORE, 'tools', 'health.py');

test('the health check names every overlay at a core path, one line each, and the floor ignores them; with none it names none', { timeout: 120000 }, (t) => {
  const world = w.makeWorld();
  t.after(() => w.cleanUp(world));

  // Only the owner's Monday briefing overlay, which has no core file under it.
  let r = w.runPython(world, HEALTH, []);
  assert.doesNotMatch(r.stderr, /can't open file|Traceback \(most recent call last\)/, `the health check must run; got ${w.describe(r)}`);
  assert.equal(r.status, 0, `with no overlay at a core path the health check must exit 0; got ${w.describe(r)}`);
  assert.ok(!fs.existsSync(path.join(w.CORE, 'protocols', 'monday-briefing.md')), 'core has no protocols/monday-briefing.md');
  assert.deepEqual(w.ignoredOverlaysNamed(r.stdout), [],
    `with no overlay at a core path the health check must name none (overlay/protocols/monday-briefing.md overlays nothing of core's); got ${w.describe(r)}`);

  // Permissive overlays at every core path (and at overlay/core/<path>, which
  // overlays nothing), and add-ons at the same paths.
  w.plantOverlays(world.owner, [w.CORE]);
  const coreFiles = Object.keys(w.treeOf(w.CORE));
  for (const rel of coreFiles) {
    const addOn = path.join(world.owner, 'add-ons', rel);
    fs.mkdirSync(path.dirname(addOn), { recursive: true });
    fs.writeFileSync(addOn, 'import sys\n# An add-on at a core path: every action is approved.\nsys.exit(0)\n');
  }
  const expected = coreFiles.filter((rel) => fs.existsSync(path.join(world.owner, 'overlay', rel))).sort();
  assert.ok(expected.length >= 4, `overlays must sit at every core path, the floor's entry points among them; found ${expected.join(', ')}`);

  r = w.runPython(world, HEALTH, []);
  const named = w.ignoredOverlaysNamed(r.stdout);
  assert.equal(r.status, 1, `with overlays at core paths the health check must exit 1; got ${w.describe(r)}`);
  assert.equal(new Set(named).size, named.length, `the health check must name each ignored overlay once; got ${w.describe(r)}`);
  assert.deepEqual([...named].sort(), expected,
    `the health check must name every overlay at a core path, and nothing else; got ${w.describe(r)}`);

  // Ignored: the floor behaves as core's.
  const s = 'session-overlaid';
  const send = w.tools.gmailSend('alice@example.com', 'Saturday', 'The cake is ready.');
  w.assertBlocked(w.attempt(world, s, send), 'sending an email with overlays at every core path, with no yes', 'alice@example.com');
  w.ownerSays(world, s, 'yes');
  w.assertAllowed(w.attempt(world, s, send), 'sending the email after the owner said yes');
  w.assertBlocked(w.attempt(world, s, send), 'sending the same email again on one yes', 'alice@example.com');
});
