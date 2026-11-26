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
// Decided on the fail-closed reading and named here (no record settles them):
// a refusal is read for what it says beyond the command it echoes back, so a
// refusal for another reason does not pass; Squire's deploy spelt any way but
// the one it is asked in is refused, naming that one spelling, so the session
// can use it; a preview of any folder but the site's own does not count for
// the site, and a deploy of any folder but workspace/sites/<site name> is
// refused whatever was previewed; a site's content decides whether it changed
// since its preview, not its file names, sizes or times; and the owner's yes
// to a deploy covers the site as it was previewed, so after a change the site
// is previewed again and its deploy asked again.
//
// Usage model (assumptions, none measured): typical, one small site of a page
// or two, previewed once and deployed once; heavy, a site changed after its
// preview and previewed again before a second deploy. No case reaches a model,
// a Cloudflare account or any host but this Mac.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const w = require('../fixtures/squire-world.js');
const U = require('../fixtures/usage-world.js');
const B = require('../fixtures/browser-world.js');
const W = require('../fixtures/website-world.js');
const CF = require('../fixtures/cloudflare-stand-in.js');

const MODES = ['default', 'auto'];

// What a refusal says beyond the command it echoes back.
const toldBeyond = (r, echoed) => r.stderr.split(echoed).join(' ');

// The one spelling Squire's deploy is asked in: the stock Python, Squire's
// website command by its path, then deploy.
const ONE_SPELLING = /\/usr\/bin\/python3\s+(?:'[^'\n]*website\.py'|\S*website\.py)\s+deploy\b/;

// A call the floor refuses, not asks, in this mode, saying what `says`
// matches beyond the command it echoes; and still refused, not asked, once
// the owner has said yes.
function assertRefused(world, floor, job, command, mode, what, says, why) {
  for (const when of ['', ', even after the owner said yes']) {
    if (when) w.ownerSays(world, job, 'yes', { env: U.UTC });
    const r = floor.run(job, w.tools.bash(command), mode);
    w.assertBlocked(r, `${what}, in ${mode} mode${when}`);
    assert.equal(w.requestIdIn(r.stderr), null, `${what}, in ${mode} mode${when}: refused, not asked; got a request the owner could answer: ${w.describe(r)}`);
    assert.match(toldBeyond(r, command), says, `${what}, in ${mode} mode${when}: ${why}; got ${w.describe(r)}`);
  }
}

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

// The account's read-back is what Cloudflare says the token holds, and a
// right is its permission group's id, whatever name rides with it. Pinned
// here on the fail-closed reading (no record settles it): a read-back whose
// one group carries the kept right's name under another group's id is not
// deploy-only, so that token is not kept; the set-up is not refused, it says
// why and can be run again. The stand-in's shape is widen 'keptNameOtherId'
// (its header names the assumption).
test("a deploy token read back naming the deploy right under another permission group's id is not kept: the set-up does not report done, leaves no token it made on the account, keeps nothing in the Keychain, removes the set-up token and says the token read back holds more than deploying (content)", { timeout: 180000 }, (t) => {
  const ctx = W.websiteWorld(t, { widen: 'keptNameOtherId' });
  const r = W.runSetUp(ctx);
  W.assertRan(r, 'the set-up when the token it made reads back with the deploy right\'s name under another group\'s id');
  const made = W.tokensOn(ctx.standIn).filter((x) => x.id !== ctx.setUp.id);
  assert.equal(made.length, 1, `the set-up made the token it would keep; got ${w.describe(r)}`);
  // The premise, read by the case itself on the stand-in: the read-back
  // names the kept right, under another group's id.
  const shown = (made[0].readBack || [])[0] || {};
  const group = (shown.permission_groups || [])[0] || {};
  assert.equal(group.name, W.KEPT_RIGHT, 'the read-back names the kept right');
  assert.notEqual(group.id, CF.groupNamed(W.KEPT_RIGHT).id, 'under another permission group\'s id');
  assert.notEqual(r.status, 0, `a set-up whose token reads back with the kept right's name under another group's id does not report done; got ${w.describe(r)}`);
  assert.deepEqual(made.filter((x) => x.status === 'active').map((x) => x.name), [], 'no token the set-up made is left on the account');
  assert.equal(w.hasSecret(ctx.keychain, W.KEPT_SECRET), false, `nothing is kept in the Keychain as ${W.KEPT_SECRET}`);
  assert.equal((W.tokensOn(ctx.standIn).find((x) => x.id === ctx.setUp.id) || {}).status, 'deleted', 'the set-up token is removed too');
  assert.match(W.said(r), new RegExp(W.KEPT_RIGHT), `the set-up names the one right it keeps; got ${w.describe(r)}`);
  assert.match(W.said(r), /more than|wider than|another (right|group)|other (right|group)|not deploy-only|not only/i, `the set-up says the token read back holds more than deploying; got ${w.describe(r)}`);
  assert.deepEqual(ctx.standIn.offLoopback(), [], 'no call left the loopback');
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

test("before any preview, Squire's deploy spelt any way but the one it is asked in is refused, not asked, even after a yes, and the refusal names that one spelling: from Squire's tools folder by a relative path, by a python3 found on the PATH, inside bash -c, or wrapped by Squire's secret helper, in the default mode and in auto mode", { timeout: 180000 }, (t) => {
  const ctx = W.websiteWorld(t, { laid: true });
  const { world } = ctx;
  const floor = U.laidFloor(world, U.UTC);
  const toolsFolder = path.dirname(W.websiteTool(world));
  const secretTool = `/usr/bin/python3 '${path.join(toolsFolder, 'secret.py')}'`;
  for (const mode of MODES) {
    const job = `job-site-near-spellings-${mode}`;
    const name = `ada-bakes-${mode}`;
    W.startSite(world, floor, job, mode);
    const folder = W.writeSite(world, floor, job, name, mode);
    const plain = W.deployCommand(world, folder, name);
    for (const [what, command] of [
      ['from Squire\'s tools folder by a relative path', `cd '${toolsFolder}' && /usr/bin/python3 website.py deploy '${folder}' ${name}`],
      ['by a python3 found on the PATH', `python3 '${W.websiteTool(world)}' deploy '${folder}' ${name}`],
      ['inside bash -c', `bash -c "${plain}"`],
      ['wrapped by Squire\'s secret helper', `${secretTool} run ${W.KEPT_SECRET} --as CLOUDFLARE_API_TOKEN -- ${plain}`],
    ]) {
      assertRefused(world, floor, job, command, mode, `Squire's deploy ${what}, before any preview`, ONE_SPELLING,
        'the refusal names the one spelling Squire\'s deploy is asked in, so the session can use it');
    }
  }
  assert.deepEqual(W.uploads(ctx.standIn), [], 'nothing was deployed');
  assert.deepEqual(ctx.standIn.offLoopback(), [], 'no call left the loopback');
});

// A call put to the floor as the session makes it: when the floor asks, the
// owner says yes and the session makes it again. Whatever the floor answers.
function throughFloor(world, floor, job, call, mode) {
  const first = floor.run(job, call, mode);
  if (first.status !== 2 || !w.requestIdIn(first.stderr)) return first;
  U.sayYesTo(world, job, first, { env: U.UTC });
  return floor.run(job, call, mode);
}

test("a site's deploy waits for a preview of the site's own folder, and Squire deploys a site only from its own folder: after a preview of another folder the site's deploy is refused, not asked, naming the preview, and a deploy of a folder that is not the site's own is refused, not asked, even once the site is previewed, in the default mode and in auto mode", { timeout: 180000 }, (t) => {
  const ctx = W.websiteWorld(t, { laid: true });
  const { world } = ctx;
  const floor = U.laidFloor(world, U.UTC);
  const files = path.join(world.owner, 'workspace', 'files');
  fs.mkdirSync(files, { recursive: true });
  fs.writeFileSync(path.join(files, 'suppliers.txt'), 'Flour from Example Mills, every Monday (invented).\n');
  for (const mode of MODES) {
    const job = `job-site-other-folder-${mode}`;
    const name = `ada-bakes-${mode}`;
    W.startSite(world, floor, job, mode);
    const folder = W.writeSite(world, floor, job, name, mode);
    // A preview on the loopback, but of the owner's whole folder, not the site's.
    throughFloor(world, floor, job, w.tools.bash(W.previewCommand(world.owner)), mode);
    assertRefused(world, floor, job, W.deployCommand(world, folder, name), mode, 'the site\'s deploy after a preview of the owner\'s folder, not the site\'s own', /preview/i,
      'the refusal says the site is previewed first, from its own folder');

    W.previewSite(world, floor, job, folder, mode);
    for (const [what, other] of [['the owner\'s folder', world.owner], ['the owner\'s files (workspace/files)', files]]) {
      assertRefused(world, floor, job, W.deployCommand(world, other, name), mode, `a deploy of ${what} as the site ${name}, once the site is previewed`,
        /workspace\/sites|(its|the site'?s) own folder/i, 'the refusal says Squire deploys a site only from its own folder, workspace/sites/<site name>');
    }
  }
  assert.deepEqual(W.uploads(ctx.standIn), [], 'nothing was deployed');
  assert.deepEqual(ctx.standIn.offLoopback(), [], 'no call left the loopback');
});

// A page of the site rewritten in place: the same name and size, only its
// content changed, and its modification time put back as far as the file
// system keeps it.
function rewriteInPlace(file, content) {
  const before = fs.statSync(file);
  assert.equal(Buffer.byteLength(content), before.size, 'the rewrite keeps the page\'s size');
  fs.writeFileSync(file, content);
  fs.utimesSync(file, before.atime, before.mtime);
}

test("what goes live is what the owner previewed and said yes to: a page of the site rewritten after its preview, under the same name, leaves the deploy refused, not asked, naming the preview, and a change after the owner's yes to the deploy leaves that deploy refused, the yes not spent on other content, and the site's deploy asked again once it is previewed again, in the default mode and in auto mode", { timeout: 180000 }, (t) => {
  const ctx = W.websiteWorld(t, { laid: true });
  const { world } = ctx;
  const floor = U.laidFloor(world, U.UTC);
  const page = (when) => `<!doctype html><title>Ada Bakes</title><p>Fresh every ${when}.</p>\n`;
  for (const mode of MODES) {
    const job = `job-site-content-${mode}`;
    const name = `ada-bakes-${mode}`;
    W.startSite(world, floor, job, mode);
    const folder = W.writeSite(world, floor, job, name, mode, page('morning'));
    const index = path.join(folder, 'index.html');
    const deploy = W.deployCommand(world, folder, name);

    W.previewSite(world, floor, job, folder, mode);
    rewriteInPlace(index, page('evening'));
    assertRefused(world, floor, job, deploy, mode, 'the site\'s deploy after its page was rewritten under the same name since its preview', /preview/i,
      'the refusal says the changed site is previewed again first');

    W.previewSite(world, floor, job, folder, mode);
    const asked = floor.run(job, w.tools.bash(deploy), mode);
    w.assertBlocked(asked, `the site's deploy once previewed again, in ${mode} mode`);
    assert.notEqual(w.requestIdIn(asked.stderr), null, `the site's deploy once previewed again is asked, in ${mode} mode; got ${w.describe(asked)}`);
    U.sayYesTo(world, job, asked, { env: U.UTC });
    rewriteInPlace(index, page('Tuesday'));
    assertRefused(world, floor, job, deploy, mode, 'the site\'s deploy the owner said yes to, after its page changed since', /preview/i,
      'the yes was to the site as it was previewed: the refusal says the changed site is previewed again first');

    W.previewSite(world, floor, job, folder, mode);
    const next = floor.run(job, w.tools.bash(deploy), mode);
    w.assertBlocked(next, `the changed site's deploy, previewed again, in ${mode} mode: the earlier yes does not cover other content`);
    assert.notEqual(w.requestIdIn(next.stderr), null, `the changed site's deploy, previewed again, is asked again, in ${mode} mode; got ${w.describe(next)}`);
  }
  assert.deepEqual(W.uploads(ctx.standIn), [], 'nothing was deployed');
  assert.deepEqual(ctx.standIn.offLoopback(), [], 'no call left the loopback');
});
