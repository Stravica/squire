'use strict';

// Code hygiene for the floor's folding of names, through its entry point.
// Bound to no criterion. The Mac's disk compares a name in either Unicode
// form, an accent composed or decomposed, as the same file; the floor must
// compare paths the same way.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const w = require('../fixtures/squire-world.js');

test('a Read of a private file by the other Unicode form of an accented owner folder leaves the job holding private things', { timeout: 60000 }, (t) => {
  const it = w.makeWorld();
  t.after(() => w.cleanUp(it));
  it.owner = path.join(it.root, 'Café');
  w.seedOwnerFolder(it.owner);
  w.writeConfig(it);
  const real = path.join(it.owner, 'state', 'now.md');
  const decomposed = path.join(it.root, 'Café', 'state', 'now.md');
  let same;
  try {
    same = fs.statSync(decomposed).ino === fs.statSync(real).ino;
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  if (!same) {
    t.skip(`the volume holding the test world does not fold the two forms of an accent: ${decomposed} names no file`);
    return;
  }
  const s = 'session-hygiene-folded-accent';
  w.assertAllowed(w.attempt(it, s, w.tools.webSearch('wholesale flour prices')), 'a web search, the job\'s first call');
  w.assertAllowed(w.attempt(it, s, w.tools.read(decomposed)), `a Read of ${decomposed}`);
  const r = w.attempt(it, s, w.tools.gmailSend('someone@example.net', 'Re: Offer', 'Here is the order sheet.'));
  w.assertBlocked(r, 'a send after a web search and a Read of the owner state by the decomposed accent');
  assert.match(r.stderr, /split/i, `the Read must leave the job holding private things, so the send is refused as one job; got ${w.describe(r)}`);
});
