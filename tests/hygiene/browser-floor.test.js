'use strict';

// Code hygiene for the floor's reading of the owner's details for a browser
// call (OwnerDetails in pre-tool-use.py) and of a preview server's bind
// (Floor.open_preview), through the floor's entry point. Bound to no
// criterion.

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

const type = (text) => ['mcp__playwright__browser_type', { element: 'Message', ref: 'e6', text }];
let jobs = 0;
const fresh = () => `session-hygiene-browser-${(jobs += 1)}`;

function refused(it, call, what) {
  const r = w.attempt(it, fresh(), call);
  w.assertBlocked(r, what);
  assert.equal(w.requestIdIn(r.stderr), null, `${what}: refused, not asked; got ${w.describe(r)}`);
  return r;
}

function asked(it, call, what) {
  const r = w.attempt(it, fresh(), call);
  w.assertBlocked(r, what);
  assert.ok(w.requestIdIn(r.stderr), `${what}: asked, with a request the owner can answer; got ${w.describe(r)}`);
  return r;
}

test("the owner's details are read from labelled lines however they are marked and found in a browser call however they are escaped, and named in the refusal without their value", { timeout: 60000 }, (t) => {
  const it = world(t);
  fs.writeFileSync(path.join(it.owner, 'operator', 'profile.md'), [
    '# About me',
    '',
    '**Email address:** baker.test@example.org',
    '* Phone number: +44 7700 900456',
    '- __Postal address__: 2 Test Lane, Sampleton, SA1 9ZZ',
    '- Note: keeps bees',
    'Bakes on Saturdays.',
    '',
  ].join('\n'));
  const r = refused(it, type('BAKER.TEST@EXAMPLE.ORG'), 'the email address in another letter case');
  assert.match(r.stderr, /email address/, `the refusal names which detail; got ${w.describe(r)}`);
  assert.ok(!/baker\.test/i.test(r.stderr), `the refusal never repeats the detail; got ${w.describe(r)}`);
  refused(it, ['mcp__playwright__browser_navigate', { url: 'http://127.0.0.1:9/a?to=baker.test%2540example.org' }], 'the email address escaped twice in an address');
  refused(it, type('baker.test&#64;example.org'), 'the email address with an HTML escape');
  refused(it, type('call 07700-900-456'), 'the phone number written another way, by its digits');
  refused(it, type('sa19zz'), 'the postcode run together');
  refused(it, type('Ada'), "the first name from the owner's squire.json");
  asked(it, type('Sampleton keeps bees, and Canada too'), 'a town alone, a note that is not a detail, and a word holding the first name');
});

test("a browser call is refused while the owner's squire.json is there and cannot be read, and asked when it is not there and the profile can be read", { timeout: 60000 }, (t) => {
  const it = world(t);
  const config = path.join(it.owner, 'squire.json');
  fs.writeFileSync(config, '{ not json');
  refused(it, type('Please send a brochure'), "a browser call with the owner's squire.json unreadable");
  fs.rmSync(config);
  asked(it, type('Please send a brochure'), "a browser call with no squire.json in the owner's folder");
});

test("Python's web server is refused unless its bind, however it is spelt, is the loopback", { timeout: 60000 }, (t) => {
  const it = world(t);
  for (const command of [
    'python3 -m http.server -b 0.0.0.0',
    'python3 -m http.server --bind=::',
    'python3 -m http.server --bi 0.0.0.0',
    'python3 -m http.server -b0.0.0.0',
    'python3 -mhttp.server 8000',
    'python3 -m http.server --bind 127.0.0.1 --bind 0.0.0.0',
    'python3 -m http.server --bind "$HOST"',
  ]) refused(it, w.tools.bash(command), `the command ${JSON.stringify(command)}`);
  for (const command of [
    'python3 -m http.server -b 127.0.0.1',
    '/usr/bin/python3 -m http.server --bind=localhost 0',
    'python3 -m http.server --bind ::1',
  ]) asked(it, w.tools.bash(command), `the command ${JSON.stringify(command)}`);
});
