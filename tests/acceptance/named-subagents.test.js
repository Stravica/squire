'use strict';

// A named subagent's own model, and the permitted calls through the same
// safety floor (AC-1301-2 and AC-1302-1, under their present wording), through
// the floor's real entry point: core/hooks/pre-tool-use.py, run by Claude Code
// before every tool call with the event on stdin, the owner's answer reaching
// it only through core/hooks/user-prompt-submit.py, and the session's start
// through core/hooks/session-start.py.
//
// Claude Code runs a named subagent (an Agent or Task call's subagent_type)
// on the model its agent file names, unless the call names one. It finds the
// file by the name in the file's frontmatter, in the project's .claude/agents
// (the owner's folder is Squire's project) and in the agents folder of its
// config folder (claude-config in the Squire home). A real interactive
// session showed that an agent file written while a session runs is not
// loaded until the next session: so the model a named subagent runs on is the
// one its file named when the session started.
//
// The floor's words (as the safety floor's cases use them):
//   free     exit 0 with nothing on stdout
//   asked    blocked (exit 2), the reason naming the item, a request id and
//            usage credits, until the owner's yes to that one call
//
// The class is open (any way to name a subagent's model). The answer for a
// named subagent the floor cannot read with certainty is to ask: a file that
// names a model outside the plan's set (opus, sonnet and haiku), a file it
// cannot read, a name no file gives, and a file changed after the session
// started (the floor cannot know which version Claude Code loaded). A
// subagent on a plan model, on inherit or on no model named stays free.
//
// The permitted calls are there so the money cases can tell a working floor
// from one that blocks everything: each goes through the same floor and is
// free. They are expected to pass at the head that adds them (guards).
//
// Usage model for the small jobs (assumptions, none measured):
//   typical  five-hour 30%, weekly 40%: a small job is free.
//   heavy    five-hour 92%, weekly 91% (both above every threshold): a small
//            job is still free; only a big job waits.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const w = require('../fixtures/squire-world.js');
const s = require('../fixtures/session-world.js');
const U = require('../fixtures/usage-world.js');

const { tools } = w;

function agentFile(dir, file, { name, model }) {
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, file);
  fs.writeFileSync(target, ['---', `name: ${name}`, 'description: Helps with the bakery\'s planning.',
    ...(model === undefined ? [] : [`model: ${model}`]), '---', '', 'You help the owner plan the week.', ''].join('\n'));
  return target;
}

const projectAgents = (world) => path.join(world.owner, '.claude', 'agents');
const userAgents = (world) => path.join(s.configDir(world), 'agents');
const named = (type, extra = {}) => ['Agent', {
  description: 'Plan the week', prompt: 'Plan next week\'s orders from the notes.', subagent_type: type, ...extra,
}];

function started(world, session) {
  const r = s.recordSessionByHook(world, { sessionId: session, source: 'startup' });
  assert.equal(r.status, 0, `the SessionStart hook must exit 0; got ${w.describe(r)}`);
}

function assertFree(r, what) {
  w.assertAllowed(r, what);
  assert.equal(r.stdout, '', `${what}: a free call prints nothing on stdout; got ${w.describe(r)}`);
}

function assertAskedForCredits(r, what) {
  w.assertBlocked(r, `${what}, with no yes`);
  assert.ok(w.requestIdIn(r.stderr), `${what}: expected it asked, with a request id the owner can answer; got ${w.describe(r)}`);
  assert.match(r.stderr, /usage credits/i, `${what}: the block must say the model may need usage credits; got ${w.describe(r)}`);
}

test("a named subagent whose own agent file names a model outside the plan's set is asked, as is one whose file cannot be read, one no file names and one whose file changed after the session started; a yes covers that one call", { timeout: 120000 }, (t) => {
  const world = U.usageWorld(t);
  // Present when the session starts. The file name and the name in it differ
  // on purpose: Claude Code finds a subagent by the name in the file.
  agentFile(projectAgents(world), 'garden.md', { name: 'shed-finder', model: 'fable' });
  agentFile(userAgents(world), 'notes-helper.md', { name: 'notes-helper', model: 'claude-fable-5-1' });
  const locked = agentFile(projectAgents(world), 'locked.md', { name: 'locked-helper', model: 'sonnet' });
  fs.chmodSync(locked, 0o000);
  t.after(() => { try { fs.chmodSync(locked, 0o644); } catch (e) { /* gone */ } });
  const changing = agentFile(projectAgents(world), 'changing.md', { name: 'changing-helper', model: 'fable' });

  const rows = {
    'a subagent whose file in the owner\'s project names a model outside the plan': named('shed-finder'),
    'a subagent whose file in Squire\'s Claude Code config names a full model id outside the plan': named('notes-helper'),
    'the same subagent called by the Task name': ['Task', named('shed-finder')[1]],
    'a subagent whose agent file cannot be read': named('locked-helper'),
    'a subagent no agent file names': named('pantry-planner'),
  };
  let n = 0;
  for (const [what, call] of Object.entries(rows)) {
    n += 1;
    const job = `job-named-${n}`;
    started(world, job);
    assertAskedForCredits(w.attempt(world, job, call), what);
  }

  // A file changed after the session started: the floor cannot know which
  // version the session loaded, so it asks, whatever the file now says.
  const job = 'job-changed';
  started(world, job);
  const later = new Date(Date.now() + 2000);
  agentFile(projectAgents(world), 'changing.md', { name: 'changing-helper', model: 'sonnet' });
  fs.utimesSync(changing, later, later);
  assertAskedForCredits(w.attempt(world, job, named('changing-helper')), 'a subagent whose agent file changed after the session started');

  // A yes covers that one call.
  const once = 'job-named-once';
  started(world, once);
  const asked = w.attempt(world, once, named('shed-finder'));
  assertAskedForCredits(asked, 'the named subagent on a model outside the plan');
  U.sayYesTo(world, once, asked);
  w.assertAllowed(w.attempt(world, once, named('shed-finder')), 'the named subagent once the owner said yes to it');
  assertAskedForCredits(w.attempt(world, once, named('shed-finder')), 'a yes covers one call: the next one asks again');
});

test("a named subagent whose own agent file names a model in the plan's set, inherit or no model, and a built-in subagent, go through the same floor and are free", { timeout: 120000 }, (t) => {
  const world = U.usageWorld(t);
  agentFile(projectAgents(world), 'tidy.md', { name: 'tidy-helper', model: 'sonnet' });
  agentFile(projectAgents(world), 'sums.md', { name: 'sums-helper', model: 'haiku' });
  agentFile(userAgents(world), 'letters.md', { name: 'letters-helper', model: 'opus' });
  agentFile(projectAgents(world), 'same.md', { name: 'same-helper', model: 'inherit' });
  agentFile(projectAgents(world), 'plain.md', { name: 'plain-helper' });
  const rows = {
    'a subagent whose file names sonnet': named('tidy-helper'),
    'a subagent whose file names haiku': named('sums-helper'),
    'a subagent whose file in Squire\'s Claude Code config names opus': named('letters-helper'),
    'a subagent whose file names inherit': named('same-helper'),
    'a subagent whose file names no model': named('plain-helper'),
    'the same subagent called by the Task name': ['Task', named('tidy-helper')[1]],
    'a built-in subagent on the session\'s own model': named('general-purpose'),
  };
  let n = 0;
  for (const [what, call] of Object.entries(rows)) {
    n += 1;
    const job = `job-plan-${n}`;
    started(world, job);
    assertFree(w.attempt(world, job, call), what);
  }
});

test('a small job below the big-job thresholds goes through the same floor and is free, with the plan calm and with both windows above every threshold', { timeout: 120000 }, (t) => {
  for (const [profile, five, week] of [['typical', 30, 40], ['heavy', 92, 91]]) {
    const world = U.usageWorld(t);
    U.writeSnapshot(world, {
      fiveHour: { used: five, resetsAt: U.onMinute(U.now() + 3 * 3600) },
      sevenDay: { used: week, resetsAt: U.onMinute(U.now() + 4 * U.DAY) },
    });
    const rows = {
      'a list of the drafts': tools.bash('ls workspace/drafts'),
      'a read of an order': tools.read(path.join(world.owner, 'workspace', 'drafts', 'order.json')),
      'a new note in the owner\'s folder': tools.write(path.join(world.owner, 'workspace', 'drafts', 'shopping.md'), '- flour\n'),
      'a subagent on haiku': named('general-purpose', { model: 'haiku' }),
    };
    let n = 0;
    for (const [what, call] of Object.entries(rows)) {
      n += 1;
      const job = `job-small-${profile}-${n}`;
      started(world, job);
      const r = w.attempt(world, job, call, { env: U.UTC });
      assertFree(r, `${profile} (five-hour ${five}%, weekly ${week}%): ${what}`);
      assert.doesNotMatch(r.stderr, /big job|can wait/i, `${profile}: ${what} is no big job and is not deferred; got ${w.describe(r)}`);
    }
  }
});
