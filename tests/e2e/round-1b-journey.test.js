'use strict';

// Round 1b's journey, end to end on a laid-down core: core is laid down into
// a Squire home beside the owner's folder, and from then on only the
// INSTALLED hooks run, as Claude Code would run them. The small model is the
// fixture's fake claude, first on the hook's PATH; no test reaches a real
// model.
//
// The target is a parameter: SQUIRE_RELEASE_DIR names the core release to lay
// down (a release folder holding hooks/, tools/ and the rest of core). Unset,
// it is this repository's core/.
//
//   SQUIRE_RELEASE_DIR=/path/to/release node --test tests/e2e/

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const w = require('../fixtures/squire-world.js');

const { tools } = w;

test('on a laid-down core a read the small model clears runs free and a later send is only asked, and a read it is unsure about is asked, allowed, and then a send is refused as one job', { timeout: 180000 }, (t) => {
  const release = process.env.SQUIRE_RELEASE_DIR ? path.resolve(process.env.SQUIRE_RELEASE_DIR) : w.CORE;
  const world = w.makeWorld();
  t.after(() => w.cleanUp(world));
  const r = w.runPython(world, path.join(release, 'tools', 'lay-down.py'), [release], { cwd: world.root });
  assert.equal(r.status, 0, `laying down core from the release must succeed; got ${w.describe(r)}`);
  const installed = fs.realpathSync(path.join(world.home, 'core'));
  w.plantOverlays(world.owner, [installed]);
  const fake = w.installFakeClaude(world, { answer: 'no\n' });
  const on = { coreDir: installed, env: fake.env };
  const send = tools.gmailSend('someone@example.net', 'Re: Offer', 'Here is the order sheet.');

  // A read of the drafts the floor cannot resolve: the model says no, the
  // read runs, and a later send waits only for its own yes.
  const cleared = 'session-journey-cleared';
  const outside = 'cat workspace/dr?fts/order.json';
  const free = w.attempt(world, cleared, tools.bash(outside), on);
  assert.equal(fake.calls().length, 1, `${outside}: the installed floor must ask the small model once; it asked ${fake.calls().length} times`);
  w.assertAllowed(free, `${outside}, the model answering no`);
  assert.equal(free.stdout, '', `${outside}: a free call prints nothing; got ${w.describe(free)}`);
  const asked = w.attempt(world, cleared, send, on);
  w.assertBlocked(asked, 'a send after a read the model cleared', 'someone@example.net');
  assert.ok(w.requestIdIn(asked.stderr), `a send after a read the model cleared must be asked, with a request id; got ${w.describe(asked)}`);
  assert.doesNotMatch(asked.stderr, /split/i, `a send after a read the model cleared must be asked, not refused as one job; got ${w.describe(asked)}`);

  // A read of the inbox the model is unsure about: asked, the owner says yes,
  // it runs, and the job then holds untrusted input and private things.
  fake.set({ answer: 'unsure\n' });
  const unsure = 'session-journey-unsure';
  const inbox = 'cat workspace/{inbox,drafts}/offer.eml';
  w.assertBlocked(w.attempt(world, unsure, tools.bash(inbox), on), `${inbox}, the model unsure`, inbox);
  w.ownerSays(world, unsure, 'yes', on);
  w.assertAllowed(w.attempt(world, unsure, tools.bash(inbox), on), `${inbox}, after the owner said yes`);
  const refused = w.attempt(world, unsure, send, on);
  w.assertBlocked(refused, 'a send after the owner allowed an inbox read');
  assert.match(refused.stderr, /split/i, `a send after the owner allowed an inbox read must be refused as one job; got ${w.describe(refused)}`);
  assert.ok(refused.stderr.includes(inbox) && refused.stderr.includes('someone@example.net'),
    `the refusal must name the read and the send; got ${w.describe(refused)}`);
  w.ownerSays(world, unsure, 'yes', on);
  w.assertBlocked(w.attempt(world, unsure, send, on), 'the same send after a yes: the job is refused as one job');
});
