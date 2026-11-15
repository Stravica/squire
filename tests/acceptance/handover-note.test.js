'use strict';

// A long conversation gets a handover note and a timely /clear prompt, and
// nothing is lost (AC-501-1, AC-501-2), through the hooks as Claude Code runs
// them: core/hooks/user-prompt-submit.py on each of the owner's messages (its
// plain stdout is added to the session's context: Squire's own note),
// core/hooks/session-start.py at each start with its source (startup, resume
// after a restart, compact, and clear after the owner types /clear; its
// stdout reaches the new conversation's context), and the safety floor for
// the session's own Write of the note. The usage snapshot carries the context
// used. The design record for plan awareness and the heavy-job gate (ADR-006
// line 8) fixes the note's place (state/handover/<session id>.md in the
// owner's folder), the triggers and the words read here ("handover",
// "/clear"); the rest of the wording is the builder's.
//
// Usage model for the triggers (assumptions, none measured; ADR-006's
// consequences):
//   typical  an everyday conversation: context under 70% (cases use 40% and
//            30%) and at most one compaction: no handover asked.
//   heavy    a long build or research conversation: context at 75%, or a
//            second compaction within the conversation: one handover, then
//            the /clear prompt at the next natural pause (the owner's next
//            message), again after a restart or a further compaction if the
//            owner carries on, and the note picked up after /clear however
//            late it comes.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const w = require('../fixtures/squire-world.js');
const s = require('../fixtures/session-world.js');
const U = require('../fixtures/usage-world.js');

const NOTE = [
  '# Handover',
  'Work in progress: the garden shed comparison, three of five suppliers priced.',
  'Done: Hartley (412 GBP), Barnes (389 GBP), Oakfield (455 GBP).',
  'Next: price Pembury and Ashdown, then the summary table in workspace/sheds.md.',
  '',
].join('\n');

const noteFile = (world, session) => path.join(world.owner, 'state', 'handover', `${session}.md`);

function started(world, sessionId, source) {
  const r = s.recordSessionByHook(world, { sessionId, source });
  assert.equal(r.status, 0, `the SessionStart hook (${source}) must exit 0; got ${w.describe(r)}`);
  return r;
}

function context(world, percent) {
  U.writeSnapshot(world, {
    context: percent,
    fiveHour: { used: 30, resetsAt: U.now() + 3 * 3600 },
    sevenDay: { used: 40, resetsAt: U.now() + 4 * U.DAY },
  });
}

// The session saves its handover note as it is asked to: the floor lets the
// Write through without a yes, and Claude Code writes the file.
function saveNote(world, session, text = NOTE) {
  const file = noteFile(world, session);
  w.assertAllowed(w.attempt(world, session, w.tools.write(file, text)), 'the session saving its handover note, a new file in the owner\'s folder');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return file;
}

const sha = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

test('at 70% context or after the second compaction Squire asks for the handover note to be saved, and asks the owner for /clear only once it is saved', { timeout: 60000 }, (t) => {
  // Context: typical 40%, then heavy 75%.
  const world = U.usageWorld(t);
  const job = 'job-long';
  started(world, job, 'startup');
  context(world, 40);
  const early = w.ownerSays(world, job, 'Next supplier on the list, please');
  assert.doesNotMatch(early.stdout, /handover/i, `at 40% context no handover is asked; got ${w.describe(early)}`);
  context(world, 75);
  const ask = w.ownerSays(world, job, 'And the one after that');
  assert.match(ask.stdout, /handover/i, `at 75% context Squire asks the session to save its handover note; got ${w.describe(ask)}`);
  assert.ok(ask.stdout.includes(noteFile(world, job)), `the ask names where the note goes (${noteFile(world, job)}); got ${w.describe(ask)}`);
  for (const [what, words] of [['the work in progress', /work in progress/i], ['what is done', /\bdone\b/i],
    ['what is next', /\bnext\b/i], ['where things are', /where things are/i]]) {
    assert.match(ask.stdout, words, `the ask says the note holds ${what}; got ${w.describe(ask)}`);
  }
  assert.doesNotMatch(ask.stdout, /\/clear/, `no /clear prompt before the note is saved; got ${w.describe(ask)}`);
  const notYet = w.ownerSays(world, job, 'ok');
  assert.doesNotMatch(notYet.stdout, /\/clear/, `still no /clear prompt while the note is not saved; got ${w.describe(notYet)}`);
  saveNote(world, job);
  const pause = w.ownerSays(world, job, 'Thanks, that is enough for now');
  assert.match(pause.stdout, /\/clear/, `once the note is saved, the next pause brings the /clear prompt; got ${w.describe(pause)}`);

  // Compactions: typical one, heavy two, with context low.
  const other = U.usageWorld(t);
  const long = 'job-compacted';
  started(other, long, 'startup');
  context(other, 30);
  started(other, long, 'compact');
  const once = w.ownerSays(other, long, 'Carry on with the letters');
  assert.doesNotMatch(once.stdout, /handover/i, `after one compaction no handover is asked; got ${w.describe(once)}`);
  started(other, long, 'compact');
  const twice = w.ownerSays(other, long, 'Next letter');
  assert.match(twice.stdout, /handover/i, `after the second compaction Squire asks for the handover note; got ${w.describe(twice)}`);
  assert.ok(twice.stdout.includes(noteFile(other, long)), `the ask names where the note goes; got ${w.describe(twice)}`);
  assert.doesNotMatch(twice.stdout, /\/clear/, `no /clear prompt before the note is saved; got ${w.describe(twice)}`);

  // An empty file at the note's place is not a saved note: no /clear prompt on the next message.
  const empty = U.usageWorld(t);
  const blank = 'job-empty-note';
  started(empty, blank, 'startup');
  context(empty, 75);
  w.ownerSays(empty, blank, 'Next supplier on the list, please');
  fs.mkdirSync(path.dirname(noteFile(empty, blank)), { recursive: true });
  fs.writeFileSync(noteFile(empty, blank), '');
  const afterEmpty = w.ownerSays(empty, blank, 'Thanks, that is enough for now');
  assert.doesNotMatch(afterEmpty.stdout, /\/clear/, `an empty file at the note's place is no saved note: no /clear prompt; got ${w.describe(afterEmpty)}`);
});

test('after /clear the new conversation picks up the work in progress from the handover note', { timeout: 60000 }, (t) => {
  const world = U.usageWorld(t);
  const before = 'job-before';
  started(world, before, 'startup');
  context(world, 75);
  w.ownerSays(world, before, 'Next supplier on the list, please');
  saveNote(world, before);
  w.ownerSays(world, before, 'Thanks, that is enough for now');
  const after = started(world, 'job-after', 'clear');
  assert.ok(after.stdout.includes(NOTE.trim()),
    `at the start after /clear the handover note reaches the new conversation whole; got ${w.describe(after)}`);

  // Typical: a /clear with no handover waiting brings none.
  const plain = U.usageWorld(t);
  started(plain, 'job-plain', 'startup');
  const cleared = started(plain, 'job-plain-next', 'clear');
  assert.doesNotMatch(cleared.stdout, /handover/i, `a /clear with no note waiting brings no handover; got ${w.describe(cleared)}`);
});

test('a handover note saved before a late /clear, or before the laptop is closed, survives and the work carries on from it with nothing lost', { timeout: 60000 }, (t) => {
  const world = U.usageWorld(t);
  const job = 'job-late';
  started(world, job, 'startup');
  context(world, 75);
  w.ownerSays(world, job, 'Next supplier on the list, please');
  const file = saveNote(world, job);
  const kept = sha(file);
  // The owner carries on without /clear: more messages, a compaction, and the
  // laptop closed (the session restarts and resumes under the same id).
  w.ownerSays(world, job, 'Actually, one more thing first');
  w.ownerSays(world, job, 'And another');
  started(world, job, 'compact');
  started(world, job, 'resume');
  w.ownerSays(world, job, 'Where were we?');
  assert.ok(fs.existsSync(file), 'the handover note survives the late messages, the compaction and the restart');
  assert.equal(sha(file), kept, 'the handover note is unchanged: nothing is lost');
  const after = started(world, 'job-next-day', 'clear');
  assert.ok(after.stdout.includes(NOTE.trim()),
    `a late /clear still picks the work up from the note, whole; got ${w.describe(after)}`);
});

test('when the owner carries on without /clear, the /clear prompt comes back at a later natural pause, after a restart or a further compaction', { timeout: 60000 }, (t) => {
  const world = U.usageWorld(t);
  const job = 'job-carry-on';
  started(world, job, 'startup');
  context(world, 75);
  w.ownerSays(world, job, 'Next supplier on the list, please');
  saveNote(world, job);
  const first = w.ownerSays(world, job, 'Thanks');
  assert.match(first.stdout, /\/clear/, `once the note is saved the next pause brings the /clear prompt; got ${w.describe(first)}`);
  w.ownerSays(world, job, 'Not now, keep going with the next supplier');
  // The laptop is closed and opened: the session resumes.
  started(world, job, 'resume');
  const afterRestart = w.ownerSays(world, job, 'Right, where were we?');
  assert.match(afterRestart.stdout, /\/clear/, `after a restart the /clear prompt comes back at the next pause; got ${w.describe(afterRestart)}`);
  w.ownerSays(world, job, 'Later. Do the summary table first');
  started(world, job, 'compact');
  const afterCompact = w.ownerSays(world, job, 'How is it going?');
  assert.match(afterCompact.stdout, /\/clear/, `after a further compaction the /clear prompt comes back; got ${w.describe(afterCompact)}`);
  assert.ok(fs.existsSync(noteFile(world, job)), 'the handover note is still there');
});

const OLDER_NOTE = [
  '# Handover',
  'Work in progress: the boiler service quotes, two of four firms asked.',
  'Done: Calder Heating and Brookside Gas asked for a Tuesday visit.',
  'Next: ask Northgate and Ferris, then compare in workspace/boiler.md.',
  '',
].join('\n');

test('with two handover notes saved, /clear picks up the newest whole and not the older, and a later /clear does not pick the same note up again', { timeout: 60000 }, (t) => {
  // Heavy: two long conversations in a day, each saving its note, the older first.
  const world = U.usageWorld(t);
  started(world, 'job-older', 'startup');
  context(world, 75);
  w.ownerSays(world, 'job-older', 'Next firm on the list, please');
  const older = saveNote(world, 'job-older', OLDER_NOTE);
  const hourAgo = new Date(Date.now() - 3600 * 1000);
  fs.utimesSync(older, hourAgo, hourAgo);
  started(world, 'job-newer', 'startup');
  w.ownerSays(world, 'job-newer', 'Next supplier on the list, please');
  saveNote(world, 'job-newer', NOTE);
  const first = started(world, 'job-after', 'clear');
  assert.ok(first.stdout.includes(NOTE.trim()),
    `at the start after /clear the newest handover note reaches the new conversation whole; got ${w.describe(first)}`);
  assert.ok(!first.stdout.includes(OLDER_NOTE.split('\n')[1]), `the older note is not the one picked up; got ${w.describe(first)}`);
  const second = started(world, 'job-after-again', 'clear');
  assert.ok(!second.stdout.includes(NOTE.split('\n')[1]),
    `a note already picked up is not picked up again at a later /clear; got ${w.describe(second)}`);
});
