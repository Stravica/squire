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
//   it reads the account's subscriptions, every page of them, with that
//     token (Billing Read, read only) and reports done only when every one
//     reads as free (a price of exactly 0), or on the owner's yes to keeping
//     each paid item it named. A subscription with a price is paid; one whose
//     price it cannot read as a number counts as paid; a read that fails is
//     not done. Either way it names what it found to the owner and changes no
//     billing, ever (a paid feature is the owner's to switch off or keep);
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
// What costs money on the account is the owner's to keep (his account, his
// money): a set-up that finds a paid item, or one it cannot read as free,
// names each with its price (or says it cannot read the price), warns that it
// costs money and that Squire changes no billing, and does not report done;
// the owner's yes to keeping what it named is the set-up run again as
// website.py set-up <account id> --keep-paid (website-world.js KEEP_PAID),
// which the floor asks for, naming each paid item, in the default mode and in
// auto mode, and which then finishes on that yes, keeps the one deploy-only
// token and names the kept paid items in its done words. Pinned here, on the
// fail-closed reading: a yes covers only the paid items the set-up named
// before it (a paid item it had not named is named and the set-up does not
// report done); a yes to an ordinary set-up run is not a yes to keeping what
// costs money; a no keeps the set-up from finishing. Every not-done run
// removes its set-up token, as before, so the run on his yes takes a new
// set-up token the owner makes and stores (the cases store a second invented
// one). Every page of subscriptions is read: a paid item on a later page is
// named and asked as one on the first.
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
const B = require('../fixtures/browser-world.js');
const W = require('../fixtures/website-world.js');
const CF = require('../fixtures/cloudflare-stand-in.js');

const MODES = ['default', 'auto'];

// The set-up's warning over what costs money: that it costs money, and that
// Squire changes no billing (its words are the builder's, these the meaning).
const COSTS = /\b(costs?|money|charged?|pays?)\b/i;
const NO_BILLING = /\bno billing\b|billing (is |stays |was )?(untouched|unchanged)|(does not|doesn't|never|did not) change[sd]? (any |the |your )?billing/i;

// Another short-lived set-up token the owner makes and stores after a set-up
// that stopped over a paid item: invented, held by the stand-in.
const anotherSetUp = (n) => ({
  id: `standin-token-set-up-000${n}`, value: W.fakeToken(`set-up-${n}`), name: `Set-up token ${n} the owner made (invented)`,
  policies: [CF.policyFor(W.ACCOUNT, W.SET_UP_RIGHTS)],
});

// The owner's yes to keeping what the set-up named, as the session runs it:
// asked through the floor in this mode, in a job of its own, the ask naming
// each paid item beyond the command it echoes; answered yes, then let
// through. Returns the request id.
function keepAskedThenYes(ctx, floor, job, mode, named, what) {
  const keep = w.tools.bash(W.setUpCommand(ctx.world, W.ACCOUNT, [W.KEEP_PAID]));
  const asked = floor.run(job, keep, mode);
  w.assertBlocked(asked, `${what}: the set-up run again to keep what it named, in ${mode} mode, before any yes`);
  const id = w.requestIdIn(asked.stderr);
  assert.notEqual(id, null, `${what}: keeping what costs money is asked, in ${mode} mode; got ${w.describe(asked)}`);
  const beyond = asked.stderr.split(keep[1].command).join(' ');
  for (const item of named) {
    assert.ok(beyond.includes(item), `${what}: the ask names ${item}, in ${mode} mode; got ${w.describe(asked)}`);
  }
  U.sayYesTo(ctx.world, job, asked, { env: U.UTC });
  w.assertAllowed(floor.run(job, keep, mode), `${what}: keeping what the set-up named, in ${mode} mode, on the owner's yes`);
  return id;
}

// A finished set-up that kept the one deploy-only token and nothing else.
function assertKeptDeployOnly(ctx, what) {
  const kept = W.keptToken(ctx);
  assert.deepEqual(W.activeTokens(ctx.standIn).map((x) => x.id), [kept.record.id], `${what}: the only token left on the account is the deploy token the set-up keeps`);
  assert.deepEqual(W.rightsOf(kept.record), [{ effect: 'allow', resources: [`com.cloudflare.api.account.${W.ACCOUNT}`], groups: [W.KEPT_RIGHT] }],
    `${what}: the kept token can deploy a Worker on the owner's account and nothing else`);
}

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

  // Every paid feature, not only Workers plans: a paid Workers plan, and a
  // paid plan on a zone, each priced above 0 in the account's answer.
  for (const [what, sub] of [
    ['a paid Workers plan', { ...W.FREE[0], id: 'standin-sub-0002', rate_plan: { ...W.FREE[0].rate_plan, id: 'standin-paid', public_name: 'Workers Paid' }, price: 5, state: 'Paid' }],
    ['a paid plan on a zone, not a Workers plan', { ...W.FREE[0], id: 'standin-sub-0006', rate_plan: { ...W.FREE[0].rate_plan, id: 'standin-zone-pro', public_name: 'Pro Plan', scope: 'zone' }, price: 20, state: 'Paid' }],
  ]) {
    const named = sub.rate_plan.public_name;
    const paid = W.websiteWorld(t, { laid: true, subscriptions: [...W.FREE, sub] });
    const p = W.runSetUp(paid);
    W.assertRan(p, `the set-up on an account with ${what} on`);
    assertSetUpTokenRemoved(paid, `a set-up that found ${what}`);
    assert.notEqual(p.status, 0, `a set-up that finds ${what} on does not report done; got ${w.describe(p)}`);
    assert.ok(W.said(p).includes(named), `it names ${what} to the owner (${named}); got ${w.describe(p)}`);
    assert.deepEqual(billingWrites(paid.standIn), [], 'Squire switches no paid feature off itself: that is the owner\'s to do');
    assertNothingKept(paid, `a set-up that found ${what}`);
    assert.deepEqual(paid.standIn.offLoopback(), [], 'no call left the loopback');
  }

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
// it, so no instance here; a browser call on the Cloudflare dashboard is
// refused by its host (a case below), and no other hosting dashboard is
// decided by these instances.
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

// The Cloudflare dashboard's host, as Cloudflare's public pages link to it
// (https://developers.cloudflare.com/fundamentals/account/find-account-and-zone-ids/).
// The floor cannot tell a purchase, a plan change or a payment method added
// there from any other act, so a browser call to it is refused, yes or no:
// decided on the fail-closed reading, for this one host. No browser is
// started: the call is put to the floor only, so nothing is opened.
const DASHBOARD = 'https://dash.cloudflare.com';

test("Squire's browser never opens the Cloudflare dashboard, where a plan could be bought: in a site job, with the owner's profile there to check, a browser navigate to the dashboard's host is refused, not asked, yes or no, the refusal naming the dashboard or money, in the default mode and in auto mode", { timeout: 180000 }, (t) => {
  const ctx = W.websiteWorld(t, { laid: true });
  const { world } = ctx;
  B.writeOwnerProfile(world);
  const floor = U.laidFloor(world, U.UTC);
  for (const mode of MODES) {
    const job = `job-site-dashboard-money-${mode}`;
    W.startSite(world, floor, job, mode);
    for (const url of [`${DASHBOARD}/`, `${DASHBOARD}/?to=/:account/home`]) {
      for (const when of ['', ', even after the owner said yes']) {
        if (when) w.ownerSays(world, job, 'yes', { env: U.UTC });
        const r = floor.run(job, B.browserTools.navigate(url), mode);
        w.assertBlocked(r, `a browser navigate to ${url}, in ${mode} mode${when}`);
        assert.equal(w.requestIdIn(r.stderr), null, `a browser navigate to ${url}, in ${mode} mode${when}: refused, not asked; got a request the owner could answer: ${w.describe(r)}`);
        assert.match(r.stderr.split(url).join(' '), /dashboard|money|spend|pay|buy|billing/i, `a browser navigate to ${url}, in ${mode} mode${when}: the refusal names the dashboard or money, not another reason; got ${w.describe(r)}`);
      }
    }
  }
  assert.deepEqual(billingWrites(ctx.standIn), [], 'nothing reached the account\'s billing');
  assert.deepEqual(ctx.standIn.offLoopback(), [], 'no call left the loopback');
});

test("a subscription the set-up cannot read as free counts as paid: the set-up names it with its price, or says it cannot read the price, warns that it costs money and that Squire changes no billing, and does not report done; on the owner's yes to keeping it, asked naming it in the default mode and in auto mode, the set-up finishes, keeps one deploy-only token and names it in its done words; when it cannot read the subscriptions at all it does not report done and says so", { timeout: 900000 }, (t) => {
  const base = W.FREE[0];
  for (const [what, options, named, price, onToYes] of [
    ['a subscription priced above 0', { pricedItem: true }, CF.PRICED_ITEM.rate_plan.public_name, String(CF.PRICED_ITEM.price), true],
    ['a subscription with no price', { extra: { id: 'standin-sub-0003', rate_plan: { ...base.rate_plan, id: 'standin-plan-x', public_name: 'Mystery Add-on' }, state: 'Provisioned', price: undefined } }, 'Mystery Add-on', null, true],
    ['a subscription priced as nothing it can read', { extra: { ...base, id: 'standin-sub-0004', rate_plan: { ...base.rate_plan, id: 'standin-plan-y', public_name: 'Unpriced Add-on' }, price: null } }, 'Unpriced Add-on', null, false],
    ['a subscription priced in words', { extra: { ...base, id: 'standin-sub-0005', rate_plan: { ...base.rate_plan, id: 'standin-plan-z', public_name: 'Wordy Add-on' }, price: 'free' } }, 'Wordy Add-on', null, false],
  ]) {
    const { extra, ...rest } = options;
    const shape = { laid: true, ...rest };
    if (extra) {
      const sub = { ...base, ...extra };
      if (extra.price === undefined) delete sub.price;
      shape.subscriptions = [...W.FREE, sub];
    }
    const second = anotherSetUp(2);
    const ctx = W.websiteWorld(t, { ...shape, extraTokens: [second] });
    const r = W.runSetUp(ctx);
    W.assertRan(r, `the set-up with ${what}`);
    assertSetUpTokenRemoved(ctx, `a set-up that found ${what}`);
    assert.notEqual(r.status, 0, `with ${what} and no yes, the set-up does not report done: it counts as paid; got ${w.describe(r)}`);
    assert.ok(W.said(r).includes(named), `with ${what}, the set-up names it to the owner (${named}); got ${w.describe(r)}`);
    if (price) assert.ok(W.said(r).includes(price), `with ${what}, the set-up names its price (${price}); got ${w.describe(r)}`);
    else assert.match(W.said(r), /price/i, `with ${what}, the set-up says what of its price it cannot read; got ${w.describe(r)}`);
    assert.match(W.said(r), COSTS, `with ${what}, the set-up warns that it costs money; got ${w.describe(r)}`);
    assert.match(W.said(r), NO_BILLING, `with ${what}, the set-up says Squire changes no billing; got ${w.describe(r)}`);
    assert.deepEqual(billingWrites(ctx.standIn), [], `with ${what}, Squire changes no billing`);
    assertNothingKept(ctx, `a set-up that found ${what}, before any yes`);
    if (onToYes) {
      const floor = U.laidFloor(ctx.world, U.UTC);
      for (const mode of MODES) keepAskedThenYes(ctx, floor, `job-keep-what-it-found-${mode}`, mode, [named], `with ${what}`);
      // The owner makes a new set-up token, as the run on his yes needs one.
      w.storeSecret(ctx.keychain, W.SET_UP_SECRET, second.value);
      const from = ctx.standIn.calls().length;
      const k = W.runSetUp(ctx, { extra: [W.KEEP_PAID] });
      W.assertRan(k, `the set-up on the owner's yes to keeping ${what}`);
      assert.equal(k.status, 0, `on the owner's yes to keeping ${what}, the set-up reports done; got ${w.describe(k)}`);
      assert.ok(W.said(k).includes(named), `its done words name what the owner kept (${named}); got ${w.describe(k)}`);
      assert.doesNotMatch(W.said(k), /every subscription there reads as free/i, `with ${what} kept, the done words never say every subscription reads as free; got ${w.describe(k)}`);
      assertKeptDeployOnly(ctx, `the set-up on the owner's yes to keeping ${what}`);
      assert.equal((W.tokensOn(ctx.standIn).find((x) => x.id === second.id) || {}).status, 'deleted', `the set-up token of the run on his yes is removed too; its calls: ${JSON.stringify(ctx.standIn.calls().slice(from).map((c) => `${c.method} ${c.path} ${c.status}`))}`);
      assert.deepEqual(billingWrites(ctx.standIn), [], `with ${what} kept, Squire changes no billing: it stays as the owner keeps it`);
    }
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

// A set-up token of the wrong kind. The stand-in answers a token the owner
// made under their own profile as a real account did (its header names the
// assumption): the account's path refuses it 401 with code 1000 and the user
// path's verify accepts it. Pinned here, on the fail-closed reading (no record
// settles it): the set-up tells such a token from an invalid one by the user
// path's verify (GET /user/tokens/verify), made only after the account's path
// refused it; such a token gets words that say the set-up token must be an
// account-owned token and that it is made under Manage account, then Account
// API Tokens; a token refused on both paths keeps today's words.
const accountVerify = `/client/v4/accounts/${W.ACCOUNT}/tokens/verify`;
const userVerify = '/client/v4/user/tokens/verify';

test("a set-up token the owner made under their own profile, which Cloudflare refuses on the account's path and accepts on the user path, gets words that say the set-up token must be an account-owned token, made under Manage account, then Account API Tokens; the set-up makes nothing on the account and keeps nothing in the Keychain", { timeout: 180000 }, (t) => {
  const ctx = W.websiteWorld(t, { setUpOwnedBy: 'user' });
  // The premise, read by the case itself on the stand-in.
  assert.equal(ctx.standIn.call('GET', `/accounts/${W.ACCOUNT}/tokens/verify`, ctx.setUp.value).status, 401, 'the account\'s path refuses a user-owned token');
  assert.equal(ctx.standIn.call('GET', '/user/tokens/verify', ctx.setUp.value).status, 200, 'the user path accepts it');
  const from = ctx.standIn.calls().length;
  const r = W.runSetUp(ctx);
  W.assertRan(r, 'the set-up with a user-owned set-up token');
  const words = W.said(r);
  assert.match(words, /account-owned/i, `the set-up says the set-up token must be an account-owned token; got ${w.describe(r)}`);
  assert.ok(words.includes('Manage account, then Account API Tokens'), `the set-up says where to make it: Manage account, then Account API Tokens; got ${w.describe(r)}`);
  assert.notEqual(r.status, 0, `the set-up does not report done; got ${w.describe(r)}`);
  const calls = ctx.standIn.calls().slice(from);
  const onAccount = calls.findIndex((c) => c.method === 'GET' && c.path === accountVerify);
  const onUser = calls.findIndex((c) => c.method === 'GET' && c.path === userVerify);
  assert.ok(onAccount >= 0 && onUser > onAccount, `the set-up checks the token on the user path only after the account's path refused it; its calls: ${JSON.stringify(calls.map((c) => `${c.method} ${c.path} ${c.status}`))}`);
  assert.deepEqual(calls.filter((c) => c.method !== 'GET').map((c) => `${c.method} ${c.path}`), [], 'the set-up writes nothing to the account');
  assert.deepEqual(W.activeTokens(ctx.standIn).map((x) => x.id), [ctx.setUp.id], 'no token is made on the account');
  assert.equal(w.hasSecret(ctx.keychain, W.KEPT_SECRET), false, `nothing is kept in the Keychain as ${W.KEPT_SECRET}`);
  assert.deepEqual(ctx.standIn.offLoopback(), [], 'no call left the loopback');
});

test("a set-up token Cloudflare refuses on both the account's path and the user path keeps today's words, to check the account id and the token, and is never called user-owned or sent to make an account-owned one; the set-up makes nothing and keeps nothing", { timeout: 180000 }, (t) => {
  const ctx = W.websiteWorld(t, { inKeychain: false });
  const unknown = W.fakeToken('set-up-unknown');
  w.storeSecret(ctx.keychain, W.SET_UP_SECRET, unknown);
  assert.equal(ctx.standIn.call('GET', `/accounts/${W.ACCOUNT}/tokens/verify`, unknown).status, 401, 'the account\'s path refuses the token');
  assert.equal(ctx.standIn.call('GET', '/user/tokens/verify', unknown).status, 401, 'the user path refuses it too');
  const from = ctx.standIn.calls().length;
  const r = W.runSetUp(ctx);
  W.assertRan(r, 'the set-up with a token Cloudflare refuses');
  const words = W.said(r);
  assert.notEqual(r.status, 0, `the set-up does not report done; got ${w.describe(r)}`);
  assert.ok(words.includes(`Cloudflare did not accept the set-up token on account ${W.ACCOUNT}`), `the set-up says Cloudflare did not accept the set-up token; got ${w.describe(r)}`);
  assert.match(words, /check the account id and the token/i, `it keeps today's advice, to check the account id and the token; got ${w.describe(r)}`);
  assert.doesNotMatch(words, /account-owned|user-owned|own profile|Manage account/i, `a token refused on both paths is never called user-owned or sent to be made again elsewhere; got ${w.describe(r)}`);
  const calls = ctx.standIn.calls().slice(from);
  assert.deepEqual(calls.filter((c) => c.method !== 'GET').map((c) => `${c.method} ${c.path}`), [], 'the set-up writes nothing to the account');
  assert.equal(w.hasSecret(ctx.keychain, W.KEPT_SECRET), false, `nothing is kept in the Keychain as ${W.KEPT_SECRET}`);
  assert.deepEqual(ctx.standIn.offLoopback(), [], 'no call left the loopback');
});

// The account's path refusing a user-owned token in another way than 401 with
// code 1000: the stand-in's own setting (userOwnedRefusals), not seen on a
// real account. Pinned here, on the same fail-closed reading as above: the
// kind of refusal on the account's path does not decide the words; an active
// verify on the user path does, and a token the user path refuses too keeps
// today's words.
const OTHER_REFUSAL = { status: 403, code: 10000, message: 'Authentication error' };
const USER_REFUSAL = { status: 401, code: 1000, message: 'Invalid API Token' };

test("a set-up token Cloudflare refuses on the account's path with another refusal than an invalid token, and accepts on the user path, gets words that say the set-up token must be an account-owned token, made under Manage account, then Account API Tokens; the set-up makes nothing on the account and keeps nothing in the Keychain", { timeout: 180000 }, (t) => {
  const ctx = W.websiteWorld(t, { setUpOwnedBy: 'user', userOwnedRefusals: { account: OTHER_REFUSAL } });
  // The premise, read by the case itself on the stand-in.
  const onAccountPath = ctx.standIn.call('GET', `/accounts/${W.ACCOUNT}/tokens/verify`, ctx.setUp.value);
  assert.equal(onAccountPath.status, 403, 'the account\'s path refuses the token with 403');
  assert.equal(JSON.parse(onAccountPath.body).errors[0].code, 10000, 'with a code other than 1000');
  assert.equal(ctx.standIn.call('GET', '/user/tokens/verify', ctx.setUp.value).status, 200, 'the user path accepts it');
  const from = ctx.standIn.calls().length;
  const r = W.runSetUp(ctx);
  W.assertRan(r, 'the set-up with a user-owned set-up token refused another way');
  const words = W.said(r);
  assert.match(words, /account-owned/i, `the set-up says the set-up token must be an account-owned token; got ${w.describe(r)}`);
  assert.ok(words.includes('Manage account, then Account API Tokens'), `the set-up says where to make it: Manage account, then Account API Tokens; got ${w.describe(r)}`);
  assert.notEqual(r.status, 0, `the set-up does not report done; got ${w.describe(r)}`);
  const calls = ctx.standIn.calls().slice(from);
  const onAccount = calls.findIndex((c) => c.method === 'GET' && c.path === accountVerify);
  const onUser = calls.findIndex((c) => c.method === 'GET' && c.path === userVerify);
  assert.ok(onAccount >= 0 && onUser > onAccount, `the set-up checks the token on the user path only after the account's path refused it; its calls: ${JSON.stringify(calls.map((c) => `${c.method} ${c.path} ${c.status}`))}`);
  assert.deepEqual(calls.filter((c) => c.method !== 'GET').map((c) => `${c.method} ${c.path}`), [], 'the set-up writes nothing to the account');
  assert.deepEqual(W.activeTokens(ctx.standIn).map((x) => x.id), [ctx.setUp.id], 'no token is made on the account');
  assert.equal(w.hasSecret(ctx.keychain, W.KEPT_SECRET), false, `nothing is kept in the Keychain as ${W.KEPT_SECRET}`);
  assert.deepEqual(ctx.standIn.offLoopback(), [], 'no call left the loopback');
});

test("a set-up token Cloudflare refuses on the account's path with another refusal than an invalid token, and refuses on the user path too, keeps today's words, to check the account id and the token, and is never called user-owned or sent to make an account-owned one; the set-up makes nothing and keeps nothing", { timeout: 180000 }, (t) => {
  const ctx = W.websiteWorld(t, { setUpOwnedBy: 'user', userOwnedRefusals: { account: OTHER_REFUSAL, userVerify: USER_REFUSAL } });
  assert.equal(ctx.standIn.call('GET', `/accounts/${W.ACCOUNT}/tokens/verify`, ctx.setUp.value).status, 403, 'the account\'s path refuses the token with 403');
  assert.equal(ctx.standIn.call('GET', '/user/tokens/verify', ctx.setUp.value).status, 401, 'the user path refuses it too');
  const from = ctx.standIn.calls().length;
  const r = W.runSetUp(ctx);
  W.assertRan(r, 'the set-up with a token Cloudflare refuses on both paths');
  const words = W.said(r);
  assert.notEqual(r.status, 0, `the set-up does not report done; got ${w.describe(r)}`);
  assert.ok(words.includes(`Cloudflare did not accept the set-up token on account ${W.ACCOUNT}`), `the set-up says Cloudflare did not accept the set-up token; got ${w.describe(r)}`);
  assert.match(words, /check the account id and the token/i, `it keeps today's advice, to check the account id and the token; got ${w.describe(r)}`);
  assert.doesNotMatch(words, /account-owned|user-owned|own profile|Manage account/i, `a token refused on both paths is never called user-owned or sent to be made again elsewhere; got ${w.describe(r)}`);
  const calls = ctx.standIn.calls().slice(from);
  assert.deepEqual(calls.filter((c) => c.method !== 'GET').map((c) => `${c.method} ${c.path}`), [], 'the set-up writes nothing to the account');
  assert.deepEqual(W.activeTokens(ctx.standIn).map((x) => x.id), [ctx.setUp.id], 'no token is made on the account');
  assert.equal(w.hasSecret(ctx.keychain, W.KEPT_SECRET), false, `nothing is kept in the Keychain as ${W.KEPT_SECRET}`);
  assert.deepEqual(ctx.standIn.offLoopback(), [], 'no call left the loopback');
});

// What costs money is the owner's to keep, and only on his own yes. Each run
// below is counted from its own first call on the stand-in, so a run is
// judged by what it did, never by an earlier run's calls.
const madeSince = (standIn, from) => standIn.calls().slice(from).filter((c) => c.method === 'POST' && /\/accounts\/[^/]+\/tokens$/.test(c.path.split('?')[0]));
const LATER_ITEM = {
  ...CF.PRICED_ITEM,
  id: 'standin-sub-priced-0008',
  rate_plan: { ...CF.PRICED_ITEM.rate_plan, id: 'standin-plan-pretend-backup', public_name: 'Pretend Backup Plus (invented)' },
  price: 3.25,
};

test("with a paid item named and no yes, or a no, the set-up does not report done and keeps nothing: the owner's no to keeping it, asked in the default mode and in auto mode, keeps that run from going ahead; a yes to an ordinary run of the set-up is not a yes to keeping it; and a yes covers only the paid items named before it, so one found after it is named and the set-up does not report done", { timeout: 900000 }, (t) => {
  const second = anotherSetUp(2);
  const third = anotherSetUp(3);
  const ctx = W.websiteWorld(t, { laid: true, pricedItem: true, extraTokens: [second, third] });
  const named = CF.PRICED_ITEM.rate_plan.public_name;

  // No answer at all: the set-up names it and stops, as it always has.
  const r = W.runSetUp(ctx);
  W.assertRan(r, 'the set-up with a paid item and no answer');
  assert.notEqual(r.status, 0, `with a paid item and no answer, the set-up does not report done; got ${w.describe(r)}`);
  assert.ok(W.said(r).includes(named), `it names the paid item (${named}); got ${w.describe(r)}`);
  assert.deepEqual(madeSince(ctx.standIn, 0).map((c) => c.path), [], 'with no answer, the set-up makes no token');
  assertSetUpTokenRemoved(ctx, 'a set-up with a paid item and no answer');
  assertNothingKept(ctx, 'a set-up with a paid item and no answer');

  // A no, in each mode, in a job of its own: the run on that ask does not go ahead.
  const floor = U.laidFloor(ctx.world, U.UTC);
  const keep = w.tools.bash(W.setUpCommand(ctx.world, W.ACCOUNT, [W.KEEP_PAID]));
  for (const mode of MODES) {
    const job = `job-keep-declined-${mode}`;
    const asked = floor.run(job, keep, mode);
    w.assertBlocked(asked, `keeping the paid item, in ${mode} mode, before any answer`);
    const id = w.requestIdIn(asked.stderr);
    assert.notEqual(id, null, `keeping the paid item is asked, in ${mode} mode; got ${w.describe(asked)}`);
    assert.ok(asked.stderr.split(keep[1].command).join(' ').includes(named), `the ask names the paid item (${named}), in ${mode} mode; got ${w.describe(asked)}`);
    w.ownerSays(ctx.world, job, `no ${id}`, { env: U.UTC });
    const after = floor.run(job, keep, mode);
    w.assertBlocked(after, `keeping the paid item, in ${mode} mode, after the owner said no`);
  }

  // A yes to an ordinary run of the set-up, with a new set-up token: it
  // names the paid item again and does not report done.
  w.storeSecret(ctx.keychain, W.SET_UP_SECRET, second.value);
  const plain = w.tools.bash(W.setUpCommand(ctx.world));
  const askedPlain = floor.run('job-set-up-again', plain, 'default');
  w.assertBlocked(askedPlain, 'an ordinary run of the set-up, before the yes');
  assert.notEqual(w.requestIdIn(askedPlain.stderr), null, `an ordinary run of the set-up is asked; got ${w.describe(askedPlain)}`);
  U.sayYesTo(ctx.world, 'job-set-up-again', askedPlain, { env: U.UTC });
  w.assertAllowed(floor.run('job-set-up-again', plain, 'default'), 'an ordinary run of the set-up, on the owner\'s yes to it');
  const fromPlain = ctx.standIn.calls().length;
  const p = W.runSetUp(ctx);
  W.assertRan(p, 'an ordinary run of the set-up on its yes');
  assert.notEqual(p.status, 0, `a yes to an ordinary run is not a yes to keeping the paid item: the set-up does not report done; got ${w.describe(p)}`);
  assert.ok(W.said(p).includes(named), `it names the paid item again (${named}); got ${w.describe(p)}`);
  assert.deepEqual(madeSince(ctx.standIn, fromPlain).map((c) => c.path), [], 'that run makes no token');
  assert.equal((W.tokensOn(ctx.standIn).find((x) => x.id === second.id) || {}).status, 'deleted', 'that run removes its set-up token');
  assert.equal(w.hasSecret(ctx.keychain, W.KEPT_SECRET), false, `that run keeps nothing in the Keychain as ${W.KEPT_SECRET}`);

  // A yes to keeping the item named, then a second paid item found: the yes
  // does not cover it.
  keepAskedThenYes(ctx, floor, 'job-keep-said-yes', 'default', [named], 'a yes to keeping the paid item named');
  ctx.standIn.set({ subscriptions: [...W.FREE, LATER_ITEM] });
  w.storeSecret(ctx.keychain, W.SET_UP_SECRET, third.value);
  const fromLater = ctx.standIn.calls().length;
  const k = W.runSetUp(ctx, { extra: [W.KEEP_PAID] });
  W.assertRan(k, 'the set-up on a yes that named one paid item, with a second found after it');
  assert.notEqual(k.status, 0, `a paid item found after the owner's yes is not covered by it: the set-up does not report done; got ${w.describe(k)}`);
  assert.ok(W.said(k).includes(LATER_ITEM.rate_plan.public_name), `it names the paid item found after the yes (${LATER_ITEM.rate_plan.public_name}); got ${w.describe(k)}`);
  assert.deepEqual(madeSince(ctx.standIn, fromLater).map((c) => c.path), [], 'that run makes no token');
  assert.equal((W.tokensOn(ctx.standIn).find((x) => x.id === third.id) || {}).status, 'deleted', 'that run removes its set-up token');
  assert.equal(w.hasSecret(ctx.keychain, W.KEPT_SECRET), false, `that run keeps nothing in the Keychain as ${W.KEPT_SECRET}`);
  const owners = [ctx.setUp.id, second.id, third.id];
  assert.deepEqual(W.activeTokens(ctx.standIn).filter((x) => !owners.includes(x.id)).map((x) => x.name), [], 'no token the set-up made is left on the account');
  assert.deepEqual(billingWrites(ctx.standIn), [], 'Squire changes no billing');
  assert.deepEqual(ctx.standIn.offLoopback(), [], 'no call left the loopback');
});

test("a paid item on the second page of the account's subscriptions is found, named with its price and asked: with the first page free and the answer naming a second, the set-up reads every page, does not report done before the owner's yes, and on his yes to keeping it, asked naming it in the default mode and in auto mode, finishes naming it", { timeout: 600000 }, (t) => {
  const second = anotherSetUp(2);
  const ctx = W.websiteWorld(t, { laid: true, subscriptionPages: [W.FREE, [CF.PRICED_ITEM]], extraTokens: [second] });
  const named = CF.PRICED_ITEM.rate_plan.public_name;
  // The premise, read by the case itself on the stand-in.
  const first = JSON.parse(ctx.standIn.call('GET', `/accounts/${W.ACCOUNT}/subscriptions`, ctx.setUp.value).body);
  assert.equal(first.result_info.total_pages, 2, 'the account\'s answer names a second page');
  assert.ok(first.result.every((x) => x.price === 0), 'its first page is free');
  const from = ctx.standIn.calls().length;
  const r = W.runSetUp(ctx);
  W.assertRan(r, 'the set-up with a paid item on the second page');
  assert.notEqual(r.status, 0, `with a paid item on the second page and no yes, the set-up does not report done; got ${w.describe(r)}`);
  const reads = ctx.standIn.calls().slice(from).filter((c) => c.method === 'GET' && /\/accounts\/[^/]+\/subscriptions(\?|$)/.test(c.path));
  assert.ok(reads.some((c) => /\/subscriptions\?(.*&)?page=2(&|$)/.test(c.path)),
    `the set-up reads the second page the answer names; its reads: ${JSON.stringify(reads.map((c) => c.path))}`);
  assert.ok(W.said(r).includes(named), `it names the paid item on the second page (${named}); got ${w.describe(r)}`);
  assert.ok(W.said(r).includes(String(CF.PRICED_ITEM.price)), `it names its price (${CF.PRICED_ITEM.price}); got ${w.describe(r)}`);
  assert.match(W.said(r), COSTS, `it warns that it costs money; got ${w.describe(r)}`);
  assertSetUpTokenRemoved(ctx, 'a set-up that found a paid item on the second page');
  assertNothingKept(ctx, 'a set-up that found a paid item on the second page, before any yes');
  const floor = U.laidFloor(ctx.world, U.UTC);
  for (const mode of MODES) keepAskedThenYes(ctx, floor, `job-keep-second-page-${mode}`, mode, [named], 'the paid item on the second page');
  w.storeSecret(ctx.keychain, W.SET_UP_SECRET, second.value);
  const k = W.runSetUp(ctx, { extra: [W.KEEP_PAID] });
  W.assertRan(k, 'the set-up on the owner\'s yes to keeping the paid item on the second page');
  assert.equal(k.status, 0, `on the owner's yes to keeping it, the set-up reports done; got ${w.describe(k)}`);
  assert.ok(W.said(k).includes(named), `its done words name it (${named}); got ${w.describe(k)}`);
  assertKeptDeployOnly(ctx, 'the set-up on the owner\'s yes to keeping the paid item on the second page');
  assert.deepEqual(billingWrites(ctx.standIn), [], 'Squire changes no billing');
  assert.deepEqual(ctx.standIn.offLoopback(), [], 'no call left the loopback');
});

// Paging the set-up cannot read whole is not read as free: each fault in a
// world of its own, the first page free and a paid item on the second.
const PAGING_FAULTS = {
  noPageCounts: 'the page counts left out of the answer',
  shortTotalPages: 'a page count of 1 while the item count names more',
  malformedTotalPages: 'a page count that is not a number',
  laterPageFails: 'the second page answering with a fault',
  laterPageNotJson: 'the second page answering with a page that is not JSON',
};

test("subscription paging the set-up cannot read whole, with the page counts missing, short or not a number, or a later page failing or not JSON, is not read as free: the set-up does not report done, names the paid item it found or says it could not read the subscriptions, keeps nothing and removes the set-up token", { timeout: 600000 }, (t) => {
  const named = CF.PRICED_ITEM.rate_plan.public_name;
  for (const [pagingFault, what] of Object.entries(PAGING_FAULTS)) {
    const ctx = W.websiteWorld(t, { laid: true, subscriptionPages: [W.FREE, [CF.PRICED_ITEM]], pagingFault });
    const r = W.runSetUp(ctx);
    W.assertRan(r, `the set-up with ${what}`);
    assert.notEqual(r.status, 0, `with ${what}, the set-up does not report done; got ${w.describe(r)}`);
    assert.doesNotMatch(W.said(r), /reads as free/i, `with ${what}, it never says the subscriptions read as free; got ${w.describe(r)}`);
    assert.ok(W.said(r).includes(named) || /(could not|cannot|can't) read/i.test(W.said(r)),
      `with ${what}, it names the paid item (${named}) or says it could not read the subscriptions; got ${w.describe(r)}`);
    assertSetUpTokenRemoved(ctx, `a set-up with ${what}`);
    assertNothingKept(ctx, `a set-up with ${what}`);
    assert.deepEqual(billingWrites(ctx.standIn), [], `with ${what}, Squire changes no billing`);
    assert.deepEqual(ctx.standIn.offLoopback(), [], `with ${what}, no call left the loopback`);
  }
});
