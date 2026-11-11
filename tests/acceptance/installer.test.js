'use strict';

// Squire's set-up, at its own entry point: the app's executable, run as
// Finder runs it, on a Mac made of fakes (tests/fixtures/installer-world.js).
// The design record for set-up (ADR-004) fixes the windows by title, the step
// ids, the record set-up.json and the key words the cases read; the rest of
// the wording is the builder's.
//
// Groups: set-up meeting a problem (explained, keeping what is done and the
// owner's things, resuming or repairing the one installation); a step whose
// result cannot be confirmed (run again from its start, never counted done);
// the one yes (nothing installed before it, every piece named in it, nothing
// outside the list after it); the Mac's commands only from the system
// folders; the undo, the record and the lock; the owner's folder; a Mac fact
// set-up cannot read; and signing in again before the sign-in ends.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const w = require('../fixtures/squire-world.js');
const s = require('../fixtures/session-world.js');
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

test("set-up on a Mac without Apple's command line tools, for a user who cannot install them, is refused before any change and says to ask whoever administers the Mac", { timeout: 60000 }, async (t) => {
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

test("a plan found below Pro at sign-in stops set-up and leaves the home folder as set-up found it, signing Squire's config folder out, with Apple's tools never started", { timeout: 120000 }, async (t) => {
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

// A plan set-up cannot confirm, asked of the owner, answered as given.
function askedPlan(plan, answer, outcome) {
  return async (t) => {
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
  };
}

test('a plan Squire cannot confirm (a value it does not know) is asked of the owner, and Continue goes on', { timeout: 120000 },
  askedPlan('enterprise_plus', 'button returned:Continue', 'goes on'));
test('a plan Squire cannot confirm (no plan field) is asked of the owner, and Stop stops', { timeout: 120000 },
  askedPlan('missing', 'button returned:Stop', 'stops'));
test('a plan Squire cannot confirm (an answer it cannot read) is asked of the owner, and Stop stops', { timeout: 120000 },
  askedPlan('unreadable', 'button returned:Stop', 'stops'));

test("the plan read comes before Apple's tools and everything else system-wide", { timeout: 120000 }, async (t) => {
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

// A download that does not finish, then set-up run again.
function failedDownload(mode, what) {
  return async (t) => {
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
  };
}

test('a failed download runs no installer, leaves no half-finished installation, and running set-up again resumes the one installation', { timeout: 180000 },
  failedDownload('fail', 'a failed download'));
test('a timed-out download runs no installer, leaves no half-finished installation, and running set-up again resumes the one installation', { timeout: 180000 },
  failedDownload('timeout', 'a timed-out download'));
test('an interrupted download runs no installer, leaves no half-finished installation, and running set-up again resumes the one installation', { timeout: 180000 },
  failedDownload('interrupted', 'an interrupted download'));

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

// A sign-in that does not finish, then set-up run again.
function failedSignIn(mode, what) {
  return async (t) => {
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
  };
}

test('a cancelled sign-in is explained, keeps Claude Code and the steps done, and running set-up again resumes at the sign-in without reinstalling', { timeout: 180000 },
  failedSignIn('cancel', 'a cancelled sign-in'));
test('a timed-out sign-in is explained, keeps Claude Code and the steps done, and running set-up again resumes at the sign-in without reinstalling', { timeout: 180000 },
  failedSignIn('timeout', 'a timed-out sign-in'));
test('a sign-in with no internet is explained, keeps Claude Code and the steps done, and running set-up again resumes at the sign-in without reinstalling', { timeout: 180000 },
  failedSignIn('offline', 'a sign-in with no internet'));

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

test("running set-up again over a finished set-up repairs what no longer holds and keeps the owner's folder and settings", { timeout: FULL_RUN * 2 }, async (t) => {
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

// Squire's runner restarted as launchd restarts it: the running one asked to
// stop, then its agent's program started again.
async function restartRunner(iw) {
  for (const r of iw.runners) await r.stop();
  const runner = I.startRunnerFromPlist(iw);
  assert.ok(runner, 'the runner\'s agent must be there to start it again');
  return runner;
}

// The session processes the fake Claude Code started that are still running.
const liveSessions = (iw) => iw.inner.sessions().filter((x) => !w.processGone(x.pid));

const runnerProblems = (iw) => {
  try { return JSON.stringify(JSON.parse(fs.readFileSync(path.join(iw.squireHome, 'runner.json'), 'utf8')).problems); } catch (e) { return '(no runner.json)'; }
};

test("set-up opened again after it finished, pausing on the owner's squire.json, leaves the running session untouched, and a restarted runner has one session running again within two minutes", { timeout: FULL_RUN * 4 }, async (t) => {
  const iw = I.makeInstallerWorld(t);
  const run = await I.runApp(iw);
  assert.deepEqual(I.doneSteps(iw), STEPS, `the first set-up must finish, its first conversation recorded done; got ${I.describeRun(run)}`);
  assert.equal(liveSessions(iw).length, 1, 'once set-up is done, one session must be running');
  // The owner's settings stop parsing. With set-up not opened again, a
  // restarted runner has its session back.
  fs.writeFileSync(path.join(iw.ownerFolder, 'squire.json'), '{"wakeUps": [{"at": "07:30"\n');
  const seen = iw.inner.sessions().length;
  await restartRunner(iw);
  const back = await s.waitFor(() => iw.inner.sessions().length > seen && liveSessions(iw).length === 1, 120000, 500);
  assert.ok(back, `with set-up not opened again, a restarted runner must have one session running within two minutes; runner.json says ${runnerProblems(iw)}`);
  const running = liveSessions(iw)[0];
  const started = iw.inner.sessions().length;
  // Set-up opened again pauses at the owner's squire.json.
  const again = await I.runApp(iw);
  assertWindow(again, TITLES.paused, [/squire\.json/], 'set-up opened again over an owner\'s squire.json that does not parse');
  // A few of the runner's ticks after set-up has paused.
  await s.sleep(5000);
  assert.ok(!w.processGone(running.pid) && iw.inner.sessions().length === started,
    `set-up opened again after it finished must leave the running session untouched: the same session process running and no other started; sessions since: ${JSON.stringify(iw.inner.sessions().slice(started - 1).map((x) => ({ pid: x.pid, alive: !w.processGone(x.pid) })))}`);
  await restartRunner(iw);
  const restarted = await s.waitFor(() => iw.inner.sessions().length > started && liveSessions(iw).length === 1, 120000, 500);
  assert.ok(restarted, `after set-up was opened again and paused, a restarted runner must have one session running within two minutes; runner.json says ${runnerProblems(iw)}`);
});

test("with the sign-in gone, the health line says to open Squire's installer to sign in again, and running set-up again resumes at the sign-in", { timeout: FULL_RUN * 2 }, async (t) => {
  const iw = I.makeInstallerWorld(t);
  const run = await I.runApp(iw);
  assert.deepEqual(I.doneSteps(iw), STEPS, `the first set-up must finish; got ${I.describeRun(run)}`);
  const signedOut = require('node:child_process').spawnSync(launcher(iw), ['auth', 'logout'],
    { env: { ...I.appEnv(iw), CLAUDE_CONFIG_DIR: iw.configDir }, encoding: 'utf8' });
  assert.equal(signedOut.status, 0, 'the world signs Squire\'s config folder out');
  const h = I.healthOf(iw);
  assert.match(h.stdout, /sign in again/i, `the health check must say to sign in again; got ${h.stdout} ${h.stderr}`);
  assert.match(h.stdout, /installer/i, `the health check must say to open Squire's installer; got ${h.stdout}`);
  // The sign-in is already in the record, so the re-run is let finish: it repairs the one step whose end state is gone.
  const again = await I.runApp(iw);
  assert.equal(authCalls(again, 'login').length, 1, `the re-run must sign in again; got ${I.describeRun(again)}`);
  assert.equal(downloads(again).length, 0, 'the re-run must not reinstall Claude Code');
  assert.ok(I.signedInto(iw), 'the sign-in must land in Squire\'s config folder');
});

test("when Claude Code's server exits before any session, the runner records its reason, the health check prints it, and set-up's last step names it", { timeout: FULL_RUN * 2 }, async (t) => {
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

test("Apple's tools still reporting that they install are not counted done, and a re-run runs that step again from its start", { timeout: 240000 }, async (t) => {
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

test("the one yes names every piece set-up adds: Claude Code with its own updates, Apple's tools with the administrator's password prompt, Squire, and each background job", { timeout: 60000 }, async (t) => {
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
    /^Library\/LaunchAgents$/, /^Library\/LaunchAgents\/com\.stravica\.squire\.(runner|wake-ups|backup)\.plist$/,
    /^Applications($|\/Squire Update\.app(\/|$))/];
  const added = Object.keys(I.contentOf(iw.userHome)).filter((rel) => !(rel in before));
  const outside = added.filter((rel) => !allowed.some((re) => re.test(rel)));
  assert.deepEqual(outside, [], 'set-up must add nothing outside Claude Code, Squire, its folder and its three background jobs');
});

// ------------------------------------- the Mac's commands, system folders only

const TOKENS = { ANTHROPIC_API_KEY: 'sk-ant-test-not-a-key', CLAUDE_CODE_OAUTH_TOKEN: 'oauth-test-not-a-token', ANTHROPIC_AUTH_TOKEN: 'auth-test-not-a-token' };

test("a hostile sw_vers first on the PATH the app is opened with is never called: the Mac check reads the system's own answer and macOS 12 is refused", { timeout: 60000 }, async (t) => {
  const iw = I.makeInstallerWorld(t, { mac: { macos: '12.7.6' } });
  I.hostileCommands(iw);
  const before = w.snapshot(iw.userHome);
  const run = await I.runApp(iw);
  assertRefusedBeforeAnyChange(iw, before, run, [/macOS 13/], 'macOS 12 with a hostile sw_vers answering 26');
  assert.deepEqual(I.hostileCalls(iw), [], 'no command on the inherited PATH may be called');
});

test("a hostile osascript and curl first on the PATH the app is opened with are never called, the one yes is asked through the system's own windows, and the token variables the app is opened with reach no claude call", { timeout: 120000 }, async (t) => {
  const iw = I.makeInstallerWorld(t);
  I.hostileCommands(iw);
  const run = await I.runApp(iw, { env: TOKENS, killWhen: doneWith('signIn') });
  assert.ok(I.doneSteps(iw).includes('signIn'), `set-up must get as far as the sign-in; got ${I.describeRun(run)}`);
  assert.deepEqual(I.hostileCalls(iw), [], 'no command on the inherited PATH may be called: not its osascript, not its curl');
  assert.ok(!fs.existsSync(iw.hostileMarker), 'the installer the hostile curl serves must never run');
  assert.equal(I.dialogsTitled(run, TITLES.setUp).length, 1, 'the one yes must be asked through the system\'s own osascript');
  assert.equal(installerRuns(run).length, 1, 'Claude Code\'s installer must come from the system\'s own download');
  const claude = I.callsOf(run, 'claude');
  assert.ok(claude.length >= 1, 'set-up must call Claude Code');
  for (const c of claude) {
    const leaked = Object.keys(TOKENS).filter((n) => (c.envNames || []).includes(n));
    assert.deepEqual(leaked, [], `claude ${c.argv.join(' ')} must run in an environment built from nothing; it was given ${leaked.join(', ')}`);
  }
});

// ------------------------------------------------- the undo, every byte

// Files laid under the world's home before set-up runs.
function put(iw, rel, data, mode = 0o644) {
  const file = path.join(iw.userHome, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, data);
  fs.chmodSync(file, mode);
  return file;
}

test("a plan found below Pro over a partial install of Claude Code already there leaves every byte that was there as it was, restores what the installer changed and takes away everything set-up added", { timeout: 120000 }, async (t) => {
  const iw = I.makeInstallerWorld(t, { claude: { plan: 'free' } });
  put(iw, '.claude.json', JSON.stringify({ numStartups: 4, projects: { [path.join(iw.userHome, 'notes')]: { allowedTools: [] } } }, null, 2) + '\n');
  put(iw, '.claude/settings.json', '{"theme": "dark"}\n');
  const partial = put(iw, `.local/share/claude/versions/2.1.300`, Buffer.alloc(200, 0), 0o755);
  fs.mkdirSync(path.join(iw.userHome, '.local', 'bin'), { recursive: true });
  fs.symlinkSync(partial, launcher(iw));
  const before = I.contentOf(iw.userHome);
  const run = await I.runApp(iw);
  assert.equal(installerRuns(run).length, 1, `a launcher that does not answer is not Claude Code found: set-up must install it; got ${I.describeRun(run)}`);
  assertWindow(run, TITLES.stopped, [/Pro/, /as set-up found it/i], 'a Free plan read over a partial install');
  assert.deepEqual(I.contentOf(iw.userHome), before,
    'every byte that was there must survive (~/.claude.json and the launcher restored as they were, the partial version kept) and every byte set-up added must go');
});

test("a plan found below Pro over a ~/.claude.json or a ~/.claude that is a link to elsewhere in the home leaves each link, and the file or folder it leads to, exactly as set-up found them, as the stopped window says", { timeout: 240000 }, async (t) => {
  const linked = [
    ['a ~/.claude.json that is a link to a file elsewhere in the home', (iw) => {
      const target = put(iw, 'dotfiles/claude.json', JSON.stringify({ numStartups: 4, theme: 'dark' }, null, 2) + '\n');
      fs.symlinkSync(target, path.join(iw.userHome, '.claude.json'));
    }],
    ['a ~/.claude that is a link to a folder elsewhere in the home holding one file', (iw) => {
      put(iw, 'dotfiles/claude/settings.json', '{"theme": "dark"}\n');
      fs.symlinkSync(path.join(iw.userHome, 'dotfiles', 'claude'), path.join(iw.userHome, '.claude'));
    }],
  ];
  for (const [what, make] of linked) {
    const iw = I.makeInstallerWorld(t, { claude: { plan: 'free' } });
    make(iw);
    const before = I.contentOf(iw.userHome);
    const run = await I.runApp(iw);
    assert.equal(installerRuns(run).length, 1, `${what}: with no Claude Code there, set-up must install it; got ${I.describeRun(run)}`);
    assertWindow(run, TITLES.stopped, [/Pro/, /as set-up found it/i], `a Free plan read over ${what}`);
    assert.deepEqual(I.contentOf(iw.userHome), before,
      `${what}: the home folder must be as set-up found it: each link still a link to the same place, what it leads to byte for byte as it was, and nothing set-up or the installer made left inside it`);
  }
});

test('a file another app writes inside a folder set-up created is kept by the undo, and that folder is kept and named on the stopped window', { timeout: 120000 }, async (t) => {
  const iw = I.makeInstallerWorld(t, { claude: { plan: 'enterprise_plus' } });
  const go = path.join(iw.root, 'answer-the-plan-ask');
  iw.set({ answers: { [TITLES.askPlan]: { waitFor: go, then: 'button returned:Stop' } } });
  const before = I.contentOf(iw.userHome);
  const stranger = path.join(iw.userHome, '.claude', 'notes-from-another-app.txt');
  const text = 'Written by another app while set-up was running.\n';
  const run = await I.runApp(iw, {
    killWhen: (x) => {
      if (!fs.existsSync(go) && I.readJsonLines(x.dialogsFile).some((d) => d.title === TITLES.askPlan)) {
        fs.writeFileSync(stranger, text);
        fs.writeFileSync(go, '');
      }
      return false;
    },
  });
  assert.ok(fs.existsSync(go), `set-up must ask the plan it cannot confirm; got ${I.describeRun(run)}`);
  assertWindow(run, TITLES.stopped, [/Pro/, /\.claude\b/], 'Stop on a plan set-up cannot confirm, with another app\'s file in ~/.claude');
  assert.equal(fs.readFileSync(stranger, 'utf8'), text, 'the file set-up did not write must be kept');
  const expected = { ...before, '.claude': 'dir', '.claude/notes-from-another-app.txt': I.contentOf(stranger)[''] };
  assert.deepEqual(I.contentOf(iw.userHome), expected, 'everything else set-up added must go, and only ~/.claude and the file in it stay');
});

test("an undo step that fails, signing Squire's config folder out, is named on the stopped window, stays in the record, and the window never says the Mac is as set-up found it",{ timeout: 120000 }, async (t) => {
  const iw = I.makeInstallerWorld(t, { claude: { plan: 'free', logout: 'fail' } });
  const run = await I.runApp(iw);
  assert.ok(authCalls(run, 'logout').length >= 1, `set-up must try to sign Squire's config folder out; got ${I.describeRun(run)}`);
  assertWindow(run, TITLES.stopped, [/Pro/, /sign/i], 'a Free plan read whose sign-out fails');
  const shown = I.dialogsTitled(run, TITLES.stopped).pop();
  assert.doesNotMatch(shown.text, /as set-up found it/i, 'with an undo step failed, the window must never say the Mac is as set-up found it');
  const record = I.readRecord(iw);
  assert.ok(record && Array.isArray(record.added) && record.added.length >= 1, `what was not undone must stay in set-up.json's added; got ${JSON.stringify(record)}`);
});

// ------------------------------------------------- the record and the lock

test('a set-up record that lists every step done, with no yes in the approvals ledger, still gets the one yes asked before anything installs', { timeout: 60000 }, async (t) => {
  const iw = I.makeInstallerWorld(t, { mac: { answers: { [TITLES.setUp]: 'button returned:Not now' } } });
  fs.mkdirSync(iw.squireHome, { recursive: true });
  fs.writeFileSync(iw.record, JSON.stringify({ done: STEPS, added: [], release: path.join(iw.squireHome, 'release', 'core') }, null, 2) + '\n');
  const run = await I.runApp(iw);
  assert.equal(I.dialogsTitled(run, TITLES.setUp).length, 1, `a record alone is never consent: the one yes must be asked; got ${I.describeRun(run)}`);
  assert.equal(downloads(run).length + installerRuns(run).length + installCalls(run).length, 0, 'with Not now, nothing may be installed');
  assert.ok(!asked(run, TITLES.ready), 'set-up must not call itself ready on a record alone');
});

test('a set-up record that does not parse, is cut short, or holds wrong types and out-of-order step ids is set aside, never adopted, and set-up runs again from the start', { timeout: 300000 }, async (t) => {
  const bad = [
    ['cut short', '{"done": ["yes", "claudeCode", "signIn"], "added": [{"path": "/x", "ma'],
    ['wrong types and out-of-order ids', '{"done": ["claudeCode", "yes", "yes", "appleTools"], "added": "nothing", "release": 7}\n'],
    ['an unknown step id', '{"done": ["yes", "claudeCode", "signIn", "appleTools", "naming", "ownerFolder", "layDown", "sudo"], "added": []}\n'],
  ];
  for (const [what, bytes] of bad) {
    const iw = I.makeInstallerWorld(t);
    fs.mkdirSync(iw.squireHome, { recursive: true });
    fs.writeFileSync(iw.record, bytes);
    const fresh = (x) => { const r = I.readRecord(x); return Boolean(r && Array.isArray(r.done) && r.done[0] === 'yes' && r.done.includes('claudeCode')); };
    // The kill waits for a record set-up wrote: the seeded unknown-id record already reads as fresh.
    const written = (x) => { try { return fresh(x) && !fs.readFileSync(x.record).equals(Buffer.from(bytes)); } catch (e) { return false; } };
    const run = await I.runApp(iw, { killWhen: written });
    assert.ok(asked(run, TITLES.plan) && asked(run, TITLES.setUp), `${what}: set-up must run again from the start, asking the declaration and the one yes; got ${I.describeRun(run)}`);
    assert.ok(fresh(iw), `${what}: set-up must write a record of its own and carry on; got ${JSON.stringify(I.readRecord(iw))}`);
    const setAside = Object.keys(I.contentOf(iw.squireHome)).filter((rel) => rel !== 'set-up.json' &&
      fs.lstatSync(path.join(iw.squireHome, rel)).isFile() && fs.readFileSync(path.join(iw.squireHome, rel)).equals(Buffer.from(bytes)));
    assert.ok(setAside.length >= 1, `${what}: the bad record must be set aside in the Squire home, never deleted`);
    assert.ok(!fs.readFileSync(iw.record).equals(Buffer.from(bytes)), `${what}: the bad record must never be adopted`);
  }
});

test('a second set-up opened with a different temporary folder still exits at once, saying set-up is already running, and changes nothing', { timeout: 120000 }, async (t) => {
  const iw = I.makeInstallerWorld(t, { mac: { answers: { [TITLES.name]: { hang: true } } } });
  const first = I.startApp(iw);
  t.after(() => first.kill());
  const waiting = await s.waitFor(() => I.readJsonLines(iw.dialogsFile).some((d) => d.title === TITLES.name), 90000, 200);
  assert.ok(waiting, 'the first set-up must reach the naming window');
  const otherTmp = path.join(iw.root, 'another-tmp');
  fs.mkdirSync(otherTmp, { recursive: true });
  const before = w.snapshot(iw.userHome);
  iw.set({ answers: {} });
  const second = await I.runApp(iw, { launchd: false, timeout: 30000, env: { TMPDIR: otherTmp } });
  assertWindow(second, TITLES.cannot, [/already running/i], 'a second set-up with another TMPDIR');
  assert.ok(!second.timedOut, 'the second set-up must exit at once');
  assert.deepEqual(w.snapshotDifferences(before, w.snapshot(iw.userHome)), [], 'the second set-up must change nothing');
  await first.kill();
});

// ------------------------------------------------------- the owner's folder

test("a ~/Squire that is a file, a link into Documents or not writable, or an owner's squire.json that does not parse, pauses set-up naming it and is left byte for byte", { timeout: 600000 }, async (t) => {
  const cases = [
    ['a file', (iw) => { put(iw, 'Squire', 'A file the owner made, called Squire.\n'); return /\/Squire\b/; }],
    ['a link into Documents', (iw) => {
      put(iw, 'Documents/Squire/plans.md', 'Kitchen, phase two.\n');
      fs.symlinkSync(path.join(iw.userHome, 'Documents', 'Squire'), iw.ownerFolder);
      return /\/Squire\b/;
    }],
    ['not writable', (iw) => {
      put(iw, 'Squire/plans.md', 'Kitchen, phase two.\n');
      fs.chmodSync(iw.ownerFolder, 0o555);
      t.after(() => { try { fs.chmodSync(iw.ownerFolder, 0o755); } catch (e) { /* gone */ } });
      return /\/Squire\b/;
    }],
    ["an owner's squire.json that does not parse", (iw) => { put(iw, 'Squire/squire.json', '{"wakeUps": [{"at": "07:30"\n'); return /squire\.json/; }],
  ];
  for (const [what, make] of cases) {
    const iw = I.makeInstallerWorld(t);
    const names = make(iw);
    const target = fs.realpathSync(path.dirname(iw.ownerFolder));
    const before = w.snapshot(target);
    const watched = Object.keys(before).filter((rel) => rel === 'Squire' || rel.startsWith('Squire/') || rel.startsWith('Documents/'));
    const run = await I.runApp(iw);
    assertWindow(run, TITLES.paused, [names], `~/Squire ${what}`);
    assert.ok(!I.doneSteps(iw).includes('ownerFolder'), `~/Squire ${what}: the owner's folder step must not be recorded done`);
    const after = w.snapshot(target);
    for (const rel of watched) assert.deepEqual(after[rel], before[rel], `~/Squire ${what}: ${rel} must be left exactly as it was`);
    const grown = Object.keys(after).filter((rel) => (rel.startsWith('Squire/') || rel.startsWith('Documents/')) && !(rel in before));
    assert.deepEqual(grown, [], `~/Squire ${what}: nothing may be written into it`);
  }
});

// ---------------------------------------------------------- the health step

test("an unreadable managed settings file on an otherwise healthy Mac lets set-up finish, and its ready window carries the cannot-confirm line", { timeout: FULL_RUN }, async (t) => {
  const iw = I.makeInstallerWorld(t);
  const managed = path.join(iw.system, 'Library', 'Application Support', 'ClaudeCode', 'managed-settings.json');
  fs.mkdirSync(path.dirname(managed), { recursive: true });
  fs.writeFileSync(managed, '{"autoCompactWindow": 500000}\n');
  fs.chmodSync(managed, 0o000);
  t.after(() => { try { fs.chmodSync(managed, 0o600); } catch (e) { /* gone */ } });
  const run = await I.runApp(iw);
  assert.deepEqual(I.doneSteps(iw), STEPS, `a line set-up's own steps did not lay down must not hold set-up; got ${I.describeRun(run)}`);
  assertWindow(run, TITLES.ready, [/cannot confirm the compaction window/i], 'set-up over an unreadable managed settings file');
});

// --------------------------------------------- a Mac fact set-up cannot read

test('a Mac fact set-up cannot read (sw_vers failing, sw_vers printing no version, a memory reading that is not a number) is refused before any change, naming it and the way on', { timeout: 180000 }, async (t) => {
  for (const [mac, word, what] of [
    [{ swVers: 'fail' }, /macOS|version/i, 'sw_vers failing'],
    [{ macos: '' }, /macOS|version/i, 'sw_vers printing no version'],
    [{ memBytes: 'plenty' }, /memory/i, 'a memory reading that is not a number'],
  ]) {
    const iw = I.makeInstallerWorld(t, { mac });
    const before = w.snapshot(iw.userHome);
    const run = await I.runApp(iw);
    assertRefusedBeforeAnyChange(iw, before, run, [word], what);
    assert.ok(!asked(run, TITLES.plan), `${what}: a fact set-up cannot read is refused, never asked and never assumed`);
  }
});

test('a Mac fact reading with a space in it (a macOS version of "1 3", a memory reading with a space between its digits, a memory reading led by a space) is not a version or a whole number: it is refused before any change, naming it, and set-up never goes on to the plan window', { timeout: 180000 }, async (t) => {
  for (const [mac, word, what] of [
    [{ macos: '1 3' }, /macOS|version/i, 'a macOS version reading of "1 3"'],
    [{ memBytes: '17179 869184' }, /memory/i, 'a memory reading with a space between its digits'],
    [{ memBytes: ' 4294967296' }, /memory/i, 'a memory reading led by a space'],
  ]) {
    // Should set-up take the reading and go on, the owner says Not now at the
    // one yes, so nothing is installed either way.
    const iw = I.makeInstallerWorld(t, { mac: { ...mac, answers: { [TITLES.setUp]: 'button returned:Not now' } } });
    const before = w.snapshot(iw.userHome);
    const run = await I.runApp(iw);
    assert.ok(!asked(run, TITLES.plan),
      `${what}: a reading that is not a version or a whole number is refused, never assumed, so set-up must not go on to the plan window; got ${I.describeRun(run)}`);
    assertRefusedBeforeAnyChange(iw, before, run, [word], what);
  }
});

// ------------------------------------ signing in again before the sign-in ends

const DAY = 24 * 60 * 60 * 1000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const pad = (n) => String(n).padStart(2, '0');
const localDay = (iso) => { const d = new Date(iso); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };

// Squire set up in a session world: core laid down and kept as the Squire
// home's release folder, set-up's record, and a fake Claude Code that says
// when the sign-in ends. The core's release.json keeps its version and names a
// loopback release host and intake where nothing answers, written before the
// lay-down records its digests, so the scheduler's tick never reaches the
// real release host.
function renewWorld(t, behaviour) {
  const world = w.makeWorld();
  t.after(() => { s.killFakes(world); w.cleanUp(world); });
  world.system = I.makeSystemRoot(path.join(world.root, 'system'));
  const core = path.join(world.root, 'renew-core');
  w.copyTree(w.CORE, core);
  const { version } = JSON.parse(fs.readFileSync(path.join(w.CORE, 'release.json'), 'utf8'));
  fs.writeFileSync(path.join(core, 'release.json'),
    JSON.stringify({ version, releaseHost: 'http://127.0.0.1:9/releases/', intake: 'http://127.0.0.1:9/tickets' }, null, 2) + '\n');
  s.layDownCore(world, core);
  world.release = path.join(world.home, 'release', 'core');
  w.copyTree(core, world.release);
  fs.writeFileSync(path.join(world.home, 'set-up.json'), JSON.stringify({ done: STEPS, added: [], release: world.release }, null, 2) + '\n');
  world.fake = s.installFakeClaudeCode(world, behaviour);
  return world;
}

// One tick of the wake-ups scheduler, as its agent runs it.
function tick(world) {
  const r = s.runDueWakeUps(world, { coreDir: fs.realpathSync(s.installedCore(world)), env: { SQUIRE_SYSTEM_ROOT: world.system } });
  assert.doesNotMatch(r.stderr, /can't open file|Traceback/, `the scheduler's run must run; got ${w.describe(r)}`);
  return r;
}

async function liveSession(world, t) {
  const runner = s.startRunner(world);
  t.after(() => runner.stop());
  const live = await s.waitFor(() => s.sessionRecords(world).length === 1 && world.fake.sessions().length >= 1, 30000);
  assert.ok(live, `the runner must start one session; runner output: ${runner.output()}`);
  return runner;
}

const renewPrompts = (world) => world.fake.prompts().filter((p) => /sign in again/i.test(p.content));

test("a sign-in that ends within seven days gets one wake-up through Squire's session naming the day and the one action, and a second run that day sends none",{ timeout: 120000 }, async (t) => {
  const ends = new Date(Date.now() + 3 * DAY).toISOString();
  const world = renewWorld(t, { loginExpiresAt: ends });
  await liveSession(world, t);
  tick(world);
  const warned = await s.waitFor(() => renewPrompts(world).length >= 1, 15000);
  assert.ok(warned, `the scheduler's run must send one wake-up saying to sign in again; the session got ${JSON.stringify(world.fake.prompts().map((p) => p.content))}`);
  assert.ok(renewPrompts(world)[0].content.includes(localDay(ends)), `the wake-up must name the day the sign-in ends (${localDay(ends)}); it said: ${renewPrompts(world)[0].content}`);
  tick(world);
  await sleep(3000);
  assert.equal(renewPrompts(world).length, 1, 'a second run the same day must send no second wake-up');
});

test('a sign-in that ends in more than seven days, or whose end cannot be read, gets no wake-up and no sign-in', { timeout: 180000 }, async (t) => {
  // A regression guard: nothing warns or signs in at the round's base, so this
  // holds there; it stays so the warning never fires outside its window or on
  // an end it cannot read. The two cases beside it fail until it is built.
  for (const [ends, what] of [[new Date(Date.now() + 20 * DAY).toISOString(), 'ending in 20 days'], ['soon', 'an end that cannot be read']]) {
    const world = renewWorld(t, { loginExpiresAt: ends });
    await liveSession(world, t);
    tick(world);
    await sleep(3000);
    assert.deepEqual(renewPrompts(world), [], `${what}: no wake-up may be sent`);
    assert.equal(world.fake.authCalls().filter((c) => c.argv[1] === 'login').length, 0, `${what}: nothing may sign in`);
  }
});

test("on the owner's yes to signing in again, the scheduler's next run runs Claude Code's sign-in into Squire's config folder and nothing else", { timeout: 120000 }, async (t) => {
  const ends = new Date(Date.now() + 3 * DAY).toISOString();
  const world = renewWorld(t, { loginExpiresAt: ends });
  const health = w.runPython(world, path.join(world.home, 'core', 'tools', 'health.py'), [], { cwd: world.root, env: { SQUIRE_SYSTEM_ROOT: world.system } });
  const request = `${w.PYTHON} ${path.join(world.home, 'core', 'tools', 'health.py')} --request sign-in`;
  assert.ok(health.stdout.includes(request), `the health check must name the day and how to ask to sign in again, ${request}; got ${w.describe(health)}`);
  assert.ok(health.stdout.includes(localDay(ends)), `the health check must name the day the sign-in ends; got ${w.describe(health)}`);
  const session = 'session-sign-in-again';
  const call = w.tools.bash(request);
  const asked = w.attempt(world, session, call);
  w.assertBlocked(asked, 'signing in again, before the owner\'s yes');
  assert.ok(w.requestIdIn(asked.stderr), `the floor must ask the owner (a block with a request id); got ${w.describe(asked)}`);
  w.ownerSays(world, session, 'yes');
  w.assertBlocked(w.attempt(world, session, call), 'signing in again from the session after the yes: it runs outside the session');
  const callsBefore = world.fake.calls().length;
  const core = fs.realpathSync(s.installedCore(world));
  const coreBefore = w.snapshot(core);
  tick(world);
  const made = world.fake.calls().slice(callsBefore).filter((c) => !(c.argv[0] === 'auth' && c.argv[1] === 'status'));
  assert.deepEqual(made.map((c) => c.argv.slice(0, 2).join(' ')), ['auth login'], `the yes must run Claude Code's sign-in once and nothing else; got ${JSON.stringify(made.map((c) => c.argv))}`);
  assert.equal(made[0].env.CLAUDE_CONFIG_DIR, s.configDir(world), 'the sign-in must go into Squire\'s config folder');
  assert.deepEqual(w.snapshotDifferences(coreBefore, w.snapshot(core)), [], 'signing in again must lay nothing down');
});
