'use strict';

// A site is deployed with a deploy-only token and shown to the owner as a
// preview first. Bound through the real entry points: Squire's website
// command run as its own command line (core/tools/website.py set-up and
// deploy) against a loopback stand-in of Cloudflare's API
// (tests/fixtures/cloudflare-stand-in.js); what the session loads (lay-down,
// Squire's own block); and the safety floor as the session runs it (the
// PreToolUse hooks of the settings lay-down writes, the event on stdin, in the
// default mode and in auto mode).
//
// What the builder provides (none of it at the base head; a case fails at its
// own first assertion while it is absent), with the names website-world.js
// pins:
//   the token the set-up keeps is account-owned, holds Workers Scripts Write
//     alone on the owner's account alone, and is kept in the Keychain as
//     cloudflare-deploy through Squire's secret helper; the set-up reads its
//     rights back from the account after making it and reports done only when
//     they are exactly that; a token read back wider (another right, every
//     account, every zone) is removed, nothing is kept and the set-up does
//     not finish;
//   website.py deploy <site folder> <site name> deploys the site as a Worker
//     with static assets on the account's workers.dev address with that token
//     alone, whatever sign-in or token is already on the Mac, waits out a new
//     address's certificate (about 30 seconds on a real account; the
//     stand-in's is shorter) by reading the site back at its address until it
//     answers, and only then reports it live at that address;
//   Squire's own block tells the session a site is previewed on this Mac, on
//   the loopback from its own folder, before its deploy; the floor does not
//   ask for a site's deploy until the owner has previewed that folder as it
//   now stands, and a site changed since its last preview waits for a new one.
//
// Usage model (assumptions, none measured): typical, one small site of a page
// or two, previewed once and deployed once; heavy, a site changed after its
// preview and previewed again before a second deploy. No case reaches a model,
// a Cloudflare account or any host but this Mac.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const w = require('../fixtures/squire-world.js');
const U = require('../fixtures/usage-world.js');
const B = require('../fixtures/browser-world.js');
const W = require('../fixtures/website-world.js');

const MODES = ['default', 'auto'];

test("the token the set-up keeps deploys the site and nothing else: a call it makes to read or change billing, tokens, account settings, DNS or another product is refused, the set-up reports done only after reading its rights back as deploy-only, and the deploy waits out a new address's certificate before it reports the site live", { timeout: 180000 }, (t) => {
  const ctx = W.websiteWorld(t);
  const r = W.runSetUp(ctx);
  W.assertRan(r, 'the set-up');
  assert.equal(r.status, 0, `the set-up reports done; got ${w.describe(r)}`);
  const kept = W.keptToken(ctx);
  assert.deepEqual(W.rightsOf(kept.record), [{ effect: 'allow', resources: [`com.cloudflare.api.account.${W.ACCOUNT}`], groups: [W.KEPT_RIGHT] }],
    `the kept token holds ${W.KEPT_RIGHT} alone, on the owner's account alone`);
  const calls = ctx.standIn.calls();
  const made = calls.findIndex((c) => c.method === 'POST' && c.path === `/client/v4/accounts/${W.ACCOUNT}/tokens` && c.status === 200);
  const readBack = calls.findIndex((c, i) => i > made && c.method === 'GET' && c.status === 200
    && [`/client/v4/accounts/${W.ACCOUNT}/tokens/${kept.record.id}`, `/client/v4/accounts/${W.ACCOUNT}/tokens`].includes(c.path.split('?')[0]));
  assert.ok(made >= 0 && readBack > made, 'the set-up reads the kept token\'s rights back from the account after making it, before it reports done');

  for (const [what, method, apiPath, body] of [
    ['read the account\'s billing', 'GET', `/accounts/${W.ACCOUNT}/subscriptions`],
    ['change the account\'s billing', 'POST', `/accounts/${W.ACCOUNT}/subscriptions`, { rate_plan: { id: 'workers_paid' } }],
    ['make another token', 'POST', `/accounts/${W.ACCOUNT}/tokens`, { name: 'wider', policies: [{ effect: 'allow', resources: { [`com.cloudflare.api.account.${W.ACCOUNT}`]: '*' }, permission_groups: [{ id: 'standin-pg-billing-write' }] }] }],
    ['list the account\'s tokens', 'GET', `/accounts/${W.ACCOUNT}/tokens`],
    ['remove a token', 'DELETE', `/accounts/${W.ACCOUNT}/tokens/${kept.record.id}`],
    ['read the account\'s settings', 'GET', `/accounts/${W.ACCOUNT}`],
    ['read or change DNS', 'GET', '/zones'],
    ['use another product (key-value storage)', 'GET', `/accounts/${W.ACCOUNT}/storage/kv/namespaces`],
  ]) {
    const res = ctx.standIn.call(method, apiPath, kept.value, body);
    assert.ok(res.status === 401 || res.status === 403, `the kept token cannot ${what}: the account refuses it; got ${res.status} ${res.body}`);
  }

  const name = 'ada-bakes';
  const folder = W.makeSite(ctx.world, name);
  const d = W.runDeploy(ctx, folder, name);
  W.assertRan(d, 'the deploy');
  assert.equal(d.status, 0, `the kept token deploys the site; got ${w.describe(d)}`);
  const uploads = W.uploads(ctx.standIn);
  assert.ok(uploads.length > 0, 'the deploy uploads the site as a Worker with static assets');
  for (const c of uploads) {
    assert.ok(c.token === kept.value || /^standin-upload-/.test(c.token || ''), `every upload carries the kept token or the upload's own session token: ${c.method} ${c.path}`);
    assert.equal(c.refused, false, `the account lets the kept token deploy: ${c.method} ${c.path} answered ${c.status}`);
  }
  const reads = ctx.standIn.calls().filter((c) => c.path.startsWith(`/__sites/${name}.${W.SUBDOMAIN}.workers.dev`));
  assert.ok(reads.some((c) => c.status === 503), 'the deploy reads the site back at its new address while the certificate is not ready');
  assert.equal((reads[reads.length - 1] || {}).status, 200, 'the deploy keeps reading until the address answers, rather than reporting a failure');
  assert.ok(W.said(d).includes(W.address(name)), `the deploy reports the site live at ${W.address(name)}; got ${w.describe(d)}`);
  assert.deepEqual(ctx.standIn.offLoopback(), [], 'no call left the loopback');
});

test('a set-up that would keep a token wider than deploy-only does not finish and keeps no token: one carrying another right, one on every account, one on every zone as well', { timeout: 180000 }, (t) => {
  for (const [what, widen] of [['another right', 'extraGroup'], ['every account', 'allAccounts'], ['every zone as well', 'allZones']]) {
    const ctx = W.websiteWorld(t, { widen });
    const r = W.runSetUp(ctx);
    W.assertRan(r, `the set-up when the token it made reads back with ${what}`);
    const made = W.tokensOn(ctx.standIn).filter((x) => x.id !== ctx.setUp.id);
    assert.ok(made.length >= 1, `the set-up made the token it would keep; got ${w.describe(r)}`);
    assert.notEqual(r.status, 0, `a set-up whose token reads back with ${what} does not finish; got ${w.describe(r)}`);
    assert.deepEqual(made.filter((x) => x.status === 'active').map((x) => x.name), [], `with ${what}, no token the set-up made is left on the account`);
    assert.equal(w.hasSecret(ctx.keychain, W.KEPT_SECRET), false, `with ${what}, nothing is kept in the Keychain`);
    assert.equal((W.tokensOn(ctx.standIn).find((x) => x.id === ctx.setUp.id) || {}).status, 'deleted', `with ${what}, the set-up token is removed too`);
    assert.deepEqual(ctx.standIn.offLoopback(), [], 'no call left the loopback');
  }
});

test("Squire's deploy uses only the token the set-up kept, on the set-up's account: a wrangler sign-in already on the Mac and a Cloudflare token or account in the environment are never used, though either would work", { timeout: 180000 }, (t) => {
  const signIn = W.fakeToken('stray-sign-in');
  const envToken = W.fakeToken('stray-env');
  const ctx = W.websiteWorld(t, { extraTokens: W.strayTokens(signIn, envToken) });
  const r = W.runSetUp(ctx);
  W.assertRan(r, 'the set-up');
  assert.equal(r.status, 0, `the set-up reports done; got ${w.describe(r)}`);
  const kept = W.keptToken(ctx);
  const strays = W.plantStrays(ctx.world, { signIn, envToken });
  const before = ctx.standIn.calls().length;
  const name = 'ada-bakes';
  const d = W.runDeploy(ctx, W.makeSite(ctx.world, name), name, { env: strays.env });
  W.assertRan(d, 'the deploy with a sign-in and a token already on the Mac');
  assert.equal(d.status, 0, `the deploy goes through with the kept token; got ${w.describe(d)}`);
  const during = ctx.standIn.calls().slice(before).filter((c) => c.path.startsWith('/client/v4/'));
  assert.ok(during.some((c) => c.token === kept.value), 'the deploy calls the account with the kept token');
  for (const c of during) {
    assert.ok(c.token === kept.value || /^standin-upload-/.test(c.token || ''), `every call the deploy made carried the kept token, never a sign-in or a token already on the Mac: ${c.method} ${c.path}`);
    assert.ok(!c.path.includes(W.OTHER_ACCOUNT), `no call names an account but the set-up's: ${c.method} ${c.path}`);
  }
  assert.deepEqual(W.callsWith(ctx.standIn, signIn), [], 'the wrangler sign-in on the Mac is never used');
  assert.deepEqual(W.callsWith(ctx.standIn, envToken), [], 'the token in the environment is never used');
  assert.deepEqual(ctx.standIn.offLoopback(), [], 'no call left the loopback');
});

test('a site is previewed on this Mac, on the loopback from its own folder, before its deploy is asked: what the session loads says so, the floor does not ask for the deploy until the owner has previewed the site, and a site changed since its last preview waits for a new one, in the default mode and in auto mode', { timeout: 180000 }, (t) => {
  const ctx = W.websiteWorld(t, { laid: true });
  const { world } = ctx;
  const sites = B.personaSentences(world).filter((x) => /\bsites?\b/i.test(x));
  assert.ok(sites.some((x) => /preview/i.test(x) && /loopback|127․0․0․1|127\.0\.0\.1|on this Mac/i.test(x) && /folder/i.test(x)),
    `Squire's own block must tell the session that a site's preview runs on this Mac, on the loopback, from the site's own folder; got ${JSON.stringify(sites)}`);
  assert.ok(sites.some((x) => /preview/i.test(x) && /\b(before|first)\b/i.test(x) && /deploy|live/i.test(x)),
    `it must say the owner sees the preview before the site is deployed; got ${JSON.stringify(sites)}`);

  const floor = U.laidFloor(world, U.UTC);
  for (const mode of MODES) {
    const job = `job-site-preview-${mode}`;
    const name = `ada-bakes-${mode}`;
    W.startSite(world, floor, job, mode);
    const folder = W.writeSite(world, floor, job, name, mode);
    const deploy = w.tools.bash(W.deployCommand(world, folder, name));

    const early = floor.run(job, deploy, mode);
    w.assertBlocked(early, `the site's deploy before any preview, in ${mode} mode`);
    assert.equal(w.requestIdIn(early.stderr), null, `the site's deploy before any preview, in ${mode} mode: not asked until the owner has seen the preview; got a request: ${w.describe(early)}`);
    assert.match(early.stderr, /preview/i, `the floor says the site is previewed first, in ${mode} mode; got ${w.describe(early)}`);

    W.previewSite(world, floor, job, folder, mode);
    const asked = floor.run(job, deploy, mode);
    w.assertBlocked(asked, `the site's deploy once previewed, in ${mode} mode`);
    assert.notEqual(w.requestIdIn(asked.stderr), null, `the site's deploy once previewed is asked, in ${mode} mode; got ${w.describe(asked)}`);

    w.assertAllowed(floor.run(job, w.tools.write(path.join(folder, 'about.html'), '<!doctype html><title>About</title><p>Since 1998.</p>\n'), mode), `a page added to the site after its preview, in ${mode} mode`);
    require('node:fs').writeFileSync(path.join(folder, 'about.html'), '<!doctype html><title>About</title><p>Since 1998.</p>\n');
    const late = floor.run(job, deploy, mode);
    w.assertBlocked(late, `the site's deploy after it changed, in ${mode} mode`);
    assert.equal(w.requestIdIn(late.stderr), null, `a site changed since its last preview waits for a new one, in ${mode} mode: not asked; got ${w.describe(late)}`);
    assert.match(late.stderr, /preview/i, `the floor says the changed site is previewed again first, in ${mode} mode; got ${w.describe(late)}`);

    W.previewSite(world, floor, job, folder, mode);
    const again = floor.run(job, deploy, mode);
    w.assertBlocked(again, `the site's deploy once previewed again, in ${mode} mode`);
    assert.notEqual(w.requestIdIn(again.stderr), null, `the changed site's deploy, previewed again, is asked, in ${mode} mode; got ${w.describe(again)}`);
  }
  assert.deepEqual(W.uploads(ctx.standIn), [], 'nothing was deployed: every deploy waited');
});

test("in a site job the owner said yes to, a site preview by Python's http.server with no loopback bind or bound beyond the loopback is refused, not asked, even after a yes, in the default mode and in auto mode", { timeout: 180000 }, (t) => {
  const ctx = W.websiteWorld(t, { laid: true });
  const { world } = ctx;
  const floor = U.laidFloor(world, U.UTC);
  for (const mode of MODES) {
    const job = `job-site-open-preview-${mode}`;
    W.startSite(world, floor, job, mode);
    const folder = W.writeSite(world, floor, job, `ada-bakes-${mode}`, mode);
    for (const [what, command] of [
      ['no loopback bind', `/usr/bin/python3 -m http.server 0 --directory '${folder}'`],
      ['a bind to every address', `/usr/bin/python3 -m http.server 0 --bind 0.0.0.0 --directory '${folder}'`],
    ]) {
      const first = floor.run(job, w.tools.bash(command), mode);
      w.assertBlocked(first, `the site's preview with ${what}, in ${mode} mode`);
      assert.equal(w.requestIdIn(first.stderr), null, `the site's preview with ${what}, in ${mode} mode: refused, not asked; got ${w.describe(first)}`);
      w.ownerSays(world, job, 'yes', { env: U.UTC });
      const again = floor.run(job, w.tools.bash(command), mode);
      w.assertBlocked(again, `the site's preview with ${what}, in ${mode} mode, even after the owner said yes`);
      assert.equal(w.requestIdIn(again.stderr), null, `the site's preview with ${what}, in ${mode} mode, after a yes: still refused; got ${w.describe(again)}`);
    }
  }
});
