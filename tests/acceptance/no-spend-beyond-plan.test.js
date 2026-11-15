'use strict';

// Squire never spends beyond the owner's plan without their yes (AC-1301-2),
// through the safety floor's real entry point: core/hooks/pre-tool-use.py, run
// by Claude Code before every tool call with the event on stdin, the owner's
// answer reaching it only through core/hooks/user-prompt-submit.py. The design
// record for plan awareness and the heavy-job gate (ADR-006 line 5) names the
// plan's set of models (opus, sonnet and haiku: usable on any paid plan, the
// model-config page) and the routes a model is picked by; any other model may
// need usage credits (the picker marks a Fable model "Requires usage credits"
// and no list is documented), so it is asked, its block naming usage
// credits. Turning usage credits on and opening the upgrade page are the
// owner's own to do: refused, yes or no.
//
// The class is open (any way to turn credits on or to pick a model); these
// cases are instances of it, and the floor's answer for anything it cannot
// read stays ask, else refuse.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const w = require('../fixtures/squire-world.js');
const U = require('../fixtures/usage-world.js');

const agent = (model) => ['Agent', {
  description: 'Compare the options',
  prompt: 'Compare the three garden sheds in the notes and say which fits best.',
  subagent_type: 'general-purpose',
  ...(model === undefined ? {} : { model }),
}];

test('a model outside the plan\'s set, picked for a subagent, by flag, by settings or by environment, is blocked until the owner\'s yes, its block naming usage credits; the plan\'s own models need none', { timeout: 60000 }, (t) => {
  const world = U.usageWorld(t);
  const s = 'job-models';

  // Typical: a subagent on the session's own model or one in the plan's set.
  for (const model of [undefined, 'sonnet', 'haiku', 'opus']) {
    w.assertAllowed(w.attempt(world, s, agent(model)), `a subagent on ${model || 'the session\'s own model'}`);
  }

  // A model outside the plan's set, for a subagent.
  const fable = w.attempt(world, s, agent('fable'));
  w.assertBlocked(fable, 'a subagent on a model outside the plan\'s set, with no yes');
  assert.match(fable.stderr, /usage credits/i, `the block must say the model may need usage credits; got ${w.describe(fable)}`);
  U.sayYesTo(world, s, fable);
  w.assertAllowed(w.attempt(world, s, agent('fable')), 'the same subagent once the owner said yes to it');
  w.assertBlocked(w.attempt(world, s, agent('fable')), 'a yes covers that one call: the next one asks again');

  // By flag, by settings and by environment, given to the claude command line.
  const routes = {
    'by flag': 'claude -p --model fable "Summarise the notes"',
    'by settings': 'claude -p --settings \'{"model":"fable"}\' "Summarise the notes"',
    'by environment': 'ANTHROPIC_MODEL=fable claude -p "Summarise the notes"',
    'for subagents by environment': 'CLAUDE_CODE_SUBAGENT_MODEL=fable claude -p "Summarise the notes"',
  };
  for (const [how, command] of Object.entries(routes)) {
    const r = w.attempt(world, `job-${how.replace(/\s+/g, '-')}`, w.tools.bash(command));
    w.assertBlocked(r, `a model outside the plan's set picked ${how}, with no yes`);
    assert.match(r.stderr, /usage credits/i, `picked ${how}, the block must say the model may need usage credits; got ${w.describe(r)}`);
  }
});

test('turning on usage credits or opening the upgrade page from the session is refused, and the owner\'s yes does not lift it', { timeout: 60000 }, (t) => {
  const world = U.usageWorld(t);
  const calls = {
    'usage credits as a slash command': ['SlashCommand', { command: '/usage-credits' }],
    'the upgrade page as a slash command': ['SlashCommand', { command: '/upgrade' }],
    'usage credits through the claude command line': w.tools.bash('claude /usage-credits'),
    'the upgrade page through the claude command line': w.tools.bash('claude -p /upgrade'),
  };
  for (const [what, call] of Object.entries(calls)) {
    const s = `job-${what.replace(/\s+/g, '-')}`;
    const first = w.attempt(world, s, call);
    w.assertBlocked(first, `${what}, with no yes`);
    U.sayYesTo(world, s, first);
    const again = w.attempt(world, s, call);
    w.assertBlocked(again, `${what}, after the owner said yes: money beyond the plan is the owner's own to turn on`);
  }
});
