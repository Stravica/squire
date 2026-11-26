'use strict';

// What the website cases share, on top of the base world (squire-world.js),
// the usage world (usage-world.js) and the loopback Cloudflare stand-in
// (cloudflare-stand-in.js). Nothing here imports or copies product logic.
//
// What the cases pin, each decided on the fail-closed reading and named here
// (none is in a design record yet):
//   core/tools/website.py   Squire's website command, two verbs:
//       website.py set-up <account id>
//                           the one-off safe set-up of the owner's Cloudflare
//                           account, run once;
//       website.py deploy <site folder> <site name>
//                           Squire's own deploy of one site, as a Worker with
//                           static assets on the account's workers.dev
//                           address, https://<site name>.<subdomain>.workers.dev.
//   The set-up token        an account-owned token the owner makes, stored by
//                           the owner as the Keychain secret cloudflare-set-up
//                           (secret.py set cloudflare-set-up, the token on
//                           stdin); the set-up takes it only through Squire's
//                           secret helper, from the Keychain squire.json names.
//                           Its rights: Account API Tokens Write and Billing
//                           Read, nothing else.
//   The kept token          made by the set-up: account-owned, Workers Scripts
//                           Write alone, on the owner's account alone, kept as
//                           the Keychain secret cloudflare-deploy through the
//                           secret helper and used only by Squire's deploy.
//   Where Squire's tools reach Cloudflare
//                           squire.json in Squire's home: cloudflareApi, the
//                           API's address (https://api.cloudflare.com/client/v4
//                           when absent), and cloudflareSites, the address
//                           template a deployed site is read back at
//                           (https://{name}.{subdomain}.workers.dev/ when
//                           absent). The cases set both to the stand-in.
//   A site's folder         workspace/sites/<site name> in the owner's folder.
//   A site's preview        the app's route: Python's own http.server bound to
//                           127.0.0.1 from the site's own folder.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const w = require('./squire-world.js');
const U = require('./usage-world.js');
const CF = require('./cloudflare-stand-in.js');

// Invented and plainly fake: no real account, subdomain or token.
const ACCOUNT = 'deadbeefdeadbeefdeadbeefdeadbeef';
const OTHER_ACCOUNT = 'feedfacefeedfacefeedfacefeedface';
const SUBDOMAIN = 'pretend-bakery';
const SET_UP_SECRET = 'cloudflare-set-up';
const KEPT_SECRET = 'cloudflare-deploy';
const SET_UP_RIGHTS = ['Account API Tokens Write', 'Billing Read'];
const KEPT_RIGHT = 'Workers Scripts Write';

const address = (name) => `https://${name}.${SUBDOMAIN}.workers.dev`;
const fakeToken = (kind) => `standin-${kind}-${crypto.randomBytes(20).toString('hex')}`;

// The account's subscriptions on the free plans: one, priced at nothing.
const FREE = [{
  id: 'standin-sub-0001',
  rate_plan: { id: 'free', public_name: 'Workers Free', currency: 'USD', scope: 'account', externally_managed: false, is_contract: false },
  price: 0,
  currency: 'USD',
  frequency: 'monthly',
  state: 'Provisioned',
  current_period_start: '2026-11-01T00:00:00Z',
  current_period_end: '2026-12-01T00:00:00Z',
}];

// A world with a temporary keychain holding the owner's set-up token, a
// stand-in that knows that token, and Squire's home pointed at the stand-in.
// laid: core laid down, as the session runs it (for cases through the floor);
// else the home's core is a link to this repository's core. setUpOwnedBy
// 'user': the owner made the set-up token under their own profile, not the
// account (the stand-in answers it as a user-owned token).
function websiteWorld(t, { laid = false, rights = SET_UP_RIGHTS, subscriptions = FREE, inKeychain = true, extraTokens = [], setUpOwnedBy = null, ...options } = {}) {
  const world = U.usageWorld(t, { core: !laid });
  if (laid) {
    const done = w.layDown(world, w.CORE);
    assert.equal(done.status, 0, `laying down core must succeed; got ${w.describe(done)}`);
    U.writeSnapshot(world, {
      fiveHour: { used: 30, resetsAt: U.onMinute(U.now() + 3 * 3600) },
      sevenDay: { used: 40, resetsAt: U.onMinute(U.now() + 4 * U.DAY) },
    });
  }
  const keychain = w.makeKeychain(world);
  const setUp = { id: 'standin-token-set-up-0001', value: fakeToken('set-up'), name: 'Set-up token the owner made (invented)', policies: [CF.policyFor(ACCOUNT, rights)] };
  if (setUpOwnedBy) setUp.ownedBy = setUpOwnedBy;
  const standIn = CF.startStandIn(t, world, { accountId: ACCOUNT, subdomain: SUBDOMAIN, tokens: [setUp, ...extraTokens], subscriptions, ...options });
  if (inKeychain) w.storeSecret(keychain, SET_UP_SECRET, setUp.value);
  w.writeConfig(world, { cloudflareApi: standIn.api, cloudflareSites: standIn.sites });
  return { world, keychain, standIn, setUp };
}

const websiteTool = (world) => path.join(world.home, 'core', 'tools', 'website.py');

// The set-up and the deploy through their own command line, as the session
// runs them once the floor lets them, with the stand-in as every process's
// web proxy.
function runSetUp(ctx, { env = {}, account = ACCOUNT } = {}) {
  return w.runPython(ctx.world, websiteTool(ctx.world), ['set-up', account], { env: { ...ctx.standIn.proxyEnv, ...env }, timeout: 90000 });
}

function runDeploy(ctx, folder, name, { env = {} } = {}) {
  return w.runPython(ctx.world, websiteTool(ctx.world), ['deploy', folder, name], { env: { ...ctx.standIn.proxyEnv, ...env }, timeout: 120000 });
}

// The commands as the session spells them for the floor.
const deployCommand = (world, folder, name) => `/usr/bin/python3 '${websiteTool(world)}' deploy '${folder}' ${name}`;
const previewCommand = (folder) => `/usr/bin/python3 -m http.server 0 --bind 127.0.0.1 --directory '${folder}'`;

// A small site in its own folder in the owner's folder.
function makeSite(world, name, html = '<!doctype html><title>Ada Bakes</title><p>Fresh every morning.</p>\n') {
  const folder = path.join(world.owner, 'workspace', 'sites', name);
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, 'index.html'), html);
  return folder;
}

// The run went through the tool, not a missing file or a crash.
function assertRan(r, what) {
  assert.doesNotMatch(`${r.stderr}\n${r.error}`, /can't open file|No such file or directory|Traceback \(most recent call last\)/,
    `${what}: Squire's website command must run; got ${w.describe(r)}`);
}

const said = (r) => `${r.stdout}\n${r.stderr}`;

// The stand-in's calls made with a token value.
const callsWith = (standIn, value) => standIn.calls().filter((c) => c.token === value);
const uploads = (standIn) => standIn.calls().filter((c) => /\/workers\/(scripts\/[^/]+(\/assets-upload-session|\/subdomain)?$|assets\/upload)/.test(c.path.split('?')[0]) && c.method !== 'GET');
const tokensOn = (standIn) => standIn.state().tokens;
const activeTokens = (standIn) => tokensOn(standIn).filter((t) => t.status === 'active');

// The kept token's record on the stand-in, by the value in the Keychain.
function keptToken(ctx) {
  assert.ok(w.hasSecret(ctx.keychain, KEPT_SECRET), `the set-up must keep its deploy token in the Keychain as ${KEPT_SECRET}, through Squire's secret helper`);
  const value = w.readSecret(ctx.keychain, KEPT_SECRET);
  const record = tokensOn(ctx.standIn).find((x) => x.value === value);
  assert.ok(record, 'the token in the Keychain must be one the set-up made on the account');
  return { value, record };
}

// Rights as names: each policy as { effect, resources, groups }.
const rightsOf = (record) => (record.policies || []).map((p) => ({
  effect: p.effect,
  resources: Object.keys(p.resources || {}).sort(),
  groups: (p.permission_groups || []).map((g) => g.name).sort(),
}));

// A wrangler sign-in and a Cloudflare token already on the Mac, invented,
// inside the case's own home and environment: what Squire's tools must never
// use. With values given, the stand-in can be told to hold them as working
// tokens, so a tool that used one would get through.
function plantStrays(world, { signIn = fakeToken('stray-sign-in'), envToken = fakeToken('stray-env') } = {}) {
  const toml = `oauth_token = "${signIn}"\nexpiration_time = "2099-01-01T00:00:00.000Z"\nrefresh_token = "${fakeToken('stray-refresh')}"\n`;
  for (const dir of [path.join(world.userHome, '.wrangler', 'config'), path.join(world.userHome, 'Library', 'Preferences', '.wrangler', 'config'), path.join(world.userHome, '.config', '.wrangler', 'config')]) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'default.toml'), toml);
  }
  return {
    signIn,
    envToken,
    env: { CLOUDFLARE_API_TOKEN: envToken, CF_API_TOKEN: envToken, CLOUDFLARE_ACCOUNT_ID: OTHER_ACCOUNT, CF_ACCOUNT_ID: OTHER_ACCOUNT },
  };
}

// Stray tokens the stand-in holds as working ones, with rights wider than
// deploying.
const strayTokens = (signIn, envToken) => [
  { id: 'standin-token-stray-sign-in', value: signIn, name: 'A sign-in already on the Mac (invented)', policies: [CF.policyFor(ACCOUNT, ['Workers Scripts Write', 'Account Settings Write'])] },
  { id: 'standin-token-stray-env', value: envToken, name: 'A token in the environment (invented)', policies: [CF.policyFor(ACCOUNT, ['Workers Scripts Write', 'Billing Write'])] },
];

// The owner's yes to building a site, through the laid floor.
function startSite(world, floor, job, mode) {
  const first = floor.run(job, U.heavyJob(world, 'site'), mode);
  w.assertBlocked(first, `building a site, in ${mode} mode, with no yes`);
  assert.match(first.stderr, U.HEAVY.site, `the floor warns of building a site as a big job, in ${mode} mode; got ${w.describe(first)}`);
  U.sayYesTo(world, job, first, { env: U.UTC });
  w.assertAllowed(floor.run(job, U.heavyJob(world, 'site'), mode), `building a site, in ${mode} mode, once the owner said yes`);
}

// The site's preview on the loopback from its own folder: asked, the owner's
// yes, then let through.
function previewSite(world, floor, job, folder, mode) {
  const first = floor.run(job, w.tools.bash(previewCommand(folder)), mode);
  w.assertBlocked(first, `the site's preview, in ${mode} mode, with no yes`);
  assert.notEqual(w.requestIdIn(first.stderr), null, `the site's preview, in ${mode} mode, is asked; got ${w.describe(first)}`);
  U.sayYesTo(world, job, first, { env: U.UTC });
  w.assertAllowed(floor.run(job, w.tools.bash(previewCommand(folder)), mode), `the site's preview, in ${mode} mode, once the owner said yes`);
}

// The site's files written by the session, as the floor judges them.
function writeSite(world, floor, job, name, mode, html = '<!doctype html><title>Ada Bakes</title><p>Fresh every morning.</p>\n') {
  const folder = path.join(world.owner, 'workspace', 'sites', name);
  w.assertAllowed(floor.run(job, w.tools.write(path.join(folder, 'index.html'), html), mode), `the site's page written in its folder, in ${mode} mode`);
  // The floor let the write through; the session's Write then makes it.
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, 'index.html'), html);
  return folder;
}

// Waits, for at most ms, until test() is true.
function waitFor(testFn, ms) {
  const end = Date.now() + ms;
  while (!testFn() && Date.now() < end) require('node:child_process').spawnSync('/bin/sleep', ['0.1']);
  return testFn();
}

module.exports = {
  ACCOUNT,
  OTHER_ACCOUNT,
  SUBDOMAIN,
  SET_UP_SECRET,
  KEPT_SECRET,
  SET_UP_RIGHTS,
  KEPT_RIGHT,
  FREE,
  address,
  fakeToken,
  websiteWorld,
  websiteTool,
  runSetUp,
  runDeploy,
  deployCommand,
  previewCommand,
  makeSite,
  assertRan,
  said,
  callsWith,
  uploads,
  tokensOn,
  activeTokens,
  keptToken,
  rightsOf,
  plantStrays,
  strayTokens,
  startSite,
  previewSite,
  writeSite,
  waitFor,
};
