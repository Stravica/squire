'use strict';

// Code hygiene for the floor's command reading and the lay-down's layout
// checks, through their entry points. Bound to no criterion.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const w = require('../fixtures/squire-world.js');

function world(t) {
  const it = w.makeWorld();
  t.after(() => w.cleanUp(it));
  return it;
}

test('a command the floor cannot read as plain words is asked, and the ledger named inside a nested shell is never the session\'s', { timeout: 60000 }, (t) => {
  const it = world(t);
  const s = 'session-hygiene';
  for (const command of [
    'ls workspace\nrm workspace/files/notes.txt',
    'echo `rm workspace/files/notes.txt`',
    'find workspace -name "*.txt" -delete',
    'cat state/now.md > workspace/drafts/copy.md',
    'ls workspace &',
    'echo "unclosed',
  ]) {
    w.assertBlocked(w.attempt(it, s, w.tools.bash(command)), `the command ${JSON.stringify(command)}`);
  }
  const nested = w.tools.bash("sh -c 'rm state/approvals.jsonl'");
  w.assertBlocked(w.attempt(it, s, nested), 'removing the ledger from a nested shell');
  w.ownerSays(it, s, 'yes');
  w.assertBlocked(w.attempt(it, s, nested), 'removing the ledger from a nested shell, after a yes');
});

test('a release that holds the Squire home is refused before anything is copied', { timeout: 60000 }, (t) => {
  const it = world(t);
  const r = w.layDown(it, it.root);
  assert.equal(r.status, 1, `lay-down of a folder holding the Squire home must be refused; got ${w.describe(r)}`);
  assert.equal(require('node:fs').existsSync(path.join(it.home, 'core')), false, 'nothing may be laid down');
});
