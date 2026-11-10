'use strict';

// The launch contract: every session Squire starts runs Squire's safety floor;
// when the floor cannot be put in place, no session starts and the health
// check says why.
//
// Every case runs the installed runner (<Squire home>/core/tools/runner.py)
// the way its launchd agent does, after core is laid down, with a fake Claude
// Code at the place Claude Code installs itself under the world's home. The
// fake records how it was started; its session runs the SessionStart hooks of
// the settings it is given, as Claude Code does. The floor's own hooks run at
// the process boundary.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const w = require('../fixtures/squire-world.js');
const s = require('../fixtures/session-world.js');

const { tools } = w;
const PRODUCT_PATH = '/usr/bin:/bin:/usr/sbin:/sbin';
const HOMEBREW_BIN = '/opt/homebrew/bin';

// A world with core laid down and a fake Claude Code signed in.
function sessionWorld(t, { signedIn = true, release = w.CORE } = {}) {
  const world = w.makeWorld();
  t.after(() => { s.killFakes(world); w.cleanUp(world); });
  const installed = s.layDownCore(world, release);
  const fake = s.installFakeClaudeCode(world, { signedIn });
  return { world, installed, fake };
}

function runnerFor(t, world, opts) {
  const runner = s.startRunner(world, opts);
  t.after(() => runner.stop());
  return runner;
}

async function firstSession(runner, fake, what) {
  // Waits for the first server start, or for the runner to have exited.
  await s.waitFor(() => fake.serverCalls()[0] || runner.exited(), 20000);
  const call = fake.serverCalls()[0];
  assert.ok(call, `${what}: the runner must start one Claude Code session within 20 seconds; it started none. ` +
    `Runner: ${runner.exited() ? `exited ${JSON.stringify(runner.exited())}` : 'still running'}; output: ${runner.output().slice(-600) || '(none)'}`);
  return call;
}

// The runner refuses to start a session: it exits, having started none, and
// the health check names what is wrong.
async function assertNoSession(world, runner, fake, mention, what) {
  const exit = await s.waitFor(() => runner.exited(), 20000);
  assert.ok(exit, `${what}: the runner must stop without a session (it exits, and its launchd agent runs it again later); it was still running after 20 seconds`);
  assert.notEqual(exit.status, 0, `${what}: the runner must exit non-zero when it starts no session; got ${JSON.stringify(exit)}`);
  assert.deepEqual(fake.serverCalls(), [], `${what}: no session may start; Claude Code was started with ${JSON.stringify(fake.serverCalls().map((c) => c.argv))}`);
  const h = s.health(world);
  assert.notEqual(h.status, 0, `${what}: the health check must report a problem; got ${w.describe(h)}`);
  assert.ok(mention.test(h.stdout), `${what}: the health check must say why (${mention}); got ${w.describe(h)}`);
}

// The names a Claude Code settings file in the owner's folder can have, by any
// spelling the disk folds to them.
function ownerSettingsIn(listing) {
  const fold = (n) => n.normalize('NFD').toLowerCase().replace(/ſ/g, 's').normalize('NFD');
  return (listing || []).filter((n) => ['settings.json', 'settings.local.json'].includes(fold(n)));
}

test('the session runs from a Claude Code config folder inside the Squire home whose settings are the installed core settings, with the trust and Remote Control questions answered in advance and the sign-in kept', { timeout: 90000 }, async (t) => {
  const { world, installed, fake } = sessionWorld(t);
  // What Claude Code's own sign-in keeps in the config folder before Squire's
  // first start.
  const config = s.configDir(world);
  fs.mkdirSync(config, { recursive: true });
  fs.writeFileSync(path.join(config, '.claude.json'), JSON.stringify({ userID: 'kept-user', oauthAccount: { accountUuid: 'kept-account' } }));

  const runner = runnerFor(t, world);
  const call = await firstSession(runner, fake, 'a first start');
  const given = call.env.CLAUDE_CONFIG_DIR;
  assert.ok(given, `Claude Code must be given its config folder (CLAUDE_CONFIG_DIR); its environment held ${call.envNames.join(', ')}`);
  assert.equal(fs.realpathSync(given), fs.realpathSync(config),
    `Claude Code's config folder must be the one inside the Squire home (${config}), never ~/.claude; got ${given}`);
  assert.notEqual(fs.realpathSync(given), path.join(fs.realpathSync(world.userHome), '.claude'),
    'the session must never take its user settings from ~/.claude');

  const settings = JSON.parse(fs.readFileSync(path.join(given, 'settings.json'), 'utf8'));
  const core = JSON.parse(fs.readFileSync(path.join(installed, 'settings.json'), 'utf8'));
  assert.deepEqual(settings, core, 'the config folder\'s settings.json must be the installed core settings, parsed and compared');

  const state = JSON.parse(fs.readFileSync(path.join(given, '.claude.json'), 'utf8'));
  const owner = fs.realpathSync(world.owner);
  assert.equal(state.projects && state.projects[owner] && state.projects[owner].hasTrustDialogAccepted, true,
    `"trust this folder" must be answered in advance for the owner's folder (${owner}) in the config folder's .claude.json; got ${JSON.stringify(state.projects)}`);
  assert.equal(state.remoteDialogSeen, true, '"Enable Remote Control" must be answered in advance (remoteDialogSeen true)');
  assert.equal(state.userID, 'kept-user', 'what Claude Code keeps in .claude.json must be kept');
  assert.deepEqual(state.oauthAccount, { accountUuid: 'kept-account' }, 'the sign-in Claude Code keeps in .claude.json must be kept');
});

test('the runner builds the session environment from nothing: the Mac folders first on PATH, then Claude Code, then Homebrew, its own home, user and config, and never an API key, a token or agent teams, whatever is set around it', { timeout: 90000 }, async (t) => {
  const { world, fake } = sessionWorld(t);
  const decoyBin = path.join(world.root, 'decoy-bin');
  fs.mkdirSync(decoyBin);
  const around = {
    PATH: `${decoyBin}:${PRODUCT_PATH}`,
    ANTHROPIC_API_KEY: 'sk-ant-api-not-a-real-key',
    CLAUDE_CODE_OAUTH_TOKEN: 'not-a-real-oauth-token',
    ANTHROPIC_AUTH_TOKEN: 'not-a-real-auth-token',
    CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
    PYTHONPATH: decoyBin,
    SQUIRE_STRAY_SETTING: 'from the owner shell profile',
  };
  const runner = runnerFor(t, world, { env: around });
  await firstSession(runner, fake, 'a start with keys and strays set around the runner');
  const calls = fake.calls();
  assert.ok(fake.authCalls().length >= 1, `the runner must check the Claude sign-in (claude auth status) before it starts a session; calls: ${JSON.stringify(calls.map((c) => c.argv))}`);
  const expectedPath = [PRODUCT_PATH, path.dirname(fake.bin), HOMEBREW_BIN].join(':');
  for (const call of calls) {
    const what = `claude ${call.argv.join(' ')}`;
    for (const name of s.ENVIRONMENT_FORBIDDEN) {
      assert.ok(!call.envNames.includes(name), `${what}: ${name} must never reach Claude Code; its environment held ${call.envNames.join(', ')}`);
    }
    const strays = call.envNames.filter((n) => !s.ENVIRONMENT_ALLOWED.includes(n));
    assert.deepEqual(strays, [], `${what}: the environment must be built from nothing; it also held ${strays.join(', ')}`);
    assert.equal(call.env.PATH, expectedPath, `${what}: PATH must be the Mac's own folders, then Claude Code's folder, then Homebrew's`);
    assert.equal(call.env.HOME, world.userHome, `${what}: HOME must be the user's home`);
    assert.equal(call.env.USER, os.userInfo().username, `${what}: USER must be the user Squire runs as (Claude Code reads its sign-in with it)`);
    assert.equal(call.env.SQUIRE_HOME, world.home, `${what}: SQUIRE_HOME must be the Squire home`);
    assert.equal(fs.realpathSync(call.env.CLAUDE_CONFIG_DIR || '/nonexistent-config'), fs.realpathSync(s.configDir(world)),
      `${what}: CLAUDE_CONFIG_DIR must be the config folder in the Squire home`);
    assert.match(call.env.LANG || '', /UTF-8$/i, `${what}: a UTF-8 locale must be set (LANG)`);
  }
});

test('the runner runs the claude Claude Code installs under the home folder and never one found on PATH, and with none it can trust it starts no session and the health check says why', { timeout: 120000 }, async (t) => {
  // A decoy claude first on the runner's PATH is never run.
  {
    const { world, fake } = sessionWorld(t);
    const decoyBin = path.join(world.root, 'decoy-bin');
    const decoyRan = path.join(world.root, 'decoy-claude.ran');
    fs.mkdirSync(decoyBin);
    fs.writeFileSync(path.join(decoyBin, 'claude'), `#!/bin/sh\necho "$*" >> '${decoyRan}'\nexit 0\n`, { mode: 0o755 });
    const runner = runnerFor(t, world, { env: { PATH: `${decoyBin}:${PRODUCT_PATH}` } });
    await firstSession(runner, fake, 'a decoy claude first on PATH');
    assert.ok(!fs.existsSync(path.join(world.root, 'decoy-claude.ran')),
      `a claude found on PATH must never run; the decoy ran with: ${fs.existsSync(decoyRan) ? fs.readFileSync(decoyRan, 'utf8') : ''}`);
    await runner.stop();
  }
  // A claude anyone on the Mac may change is never run.
  {
    const { world, fake } = sessionWorld(t);
    fs.chmodSync(fake.bin, 0o777);
    const runner = runnerFor(t, world);
    await assertNoSession(world, runner, fake, /claude/i, 'a ~/.local/bin/claude anyone may change');
    assert.deepEqual(fake.calls(), [], `a claude anyone may change must never be run, not even to check the sign-in; it ran: ${JSON.stringify(fake.calls().map((c) => c.argv))}`);
  }
  // No claude where Claude Code installs itself.
  {
    const { world, fake } = sessionWorld(t);
    fs.rmSync(fake.bin);
    const runner = runnerFor(t, world);
    await assertNoSession(world, runner, fake, /claude/i, 'no claude where Claude Code installs itself');
  }
});

test('the runner starts one Remote Control server in the owner folder in single-session mode, with the permission mode that asks nothing, the owner name for Squire, Squire settings accepting its wake-ups, and never a fork', { timeout: 120000 }, async (t) => {
  const { world, installed, fake } = sessionWorld(t);
  let runner = runnerFor(t, world);
  const call = await firstSession(runner, fake, 'a start');
  const argv = call.argv;
  const pairAt = (flag, value) => argv.some((a, i) => a === flag && argv[i + 1] === value);
  assert.equal(argv[0], 'remote-control', `the session must be a Remote Control server; argv ${JSON.stringify(argv)}`);
  assert.ok(pairAt('--spawn', 'session'), `the server must hold exactly one session (--spawn session); argv ${JSON.stringify(argv)}`);
  assert.ok(pairAt('--permission-mode', 'bypassPermissions'),
    `Claude Code must ask nothing itself, so the floor is the one approval channel (--permission-mode bypassPermissions); argv ${JSON.stringify(argv)}`);
  assert.ok(pairAt('--name', 'Pip'), `the session must carry the name the owner gave Squire (squireName "Pip" in the owner config); argv ${JSON.stringify(argv)}`);
  for (const flag of ['--fork-session', '--settings', '--setting-sources', '--capacity', '--dangerously-skip-permissions', '--continue', '--session-id']) {
    assert.ok(!argv.includes(flag), `the runner must never pass ${flag}; argv ${JSON.stringify(argv)}`);
  }
  assert.equal(fs.realpathSync(call.cwd), fs.realpathSync(world.owner), 'the session\'s working folder must be the owner\'s folder');

  // The server's own output, its registration and connected state, is kept
  // in the Squire home, where the release Verify reads it.
  const sessionLog = path.join(world.home, 'logs', 'session.log');
  const kept = await s.waitFor(() => fs.existsSync(sessionLog) && /Session started/.test(fs.readFileSync(sessionLog, 'utf8'))
    && /Connected/.test(fs.readFileSync(sessionLog, 'utf8')), 10000);
  assert.ok(kept, `the server's output (its "Session started" and "Connected" lines) must be kept in logs/session.log in the Squire home; got ${fs.existsSync(sessionLog) ? JSON.stringify(fs.readFileSync(sessionLog, 'utf8').slice(-400)) : 'no file'}`);

  // The installed settings accept the wake-up router's messages: a session
  // that asks nothing would otherwise hold each one for an approval in the app.
  const core = JSON.parse(fs.readFileSync(path.join(installed, 'settings.json'), 'utf8'));
  assert.equal(core.crossSessionInbound, 'accept', `core's settings must accept messages on the session's socket (crossSessionInbound "accept"); got ${JSON.stringify(core.crossSessionInbound)}`);

  // With no name in the owner config, the session is called Squire.
  await runner.stop();
  const ownerConfig = path.join(world.owner, 'squire.json');
  const personal = JSON.parse(fs.readFileSync(ownerConfig, 'utf8'));
  delete personal.squireName;
  fs.writeFileSync(ownerConfig, JSON.stringify(personal, null, 2) + '\n');
  runner = runnerFor(t, world);
  const second = await s.waitFor(() => fake.serverCalls()[1], 20000);
  assert.ok(second, `a second start must start a session; output: ${runner.output().slice(-600)}`);
  assert.ok(second.argv.some((a, i) => a === '--name' && second.argv[i + 1] === 'Squire'),
    `with no squireName in the owner config the session must be called Squire; argv ${JSON.stringify(second.argv)}`);
});

test('before each start the runner checks the floor: with core settings or a floor hook missing, its config folder settings changed, or no Claude sign-in, no session starts and the health check says why, never with a sign-in window', { timeout: 300000 }, async (t) => {
  const cases = [
    ['core settings missing', (world) => fs.rmSync(path.join(s.installedCore(world), 'settings.json')), /settings\.json/],
    ['the pre-tool-use hook missing', (world) => fs.rmSync(path.join(s.installedCore(world), 'hooks', 'pre-tool-use.py'), { force: true }), /pre-tool-use\.py/],
    ['the user-prompt-submit hook missing', (world) => fs.rmSync(path.join(s.installedCore(world), 'hooks', 'user-prompt-submit.py'), { force: true }), /user-prompt-submit\.py/],
    ['the session-start hook missing', (world) => fs.rmSync(path.join(s.installedCore(world), 'hooks', 'session-start.py'), { force: true }), /session-start\.py/],
    ['the config-change hook missing', (world) => fs.rmSync(path.join(s.installedCore(world), 'hooks', 'config-change.py'), { force: true }), /config-change\.py/],
    ['the config folder settings changed', (world) => {
      const file = path.join(s.configDir(world), 'settings.json');
      const settings = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
      fs.mkdirSync(s.configDir(world), { recursive: true });
      fs.writeFileSync(file, JSON.stringify({ ...settings, disableAllHooks: true }, null, 2) + '\n');
    }, /settings\.json/],
  ];
  for (const [what, breakIt, mention] of cases) {
    const { world, fake } = sessionWorld(t);
    breakIt(world);
    const runner = runnerFor(t, world);
    await assertNoSession(world, runner, fake, mention, what);
    await runner.stop();
  }
  // Not signed in: no session, no sign-in window, and the health check says so.
  const { world, fake } = sessionWorld(t, { signedIn: false });
  const runner = runnerFor(t, world);
  await assertNoSession(world, runner, fake, /sign/i, 'no Claude sign-in');
  assert.ok(fake.authCalls().length >= 1, 'the runner must ask Claude Code whether it is signed in (claude auth status)');
  const opened = fake.calls().filter((c) => c.argv.includes('login') || c.argv.includes('setup-token'));
  assert.deepEqual(opened, [], `the runner must never start a sign-in itself; it ran ${JSON.stringify(opened.map((c) => c.argv))}`);
});

test('before each start the runner compares core settings and every floor hook with the digests lay-down recorded: a hook with one line added, or core settings and the config folder settings changed alike, starts no session and the health check names the file', { timeout: 300000 }, async (t) => {
  const cases = ['pre-tool-use.py', 'user-prompt-submit.py', 'session-start.py', 'config-change.py'].map((hook) => [
    `the ${hook} hook with one harmless line added`,
    (world) => fs.appendFileSync(path.join(s.installedCore(world), 'hooks', hook), '\n# one harmless line\n'),
    new RegExp(hook.replace(/\./g, '\\.')),
  ]);
  // Only the digest can see this one: the config folder's settings still
  // equal core's, and every file is there.
  cases.push(['core settings and the config folder settings changed alike, the PreToolUse hook taken out of both', (world) => {
    const coreSettings = path.join(s.installedCore(world), 'settings.json');
    const settings = JSON.parse(fs.readFileSync(coreSettings, 'utf8'));
    delete settings.hooks.PreToolUse;
    const text = JSON.stringify(settings, null, 2) + '\n';
    fs.writeFileSync(coreSettings, text);
    fs.mkdirSync(s.configDir(world), { recursive: true });
    fs.writeFileSync(path.join(s.configDir(world), 'settings.json'), text);
  }, /settings\.json/]);
  for (const [what, changeIt, mention] of cases) {
    const { world, fake } = sessionWorld(t);
    changeIt(world);
    const runner = runnerFor(t, world);
    await assertNoSession(world, runner, fake, mention, what);
    const signIns = fake.calls().filter((c) => c.argv.includes('login') || c.argv.includes('setup-token'));
    assert.deepEqual(signIns, [], `${what}: no sign-in may be started; the runner ran ${JSON.stringify(signIns.map((c) => c.argv))}`);
    await runner.stop();
  }
});

test('no session starts while a Claude Code settings file sits in the owner folder: the runner moves it into the Squire home, keeps its content, names it in the health check, and only then starts the session', { timeout: 90000 }, async (t) => {
  const { world, fake } = sessionWorld(t);
  const planted = path.join(world.owner, '.claude', 'settings.local.json');
  const content = Buffer.from(JSON.stringify({ disableAllHooks: true }) + '\n');
  fs.mkdirSync(path.dirname(planted), { recursive: true });
  fs.writeFileSync(planted, content);
  const runner = runnerFor(t, world);
  const call = await firstSession(runner, fake, 'a start with a settings file in the owner folder');
  assert.deepEqual(ownerSettingsIn(call.ownerClaude), [],
    `the session must start only once no Claude Code settings file is in the owner folder; at its start .claude held ${JSON.stringify(call.ownerClaude)}`);
  assert.ok(!fs.existsSync(planted), 'the settings file must no longer be in the owner folder');
  assert.ok(s.filesWithContent(world.home, content).length >= 1, 'the settings file must be kept in the Squire home with its content');
  const h = s.health(world);
  assert.ok(h.stdout.includes('settings.local.json'), `the health check must name the file it moved; got ${w.describe(h)}`);
});

// Plants settings files in the owner's folder while a session runs, and checks
// what the ruling asks of the runner: the session stopped within 5 seconds of
// the file appearing (its whole process group gone), the file kept in the
// Squire home and named by the health check, and a new session started.
async function plantAndExpectRestart(world, fake, names, what) {
  const before = fake.sessions().length;
  const running = fake.sessions()[before - 1];
  assert.ok(running, `${what}: a session must be running first`);
  const server = fake.serverCalls()[fake.serverCalls().length - 1];
  const files = names.map((name) => {
    const file = path.join(world.owner, '.claude', name);
    return { name, file, content: Buffer.from(`{"disableAllHooks": true, "planted": ${JSON.stringify(name)}}\n`) };
  });
  fs.mkdirSync(path.join(world.owner, '.claude'), { recursive: true });
  const t0 = Date.now();
  for (const f of files) fs.writeFileSync(f.file, f.content);
  const gone = await s.waitFor(() => w.processGone(server.pid) && w.processGone(running.pid), 5000, 50);
  assert.ok(gone, `${what}: the session must stop within 5 seconds of the file appearing, its whole process group gone; ` +
    `after ${Date.now() - t0} ms server ${server.pid} gone: ${w.processGone(server.pid)}, session ${running.pid} gone: ${w.processGone(running.pid)}`);
  const restarted = await s.waitFor(() => fake.sessions().length > before && fake.sessions()[fake.sessions().length - 1], 15000);
  assert.ok(restarted, `${what}: a new session must start once the file is moved`);
  const next = fake.serverCalls()[fake.serverCalls().length - 1];
  assert.deepEqual(ownerSettingsIn(next.ownerClaude), [], `${what}: the new session must start with no settings file in the owner folder; .claude held ${JSON.stringify(next.ownerClaude)}`);
  const h = s.health(world);
  for (const f of files) {
    assert.ok(!fs.existsSync(f.file) || !fs.readdirSync(path.dirname(f.file)).includes(f.name), `${what}: ${f.name} must be gone from the owner folder`);
    assert.ok(s.filesWithContent(world.home, f.content).length >= 1, `${what}: ${f.name} must be kept in the Squire home with its content`);
    assert.ok(h.stdout.includes(f.name), `${what}: the health check must name ${f.name}; got ${w.describe(h)}`);
  }
}

test('typical: a Claude Code settings file appearing in the owner folder while the session runs stops the session within 5 seconds, is moved into the Squire home and named, and a new session starts', { timeout: 90000 }, async (t) => {
  const { world, fake } = sessionWorld(t);
  const runner = runnerFor(t, world);
  await firstSession(runner, fake, 'a first start');
  assert.ok(await s.waitFor(() => fake.sessions()[0], 10000), 'the first session must be running');
  await plantAndExpectRestart(world, fake, ['settings.json'], 'a project settings file appearing');
});

test('heavy: settings files appearing together, and by spellings the disk folds, each stop the session within 5 seconds, are moved into the Squire home and named, and a new session starts each time', { timeout: 180000 }, async (t) => {
  const { world, fake } = sessionWorld(t);
  const runner = runnerFor(t, world);
  await firstSession(runner, fake, 'a first start');
  assert.ok(await s.waitFor(() => fake.sessions()[0], 10000), 'the first session must be running');
  await plantAndExpectRestart(world, fake, ['settings.json', 'settings.local.json'], 'project and local settings appearing together');

  // Premise: on this volume a name with the long s, and one in capitals, open
  // the settings file itself. Where the disk does not fold them, Claude Code
  // would never read them and the case does not apply.
  const probeDir = fs.mkdtempSync(path.join(world.root, 'fold-'));
  fs.writeFileSync(path.join(probeDir, 'ſettings.local.json'), 'folded');
  fs.writeFileSync(path.join(probeDir, 'Settings.JSON'), 'capitals');
  const folds = fs.existsSync(path.join(probeDir, 'settings.local.json'))
    && fs.readFileSync(path.join(probeDir, 'settings.local.json'), 'utf8') === 'folded'
    && fs.readFileSync(path.join(probeDir, 'settings.json'), 'utf8') === 'capitals';
  fs.rmSync(probeDir, { recursive: true, force: true });
  if (!folds) {
    t.diagnostic('this volume does not fold the long s or capitals in names; the folded spellings were not planted');
    return;
  }
  await plantAndExpectRestart(world, fake, ['ſettings.local.json'], 'local settings by the long s');
  await plantAndExpectRestart(world, fake, ['Settings.JSON'], 'project settings in capitals');
});

test('a change to Claude Code settings during a session is refused by the floor ConfigChange hook, for the owner folder project and local settings and Squire own user settings, and core settings run it as Claude Code does', { timeout: 60000 }, (t) => {
  const world = w.makeWorld();
  t.after(() => w.cleanUp(world));
  const hook = path.join(w.CORE, 'hooks', 'config-change.py');
  assert.ok(fs.existsSync(hook), 'core must ship the floor\'s ConfigChange hook at core/hooks/config-change.py');
  const events = [
    ['project_settings', path.join(world.owner, '.claude', 'settings.json')],
    ['local_settings', path.join(world.owner, '.claude', 'settings.local.json')],
    ['user_settings', path.join(world.home, 'claude-config', 'settings.json')],
  ].map(([source, filePath]) => ({
    session_id: 'session-config-change', transcript_path: world.transcript, cwd: world.owner,
    hook_event_name: 'ConfigChange', source, file_path: filePath,
  }));
  for (const event of events) {
    const r = w.runPython(world, hook, [], { input: JSON.stringify(event) });
    assert.equal(r.status, 2, `a ${event.source} change must be refused by the floor's ConfigChange hook (exit 2); got ${w.describe(r)}`);
    assert.ok(r.stderr.trim().length > 0, `the refusal of a ${event.source} change must give a reason; got ${w.describe(r)}`);
  }
  // Run from core's settings as Claude Code runs a ConfigChange hook.
  const settings = JSON.parse(fs.readFileSync(path.join(w.CORE, 'settings.json'), 'utf8'));
  const handlers = ((settings.hooks || {}).ConfigChange || []).flatMap((g) => g.hooks || []).filter((h) => h.type === 'command');
  assert.ok(handlers.length >= 1, `core's settings must run a ConfigChange hook; got ${JSON.stringify(settings.hooks && settings.hooks.ConfigChange)}`);
  const installed = s.layDownCore(world);
  for (const event of events) {
    const runs = handlers.map((h) => spawnSync('/bin/sh', ['-c', h.command], {
      input: JSON.stringify(event), cwd: world.owner, encoding: 'utf8', env: w.productEnv(world),
    }));
    assert.ok(runs.some((r) => r.status === 2), `core's settings must refuse a ${event.source} change through the installed hook under ${installed}; got ${runs.map((r) => w.describe({ ...r, error: '' })).join(' | ')}`);
  }
});

test('a resumed session the floor has never seen starts its job holding untrusted input and private things, while a resumed job it knows keeps what it had and a fresh start or a clear starts clean', { timeout: 60000 }, (t) => {
  const world = w.makeWorld();
  t.after(() => w.cleanUp(world));
  const send = (n) => tools.gmailSend(`someone${n}@example.com`, 'Saturday', 'The cake is ready.');
  const startSession = (sessionId, source) => {
    const r = s.recordSessionByHook(world, { sessionId, source });
    assert.equal(r.status, 0, `the SessionStart hook must let the session start (exit 0) for source ${source}; got ${w.describe(r)}`);
  };

  // Resumed under an id the ledger has never seen: refused as one job.
  startSession('session-resumed-unknown', 'resume');
  let r = w.attempt(world, 'session-resumed-unknown', send(1));
  w.assertBlocked(r, 'a send in a resumed job the floor cannot place');
  assert.match(r.stderr, /split/i, `a send in a resumed job the floor cannot place must be refused as one job; got ${w.describe(r)}`);
  w.ownerSays(world, 'session-resumed-unknown', 'yes');
  r = w.attempt(world, 'session-resumed-unknown', send(1));
  assert.match(r.stderr, /split/i, `the refusal must stand after a yes; got ${w.describe(r)}`);

  // Resumed under an id the ledger knows (a server restart brings the same
  // session back): the job keeps what it had, here nothing, so a send is asked.
  const known = 'session-resumed-known';
  startSession(known, 'startup');
  r = w.attempt(world, known, send(2));
  assert.ok(w.requestIdIn(r.stderr), `a first send in a fresh job must be asked; got ${w.describe(r)}`);
  startSession(known, 'resume');
  r = w.attempt(world, known, send(3));
  w.assertBlocked(r, 'a send after the same session resumed');
  assert.ok(w.requestIdIn(r.stderr), `a send after a known session resumed must be asked, with a request id; got ${w.describe(r)}`);
  assert.doesNotMatch(r.stderr, /split/i, `a send after a known session resumed must not be refused as one job; got ${w.describe(r)}`);

  // A fresh start and a clear start clean.
  for (const [sessionId, source] of [['session-fresh', 'startup'], ['session-cleared', 'clear']]) {
    startSession(sessionId, source);
    r = w.attempt(world, sessionId, send(4));
    w.assertBlocked(r, `a send in a job started by ${source}`);
    assert.ok(w.requestIdIn(r.stderr), `a send in a job started by ${source} must be asked; got ${w.describe(r)}`);
    assert.doesNotMatch(r.stderr, /split/i, `a job started by ${source} must start clean; got ${w.describe(r)}`);
  }
});

test('the SessionStart hook never removes the marks of a job: one holding untrusted input and private things keeps both through compact, resume, startup, clear and an unknown source under its own id', { timeout: 120000 }, (t) => {
  const world = w.makeWorld();
  t.after(() => w.cleanUp(world));
  const sessionId = 'session-marked';
  const send = tools.gmailSend('someone@example.com', 'Saturday', 'The cake is ready.');
  // Both marks, as round 1b gives them: the owner's profile read (private
  // things), then a web search (untrusted input).
  w.assertAllowed(w.attempt(world, sessionId, tools.read(path.join(world.owner, 'operator', 'profile.md'))), 'reading the owner profile');
  w.assertAllowed(w.attempt(world, sessionId, tools.webSearch('wholesale flour prices')), 'a web search');
  let r = w.attempt(world, sessionId, send);
  w.assertBlocked(r, 'premise: a send in a job holding both');
  assert.match(r.stderr, /split/i, `premise: a send in a job holding both must be refused as one job; got ${w.describe(r)}`);
  for (const source of ['compact', 'resume', 'startup', 'clear', 'a-source-the-hook-does-not-know']) {
    const h = s.recordSessionByHook(world, { sessionId, source });
    assert.equal(h.status, 0, `the SessionStart hook must let the session go on (exit 0) for source ${source}; got ${w.describe(h)}`);
    r = w.attempt(world, sessionId, send);
    w.assertBlocked(r, `a send after a SessionStart with source ${source} under the job's own id`);
    assert.match(r.stderr, /split/i, `after a SessionStart with source ${source} under its own id the job must keep both marks, so a send is refused as one job; got ${w.describe(r)}`);
  }
});

test('a session started and then resumed under the same id with nothing done is a job the floor has seen: a send in it is asked, not refused as one job', { timeout: 60000 }, (t) => {
  const world = w.makeWorld();
  t.after(() => w.cleanUp(world));
  const sessionId = 'session-quiet';
  for (const source of ['startup', 'resume']) {
    const h = s.recordSessionByHook(world, { sessionId, source });
    assert.equal(h.status, 0, `the SessionStart hook must let the session start (exit 0) for source ${source}; got ${w.describe(h)}`);
  }
  const r = w.attempt(world, sessionId, tools.gmailSend('someone@example.com', 'Saturday', 'The cake is ready.'));
  w.assertBlocked(r, 'a send in a quiet session after it resumed');
  assert.ok(w.requestIdIn(r.stderr), `a send in a session the floor saw start must be asked, with a request id; got ${w.describe(r)}`);
  assert.doesNotMatch(r.stderr, /split/i, `startup writes the job record, so the resumed job is one the floor has seen and must not be refused as one job; got ${w.describe(r)}`);
});

test('the SessionStart hook records the session id, its messaging socket and token in the Squire home and never in the owner folder, and core settings run it as Claude Code does', { timeout: 60000 }, async (t) => {
  const world = w.makeWorld();
  t.after(() => w.cleanUp(world));
  const inbox = await s.startInbox(world, 'session-a');
  t.after(() => inbox.stop());
  const r = await s.recordSessionFromInbox(world, inbox, { sessionId: 'session-recorded' });
  assert.equal(r.status, 0, `the SessionStart hook must let the session start; got ${w.describe(r)}`);
  assert.equal(r.stdout, '', `the SessionStart hook must add nothing to the session's context; it printed ${JSON.stringify(r.stdout)}`);
  const records = s.sessionRecords(world);
  assert.equal(records.length, 1, `one session record must be written in the Squire home (sessions/); got ${JSON.stringify(records)}`);
  const rec = records[0];
  assert.equal(rec.sessionId, 'session-recorded', 'the record must hold the session id');
  assert.equal(rec.socket, inbox.socket, 'the record must hold the messaging socket from CLAUDE_CODE_MESSAGING_SOCKET');
  assert.equal(rec.token, r.token, 'the record must hold the token from CLAUDE_CODE_MESSAGING_TOKEN');
  assert.equal(rec.pid, inbox.pid, 'the record must hold the session process, the one listening on the socket: the hook\'s parent');
  assert.equal(rec.socketInode, fs.statSync(inbox.socket).ino, 'the record must hold the socket\'s identity on disk (its inode)');
  assert.deepEqual(w.filesHolding([world.owner], r.token), [], 'nothing in the owner folder may hold the session token');

  // Core's settings run the installed hook at every SessionStart.
  const installed = s.layDownCore(world);
  const settings = JSON.parse(fs.readFileSync(path.join(installed, 'settings.json'), 'utf8'));
  const handlers = ((settings.hooks || {}).SessionStart || []).flatMap((g) => g.hooks || []).filter((h) => h.type === 'command');
  assert.ok(handlers.length >= 1, `core's settings must run a SessionStart hook; got ${JSON.stringify(settings.hooks && settings.hooks.SessionStart)}`);
  const event = { session_id: 'session-from-settings', transcript_path: world.transcript, cwd: world.owner, hook_event_name: 'SessionStart', source: 'startup' };
  // Run by the session's process, as Claude Code runs a command hook.
  for (const h of handlers) {
    await inbox.run({
      argv: ['/bin/sh', '-c', h.command], input: JSON.stringify(event), cwd: world.owner,
      env: w.productEnv(world, { CLAUDE_CODE_MESSAGING_SOCKET: inbox.socket, CLAUDE_CODE_MESSAGING_TOKEN: 'token-from-settings' }),
    });
  }
  const fromSettings = s.sessionRecords(world).find((x) => x.sessionId === 'session-from-settings');
  assert.ok(fromSettings && fromSettings.token === 'token-from-settings',
    `run from core's settings as Claude Code runs it, the installed SessionStart hook must record the session; records: ${JSON.stringify(s.sessionRecords(world).map((x) => x.sessionId))}`);
});

test('the session record names the process listening on the messaging socket, its start time in UTC as the system reports it, and the socket owner', { timeout: 60000 }, async (t) => {
  const world = w.makeWorld();
  t.after(() => w.cleanUp(world));
  const inbox = await s.startInbox(world, 'session-a');
  t.after(() => inbox.stop());
  const started = s.startTimeOf(inbox.pid);
  assert.ok(started, 'premise: the start of the session process can be read');
  // The same whatever the time zone the hook runs in.
  for (const [sessionId, env] of [['session-identity', {}], ['session-identity-elsewhere', { TZ: 'Etc/GMT-9' }]]) {
    const r = await s.recordSessionFromInbox(world, inbox, { sessionId, env });
    assert.equal(r.status, 0, `the SessionStart hook must let the session start; got ${w.describe(r)}`);
    const rec = s.sessionRecords(world).find((x) => x.sessionId === sessionId);
    assert.ok(rec, `the session must be recorded; records: ${JSON.stringify(s.sessionRecords(world).map((x) => x.sessionId))}`);
    assert.equal(rec.pid, inbox.pid, `the record must hold the process listening on the socket (the hook's parent); got ${rec.pid}`);
    assert.equal(rec.pidStartedAt, started,
      `the record must hold that process's start as ISO 8601 UTC to the second (pidStartedAt), whatever the hook's time zone (${env.TZ || 'unset'}); got ${JSON.stringify(rec.pidStartedAt)}`);
    assert.equal(rec.socketOwner, process.getuid(), `the record must hold the socket's owner (socketOwner, its uid); got ${JSON.stringify(rec.socketOwner)}`);
    assert.equal(rec.socketInode, fs.statSync(inbox.socket).ino, 'the record must hold the socket\'s inode');
  }
});

test('the SessionStart hook given a messaging socket path where no socket is and none appears writes no session record, prints nothing and lets the session start within its wait', { timeout: 60000 }, async (t) => {
  const world = w.makeWorld();
  t.after(() => w.cleanUp(world));
  // The session process; the path the hook is given holds no socket.
  const inbox = await s.startInbox(world, 'session-a');
  t.after(() => inbox.stop());
  const started = Date.now();
  const r = await s.recordSessionFromInbox(world, inbox, { sessionId: 'session-no-socket', socket: path.join(world.root, 's', 'never.sock') });
  const took = Date.now() - started;
  assert.equal(r.status, 0, `with no socket at the path the SessionStart hook must still let the session start (exit 0); got ${w.describe(r)}`);
  assert.equal(r.stdout, '', `the SessionStart hook must add nothing to the session's context; it printed ${JSON.stringify(r.stdout)}`);
  assert.ok(took <= 15000, `the hook must give up on a socket that never appears within its wait of at most 10 seconds, and 5 more; it took ${took} ms`);
  assert.deepEqual(s.sessionRecords(world), [], `with no socket there may be no session record; found ${JSON.stringify(s.sessionRecords(world))}`);
});

test('lay-down writes the three launchd agents that run the installed runner, wake-up router and backup from the Squire home, the runner kept alive and started at load, and loads none of them into the domain of whoever runs the tests', { timeout: 60000 }, (t) => {
  const world = w.makeWorld();
  t.after(() => w.cleanUp(world));
  const release = path.join(world.root, 'release');
  w.copyTree(w.CORE, release);
  const installed = s.layDownCore(world, release);
  const agents = s.launchAgents(world);
  // Three, not two: ADR-004 line 16 has the same lay-down write the nightly backup's agent, com.stravica.squire.backup.
  assert.equal(agents.length, 3, `lay-down must write three launchd agents under ~/Library/LaunchAgents; found ${agents.map((a) => path.basename(a.file)).join(', ') || 'none'}`);
  const labels = agents.map((a) => a.plist.Label);
  assert.equal(new Set(labels).size, 3, `each agent must have its own label; got ${labels}`);
  for (const a of agents) {
    assert.equal(path.basename(a.file), `${a.plist.Label}.plist`, `an agent's file must be named for its label; got ${path.basename(a.file)}`);
    assert.equal(a.plist.EnvironmentVariables && a.plist.EnvironmentVariables.SQUIRE_HOME, world.home, `${a.plist.Label} must name the Squire home (SQUIRE_HOME)`);
    assert.equal(a.plist.ProgramArguments[0], w.PYTHON, `${a.plist.Label} must run /usr/bin/python3`);
    for (const arg of a.plist.ProgramArguments) {
      assert.ok(!arg.startsWith(release) && !arg.startsWith(world.owner), `${a.plist.Label} must run installed copies, never the release or the owner folder; got ${arg}`);
    }
  }
  const runsTool = (a, name) => a.plist.ProgramArguments.some((arg) => arg === path.join(installed, 'tools', name));
  const runner = agents.find((a) => runsTool(a, 'runner.py'));
  assert.ok(runner, `one agent must run the installed runner (${path.join(installed, 'tools', 'runner.py')}); got ${JSON.stringify(agents.map((a) => a.plist.ProgramArguments))}`);
  assert.equal(runner.plist.RunAtLoad, true, 'the runner agent must start at load (RunAtLoad)');
  assert.equal(runner.plist.KeepAlive, true, 'the runner agent must be kept alive (KeepAlive)');
  const router = agents.find((a) => runsTool(a, 'wake-up.py'));
  assert.ok(router, `one agent must run the installed wake-up router (${path.join(installed, 'tools', 'wake-up.py')})`);
  assert.ok(router.plist.ProgramArguments.includes('--due'), `the wake-up agent must run the wake-ups due (--due); got ${router.plist.ProgramArguments}`);
  assert.ok(Number.isInteger(router.plist.StartInterval) && router.plist.StartInterval >= 1 && router.plist.StartInterval <= 120,
    `the wake-up agent must run at least every 120 seconds, so three retries a minute or more apart fit inside ten minutes; got ${router.plist.StartInterval}`);
  for (const label of labels) {
    assert.ok(!s.launchdHas(label), `lay-down in a test world, whose home is not this user's own, must not load ${label} into the launchd domain of whoever runs the tests`);
  }
});
