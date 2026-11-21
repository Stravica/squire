'use strict';

// Code hygiene for the floor's list of the browser tools it checks
// (Floor.BROWSER_CHECKED and Floor.judge_browser in pre-tool-use.py), through
// the floor's entry point. Bound to no criterion.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const w = require('../fixtures/squire-world.js');

function world(t) {
  const it = w.makeWorld();
  t.after(() => w.cleanUp(it));
  return it;
}

let jobs = 0;
const fresh = () => `session-hygiene-browser-list-${(jobs += 1)}`;

function refused(it, call, what) {
  const r = w.attempt(it, fresh(), call);
  w.assertBlocked(r, what, call[0]);
  assert.equal(w.requestIdIn(r.stderr), null, `${what}: refused, not asked; got ${w.describe(r)}`);
  return r;
}

function asked(it, call, what) {
  const r = w.attempt(it, fresh(), call);
  w.assertBlocked(r, what);
  assert.ok(w.requestIdIn(r.stderr), `${what}: asked, with a request the owner can answer; got ${w.describe(r)}`);
  return r;
}

test("a tool of the browser server off the floor's list is refused with words naming the tool and no value from the call, whether its name starts like a listed one or not", { timeout: 60000 }, (t) => {
  const it = world(t);
  const marker = 'Kestrel-4417';
  for (const name of [
    'mcp__playwright__browser_navigate_back',
    'mcp__playwright__browser_clicks',
    'mcp__playwright__browser_type_slowly',
    'mcp__playwright__browser_press_key',
    'mcp__playwright__browser_',
    'mcp__playwright__webmcp_book_a_table',
    'mcp__playwright__something_else',
  ]) {
    const r = refused(it, [name, { text: marker, key: marker }], `the tool ${name}`);
    assert.match(r.stderr, /cannot check/, `the refusal says Squire cannot check the call; got ${w.describe(r)}`);
    assert.ok(!r.stderr.includes(marker), `the refusal never repeats a value from the call; got ${w.describe(r)}`);
  }
});

test('the listed browser tools stay asked, the script and file tools keep their own words, and an unlisted tool is refused before the profile is read', { timeout: 60000 }, (t) => {
  const it = world(t);
  asked(it, ['mcp__playwright__browser_navigate', { url: 'http://127.0.0.1:9/a' }], 'a navigate');
  asked(it, ['mcp__playwright__browser_snapshot', {}], 'a snapshot');
  asked(it, ['mcp__playwright__browser_click', { element: 'Send', ref: 'e7' }], 'a click');
  asked(it, ['mcp__playwright__browser_type', { element: 'Message', ref: 'e6', text: 'Please send a brochure' }], 'a type');
  asked(it, ['mcp__playwright__browser_fill_form', { fields: [{ name: 'Message', type: 'textbox', ref: 'e6', value: 'Please send a brochure' }] }], 'a form fill');
  const script = refused(it, ['mcp__playwright__browser_evaluate', { function: '() => 1' }], 'a script in the page');
  assert.match(script.stderr, /does not run a script in the page or send a file/, `the script tool keeps its words; got ${w.describe(script)}`);
  fs.rmSync(path.join(it.owner, 'operator', 'profile.md'));
  const unlisted = refused(it, ['mcp__playwright__browser_tabs', { action: 'list' }], 'an unlisted tool with the profile gone');
  assert.match(unlisted.stderr, /no check for this tool/, `an unlisted tool gets the unlisted words, not the profile's; got ${w.describe(unlisted)}`);
  refused(it, ['mcp__playwright__browser_type', { element: 'Message', ref: 'e6', text: 'Please send a brochure' }], 'a listed tool with the profile gone');
});

test("a server whose key only starts with the browser's is not Squire's browser and is asked as a tool the floor does not know", { timeout: 60000 }, (t) => {
  const it = world(t);
  asked(it, ['mcp__playwrightx__browser_click', { element: 'Send', ref: 'e7' }], 'a click on another server');
});
