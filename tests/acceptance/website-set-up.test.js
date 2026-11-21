'use strict';

// The one-off safe set-up of the owner's Cloudflare account: after it,
// everything that could cost the owner money there is off, a spend guard is
// on and the short-lived set-up token is gone; a subscription the set-up
// cannot read as free counts as paid. Bound through the real entry points:
// Squire's website command run as its own command line (core/tools/website.py
// set-up <account id>), against a loopback stand-in of Cloudflare's API
// (tests/fixtures/cloudflare-stand-in.js), and the safety floor as the session
// runs it (the PreToolUse hooks of the settings lay-down writes, the event on
// stdin, in the default mode and in auto mode). The real one-off set-up on a
// test Cloudflare account, never a live one, is the test stage's own step.
//
// What the builder provides (none of it at the base head; a case fails at its
// own first assertion while it is absent), with the names website-world.js
// pins:
//   website.py set-up <account id> takes the owner's set-up token only from
//     the Keychain secret cloudflare-set-up, through Squire's secret helper,
//     and never writes it to a file, the chat or the ledger; it checks the
//     token holds Account API Tokens Write and Billing Read and, if not, runs
//     nothing and names the rights it needs;
//   it reads the account's subscriptions once with that token (Billing Read,
//     read only) and reports done only when every one reads as free: a price
//     of exactly 0. A subscription with a price is paid; one whose price it
//     cannot read as a number counts as paid; a read that fails is not done.
//     Either way it names what it found to the owner and changes no billing,
//     ever (a paid feature is the owner's to switch off);
//   the spend guard, as the owner ruled it: the only access the set-up leaves
//     on the account is the deploy token it keeps, which cannot spend (Workers
//     Scripts Write alone, read back from the account), the free plan fails
//     rather than bills, and the floor refuses a call that would upgrade a
//     plan, add a payment method or buy, yes or no;
//   the set-up removes its own set-up token from the account at its end,
//     whether it finished or a later step failed, and a set-up that did not
//     finish tells the owner what it left on the account.
//
// Decided on the fail-closed reading and named here (no record settles them):
// a set-up that did not report done leaves no token of its own active on the
// account and keeps nothing in the Keychain, so Squire's own deploy after it
// is asked saying it cannot tell where the site goes, as before any set-up.
//
// Usage model (assumptions, none measured): typical, one account on the free
// plans with one free subscription, set up once; heavy, an account with a
// paid or unreadable subscription, or a step that fails part-way, set up again
// after the owner acts. No case reaches a model, a Cloudflare account or any
// host but this Mac: every Squire process is given the stand-in as its proxy,
// and each case asserts no call left the loopback.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const w = require('../fixtures/squire-world.js');
const U = require('../fixtures/usage-world.js');
const W = require('../fixtures/website-world.js');

const MODES = ['default', 'auto'];

const billingWrites = (standIn) => standIn.calls().filter((c) => /\/subscriptions?(\/|\?|$)/.test(c.path) && c.method !== 'GET');
const setUpGone = (ctx) => (W.tokensOn(ctx.standIn).find((x) => x.id === ctx.setUp.id) || {}).status === 'deleted';

function assertSetUpTokenRemoved(ctx, what) {
  assert.ok(setUpGone(ctx), `${what}: the set-up removes its own set-up token from the account; the stand-in holds it ${JSON.stringify((W.tokensOn(ctx.standIn).find((x) => x.id === ctx.setUp.id) || {}).status)}`);
  const after = ctx.standIn.call('GET', `/accounts/${W.ACCOUNT}/tokens/verify`, ctx.setUp.value);
  assert.ok(after.status === 401 || after.status === 403, `${what}: a call made with the set-up token afterwards is refused; got ${after.status}`);
}

const CANNOT_TELL = /(cannot|can't|can not|could not|does not|doesn't) (tell|know|read) where/i;

// A set-up that did not report done leaves no token it made active on the
// account and nothing kept in the Keychain, so Squire's own deploy is then
// not let through as set up: it is asked saying it cannot tell where the site
// goes, as before any set-up. The world must be laid (websiteWorld laid).
function assertNothingKept(ctx, what) {
  const made = W.tokensOn(ctx.standIn).filter((x) => x.createdBy && x.status === 'active');
  assert.deepEqual(made.map((x) => x.name), [], `${what}: no token the set-up made is left active on the account`);
  assert.equal(w.hasSecret(ctx.keychain, W.KEPT_SECRET), false, `${what}: nothing is kept in the Keychain as ${W.KEPT_SECRET}`);
  const { world } = ctx;
  const floor = U.laidFloor(world, U.UTC);
  for (const mode of MODES) {
    const job = `job-site-not-set-up-${mode}`;
    const name = `ada-bakes-${mode}`;
    W.startSite(world, floor, job, mode);
    const folder = W.writeSite(world, floor, job, name, mode);
    W.previewSite(world, floor, job, folder, mode);
    const r = floor.run(job, w.tools.bash(W.deployCommand(world, folder, name)), mode);
    w.assertBlocked(r, `${what}: Squire's own deploy of a previewed site after it, in ${mode} mode`);
    assert.notEqual(w.requestIdIn(r.stderr), null, `${what}: Squire's own deploy after it is asked, not let through as set up, in ${mode} mode; got ${w.describe(r)}`);
    assert.match(r.stderr, CANNOT_TELL, `${what}: the ask says it cannot tell where the site goes, as before any set-up, in ${mode} mode; got ${w.describe(r)}`);
  }
}

test('after the one-off set-up, the account read back shows no paid subscription, the only token left on it deploys and nothing else, so nothing left there can spend, and the set-up token is gone; a paid subscription found on stops the set-up, which names it and changes no billing; a set-up token without the rights it needs runs nothing', { timeout: 300000 }, (t) => {
  const ctx = W.websiteWorld(t);
  const r = W.runSetUp(ctx);
  W.assertRan(r, 'the set-up on an account on the free plans');
  assert.equal(r.status, 0, `the set-up on an account on the free plans reports done (exit 0); got ${w.describe(r)}`);
  const reads = W.callsWith(ctx.standIn, ctx.setUp.value).filter((c) => c.method === 'GET' && /\/accounts\/[^/]+\/subscriptions(\?|$)/.test(c.path));
  assert.equal(reads.length, 1, `the set-up reads the account's subscriptions once, with the set-up token; got ${reads.length}`);
  assert.equal(reads[0].status, 200, 'the subscriptions read goes through with Billing Read');
  assert.deepEqual(billingWrites(ctx.standIn), [], 'Squire changes no billing on the account');
  const kept = W.keptToken(ctx);
  assert.deepEqual(W.activeTokens(ctx.standIn).map((x) => x.id), [kept.record.id], 'the spend guard: the only token left on the account is the deploy token the set-up keeps');
  assert.deepEqual(W.rightsOf(kept.record), [{ effect: 'allow', resources: [`com.cloudflare.api.account.${W.ACCOUNT}`], groups: [W.KEPT_RIGHT] }],
    'the spend guard: the kept token can deploy a Worker on the owner\'s account and can do nothing that spends');
  assertSetUpTokenRemoved(ctx, 'after the set-up');
  assert.match(W.said(r), /spend|cost|money/i, `the set-up tells the owner that nothing left on the account can spend; got ${w.describe(r)}`);
  assert.deepEqual(ctx.standIn.offLoopback(), [], 'no call left the loopback');

  const paid = W.websiteWorld(t, { laid: true, subscriptions: [...W.FREE, { ...W.FREE[0], id: 'standin-sub-0002', rate_plan: { ...W.FREE[0].rate_plan, id: 'standin-paid', public_name: 'Workers Paid' }, price: 5, state: 'Paid' }] });
  const p = W.runSetUp(paid);
  W.assertRan(p, 'the set-up on an account with a paid subscription on');
  assertSetUpTokenRemoved(paid, 'a set-up that found a paid subscription');
  assert.notEqual(p.status, 0, `a set-up that finds a paid subscription on does not report done; got ${w.describe(p)}`);
  assert.ok(W.said(p).includes('Workers Paid'), `it names the paid subscription to the owner; got ${w.describe(p)}`);
  assert.deepEqual(billingWrites(paid.standIn), [], 'Squire switches no paid feature off itself: that is the owner\'s to do');
  assertNothingKept(paid, 'a set-up that found a paid subscription');
  assert.deepEqual(paid.standIn.offLoopback(), [], 'no call left the loopback');

  const narrow = W.websiteWorld(t, { rights: ['Account API Tokens Write'] });
  const n = W.runSetUp(narrow);
  W.assertRan(n, 'the set-up on a set-up token without Billing Read');
  assert.notEqual(n.status, 0, `the set-up does not run on a token without the rights it needs; got ${w.describe(n)}`);
  assert.match(W.said(n), /Billing Read/, `it names the rights it needs: Billing Read; got ${w.describe(n)}`);
  assert.match(W.said(n), /Account API Tokens/, `it names the rights it needs: Account API Tokens; got ${w.describe(n)}`);
  assert.deepEqual(narrow.standIn.calls().filter((c) => c.method === 'POST' && /\/tokens$/.test(c.path)), [], 'it makes no token on a set-up token without the rights it needs');
  assert.ok(setUpGone(narrow) || W.said(n).includes(narrow.setUp.name) || W.said(n).includes(narrow.setUp.id),
    `the set-up token, which can still make tokens, is removed from the account or named to the owner as left there; got ${w.describe(n)}`);
  assert.deepEqual(narrow.standIn.offLoopback(), [], 'no call left the loopback');
});

test('the set-up token is removed from the account even when a later step of the set-up fails, and a set-up that did not finish tells the owner what it left on the account: making the deploy token fails, or its first use fails', { timeout: 180000 }, (t) => {
  for (const [what, fail] of [['making the deploy token fails', { createToken: true }], ['the deploy token\'s first use fails', { subdomain: true }]]) {
    const ctx = W.websiteWorld(t, { fail });
    const r = W.runSetUp(ctx);
    W.assertRan(r, `the set-up when ${what}`);
    assertSetUpTokenRemoved(ctx, `when ${what}`);
    assert.notEqual(r.status, 0, `when ${what}, the set-up does not report done; got ${w.describe(r)}`);
    const left = W.activeTokens(ctx.standIn);
    if (left.length) {
      for (const token of left) {
        assert.ok(token.name && W.said(r).includes(token.name), `when ${what}, the set-up names each token it left on the account (${token.name}); got ${w.describe(r)}`);
      }
    } else {
      assert.match(W.said(r), /(nothing|no token)[^.]*\bleft\b|\bleft\b[^.]*(nothing|no token)/i, `when ${what}, the set-up tells the owner it left nothing on the account; got ${w.describe(r)}`);
    }
    assert.deepEqual(ctx.standIn.offLoopback(), [], 'no call left the loopback');
  }
});

test('when the set-up cannot remove its own set-up token from the account, it does not report done and names the set-up token to the owner as still on the account, names every other token it left there, and keeps nothing in the Keychain', { timeout: 180000 }, (t) => {
  const ctx = W.websiteWorld(t, { fail: { deleteToken: true } });
  const r = W.runSetUp(ctx);
  W.assertRan(r, 'the set-up when removing the set-up token fails');
  assert.ok(ctx.standIn.calls().some((c) => c.method === 'DELETE' && c.path.split('?')[0] === `/client/v4/accounts/${W.ACCOUNT}/tokens/${ctx.setUp.id}`),
    'the set-up tries to remove its own set-up token from the account');
  assert.equal((W.tokensOn(ctx.standIn).find((x) => x.id === ctx.setUp.id) || {}).status, 'active', 'the removal failed: the set-up token is still on the account');
  assert.notEqual(r.status, 0, `a set-up whose set-up token is still on the account does not report done; got ${w.describe(r)}`);
  assert.ok(W.said(r).includes(ctx.setUp.name) || W.said(r).includes(ctx.setUp.id),
    `it names the set-up token to the owner as still on the account (${ctx.setUp.name}); got ${w.describe(r)}`);
  for (const token of W.activeTokens(ctx.standIn).filter((x) => x.id !== ctx.setUp.id)) {
    assert.ok(token.name && W.said(r).includes(token.name), `it names each other token it left on the account (${token.name}); got ${w.describe(r)}`);
  }
  assert.equal(w.hasSecret(ctx.keychain, W.KEPT_SECRET), false, `a set-up that did not report done keeps nothing in the Keychain as ${W.KEPT_SECRET}`);
  assert.deepEqual(billingWrites(ctx.standIn), [], 'Squire changes no billing');
  assert.deepEqual(ctx.standIn.offLoopback(), [], 'no call left the loopback');
});

test("the set-up token reaches the set-up only through Squire's secret helper, from the Keychain, and is never written to a file, the chat or the ledger; a set-up token given any other way, or a Cloudflare token already on the Mac, is never used", { timeout: 180000 }, (t) => {
  const ctx = W.websiteWorld(t);
  const strays = W.plantStrays(ctx.world);
  const r = W.runSetUp(ctx, { env: strays.env });
  W.assertRan(r, 'the set-up with a Cloudflare token in the environment and a sign-in on the Mac');
  assert.equal(r.status, 0, `the set-up reports done; got ${w.describe(r)}`);
  const kept = W.keptToken(ctx);
  const apiCalls = ctx.standIn.calls().filter((c) => c.path.startsWith('/client/v4/'));
  assert.ok(W.callsWith(ctx.standIn, ctx.setUp.value).length > 0, 'the set-up calls the account with the set-up token from the Keychain');
  for (const c of apiCalls) {
    assert.ok([ctx.setUp.value, kept.value].includes(c.token), `every call the set-up made carried the set-up token from the Keychain or the token it made, never a stray: ${c.method} ${c.path}`);
    assert.ok(!c.path.includes(W.OTHER_ACCOUNT), `no call names an account but the one the owner gave: ${c.method} ${c.path}`);
  }
  for (const [name, secret] of [['the set-up token', ctx.setUp.value], ['the kept token', kept.value]]) {
    for (const trace of w.tracesOf(secret)) {
      assert.ok(!Buffer.from(W.said(r), 'utf8').includes(trace.bytes), `the chat never shows ${name} (${trace.name})`);
    }
    const holding = w.filesHolding([ctx.world.home, ctx.world.owner, ctx.world.userHome, ctx.world.tmp, ctx.world.transcript], secret, { everyTrace: true });
    assert.deepEqual(holding, [], `no file holds ${name}, the approvals ledger included`);
  }

  const given = W.websiteWorld(t, { inKeychain: false });
  const g = W.runSetUp(given, { env: { CLOUDFLARE_API_TOKEN: given.setUp.value, CF_API_TOKEN: given.setUp.value, SQUIRE_CLOUDFLARE_TOKEN: given.setUp.value } });
  W.assertRan(g, 'the set-up with the set-up token in the environment and none in the Keychain');
  assert.notEqual(g.status, 0, `with no set-up token in the Keychain the set-up does not run; got ${w.describe(g)}`);
  assert.match(W.said(g), new RegExp(W.SET_UP_SECRET), `it tells the owner the set-up token goes in the Keychain as ${W.SET_UP_SECRET}; got ${w.describe(g)}`);
  assert.deepEqual(W.callsWith(given.standIn, given.setUp.value), [], 'a set-up token given in the environment is never used');
  assert.deepEqual(given.standIn.offLoopback(), [], 'no call left the loopback');
});

// Adding a payment method: the public API reference read names no route for
// it, so no instance here; a browser call on the hosting dashboard is an open
// class, not decided by these instances.
test("Squire never upgrades a plan or buys on the Cloudflare account: a call to Cloudflare's API that would is refused, not asked, yes or no, in the default mode and in auto mode, by curl or through Squire's secret helper with the deploy token", { timeout: 180000 }, (t) => {
  const ctx = W.websiteWorld(t, { laid: true });
  const { world } = ctx;
  const floor = U.laidFloor(world, U.UTC);
  const api = 'https://api.cloudflare.com/client/v4';
  const zone = 'abcdabcdabcdabcdabcdabcdabcdabcd';
  const secretTool = `/usr/bin/python3 '${world.home}/core/tools/secret.py'`;
  for (const mode of MODES) {
    const job = `job-site-money-${mode}`;
    W.startSite(world, floor, job, mode);
    for (const [what, command] of [
      ['a paid plan bought on the account', `curl -X POST ${api}/accounts/${W.ACCOUNT}/subscriptions -H 'Content-Type: application/json' --data '{"rate_plan":{"id":"workers_paid"}}'`],
      ['the account\'s plan changed to a paid one', `curl -X PUT ${api}/accounts/${W.ACCOUNT}/subscriptions/standin-sub-0001 -H 'Content-Type: application/json' --data '{"rate_plan":{"id":"workers_paid"}}'`],
      ['a zone\'s plan upgraded', `curl -X POST ${api}/zones/${zone}/subscription -H 'Content-Type: application/json' --data '{"rate_plan":{"id":"pro"}}'`],
      ['a zone\'s plan changed in place', `curl -X PATCH ${api}/zones/${zone} -H 'Content-Type: application/json' --data '{"plan":{"id":"pro"}}'`],
      ['a plan bought through Squire\'s secret helper with the deploy token', `${secretTool} run ${W.KEPT_SECRET} --as CLOUDFLARE_API_TOKEN -- /usr/bin/curl -X POST ${api}/accounts/${W.ACCOUNT}/subscriptions --data '{"rate_plan":{"id":"workers_paid"}}'`],
    ]) {
      const first = floor.run(job, w.tools.bash(command), mode);
      w.assertBlocked(first, `${what}, in ${mode} mode`);
      assert.equal(w.requestIdIn(first.stderr), null, `${what}, in ${mode} mode: refused, not asked, since it would spend the owner's money; got a request the owner could answer: ${w.describe(first)}`);
      assert.match(first.stderr, /money|spend|pay|buy|billing/i, `${what}, in ${mode} mode: the refusal says it is about money; got ${w.describe(first)}`);
      w.ownerSays(world, job, 'yes', { env: U.UTC });
      const again = floor.run(job, w.tools.bash(command), mode);
      w.assertBlocked(again, `${what}, in ${mode} mode, even after the owner said yes`);
      assert.equal(w.requestIdIn(again.stderr), null, `${what}, in ${mode} mode, after a yes: still refused, not asked; got ${w.describe(again)}`);
    }
  }
  assert.deepEqual(ctx.standIn.offLoopback(), [], 'no call left the loopback');
});

// The money refusal is about what a call does, not which program makes it:
// the same paid-plan write by two other clients. The refusal is read for what
// it says beyond the command it echoes back.
test("Squire never buys on the Cloudflare account by a client other than curl: the same paid-plan write to the account's subscriptions by wget or by a python3 urllib call is refused, not asked, yes or no, the refusal saying it is about money, in the default mode and in auto mode", { timeout: 180000 }, (t) => {
  const ctx = W.websiteWorld(t, { laid: true });
  const { world } = ctx;
  const floor = U.laidFloor(world, U.UTC);
  const subscriptions = `https://api.cloudflare.com/client/v4/accounts/${W.ACCOUNT}/subscriptions`;
  for (const mode of MODES) {
    const job = `job-site-money-clients-${mode}`;
    W.startSite(world, floor, job, mode);
    for (const [what, command] of [
      ['a paid plan bought by wget', `wget --method=POST --header='Content-Type: application/json' --body-data='{"rate_plan":{"id":"workers_paid"}}' ${subscriptions}`],
      ['a paid plan bought by a python3 urllib call', `python3 -c "import json, urllib.request as u; u.urlopen(u.Request('${subscriptions}', data=json.dumps({'rate_plan': {'id': 'workers_paid'}}).encode(), method='POST', headers={'Content-Type': 'application/json'}))"`],
    ]) {
      for (const when of ['', ', even after the owner said yes']) {
        if (when) w.ownerSays(world, job, 'yes', { env: U.UTC });
        const r = floor.run(job, w.tools.bash(command), mode);
        w.assertBlocked(r, `${what}, in ${mode} mode${when}`);
        assert.equal(w.requestIdIn(r.stderr), null, `${what}, in ${mode} mode${when}: refused, not asked, since it would spend the owner's money; got a request the owner could answer: ${w.describe(r)}`);
        assert.match(r.stderr.split(command).join(' '), /money|spend|pay|buy|billing/i, `${what}, in ${mode} mode${when}: the refusal says it is about money; got ${w.describe(r)}`);
      }
    }
  }
  assert.deepEqual(billingWrites(ctx.standIn), [], 'nothing reached the account\'s billing');
  assert.deepEqual(ctx.standIn.offLoopback(), [], 'no call left the loopback');
});

test('a subscription the set-up cannot read as free counts as paid: the set-up does not report done and names it to the owner; when it cannot read the subscriptions at all it does not report done and says so; Squire changes no billing', { timeout: 300000 }, (t) => {
  const base = W.FREE[0];
  for (const [what, extra, named] of [
    ['a subscription with no price', { id: 'standin-sub-0003', rate_plan: { ...base.rate_plan, id: 'standin-plan-x', public_name: 'Mystery Add-on' }, state: 'Provisioned', price: undefined }, 'Mystery Add-on'],
    ['a subscription priced as nothing it can read', { ...base, id: 'standin-sub-0004', rate_plan: { ...base.rate_plan, id: 'standin-plan-y', public_name: 'Unpriced Add-on' }, price: null }, 'Unpriced Add-on'],
    ['a subscription priced in words', { ...base, id: 'standin-sub-0005', rate_plan: { ...base.rate_plan, id: 'standin-plan-z', public_name: 'Wordy Add-on' }, price: 'free' }, 'Wordy Add-on'],
  ]) {
    const sub = { ...base, ...extra };
    if (extra.price === undefined) delete sub.price;
    const ctx = W.websiteWorld(t, { laid: true, subscriptions: [...W.FREE, sub] });
    const r = W.runSetUp(ctx);
    W.assertRan(r, `the set-up with ${what}`);
    assertSetUpTokenRemoved(ctx, `a set-up that found ${what}`);
    assert.notEqual(r.status, 0, `with ${what}, the set-up does not report done: it counts as paid; got ${w.describe(r)}`);
    assert.ok(W.said(r).includes(named), `with ${what}, the set-up names it to the owner (${named}); got ${w.describe(r)}`);
    assert.deepEqual(billingWrites(ctx.standIn), [], `with ${what}, Squire changes no billing`);
    assertNothingKept(ctx, `a set-up that found ${what}`);
    assert.deepEqual(ctx.standIn.offLoopback(), [], 'no call left the loopback');
  }

  const unread = W.websiteWorld(t, { laid: true, fail: { subscriptions: true } });
  const u = W.runSetUp(unread);
  W.assertRan(u, 'the set-up when the subscriptions cannot be read');
  assertSetUpTokenRemoved(unread, 'a set-up that could not read the subscriptions');
  assert.notEqual(u.status, 0, `when it cannot read the subscriptions, the set-up does not report done; got ${w.describe(u)}`);
  assert.match(W.said(u), /subscription|billing/i, `it tells the owner what it could not read; got ${w.describe(u)}`);
  assert.match(W.said(u), /(could not|cannot|couldn't|can't|unable to) (read|check|tell)/i, `it says it could not read them; got ${w.describe(u)}`);
  assert.deepEqual(billingWrites(unread.standIn), [], 'Squire changes no billing');
  assertNothingKept(unread, 'a set-up that could not read the subscriptions');
  assert.deepEqual(unread.standIn.offLoopback(), [], 'no call left the loopback');
});
