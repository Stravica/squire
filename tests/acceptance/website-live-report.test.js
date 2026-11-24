'use strict';

// When Squire's deploy has put a site live, Squire reports it live at its
// address once the address serves the site's page to an ordinary client; when
// the address turns Squire's own read away for a reason that is not "not
// live yet", Squire says it could not confirm the site and names the address
// for the owner to open; it never tells the owner a live site is not live and
// never advises a new deploy for a site that is live. Bound through the real
// entry point: Squire's website command run as its own command line
// (core/tools/website.py set-up, then deploy) against the loopback stand-in of
// Cloudflare's API and its sites' addresses (tests/fixtures/cloudflare-stand-in.js).
//
// What the stand-in does here, as a real address did (seen on a real account,
// not documented; the assumptions are in the stand-in's header):
// siteRefuses 'defaultClient', a read sent with the default client signature
// of Python's own library (a User-Agent beginning Python-urllib/) gets 403 and
// "error code: 1010", any other read the page; siteRefuses 'everyRead', every
// read gets that 403; notFoundFirstMs with a long certificateWaitMs, the
// address answers 404, then 503, for the whole read-back.
//
// What the cases pin, decided on the fail-closed reading and named here (no
// record settles them):
//   the read-back reads the address as an ordinary client does, so an address
//     that turns away only Python's default signature serves it the page; a
//     read-back that special-cases the stand-in (its path, its port, a header
//     only it would honour) is not that;
//   "not live yet" is an address that answers 404 or 503, or does not answer,
//     through the read-back: the deploy says the site "is not reported live
//     yet" and names its address, and may advise running the deploy again;
//   an address that refuses Squire's read (403 above all) is not "not live
//     yet": the deploy says Squire "could not confirm" the site, says in plain
//     words that the address refused Squire's own check, names the address and
//     tells the owner to open it; it never says the site is not live and never
//     advises another deploy;
//   live: "The site <name> is live at <address>", exit 0, as today.
//
// Usage model (assumptions, none measured): typical, one small site deployed
// once to an address that turns away Python's default signature, as a real one
// did; heavy, an address that refuses every read, or one not live for the
// whole read-back. Each case waits out the deploy's read-back where the
// address never serves the page to Squire (about 100 seconds). No case reaches
// a model, a Cloudflare account or any host but this Mac.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const w = require('../fixtures/squire-world.js');
const W = require('../fixtures/website-world.js');

const NAME = 'ada-bakes';
const PAGE = '<!doctype html><title>Ada Bakes</title><p>Fresh every morning.</p>\n';

// One read of the site's address on the stand-in, as the case makes it, with
// the given User-Agent (null: none at all): the Mac's own curl, loopback only.
function readAs(ctx, name, agent) {
  const args = ['-s', '-o', '-', '-w', '\n%{http_code}', '--noproxy', '*', '-H', agent === null ? 'User-Agent:' : `User-Agent: ${agent}`,
    `${ctx.standIn.origin}/__sites/${name}.${W.SUBDOMAIN}.workers.dev/`];
  const r = spawnSync('/usr/bin/curl', args, { encoding: 'utf8', timeout: 15000 });
  const out = r.stdout || '';
  const cut = out.lastIndexOf('\n');
  return { status: Number(out.slice(cut + 1)), body: out.slice(0, cut) };
}

const siteReads = (ctx, name, from = 0) => ctx.standIn.calls().slice(from)
  .filter((c) => c.path.startsWith(`/__sites/${name}.${W.SUBDOMAIN}.workers.dev`));

// The set-up, done, then the deploy of a small site through the command line.
function setUpAndDeploy(ctx) {
  const s = W.runSetUp(ctx);
  W.assertRan(s, 'the set-up');
  assert.equal(s.status, 0, `the set-up reports done; got ${w.describe(s)}`);
  const folder = W.makeSite(ctx.world, NAME, PAGE);
  const from = ctx.standIn.calls().length;
  const d = W.runDeploy(ctx, folder, NAME);
  W.assertRan(d, 'the deploy');
  return { d, folder, reads: siteReads(ctx, NAME, from) };
}

const NOT_LIVE = /\bnot (reported )?live\b|\bis not live\b/i;
const DEPLOY_AGAIN = /\b(run|try) the deploy again\b|\bdeploy (it )?again\b|\bredeploy\b/i;

test("a deploy on the owner's yes, to an address that turns away the default signature of Python's own library with 403 error code 1010 and serves any other read the page, is reported live at its address, and the address served the page to Squire's own read", { timeout: 300000 }, (t) => {
  const ctx = W.websiteWorld(t, { siteRefuses: 'defaultClient' });
  const { d, folder, reads } = setUpAndDeploy(ctx);
  const words = W.said(d);
  assert.ok(words.includes(`The site ${NAME} is live at ${W.address(NAME)}`),
    `the deploy reports the site live at its address, ${W.address(NAME)}; got ${w.describe(d)}`);
  assert.equal(d.status, 0, `a deploy reported live exits as the live path does; got ${w.describe(d)}`);
  assert.doesNotMatch(words, NOT_LIVE, `a live site is never reported not live; got ${w.describe(d)}`);
  assert.doesNotMatch(words, DEPLOY_AGAIN, `a live site never gets advice to deploy it again; got ${w.describe(d)}`);
  assert.ok(reads.some((c) => c.status === 200), `the address served the page to Squire's own read-back; its reads answered ${JSON.stringify(reads.map((c) => [c.status, c.userAgent]))}`);
  assert.ok(words.includes(folder), `the live report names the site's folder, as today; got ${w.describe(d)}`);
  // The premise, read by the case itself: the address turns away Python's
  // default signature and serves the page to any other read, or to none.
  assert.equal(readAs(ctx, NAME, 'Python-urllib/3.9').status, 403, 'the stand-in turns away the default signature of Python\'s own library');
  for (const agent of ['curl/8.7.1', null]) {
    const r = readAs(ctx, NAME, agent);
    assert.equal(r.status, 200, `the stand-in serves the page to a read with ${agent === null ? 'no User-Agent' : agent}`);
    assert.equal(r.body, PAGE, 'the page served is the site\'s own');
  }
  assert.deepEqual(ctx.standIn.offLoopback(), [], 'no call left the loopback');
});

test("when the address turns away every read of Squire's with 403 error code 1010, the deploy never says the site is not live and never advises running the deploy again: it says Squire could not confirm the site, says why in plain words, and names the address for the owner to open", { timeout: 300000 }, (t) => {
  const ctx = W.websiteWorld(t, { siteRefuses: 'everyRead' });
  const { d, reads } = setUpAndDeploy(ctx);
  const words = W.said(d);
  assert.match(words, /could not confirm/i, `the deploy says Squire could not confirm the site; got ${w.describe(d)}`);
  assert.ok(words.includes(W.address(NAME)), `the report names the address, ${W.address(NAME)}; got ${w.describe(d)}`);
  assert.match(words, /\bopen\b/i, `the report tells the owner to open the address; got ${w.describe(d)}`);
  assert.match(words, /refus|turn(s|ed)? (squire|it|the read|the check)?[^.]{0,40}away/i, `the report says why in plain words: the address refused Squire's own check; got ${w.describe(d)}`);
  assert.doesNotMatch(words, NOT_LIVE, `a site Squire could not confirm is never reported not live; got ${w.describe(d)}`);
  assert.doesNotMatch(words, DEPLOY_AGAIN, `the report never advises running the deploy again; got ${w.describe(d)}`);
  assert.equal(words.includes(`is live at ${W.address(NAME)}`), false, `a site Squire could not confirm is not reported live either; got ${w.describe(d)}`);
  assert.ok(reads.length > 0 && reads.every((c) => c.status === 403), `every read of the address was turned away; got ${JSON.stringify(reads.map((c) => c.status))}`);
  assert.deepEqual(ctx.standIn.offLoopback(), [], 'no call left the loopback');
});

test("an address that answers 404 and then 503 throughout the deploy's read-back is still not reported live: the deploy says the site is not reported live yet and names the address, and never says Squire could not confirm it", { timeout: 300000 }, (t) => {
  const ctx = W.websiteWorld(t, { notFoundFirstMs: 50000, certificateWaitMs: 1000000000 });
  const { d, reads } = setUpAndDeploy(ctx);
  const words = W.said(d);
  assert.notEqual(d.status, 0, `a site whose address never served it is not reported done; got ${w.describe(d)}`);
  assert.match(words, /not reported live yet/i, `the deploy says the site is not reported live yet; got ${w.describe(d)}`);
  assert.ok(words.includes(W.address(NAME)), `the report names the address, ${W.address(NAME)}; got ${w.describe(d)}`);
  assert.equal(words.includes(`is live at ${W.address(NAME)}`), false, `a site whose address never served it is not reported live; got ${w.describe(d)}`);
  assert.doesNotMatch(words, /could not confirm/i, `an address not live yet is not one Squire could not confirm; got ${w.describe(d)}`);
  const statuses = new Set(reads.map((c) => c.status));
  assert.ok(statuses.has(404) && statuses.has(503) && !statuses.has(200), `the address answered 404, then 503, and never the page; got ${JSON.stringify([...statuses])}`);
  assert.deepEqual(ctx.standIn.offLoopback(), [], 'no call left the loopback');
});
