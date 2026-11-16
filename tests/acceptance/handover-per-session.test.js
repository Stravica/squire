'use strict';

// The handover note and the /clear prompt when more than one conversation
// runs, and after a note is picked up (AC-501-1, under its present wording),
// through the hooks as Claude Code runs them: the status line command core's
// settings set (its input on stdin, carrying the conversation's session id
// and context), core/hooks/user-prompt-submit.py on each of the owner's
// messages, and core/hooks/session-start.py at each start, its stdout
// reaching the new conversation.
//
// One conversation's context is its own: a reading from one conversation's
// status line never brings the handover ask into another. The plan's usage
// windows are the account's, the same in every conversation.
//
// After /clear the newest handover note is picked up once. Once it has been,
// a later /clear never brings an older note as "the handover note from the
// last conversation": it was not the last conversation's. At most one line
// may say older notes stay in the owner's folder (the rule and its wording
// are drafts the stage-keeper rules).
//
// A login whose status line carries no usage windows (no rate_limits) still
// has its conversation's context reading, kept per conversation whether or
// not the windows are there (ADR-006 line 2), so its handover ask still comes.
//
// Usage model for the trigger (assumptions, none measured; as the handover
// note's own cases):
//   typical  an everyday conversation, context 20%: no handover asked.
//   heavy    a long conversation beside it, context 76%: the handover asked
//            there only; the weekly window at 75% is said in either.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const w = require('../fixtures/squire-world.js');
const s = require('../fixtures/session-world.js');
const U = require('../fixtures/usage-world.js');

function started(world, sessionId, source) {
  const r = s.recordSessionByHook(world, { sessionId, source });
  assert.equal(r.status, 0, `the SessionStart hook (${source}) must exit 0; got ${w.describe(r)}`);
  return r;
}

function statusLine(world, sessionId, context) {
  const r = U.runStatusLine(world, U.statusInput(world, {
    sessionId,
    context,
    rateLimits: {
      fiveHour: { used: 30, resetsAt: U.onMinute(U.now() + 3 * 3600) },
      sevenDay: { used: 75, resetsAt: U.onMinute(U.now() + 4 * U.DAY) },
    },
  }));
  assert.equal(r.status, 0, `the status line command must run and exit 0; got ${w.describe(r)}`);
}

test("one conversation's context reading never brings the handover ask into another running beside it, while the plan's windows are the account's in every conversation", { timeout: 60000 }, (t) => {
  const world = U.usageWorld(t);
  started(world, 'job-quiet', 'startup');
  started(world, 'job-busy', 'startup');
  started(world, 'job-new', 'startup');
  statusLine(world, 'job-quiet', 20);
  statusLine(world, 'job-busy', 76);

  const quiet = w.ownerSays(world, 'job-quiet', 'Next supplier on the list, please');
  assert.doesNotMatch(quiet.stdout, /handover/i,
    `a conversation whose own context is at 20% gets no handover ask from another conversation at 76%; got ${w.describe(quiet)}`);
  assert.match(quiet.stdout, /weekly/i, `the weekly window at 75% is the account's: it is said in this conversation too; got ${w.describe(quiet)}`);
  assert.ok(quiet.stdout.includes('75%'), `the weekly line names the account's usage; got ${w.describe(quiet)}`);
  const fresh = w.ownerSays(world, 'job-new', 'Good morning');
  assert.doesNotMatch(fresh.stdout, /handover/i,
    `a conversation with no context reading of its own gets no handover ask from another's; got ${w.describe(fresh)}`);
  const busy = w.ownerSays(world, 'job-busy', 'And the one after that');
  assert.match(busy.stdout, /handover/i, `the conversation at 76% context is asked for its handover note; got ${w.describe(busy)}`);
});

const NOTE = [
  '# Handover',
  'Work in progress: the garden shed comparison, three of five suppliers priced.',
  'Next: price Pembury and Ashdown, then the summary table in workspace/sheds.md.',
  '',
].join('\n');

const OLDER_NOTE = [
  '# Handover',
  'Work in progress: the boiler service quotes, two of four firms asked.',
  'Next: ask Northgate and Ferris, then compare in workspace/boiler.md.',
  '',
].join('\n');

const noteFile = (world, session) => path.join(world.owner, 'state', 'handover', `${session}.md`);

function saveNote(world, session, text) {
  const file = noteFile(world, session);
  w.assertAllowed(w.attempt(world, session, w.tools.write(file, text)), 'the session saving its handover note, a new file in the owner\'s folder');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return file;
}

test('after the newest handover note is picked up, a later /clear never brings an older note as the handover from the last conversation', { timeout: 60000 }, (t) => {
  // Heavy: two long conversations in a day, each saving its note, the older first.
  const world = U.usageWorld(t);
  started(world, 'job-older', 'startup');
  const older = saveNote(world, 'job-older', OLDER_NOTE);
  const hourAgo = new Date(Date.now() - 3600 * 1000);
  fs.utimesSync(older, hourAgo, hourAgo);
  started(world, 'job-newer', 'startup');
  saveNote(world, 'job-newer', NOTE);

  const first = started(world, 'job-after', 'clear');
  assert.ok(first.stdout.includes(NOTE.trim()), `the first /clear picks up the newest note whole; got ${w.describe(first)}`);
  for (const [n, id] of [[2, 'job-after-again'], [3, 'job-after-that']]) {
    const later = started(world, id, 'clear');
    assert.doesNotMatch(later.stdout, /from the last conversation/i,
      `/clear number ${n}: an older note is never brought as the handover from the last conversation; got ${w.describe(later)}`);
    assert.ok(!later.stdout.includes(OLDER_NOTE.split('\n')[1]), `/clear number ${n}: the older note is not brought into the new conversation; got ${w.describe(later)}`);
    assert.ok(later.stdout.trim().split('\n').filter(Boolean).length <= 1, `/clear number ${n}: at most one line, saying older notes stay in the owner's folder; got ${w.describe(later)}`);
  }
  assert.ok(fs.existsSync(older), 'the older note is never deleted');
});

test("a conversation whose status line carries no usage windows still gets the handover ask on its next message once its own context reaches 76%", { timeout: 60000 }, (t) => {
  // A login whose status line input has no rate_limits (before the first
  // answer of a session, or a plan that carries none): the context reading
  // is still the conversation's own, so nothing is lost at /clear.
  const world = U.usageWorld(t);
  started(world, 'job-long', 'startup');
  const r = U.runStatusLine(world, U.statusInput(world, { sessionId: 'job-long', context: 76, rateLimits: null }));
  assert.equal(r.status, 0, `the status line command must run and exit 0 with no usage windows in its input; got ${w.describe(r)}`);
  const next = w.ownerSays(world, 'job-long', 'Carry on with the supplier list');
  assert.match(next.stdout, /handover/i,
    `a conversation at 76% context with no usage windows in its status line is asked for its handover note on its next message; got ${w.describe(next)}`);
});
