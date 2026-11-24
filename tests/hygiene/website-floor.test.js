'use strict';

// Code hygiene for the safety floor's reading of Squire's website command
// and a site's preview (core/hooks/pre-tool-use.py WebsiteCommand and the
// Floor's deploy-target reading), through the laid floor as the session runs
// it: the set-up's one spelling is asked naming the account and every other
// form is refused naming that spelling; a preview the floor does not pin
// does not count as the site's; a deploy route whose name is in a variable
// says it cannot tell where. Bound to no criterion.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const w = require('../fixtures/squire-world.js');
const U = require('../fixtures/usage-world.js');
const W = require('../fixtures/website-world.js');
const B = require('../fixtures/browser-world.js');

const ONE_SPELLING = /\/usr\/bin\/python3 '[^'\n]*website\.py' set-up <account id>/;

test('the set-up is asked in its one spelling, naming the account, each run on its own yes, and refused in any other form, naming that spelling', { timeout: 120000 }, (t) => {
  const ctx = W.websiteWorld(t, { laid: true });
  const { world } = ctx;
  const floor = U.laidFloor(world, U.UTC);
  const tool = `/usr/bin/python3 '${W.websiteTool(world)}'`;
  const job = 'job-site-set-up';
  const plain = w.tools.bash(`${tool} set-up ${W.ACCOUNT}`);
  const first = floor.run(job, plain);
  w.assertBlocked(first, 'the set-up in its one spelling', W.ACCOUNT);
  assert.notEqual(w.requestIdIn(first.stderr), null, `it is asked; got ${w.describe(first)}`);
  U.sayYesTo(world, job, first, { env: U.UTC });
  w.assertAllowed(floor.run(job, plain), 'the set-up on the owner\'s yes');
  assert.notEqual(w.requestIdIn(floor.run(job, plain).stderr), null, 'a second run is asked again');
  for (const command of [`${tool} set-up ${W.ACCOUNT} --force`, `${tool} set-up not-an-account`, `${tool} publish`, `python3 '${W.websiteTool(world)}' set-up ${W.ACCOUNT}`]) {
    const r = floor.run(job, w.tools.bash(command));
    w.assertBlocked(r, command);
    assert.equal(w.requestIdIn(r.stderr), null, `${command}: refused, not asked; got ${w.describe(r)}`);
    assert.match(r.stderr.split(command).join(' '), ONE_SPELLING, `${command}: the refusal names the one spelling; got ${w.describe(r)}`);
  }
});

test('a preview the floor does not pin is not the site\'s preview, and a deploy route with its name in a variable says it cannot tell where', { timeout: 120000 }, (t) => {
  const ctx = W.websiteWorld(t, { laid: true });
  const { world } = ctx;
  const floor = U.laidFloor(world, U.UTC);
  const job = 'job-site-other-previews';
  W.startSite(world, floor, job, 'default');
  const folder = W.writeSite(world, floor, job, 'ada-bakes', 'default');
  const deploy = w.tools.bash(W.deployCommand(world, folder, 'ada-bakes'));
  for (const command of [
    `python3 -m http.server 0 --bind 127.0.0.1 --directory '${folder}'`,
    `/usr/bin/python3 -m http.server 0 --bind 127.0.0.1 --directory '${folder}' --cgi`,
    `/usr/bin/python3 -m http.server 0 --bind 127.0.0.1 --directory '${path.dirname(folder)}'`,
  ]) {
    const first = floor.run(job, w.tools.bash(command));
    if (w.requestIdIn(first.stderr)) U.sayYesTo(world, job, first, { env: U.UTC });
    floor.run(job, w.tools.bash(command));
    const r = floor.run(job, deploy);
    w.assertBlocked(r, `the deploy after ${command}`);
    assert.equal(w.requestIdIn(r.stderr), null, `after ${command}: the deploy is refused, not asked; got ${w.describe(r)}`);
    assert.match(r.stderr, /preview/i, `after ${command}: the refusal names the preview; got ${w.describe(r)}`);
  }
  fs.mkdirSync(path.join(folder, 'img'));
  W.previewSite(world, floor, job, folder, 'default');
  fs.rmdirSync(path.join(folder, 'img'));
  assert.equal(w.requestIdIn(floor.run(job, deploy).stderr), null, 'a folder gone from the site since its preview is a change: refused');
  const pages = floor.run(job, w.tools.bash(`npx wrangler pages deploy '${folder}' --project-name="$PROJECT"`));
  w.assertBlocked(pages, 'a Pages deploy with its project in a variable');
  assert.notEqual(w.requestIdIn(pages.stderr), null, `it is asked; got ${w.describe(pages)}`);
  assert.match(pages.stderr, /cannot tell where/, `it says it cannot tell where; got ${w.describe(pages)}`);
});

test('what the session loads names the website command in plain words, by the laid tool\'s path, never in a code span a placeholder could fill', { timeout: 60000 }, (t) => {
  const ctx = W.websiteWorld(t, { laid: true });
  const sites = B.personaSentences(ctx.world).filter((x) => /\bsites?\b/i.test(x) && /website[․.]py/.test(x));
  assert.ok(sites.length > 0, 'the site block names the website command');
  for (const x of sites) {
    assert.doesNotMatch(x, /`/, `the website command is never in a code span; got ${JSON.stringify(x)}`);
    assert.ok(x.includes(`/usr/bin/python3 '${W.websiteTool(ctx.world)}'`), `it is named by the laid tool's path; got ${JSON.stringify(x)}`);
  }
});

test('the money refusal reads Cloudflare\'s host as the Mac does and lets a plain read be asked; the dashboard refusal takes the host in any case, with a trailing dot, escaped or under it, and no look-alike', { timeout: 120000 }, (t) => {
  const ctx = W.websiteWorld(t, { laid: true });
  const { world } = ctx;
  B.writeOwnerProfile(world);
  const floor = U.laidFloor(world, U.UTC);
  const job = 'job-site-money-edges';
  W.startSite(world, floor, job, 'default');
  const subscriptions = `https://api.cloudflare.com/client/v4/accounts/${W.ACCOUNT}/subscriptions`;
  const refused = (r) => r.status === 2 && w.requestIdIn(r.stderr) === null;
  for (const command of [
    `curl -sXPOST ${subscriptions} -d '{}'`,
    `curl --request=PUT 'HTTPS://API.CLOUDFLARE.COM./client/v4/accounts/${W.ACCOUNT}/subscriptions/one'`,
    `curl -X PATCH https://api.cloudflare.com/client/v4/zones/abcdabcdabcdabcdabcdabcdabcdabcd --json '{"plan":{"id":"pro"}}'`,
    `curl https://api.cloudflare.com/client/v4/user/billing/profile -F 'x=1'`,
    `node -e "fetch('${subscriptions}', { method: 'POST' })"`,
  ]) {
    const r = floor.run(job, w.tools.bash(command));
    assert.ok(refused(r), `${command}: refused, not asked; got ${w.describe(r)}`);
    assert.match(r.stderr.split(command).join(' '), /money/, `${command}: the refusal is about money; got ${w.describe(r)}`);
  }
  for (const command of [`curl -s ${subscriptions}`, `curl -G ${subscriptions} -d page=1`, `wget -q -O - ${subscriptions}`,
    `curl -X PUT https://api.cloudflare.com/client/v4/accounts/${W.ACCOUNT}/workers/scripts/ada-bakes -F 'metadata=@meta.json'`]) {
    const r = floor.run(job, w.tools.bash(command));
    assert.notEqual(w.requestIdIn(r.stderr), null, `${command}: asked, not refused as money; got ${w.describe(r)}`);
  }
  for (const url of ['https://DASH.Cloudflare.COM./', 'dash.cloudflare.com/?to=/:account/home', 'https://one.dash.cloudflare.com/', 'https%3A%2F%2Fdash.cloudflare.com%2F']) {
    const r = floor.run(job, B.browserTools.navigate(url));
    assert.ok(refused(r), `a navigate to ${url}: refused, not asked; got ${w.describe(r)}`);
    assert.match(r.stderr.split(url).join(' '), /dashboard/, `a navigate to ${url}: the refusal names the dashboard; got ${w.describe(r)}`);
  }
  const lookAlike = floor.run(job, B.browserTools.navigate('https://dash.cloudflare.com.example.net/'));
  assert.notEqual(w.requestIdIn(lookAlike.stderr), null, `a look-alike host is asked as any other site; got ${w.describe(lookAlike)}`);
  assert.deepEqual(ctx.standIn.offLoopback(), [], 'no call left the loopback');
});
