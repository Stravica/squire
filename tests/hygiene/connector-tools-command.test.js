'use strict';

// Code hygiene for Squire's connector-tools command
// (core/tools/connector-tools.py) and the floor's ask for it
// (core/hooks/pre-tool-use.py, ConnectorToolsCommand), through their entry
// points. Bound to no criterion. A name is in one class at most, every other
// setting of the owner's squire.json stays, and an input the command cannot
// take changes nothing and says why. The tool names here are this file's own
// invention.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const w = require('../fixtures/squire-world.js');

const READ = 'mcp__example_notes__read_note';
const DRAFT = 'mcp__example_notes__keep_draft';
const SCRIPT = path.join(w.CORE, 'tools', 'connector-tools.py');

function world(t) {
  const it = w.makeWorld();
  t.after(() => w.cleanUp(it));
  return it;
}
const ownerConfig = (it) => path.join(it.owner, 'squire.json');
const settings = (it) => JSON.parse(fs.readFileSync(ownerConfig(it), 'utf8'));
const run = (it, args) => w.runPython(it, SCRIPT, args);

test('read, draft and remove keep each name in one class at most and every other setting as it was, and say what they set', { timeout: 60000 }, (t) => {
  const it = world(t);
  const others = settings(it);
  delete others.connectorTools;
  const steps = [
    [['read', READ, DRAFT], { read: [READ, DRAFT], draft: [] }],
    [['draft', DRAFT], { read: [READ], draft: [DRAFT] }],
    [['read', READ], { read: [READ], draft: [DRAFT] }],
    [['remove', READ, DRAFT], { read: [], draft: [] }],
  ];
  for (const [args, classes] of steps) {
    const r = run(it, args);
    assert.equal(r.status, 0, `${args.join(' ')} runs; got ${w.describe(r)}`);
    for (const name of args.slice(1)) assert.ok(r.stdout.includes(name), `${args[0]} names ${name}; got ${w.describe(r)}`);
    const now = settings(it);
    assert.deepEqual(now.connectorTools, classes, `after ${args.join(' ')}`);
    delete now.connectorTools;
    assert.deepEqual(now, others, `every other setting stays, after ${args.join(' ')}`);
  }
});

test('an input the command cannot take changes nothing and says why: no verb or no name, a wildcard, a name that is not a connector tool\'s, a file that is not JSON and classes of another shape', { timeout: 60000 }, (t) => {
  const it = world(t);
  const bad = [
    ['no name', ['read']],
    ['another verb', ['allow', READ]],
    ['a wildcard', ['read', 'mcp__example_notes__*']],
    ['a name that is not a connector tool\'s', ['read', 'read_note']],
    ['a name with a new line in it', ['read', `${READ}\nmcp__example_notes__send_note`]],
  ];
  const before = fs.readFileSync(ownerConfig(it), 'utf8');
  for (const [what, args] of bad) {
    const r = run(it, args);
    assert.equal(r.status, 1, `${what}: refused; got ${w.describe(r)}`);
    assert.match(r.stderr, /changed nothing/, `${what}: says it changed nothing; got ${w.describe(r)}`);
    assert.equal(fs.readFileSync(ownerConfig(it), 'utf8'), before, `${what}: the file is as it was`);
  }
  for (const [what, text] of [['a file that is not JSON', '{"firstName": "Ada",'],
    ['classes of another shape', JSON.stringify({ firstName: 'Ada', connectorTools: { read: READ } }, null, 2)]]) {
    fs.writeFileSync(ownerConfig(it), text);
    const r = run(it, ['read', READ]);
    assert.equal(r.status, 1, `${what}: refused; got ${w.describe(r)}`);
    assert.equal(fs.readFileSync(ownerConfig(it), 'utf8'), text, `${what}: the file is as it was`);
  }
});

test('the floor asks every plain run of the command, naming each tool, the same run goes on the owner\'s yes, and words it cannot read are asked as written, never refused', { timeout: 60000 }, (t) => {
  const it = world(t);
  const command = `/usr/bin/python3 '${SCRIPT}' read ${READ} ${DRAFT}`;
  const asked = w.attempt(it, 'session-classes', w.tools.bash(command));
  w.assertBlocked(asked, 'the command, with no yes');
  const id = w.requestIdIn(asked.stderr);
  assert.ok(id, `asked, with a request; got ${w.describe(asked)}`);
  for (const name of [READ, DRAFT]) assert.ok(asked.stderr.includes(name), `the ask names ${name}; got ${w.describe(asked)}`);
  w.ownerSays(it, 'session-classes', `yes ${id}`);
  w.assertAllowed(w.attempt(it, 'session-classes', w.tools.bash(command)), 'the same run, on the owner\'s yes');
  const odd = w.attempt(it, 'session-odd', w.tools.bash(`/usr/bin/python3 '${SCRIPT}' allow ${READ}`));
  w.assertBlocked(odd, 'another verb, with no yes');
  assert.ok(w.requestIdIn(odd.stderr), `another verb is asked as written; got ${w.describe(odd)}`);
});
