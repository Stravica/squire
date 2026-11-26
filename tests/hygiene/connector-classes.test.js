'use strict';

// Code hygiene for the floor's reading of the owner's connector classes
// (connectorTools { read, draft } in the owner's squire.json), through its
// entry point. Bound to no criterion. The classes are read whole on every
// call or not at all: a file that cannot be read, classes of another shape and
// a name in both classes free nothing, and every connector tool is then asked.
// The tool names here are this file's own invention.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const w = require('../fixtures/squire-world.js');

const READ = 'mcp__example_notes__read_note';
const DRAFT = 'mcp__example_notes__keep_draft';
const SEND = 'mcp__example_notes__send_note';
const input = { note: 'n-1' };

function world(t) {
  const it = w.makeWorld();
  t.after(() => w.cleanUp(it));
  return it;
}

const ownerConfig = (it) => path.join(it.owner, 'squire.json');
function plant(it, text) {
  fs.writeFileSync(ownerConfig(it), text);
}
function asked(r, what) {
  w.assertBlocked(r, what);
  assert.ok(w.requestIdIn(r.stderr), `${what}: asked, with a request; got ${w.describe(r)}`);
  assert.doesNotMatch(r.stderr, /split/i, `${what}: asked, not split; got ${w.describe(r)}`);
}

test('classes that cannot be read whole free nothing: an owner\'s squire.json that is not JSON, not an object, or holds classes of another shape, and a name in both classes, leave every connector tool asked', { timeout: 60000 }, (t) => {
  const it = world(t);
  const cases = [
    ['a file that is not JSON', '{"connectorTools": {"read": ["' + READ + '"]'],
    ['a file holding a list', JSON.stringify([{ connectorTools: { read: [READ], draft: [DRAFT] } }])],
    ['classes that are a list', JSON.stringify({ connectorTools: [READ, DRAFT] })],
    ['a class that is a name, not a list', JSON.stringify({ connectorTools: { read: READ, draft: DRAFT } })],
    ['a class holding something other than names', JSON.stringify({ connectorTools: { read: [READ, 7], draft: [DRAFT] } })],
    ['a name in both classes', JSON.stringify({ connectorTools: { read: [READ, DRAFT], draft: [DRAFT, READ] } })],
  ];
  cases.forEach(([what, text], i) => {
    plant(it, text);
    asked(w.attempt(it, `session-classes-${i}-read`, w.tools.mcp(READ, input)), `${READ} with ${what}`);
    asked(w.attempt(it, `session-classes-${i}-draft`, w.tools.mcp(DRAFT, input)), `${DRAFT} with ${what}`);
  });
});

test('classes read whole are read again at every call: an allowed read runs and marks its job, a draft runs and marks nothing, and a class the owner takes away is asked at the next call', { timeout: 60000 }, (t) => {
  const it = world(t);
  plant(it, JSON.stringify({ connectorTools: { read: [READ], draft: [DRAFT] } }, null, 2));
  w.assertAllowed(w.attempt(it, 'session-read', w.tools.mcp(READ, input)), `${READ}, allowed for reading`);
  const split = w.attempt(it, 'session-read', w.tools.mcp(SEND, input));
  w.assertBlocked(split, `${SEND} after the allowed read`);
  assert.match(split.stderr, /split/i, `the allowed read marked its job, so a send there is split; got ${w.describe(split)}`);
  w.assertAllowed(w.attempt(it, 'session-draft', w.tools.mcp(DRAFT, input)), `${DRAFT}, classed as drafting`);
  asked(w.attempt(it, 'session-draft', w.tools.mcp(SEND, input)), `${SEND} after a draft, which marks nothing`);
  plant(it, JSON.stringify({ connectorTools: { read: [], draft: [DRAFT] } }, null, 2));
  asked(w.attempt(it, 'session-after', w.tools.mcp(READ, input)), `${READ} once the owner took it out of his read class`);
});
