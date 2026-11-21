'use strict';

// A site goes live only on the owner's yes to that deploy: the safety story's
// first criterion (nothing is sent or goes live without the owner's yes for
// that item), met again for websites. Bound through the real entry points:
// what the session loads (lay-down, Squire's own block), the safety floor as
// the session runs it (the PreToolUse hooks of the settings lay-down writes,
// the event on stdin, in the default mode and in auto mode), and Squire's
// website command run as its own command line against a loopback stand-in of
// Cloudflare's API (tests/fixtures/cloudflare-stand-in.js).
//
// What the builder provides (none of it at the base head; a case fails at its
// own first assertion while it is absent), with the names website-world.js
// pins:
//   Squire's own block tells the session that a site goes live only through
//   Squire's deploy command (website.py deploy <site folder> <site name>) and
//   only on the owner's yes to that deploy, which a yes to the site job or to
//   its preview is not;
//   the floor asks for Squire's deploy naming the site and the address it
//   goes live at (https://<site name>.<subdomain>.workers.dev, the subdomain
//   the set-up read from the account), each deploy on its own yes; a deploy
//   whose account, project or address the floor cannot read from the command
//   (by Squire's command before the set-up, by wrangler with no name, by curl
//   with the account or script in a variable) is asked saying it cannot tell
//   where the site goes; a deploy by any other route stays asked, never free,
//   naming its target where the command does.
//
// Usage model (assumptions, none measured): typical, one site previewed and
// deployed once on a yes; heavy, a second deploy of the same site after a
// change, which needs its own yes. The class of deploy routes is open (any
// program, any API, any spelling); these are instances. No case reaches a
// model, a Cloudflare account or any host but this Mac.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const w = require('../fixtures/squire-world.js');
const U = require('../fixtures/usage-world.js');
const B = require('../fixtures/browser-world.js');
const W = require('../fixtures/website-world.js');

const MODES = ['default', 'auto'];
const CANNOT_TELL = /(cannot|can't|can not|could not|does not|doesn't) (tell|know|read) where/i;

test("Squire's own deploy of a site, under the token the set-up kept, is asked naming the site and the address it goes live at, and runs only on the owner's yes to that deploy: a yes to the site job, to its preview or to an earlier deploy does not cover it, in the default mode and in auto mode", { timeout: 240000 }, (t) => {
  const ctx = W.websiteWorld(t, { laid: true });
  const { world } = ctx;
  const set = W.runSetUp(ctx);
  W.assertRan(set, 'the set-up');
  assert.equal(set.status, 0, `the set-up reports done; got ${w.describe(set)}`);
  const sites = B.personaSentences(world).filter((x) => /\bsites?\b/i.test(x));
  assert.ok(sites.some((x) => /website[․.]py/.test(x) && /deploy/i.test(x)), `Squire's own block must tell the session that a site goes live only through Squire's deploy command; got ${JSON.stringify(sites)}`);
  assert.ok(sites.some((x) => /deploy|live/i.test(x) && /\byes\b/i.test(x) && /\b(own|its own|separate|not)\b/i.test(x)),
    `it must say a deploy waits for the owner's yes to that deploy, which a yes to the site job or its preview is not; got ${JSON.stringify(sites)}`);

  const floor = U.laidFloor(world, U.UTC);
  for (const mode of MODES) {
    const job = `job-site-deploy-${mode}`;
    const name = `ada-bakes-${mode}`;
    W.startSite(world, floor, job, mode);
    const folder = W.writeSite(world, floor, job, name, mode);
    W.previewSite(world, floor, job, folder, mode);
    const deploy = w.tools.bash(W.deployCommand(world, folder, name));

    const first = floor.run(job, deploy, mode);
    w.assertBlocked(first, `Squire's deploy of the site, in ${mode} mode, after yeses to the site job and its preview`, name);
    assert.ok(first.stderr.includes(W.address(name)), `the ask names the address the site goes live at (${W.address(name)}), in ${mode} mode; got ${w.describe(first)}`);
    assert.notEqual(w.requestIdIn(first.stderr), null, `Squire's deploy is asked, in ${mode} mode; got ${w.describe(first)}`);
    U.sayYesTo(world, job, first, { env: U.UTC });
    w.assertAllowed(floor.run(job, deploy, mode), `Squire's deploy, in ${mode} mode, on the owner's yes to it`);
    const d = W.runDeploy(ctx, folder, name);
    W.assertRan(d, `the deploy, in ${mode} mode`);
    assert.equal(d.status, 0, `the deploy the owner said yes to goes live, in ${mode} mode; got ${w.describe(d)}`);

    fs.writeFileSync(path.join(folder, 'index.html'), '<!doctype html><title>Ada Bakes</title><p>Fresh every morning, and on Sundays.</p>\n');
    W.previewSite(world, floor, job, folder, mode);
    const second = floor.run(job, deploy, mode);
    w.assertBlocked(second, `a second deploy of the same site, in ${mode} mode, after the owner's yes to the first`, name);
    assert.notEqual(w.requestIdIn(second.stderr), null, `a second deploy is asked again: the earlier yes covered one deploy, in ${mode} mode; got ${w.describe(second)}`);
    assert.ok(second.stderr.includes(W.address(name)), `the second ask names the address too, in ${mode} mode; got ${w.describe(second)}`);
  }
  assert.deepEqual(ctx.standIn.offLoopback(), [], 'no call left the loopback');
});

test('a deploy whose account, project or address the floor cannot read from the command is asked saying it cannot tell where the site goes, never free and never covered by an earlier yes, in the default mode and in auto mode', { timeout: 180000 }, (t) => {
  const ctx = W.websiteWorld(t, { laid: true });
  const { world } = ctx;
  const floor = U.laidFloor(world, U.UTC);
  for (const mode of MODES) {
    const job = `job-site-unknown-target-${mode}`;
    const name = `ada-bakes-${mode}`;
    W.startSite(world, floor, job, mode);
    const folder = W.writeSite(world, floor, job, name, mode);
    W.previewSite(world, floor, job, folder, mode);
    for (const [what, command] of [
      ['Squire\'s own deploy before the set-up has read the account', W.deployCommand(world, folder, name)],
      ['wrangler with no name or account, from the site\'s folder', `cd '${folder}' && npx wrangler deploy`],
      ['wrangler with its name in a variable', `npx wrangler deploy --name "$SITE_NAME" --assets '${folder}'`],
      ['a Workers upload by curl to an account and script in variables', `curl -X PUT "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/workers/scripts/$SCRIPT" -H "Authorization: Bearer $TOKEN" -F 'metadata=@meta.json'`],
    ]) {
      const first = floor.run(job, w.tools.bash(command), mode);
      w.assertBlocked(first, `${what}, in ${mode} mode`);
      assert.notEqual(w.requestIdIn(first.stderr), null, `${what}, in ${mode} mode: asked, never free; got ${w.describe(first)}`);
      assert.match(first.stderr, CANNOT_TELL, `${what}, in ${mode} mode: the ask says it cannot tell where the site goes; got ${w.describe(first)}`);
      U.sayYesTo(world, job, first, { env: U.UTC });
      w.assertAllowed(floor.run(job, w.tools.bash(command), mode), `${what}, in ${mode} mode, on the owner's yes to it`);
      const again = floor.run(job, w.tools.bash(command), mode);
      w.assertBlocked(again, `${what} once more, in ${mode} mode: the earlier yes covered one`);
      assert.notEqual(w.requestIdIn(again.stderr), null, `${what} once more, in ${mode} mode: asked again; got ${w.describe(again)}`);
      assert.match(again.stderr, CANNOT_TELL, `${what} once more, in ${mode} mode: still says it cannot tell where the site goes; got ${w.describe(again)}`);
    }
  }
  assert.deepEqual(W.uploads(ctx.standIn), [], 'nothing was deployed');
});

test("nothing reaches the site's address before the owner's yes to its deploy: the set-up, the preview and the deploy's ask put nothing there, a no keeps it so, and the site answers at its address only once the deploy the owner said yes to has run", { timeout: 240000 }, (t) => {
  const ctx = W.websiteWorld(t, { laid: true });
  const { world } = ctx;
  const set = W.runSetUp(ctx);
  W.assertRan(set, 'the set-up');
  assert.equal(set.status, 0, `the set-up reports done; got ${w.describe(set)}`);
  const floor = U.laidFloor(world, U.UTC);
  for (const mode of MODES) {
    const job = `job-site-not-yet-${mode}`;
    const name = `ada-bakes-${mode}`;
    const at = `/__sites/${name}.${W.SUBDOMAIN}.workers.dev/`;
    assert.deepEqual(W.uploads(ctx.standIn).filter((c) => c.path.includes(`/${name}`)), [], `the set-up put nothing on the account for ${name}`);
    W.startSite(world, floor, job, mode);
    const folder = W.writeSite(world, floor, job, name, mode);
    W.previewSite(world, floor, job, folder, mode);
    const deploy = w.tools.bash(W.deployCommand(world, folder, name));
    const asked = floor.run(job, deploy, mode);
    w.assertBlocked(asked, `the site's deploy, in ${mode} mode, before the yes`);
    const id = w.requestIdIn(asked.stderr);
    assert.notEqual(id, null, `the site's deploy is asked, in ${mode} mode; got ${w.describe(asked)}`);
    assert.deepEqual(W.uploads(ctx.standIn).filter((c) => c.path.includes(`/${name}`)), [], `nothing of ${name} is uploaded before the owner's yes, in ${mode} mode`);
    assert.equal(ctx.standIn.call('GET', at).status, 404, `nothing answers at the site's address before the yes, in ${mode} mode`);

    w.ownerSays(world, job, `no ${id}`, { env: U.UTC });
    w.assertBlocked(floor.run(job, deploy, mode), `the site's deploy, in ${mode} mode, after the owner said no`);
    assert.deepEqual(W.uploads(ctx.standIn).filter((c) => c.path.includes(`/${name}`)), [], `nothing of ${name} is uploaded after a no, in ${mode} mode`);
    assert.equal(ctx.standIn.call('GET', at).status, 404, `nothing answers at the site's address after a no, in ${mode} mode`);

    const later = floor.run(job, deploy, mode);
    w.assertBlocked(later, `the site's deploy asked again, in ${mode} mode`);
    U.sayYesTo(world, job, later, { env: U.UTC });
    w.assertAllowed(floor.run(job, deploy, mode), `the site's deploy on the owner's yes, in ${mode} mode`);
    const d = W.runDeploy(ctx, folder, name);
    W.assertRan(d, `the deploy, in ${mode} mode`);
    assert.equal(d.status, 0, `the deploy goes live on the yes, in ${mode} mode; got ${w.describe(d)}`);
    const live = ctx.standIn.call('GET', at);
    assert.equal(live.status, 200, `the site answers at its address once the deploy the owner said yes to has run, in ${mode} mode`);
    assert.match(live.body, /Fresh every morning/, `the site's address serves the site from its folder, in ${mode} mode`);
  }
  assert.deepEqual(ctx.standIn.offLoopback(), [], 'no call left the loopback');
});

test("a deploy by any route Squire did not set up is asked, never free, naming its target where the command does, in the default mode and in auto mode: wrangler deploy, npx wrangler, a Workers or Pages call to Cloudflare's API by curl, and a git push to a connected repository", { timeout: 180000 }, (t) => {
  const ctx = W.websiteWorld(t, { laid: true });
  const { world } = ctx;
  const floor = U.laidFloor(world, U.UTC);
  const api = 'https://api.cloudflare.com/client/v4';
  for (const mode of MODES) {
    const job = `job-site-other-routes-${mode}`;
    const name = `ada-bakes-${mode}`;
    W.startSite(world, floor, job, mode);
    const folder = W.writeSite(world, floor, job, name, mode);
    for (const [what, command, target] of [
      ['wrangler deploy', `wrangler deploy --name ${name} --assets '${folder}'`, name],
      ['npx wrangler deploy', `npx wrangler deploy --name ${name} --assets '${folder}'`, name],
      ['npx wrangler pages deploy', `npx wrangler pages deploy '${folder}' --project-name ${name}`, name],
      ['a Workers upload by curl', `curl -X PUT ${api}/accounts/${W.ACCOUNT}/workers/scripts/${name} -F 'metadata=@meta.json'`, name],
      ['a Pages deployment by curl', `curl -X POST ${api}/accounts/${W.ACCOUNT}/pages/projects/${name}/deployments -F 'manifest=@manifest.json'`, name],
      ['a git push to a connected repository', `git -C '${folder}' push https://git.example.net/ada/${name}.git main`, 'git.example.net'],
    ]) {
      const r = floor.run(job, w.tools.bash(command), mode);
      w.assertBlocked(r, `${what}, in ${mode} mode`, target);
      assert.notEqual(w.requestIdIn(r.stderr), null, `${what}, in ${mode} mode: asked, never free; got ${w.describe(r)}`);
    }
  }
  assert.deepEqual(W.uploads(ctx.standIn), [], 'nothing was deployed');
});

// The Cloudflare dashboard's host, as Cloudflare's public pages link to it
// (https://developers.cloudflare.com/fundamentals/account/find-account-and-zone-ids/).
// The floor cannot tell a deploy or a purchase there from any other act, so a
// browser call to it is refused, yes or no: decided on the fail-closed
// reading, for this one host. No browser is started: the call is put to the
// floor only, so nothing is opened.
const DASHBOARD = 'https://dash.cloudflare.com';

test("a site never goes live through the Cloudflare dashboard in Squire's browser: in a site job, with the owner's profile there to check, a browser navigate to the dashboard's host is refused, not asked, yes or no, the refusal naming the dashboard, in the default mode and in auto mode, and nothing is deployed", { timeout: 180000 }, (t) => {
  const ctx = W.websiteWorld(t, { laid: true });
  const { world } = ctx;
  B.writeOwnerProfile(world);
  const floor = U.laidFloor(world, U.UTC);
  for (const mode of MODES) {
    const job = `job-site-dashboard-${mode}`;
    W.startSite(world, floor, job, mode);
    for (const url of [`${DASHBOARD}/?to=/:account/workers-and-pages`, `${DASHBOARD}/`]) {
      for (const when of ['', ', even after the owner said yes']) {
        if (when) w.ownerSays(world, job, 'yes', { env: U.UTC });
        const r = floor.run(job, B.browserTools.navigate(url), mode);
        w.assertBlocked(r, `a browser navigate to ${url}, in ${mode} mode${when}`);
        assert.equal(w.requestIdIn(r.stderr), null, `a browser navigate to ${url}, in ${mode} mode${when}: refused, not asked; got a request the owner could answer: ${w.describe(r)}`);
        assert.match(r.stderr.split(url).join(' '), /dashboard|money|spend|pay|buy|billing/i, `a browser navigate to ${url}, in ${mode} mode${when}: the refusal names the dashboard or money, not another reason; got ${w.describe(r)}`);
      }
    }
  }
  assert.deepEqual(W.uploads(ctx.standIn), [], 'nothing was deployed');
  assert.deepEqual(ctx.standIn.offLoopback(), [], 'no call left the loopback');
});
