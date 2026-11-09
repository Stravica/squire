'use strict';

// Squire's set-up, at its own entry point: the app's executable, run as
// Finder runs it, on a Mac made of fakes (tests/fixtures/installer-world.js).
// The design record for set-up (ADR-004) fixes the windows by title, the step
// ids, the record set-up.json and the key words the cases read; the rest of
// the wording is the builder's.
//
// Three groups: set-up meeting a problem (explained, keeping what is done and
// the owner's things, resuming or repairing the one installation); a step
// whose result cannot be confirmed (run again from its start, never counted
// done); and the one yes (nothing installed before it, every piece named in
// it, nothing outside the list after it).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const w = require('../fixtures/squire-world.js');
const I = require('../fixtures/installer-world.js');

const { TITLES, STEPS } = I;
const FULL_RUN = 180000;

const noAdmin = 'staff everyone localaccounts _appserverusr';
const installCalls = (run) => I.callsOf(run, 'xcode-select', (c) => c.argv.includes('--install'));
const downloads = (run) => I.callsOf(run, 'curl');
const installerRuns = (run) => I.callsOf(run, 'claude-installer');
const authCalls = (run, verb) => I.callsOf(run, 'claude', (c) => c.argv[0] === 'auth' && c.argv[1] === verb);
const launcher = (iw) => path.join(iw.userHome, '.local', 'bin', 'claude');
const agentsDir = (iw) => path.join(iw.userHome, 'Library', 'LaunchAgents');
const doneWith = (step) => (iw) => I.doneSteps(iw).includes(step);
const asked = (run, title) => I.dialogsTitled(run, title).length > 0;

// One window with this title, holding every key word.
function assertWindow(run, title, words, what) {
  const shown = I.dialogsTitled(run, title);
  assert.ok(shown.length >= 1, `${what}: set-up must show "${title}"; got ${I.describeRun(run)}`);
  for (const word of words) {
    assert.match(shown[shown.length - 1].text, word, `${what}: "${title}" must say ${word}; it said: ${shown[shown.length - 1].text}`);
  }
}

// A refusal before any change: the window, the home folder exactly as it
// was (every entry, its bytes, times and inodes), nothing downloaded or
// installed, and set-up never got as far as the one yes.
function assertRefusedBeforeAnyChange(iw, before, run, words, what) {
  assertWindow(run, TITLES.cannot, words, what);
  assert.deepEqual(w.snapshotDifferences(before, w.snapshot(iw.userHome)), [],
    `${what}: set-up must change nothing in the home folder before the refusal`);
  assert.equal(downloads(run).length, 0, `${what}: nothing may be downloaded`);
  assert.equal(installCalls(run).length, 0, `${what}: Apple's tools must not be installed`);
  assert.ok(!asked(run, TITLES.setUp), `${what}: set-up must refuse before it asks for the one yes`);
}

// --------------------------------------------------------- before any change

test('set-up on a macOS older than 13 is refused before any change, naming macOS 13 and the way on', { timeout: 60000 }, async (t) => {
  const iw = I.makeInstallerWorld(t, { mac: { macos: '12.7.6' } });
  const before = w.snapshot(iw.userHome);
  const run = await I.runApp(iw);
  assertRefusedBeforeAnyChange(iw, before, run, [/macOS 13/, /System Settings/], 'macOS 12');
  assert.ok(!asked(run, TITLES.plan), 'macOS 12: the Mac check comes before the plan is asked');
});

test('set-up on a Mac with less than 4 GB of memory is refused before any change, naming 4 GB', { timeout: 60000 }, async (t) => {
  const iw = I.makeInstallerWorld(t, { mac: { memBytes: 2147483648 } });
  const before = w.snapshot(iw.userHome);
  const run = await I.runApp(iw);
  assertRefusedBeforeAnyChange(iw, before, run, [/4 GB/], '2 GB of memory');
});

test('set-up on a Mac without Apple\'s command line tools, for a user who cannot install them, is refused before any change and says to ask whoever administers the Mac', { timeout: 60000 }, async (t) => {
  const iw = I.makeInstallerWorld(t, { mac: { toolsPresent: false, groups: noAdmin } });
  const before = w.snapshot(iw.userHome);
  const run = await I.runApp(iw);
  assertRefusedBeforeAnyChange(iw, before, run, [/command line tools/i, /administ/i], 'no tools and no administrator');
});

test('a declared plan below Pro, or the plan window closed, stops set-up before any change, naming Pro', { timeout: 120000 }, async (t) => {
  for (const [answer, what] of [['Free', 'Free declared'], [{ cancel: true }, 'the plan window closed']]) {
    const iw = I.makeInstallerWorld(t, { mac: { answers: { [TITLES.plan]: answer } } });
    const before = w.snapshot(iw.userHome);
    const run = await I.runApp(iw);
    assert.ok(asked(run, TITLES.plan), `${what}: set-up must ask for the plan; got ${I.describeRun(run)}`);
    assertRefusedBeforeAnyChange(iw, before, run, [/Pro/], what);
  }
});

// ------------------------------------------------------------ the plan read

test('a plan found below Pro at sign-in stops set-up and leaves the home folder as set-up found it, signing Squire\'s config folder out, with Apple\'s tools never started', { timeout: 120000 }, async (t) => {
  const iw = I.makeInstallerWorld(t, { mac: { toolsPresent: false }, claude: { plan: 'free' } });
  const before = I.contentOf(iw.userHome);
  const run = await I.runApp(iw);
  assertWindow(run, TITLES.stopped, [/Pro/], 'a Free plan read at sign-in');
  assert.ok(authCalls(run, 'login').length >= 1, `the sign-in must have run before the plan read; got ${I.describeRun(run)}`);
  const logout = authCalls(run, 'logout');
  assert.ok(logout.length >= 1 && logout.every((c) => c.configDir === iw.configDir),
    `set-up must sign out of Squire's config folder (and only that one); got ${JSON.stringify(logout)}`);
  assert.equal(installCalls(run).length, 0, 'the plan read comes before Apple\'s tools: they must never be started');
  assert.deepEqual(I.contentOf(iw.userHome), before,
    'after a plan below Pro, the home folder must be as set-up found it: Claude Code, the Squire home, the owner\'s folder and every agent set-up added removed');
});

test('a plan found below Pro at sign-in never touches a Claude Code the owner already had', { timeout: 120000 }, async (t) => {
  const iw = I.makeInstallerWorld(t, { claude: { plan: 'free' } });
  const places = I.preinstallClaudeCode(iw);
  const version = path.join(iw.userHome, '.local', 'share', 'claude', 'versions', I.CLAUDE_VERSION);
  const inode = fs.statSync(version).ino;
  const before = I.contentOf(iw.userHome);
  const run = await I.runApp(iw);
  assertWindow(run, TITLES.stopped, [/Pro/], 'a Free plan read at sign-in, with Claude Code already there');
  assert.equal(downloads(run).length, 0, 'Claude Code already there must not be downloaded again');
  assert.deepEqual(I.claudeCodePlaces(iw), places, 'the owner\'s Claude Code, its folders and its own ~/.claude and ~/.claude.json must be untouched');
  assert.equal(fs.statSync(version).ino, inode, 'the owner\'s Claude Code must be the same file, never removed and laid again');
  assert.ok(authCalls(run, 'logout').every((c) => c.configDir === iw.configDir), 'only Squire\'s config folder may be signed out');
  assert.deepEqual(I.contentOf(iw.userHome), before, 'the home folder must be as set-up found it');
});

for (const [plan, answer, outcome] of [
  ['enterprise_plus', 'button returned:Continue', 'goes on'],
  ['missing', 'button returned:Stop', 'stops'],
  ['unreadable', 'button returned:Stop', 'stops'],
]) {
  test(`a plan Squire cannot confirm (${plan === 'missing' ? 'no plan field' : plan === 'unreadable' ? 'an answer it cannot read' : 'a value it does not know'}) is asked of the owner, and ${answer.split(':')[1]} ${outcome}`, { timeout: 120000 }, async (t) => {
    const iw = I.makeInstallerWorld(t, { claude: { plan }, mac: { answers: { [TITLES.askPlan]: answer } } });
    const before = I.contentOf(iw.userHome);
    const run = await I.runApp(iw, { killWhen: doneWith('signIn') });
    assertWindow(run, TITLES.askPlan, [/Squire could not confirm your plan; it needs Pro or above\. Continue\?/], `plan ${plan}`);
    if (outcome === 'goes on') {
      assert.ok(I.doneSteps(iw).includes('signIn'), `Continue must go on with the sign-in recorded done; got ${I.describeRun(run)}`);
    } else {
      assertWindow(run, TITLES.stopped, [/Pro/], `plan ${plan}, Stop`);
      assert.deepEqual(I.contentOf(iw.userHome), before, `plan ${plan}, Stop: the home folder must be as set-up found it`);
    }
  });
}

test('the plan read comes before Apple\'s tools and everything else system-wide', { timeout: 120000 }, async (t) => {
  const iw = I.makeInstallerWorld(t, { mac: { toolsPresent: false } });
  const run = await I.runApp(iw, { killWhen: doneWith('appleTools') });
  const calls = run.calls;
  const planRead = calls.findIndex((c) => c.cmd === 'claude' && c.argv[0] === 'auth' && c.argv[1] === 'status');
  const tools = calls.findIndex((c) => c.cmd === 'xcode-select' && c.argv.includes('--install'));
  assert.ok(planRead >= 0, `set-up must read the plan; got ${I.describeRun(run)}`);
  assert.ok(tools > planRead, `Apple's tools must be started only after the plan read; calls: ${calls.map((c) => `${c.cmd} ${c.argv.join(' ')}`).join(' | ')}`);
  assert.ok(!fs.existsSync(path.join(iw.squireHome, 'core')), 'core must not be laid down before Apple\'s tools are present');
});

// ---------------------------------------------------- the listed failures

for (const [mode, what] of [['fail', 'a failed download'], ['timeout', 'a timed-out download'], ['interrupted', 'an interrupted download']]) {
  test(`${what} runs no installer, leaves no half-finished installation, and running set-up again resumes the one installation`, { timeout: 180000 }, async (t) => {
    const iw = I.makeInstallerWorld(t, { mac: { download: mode } });
    const run = await I.runApp(iw);
    assertWindow(run, TITLES.paused, [/download/i], what);
    assert.equal(installerRuns(run).length, 0, `${what}: no installer may run`);
    assert.ok(!fs.existsSync(launcher(iw)) && !fs.existsSync(path.join(iw.userHome, '.local', 'share', 'claude')),
      `${what}: no launcher and no versions folder may be left`);
    assert.ok(I.doneSteps(iw).includes('yes') && !I.doneSteps(iw).includes('claudeCode'),
      `${what}: the one yes stays done and Claude Code is not recorded done; record ${JSON.stringify(I.readRecord(iw))}`);
    const curl = downloads(run)[0];
    const bound = curl.argv.indexOf('--max-time') >= 0 ? curl.argv[curl.argv.indexOf('--max-time') + 1] : curl.argv[curl.argv.indexOf('-m') + 1];
    assert.ok(Number(bound) > 0 && Number(bound) <= 600, `the download must be bounded at 10 minutes; curl was called with ${curl.argv.join(' ')}`);
    iw.set({ download: 'ok' });
    const again = await I.runApp(iw, { killWhen: doneWith('signIn') });
    assert.ok(!asked(again, TITLES.plan) && !asked(again, TITLES.setUp), `the re-run must not ask the plan or the yes again; got ${I.describeRun(again)}`);
    assert.equal(installerRuns(again).length, 1, `the re-run must install Claude Code once; got ${I.describeRun(again)}`);
    assert.ok(I.doneSteps(iw).includes('claudeCode'), 'the re-run must record Claude Code done');
  });
}

test('a second set-up started while one runs exits at once, saying set-up is already running, and changes nothing', { timeout: 120000 }, async (t) => {
  const iw = I.makeInstallerWorld(t, { mac: { answers: { [TITLES.name]: { hang: true } } } });
  const first = I.startApp(iw);
  t.after(() => first.kill());
  const waiting = await require('../fixtures/session-world.js').waitFor(
    () => I.readJsonLines(iw.dialogsFile).some((d) => d.title === TITLES.name), 90000, 200);
  assert.ok(waiting, 'the first set-up must reach the naming window');
  const before = w.snapshot(iw.userHome);
  iw.set({ answers: {} });
  const second = await I.runApp(iw, { launchd: false, timeout: 30000 });
  assertWindow(second, TITLES.cannot, [/already running/i], 'a second set-up');
  assert.ok(!second.timedOut, 'the second set-up must exit at once');
  assert.deepEqual(w.snapshotDifferences(before, w.snapshot(iw.userHome)), [], 'the second set-up must change nothing');
  await first.kill();
});

for (const [mode, what] of [['cancel', 'a cancelled sign-in'], ['timeout', 'a timed-out sign-in'], ['offline', 'a sign-in with no internet']]) {
  test(`${what} is explained, keeps Claude Code and the steps done, and running set-up again resumes at the sign-in without reinstalling`, { timeout: 180000 }, async (t) => {
    const iw = I.makeInstallerWorld(t, { claude: { signIn: mode } });
    const run = await I.runApp(iw);
    assertWindow(run, TITLES.paused, [/sign/i], what);
    assert.deepEqual(I.doneSteps(iw), ['yes', 'claudeCode'], `${what}: the yes and Claude Code stay done, the sign-in is not`);
    assert.ok(fs.existsSync(launcher(iw)), `${what}: Claude Code must be kept`);
    iw.setClaude({ signIn: 'ok' });
    const again = await I.runApp(iw, { killWhen: doneWith('signIn') });
    assert.equal(downloads(again).length, 0, `the re-run must not download Claude Code again; got ${I.describeRun(again)}`);
    assert.ok(authCalls(again, 'login').length === 1 && I.doneSteps(iw).includes('signIn'), 'the re-run must sign in once and record it done');
    assert.ok(I.signedInto(iw), 'the sign-in must land in Squire\'s config folder');
  });
}

test('with no phone to hand set-up still completes: the phone step is answered Later and every step is recorded done', { timeout: FULL_RUN }, async (t) => {
  const iw = I.makeInstallerWorld(t, { mac: { answers: { [TITLES.phone]: 'button returned:Later' } } });
  const run = await I.runApp(iw);
  assert.deepEqual(I.doneSteps(iw), STEPS, `every step must be recorded done, in order; got ${I.describeRun(run)}`);
  assert.ok(asked(run, TITLES.ready), 'set-up must end on its ready window');
  assert.ok(I.callsOf(run, 'open').some((c) => c.argv.includes('https://claude.ai/code')), 'the first conversation opens claude.ai/code');
});

test('with the laptop closed during the first conversation, the earlier steps stay done, and running set-up again finishes only the last step', { timeout: FULL_RUN * 2 }, async (t) => {
  const iw = I.makeInstallerWorld(t);
  const sessions = path.join(iw.squireHome, 'sessions');
  const run = await I.runApp(iw, { killWhen: () => fs.existsSync(sessions) && fs.readdirSync(sessions).length > 0 });
  assert.ok(run.killed, `set-up must reach the first conversation; got ${I.describeRun(run)}`);
  assert.deepEqual(I.doneSteps(iw).slice(0, STEPS.length - 1), STEPS.slice(0, -1), 'every step before the first conversation must stay done');
  const again = await I.runApp(iw);
  for (const title of [TITLES.plan, TITLES.setUp, TITLES.name, TITLES.personality, TITLES.phone]) {
    assert.ok(!asked(again, title), `the re-run must not ask "${title}" again; got ${I.describeRun(again)}`);
  }
  assert.deepEqual(I.doneSteps(iw), STEPS, 'the re-run must finish the first conversation');
  assert.equal(new Set(iw.inner.sessions().map((s) => s.sessionId)).size, 1, 'the first conversation resumes in the one session');
});

// ------------------------------------------------------ the construction

test('a step killed part way is not recorded done and runs again from its start on the next run', { timeout: 180000 }, async (t) => {
  const iw = I.makeInstallerWorld(t, { mac: { installer: 'slow' } });
  const run = await I.runApp(iw, { killWhen: (x) => I.readJsonLines(x.callsFile).some((c) => c.cmd === 'claude-installer') });
  assert.ok(run.killed, `the test must kill set-up while Claude Code installs; got ${I.describeRun(run)}`);
  assert.ok(!I.doneSteps(iw).includes('claudeCode'), 'a step killed part way must not be recorded done');
  iw.set({ installer: 'ok' });
  const again = await I.runApp(iw, { killWhen: doneWith('signIn') });
  assert.equal(downloads(again).length, 1, `the step must run again from its start, the download included; got ${I.describeRun(again)}`);
  assert.ok(I.doneSteps(iw).includes('claudeCode'), 'the re-run must record Claude Code done');
});

test('a re-run resumes at the first step not recorded done, and runs again a step recorded done whose end state no longer holds', { timeout: 180000 }, async (t) => {
  const iw = I.makeInstallerWorld(t);
  await I.runApp(iw, { killWhen: doneWith('signIn') });
  assert.deepEqual(I.doneSteps(iw).slice(0, 3), ['yes', 'claudeCode', 'signIn'], 'the first run must record the yes, Claude Code and the sign-in');
  fs.rmSync(launcher(iw));
  const again = await I.runApp(iw, { killWhen: doneWith('appleTools') });
  assert.ok(!asked(again, TITLES.plan) && !asked(again, TITLES.setUp), `the re-run must not ask the plan or the yes again; got ${I.describeRun(again)}`);
  assert.equal(downloads(again).length, 1, 'Claude Code, recorded done but its launcher gone, must be installed again');
  assert.ok(fs.existsSync(launcher(iw)), 'the launcher must be back');
});

test('running set-up again over a finished set-up repairs what no longer holds and keeps the owner\'s folder and settings', { timeout: FULL_RUN * 2 }, async (t) => {
  const iw = I.makeInstallerWorld(t);
  const run = await I.runApp(iw);
  assert.deepEqual(I.doneSteps(iw), STEPS, `the first set-up must finish; got ${I.describeRun(run)}`);
  const backupAgent = path.join(agentsDir(iw), 'com.stravica.squire.backup.plist');
  fs.rmSync(backupAgent);
  fs.writeFileSync(path.join(iw.ownerFolder, 'notes.md'), 'Ask the plumber about Thursday.\n');
  const ownerConfig = { ...I.ownerConfig(iw), wakeUps: [{ id: 'morning', at: '07:30', text: 'Good morning' }] };
  fs.writeFileSync(path.join(iw.ownerFolder, 'squire.json'), JSON.stringify(ownerConfig, null, 2) + '\n');
  const owner = I.contentOf(iw.ownerFolder);
  const again = await I.runApp(iw);
  for (const title of [TITLES.plan, TITLES.setUp, TITLES.name, TITLES.personality]) {
    assert.ok(!asked(again, title), `the re-run must not ask "${title}" again; got ${I.describeRun(again)}`);
  }
  assert.ok(fs.existsSync(backupAgent), 'the re-run must write the backup agent again');
  const kept = I.contentOf(iw.ownerFolder);
  for (const rel of ['notes.md', 'squire.json']) assert.equal(kept[rel], owner[rel], `the owner's ${rel} must be kept as it was`);
  assert.deepEqual(I.ownerConfig(iw), ownerConfig, 'the owner\'s settings must be kept');
});

test('with the sign-in gone, the health line says to open Squire\'s installer to sign in again, and running set-up again resumes at the sign-in', { timeout: FULL_RUN * 2 }, async (t) => {
  const iw = I.makeInstallerWorld(t);
  const run = await I.runApp(iw);
  assert.deepEqual(I.doneSteps(iw), STEPS, `the first set-up must finish; got ${I.describeRun(run)}`);
  const signedOut = require('node:child_process').spawnSync(launcher(iw), ['auth', 'logout'],
    { env: { ...I.appEnv(iw), CLAUDE_CONFIG_DIR: iw.configDir }, encoding: 'utf8' });
  assert.equal(signedOut.status, 0, 'the world signs Squire\'s config folder out');
  const h = I.healthOf(iw);
  assert.match(h.stdout, /sign in again/i, `the health check must say to sign in again; got ${h.stdout} ${h.stderr}`);
  assert.match(h.stdout, /installer/i, `the health check must say to open Squire's installer; got ${h.stdout}`);
  const again = await I.runApp(iw, { killWhen: doneWith('signIn') });
  assert.equal(authCalls(again, 'login').length, 1, `the re-run must sign in again; got ${I.describeRun(again)}`);
  assert.equal(downloads(again).length, 0, 'the re-run must not reinstall Claude Code');
  assert.ok(I.signedInto(iw), 'the sign-in must land in Squire\'s config folder');
});

test('when Claude Code\'s server exits before any session, the runner records its reason, the health check prints it, and set-up\'s last step names it', { timeout: FULL_RUN * 2 }, async (t) => {
  const refusal = 'Unable to determine your organization for Remote Control eligibility';
  const iw = I.makeInstallerWorld(t, { claude: { server: 'refuse' } });
  const run = await I.runApp(iw);
  assertWindow(run, TITLES.paused, [new RegExp(refusal)], 'a server refused before any session');
  assert.ok(!I.doneSteps(iw).includes('firstConversation'), 'the first conversation must not be recorded done');
  const problems = JSON.parse(fs.readFileSync(path.join(iw.squireHome, 'runner.json'), 'utf8')).problems || [];
  assert.ok(problems.some((p) => p.includes(refusal)), `runner.json must hold the server's reason; got ${JSON.stringify(problems)}`);
  const h = I.healthOf(iw);
  assert.ok(h.stdout.includes(refusal), `the health check must print the server's reason; got ${h.stdout}`);
});

// ------------------------------------------- a step it cannot confirm

test('a Claude Code whose launcher is there but whose version is incomplete is not counted done, and is installed again from its start on every run until it answers', { timeout: 180000 }, async (t) => {
  const iw = I.makeInstallerWorld(t, { mac: { installer: 'incomplete' } });
  const run = await I.runApp(iw);
  assert.ok(fs.lstatSync(launcher(iw)).isSymbolicLink(), 'the world leaves a launcher behind');
  assert.ok(!I.doneSteps(iw).includes('claudeCode'), `Claude Code that does not answer --version must not be recorded done; got ${I.describeRun(run)}`);
  assert.equal(authCalls(run, 'login').length, 0, 'set-up must not go on to the sign-in');
  const second = await I.runApp(iw);
  assert.equal(downloads(second).length, 1, `a re-run must install it again from its start, never skip it; got ${I.describeRun(second)}`);
  assert.ok(!I.doneSteps(iw).includes('claudeCode'), 'still incomplete: still not done');
  iw.set({ installer: 'ok' });
  await I.runApp(iw, { killWhen: doneWith('signIn') });
  assert.ok(I.doneSteps(iw).includes('claudeCode'), 'once it answers, Claude Code is recorded done');
});

test('Apple\'s tools still reporting that they install are not counted done, and a re-run runs that step again from its start', { timeout: 240000 }, async (t) => {
  const iw = I.makeInstallerWorld(t, { mac: { toolsPresent: false, toolsInstall: 'stillInstalling' } });
  const polledAfterInstall = (n) => (x) => {
    const calls = I.readJsonLines(x.callsFile).filter((c) => c.cmd === 'xcode-select');
    const installs = calls.filter((c) => c.argv.includes('--install')).length;
    const last = calls.map((c) => c.argv.includes('--install')).lastIndexOf(true);
    return installs >= n && calls.slice(last + 1).some((c) => c.argv.includes('-p') || c.argv.includes('--print-path'));
  };
  const run = await I.runApp(iw, { killWhen: polledAfterInstall(1) });
  assert.ok(run.killed, `set-up must start Apple's tools and look for them; got ${I.describeRun(run)}`);
  assert.ok(!I.doneSteps(iw).includes('appleTools'), 'Apple\'s tools still installing must not be recorded done');
  const again = await I.runApp(iw, { killWhen: polledAfterInstall(2) });
  assert.equal(installCalls(again).length, 1, `the re-run must start Apple's tools again from its start, never skip the step; got ${I.describeRun(again)}`);
  assert.ok(!I.doneSteps(iw).includes('appleTools'), 'still installing: still not done');
});

// ------------------------------------------------------------ the one yes

test('before the one yes nothing is installed, and Not now or a closed window installs nothing and writes nothing', { timeout: 120000 }, async (t) => {
  for (const [answer, what] of [['button returned:Not now', 'Not now'], [{ cancel: true }, 'the window closed']]) {
    const iw = I.makeInstallerWorld(t, { mac: { toolsPresent: false, answers: { [TITLES.setUp]: answer } } });
    const before = w.snapshot(iw.userHome);
    const run = await I.runApp(iw);
    assert.equal(I.dialogsTitled(run, TITLES.setUp).length, 1, `${what}: set-up must ask the one yes once; got ${I.describeRun(run)}`);
    assert.equal(downloads(run).length + installerRuns(run).length + installCalls(run).length, 0, `${what}: nothing may be installed`);
    assert.deepEqual(w.snapshotDifferences(before, w.snapshot(iw.userHome)), [], `${what}: nothing may be written in the home folder`);
  }
});

test('the one yes names every piece set-up adds: Claude Code with its own updates, Apple\'s tools with the administrator\'s password prompt, Squire, and each background job', { timeout: 60000 }, async (t) => {
  const iw = I.makeInstallerWorld(t, { mac: { toolsPresent: false, answers: { [TITLES.setUp]: 'button returned:Not now' } } });
  const run = await I.runApp(iw);
  assertWindow(run, TITLES.setUp, [/Claude Code/, /updat/i, /command line tools/i, /password/i, /Squire/, /session/i, /wake-up/i, /backup/i],
    'the one yes');
});

test('after the one yes nothing outside the named list is installed', { timeout: FULL_RUN }, async (t) => {
  const iw = I.makeInstallerWorld(t, { mac: { toolsPresent: false } });
  const before = I.contentOf(iw.userHome);
  const run = await I.runApp(iw);
  assert.deepEqual(I.doneSteps(iw), STEPS, `set-up must finish; got ${I.describeRun(run)}`);
  assert.equal(I.dialogsTitled(run, TITLES.setUp).length, 1, 'one yes, asked once');
  assert.deepEqual(downloads(run).map((c) => c.url), [I.INSTALL_URL], 'the one download is Claude Code\'s installer');
  assert.equal(installerRuns(run).length, 1, 'Claude Code\'s installer runs once');
  assert.equal(installCalls(run).length, 1, 'Apple\'s tools are started once');
  const allowed = [/^Library\/Application Support\/Squire(\/|$)/, /^Squire(\/|$)/, /^\.claude(\/|$)/, /^\.claude\.json$/,
    /^\.local$/, /^\.local\/(bin|share|state)$/, /^\.local\/bin\/claude$/, /^\.local\/(share|state)\/claude(\/|$)/, /^\.cache$/, /^\.cache\/claude(\/|$)/,
    /^Library\/LaunchAgents$/, /^Library\/LaunchAgents\/com\.stravica\.squire\.(runner|wake-ups|backup)\.plist$/];
  const added = Object.keys(I.contentOf(iw.userHome)).filter((rel) => !(rel in before));
  const outside = added.filter((rel) => !allowed.some((re) => re.test(rel)));
  assert.deepEqual(outside, [], 'set-up must add nothing outside Claude Code, Squire, its folder and its three background jobs');
});
