'use strict';

// Code hygiene for Squire's website command (core/tools/website.py), through
// its entry point: what it refuses before any call does nothing and never
// crashes, an address that is not https is never called, and a set-up token
// without the rights it needs is named as left and its Keychain copy is
// removed. Bound to no criterion. Every call goes to the loopback stand-in.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const w = require('../fixtures/squire-world.js');
const W = require('../fixtures/website-world.js');

const WEBSITE = path.join(w.CORE, 'tools', 'website.py');

test('the website command refuses a verb it does not take, a missing or extra word and an account id that is not one, before any call, and never crashes', { timeout: 60000 }, (t) => {
  const ctx = W.websiteWorld(t);
  for (const [args, what] of [
    [[], 'no verb'],
    [['publish', W.ACCOUNT], 'a verb it does not take'],
    [['set-up'], 'no account id'],
    [['set-up', W.ACCOUNT, 'extra'], 'an extra word'],
    [['set-up', 'not-an-account'], 'an account id that is not one'],
    [['set-up', `${W.ACCOUNT}0`], 'an account id one letter too long'],
  ]) {
    const r = w.runPython(ctx.world, WEBSITE, args, { env: ctx.standIn.proxyEnv, timeout: 30000 });
    assert.equal(r.status, 1, `${what}: refused with exit 1; got ${w.describe(r)}`);
    assert.doesNotMatch(r.stderr, /Traceback/, `${what}: never a crash; got ${w.describe(r)}`);
  }
  assert.deepEqual(ctx.standIn.calls(), [], 'nothing was called');
  assert.equal(w.hasSecret(ctx.keychain, W.SET_UP_SECRET), true, 'a refused command leaves the set-up token where the owner stored it');
});

test('the set-up calls no address that is not https, unless it is on the loopback', { timeout: 60000 }, (t) => {
  const ctx = W.websiteWorld(t);
  w.writeConfig(ctx.world, { cloudflareApi: 'http://api.example.net/client/v4' });
  const r = w.runPython(ctx.world, WEBSITE, ['set-up', W.ACCOUNT], { env: ctx.standIn.proxyEnv, timeout: 30000 });
  assert.equal(r.status, 1, `refused; got ${w.describe(r)}`);
  assert.match(r.stderr, /https/, `it says the address must be https; got ${w.describe(r)}`);
  assert.deepEqual(ctx.standIn.calls(), [], 'nothing was called, through the proxy or otherwise');
});

test('a set-up token that cannot read its own rights runs nothing, is named as left when it cannot be removed, and its Keychain copy is removed', { timeout: 60000 }, (t) => {
  const ctx = W.websiteWorld(t, { rights: [] });
  const r = w.runPython(ctx.world, WEBSITE, ['set-up', W.ACCOUNT], { env: ctx.standIn.proxyEnv, timeout: 60000 });
  assert.equal(r.status, 1, `not done; got ${w.describe(r)}`);
  assert.match(W.said(r), /Account API Tokens Write and Billing Read/, `it names the rights it needs; got ${w.describe(r)}`);
  assert.ok(W.said(r).includes(ctx.setUp.id), `it names the set-up token, by the id it could read, as left on the account; got ${w.describe(r)}`);
  assert.deepEqual(ctx.standIn.calls().filter((c) => c.method === 'POST'), [], 'it made nothing');
  assert.equal(w.hasSecret(ctx.keychain, W.SET_UP_SECRET), false, 'the set-up token\'s Keychain copy is removed');
  assert.equal(w.hasSecret(ctx.keychain, W.KEPT_SECRET), false, 'nothing is kept');
  assert.doesNotMatch(r.stderr, /Traceback/, `never a crash; got ${w.describe(r)}`);
});
