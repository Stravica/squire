'use strict';

// What the Squire owner sees while Squire sets itself up: from the first
// click until set-up ends, a Squire window is always on screen, naming what
// set-up is doing now and how far it has got (step N of M at least, and how
// long a long step usually takes); every window comes to the front; and on
// an Apple silicon Mac, Apple silicon builds, even under Rosetta.
//
// Every case opens set-up's app as Finder would, on the installer world's Mac
// of fakes (tests/fixtures/installer-world.js), and reads set-up's window
// timeline from the world's osascript: each window's script lines, the
// moment its process started and the moment it ended. In this world no
// moment of set-up may pass with no Squire window on screen: the next window
// opens before the last one closes. (On a real Mac the timeline is read from
// set-up's log and the owner's own words, where about 3 seconds is the
// tolerance; here it is the world's resolution, 100 ms, for a window ended by
// SIGKILL, and none otherwise.)
//
// The mechanism these cases pin (one window per step, the next opened before
// the last is closed, redrawn only between the parts of a step and never
// while the Claude sign-in or a macOS window of its own is up) is the one
// Squire Update already ships: a window with a Hide button left on screen
// while the work goes on ("Squire: setting up" here). It cannot show a live
// figure such as megabytes so far: a window of the Mac's own can only change
// by being drawn again, and drawing it again takes the front.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const s = require('../fixtures/session-world.js');
const I = require('../fixtures/installer-world.js');

const { TITLES } = I;
const LONG = { timeout: 600000 };
const RUN = 300000;
const STEP_N_OF_M = /\bstep \d+ of \d+\b/i;
const HOW_LONG = /\b(?:usually|about|around|up to|a few)\b[^.]*\b(?:seconds?|minutes?)\b/i;

const callsAt = (iw, test) => I.readJsonLines(iw.callsFile).filter(test);
const browserCurls = (iw) => callsAt(iw, (c) => c.cmd === 'curl' && c.url !== I.INSTALL_URL);
const show = (xs) => JSON.stringify(xs.map((x) => ({ title: x.title, opened: x.opened, closed: x.closed, text: (x.text || '').slice(-200) })));

// A full set-up, timed from the first click.
async function setUp(iw, opts = {}) {
  const clicked = Date.now();
  const run = await I.runApp(iw, { timeout: RUN, ...opts });
  const timeline = I.windowTimeline(iw);
  return { run, clicked, ended: Date.now(), timeline };
}

// The window whose title is given, nth of its title (the last by default).
const titled = (timeline, title, nth = -1) => {
  const all = timeline.filter((x) => x.title === title);
  return all[nth < 0 ? all.length + nth : nth] || null;
};

function assertNoGap(timeline, from, to, what) {
  const gaps = I.gapsIn(timeline, from, to);
  assert.deepEqual(gaps.map((g) => ({ ...g, ms: g.to - g.from })), [],
    `${what}: a Squire window must be on screen at every moment, the next opened before the last is closed; moments with none (ms since 1970): ` +
    `${JSON.stringify(gaps)}; windows: ${show(timeline)}`);
}

function assertNamesStep(timeline, at, words, what) {
  const up = I.windowsAt(timeline, at);
  assert.ok(up.some((x) => STEP_N_OF_M.test(x.text) && words.test(x.text)),
    `${what}: the window on screen must name what set-up is doing (${words}) and show how far it has got (step N of M); on screen: ${show(up)}`);
}

test("the installer's own half of set-up, the yes, Claude Code's download and install, the Claude sign-in and the browser's parts, keeps a Squire window on screen at every moment, each naming its activity and showing step N of M", LONG, async (t) => {
  const iw = I.makeInstallerWorld(t, { mac: { toolsPresent: false } });
  const { run, timeline } = await setUp(iw);
  const naming = titled(timeline, TITLES.name, 0);
  assert.ok(naming, `set-up must reach naming; ${I.describeRun(run)}`);
  assertNoGap(timeline, timeline[0].opened, naming.opened, 'from the first window to naming');
  const claudeDownload = callsAt(iw, (c) => c.cmd === 'curl' && c.url === I.INSTALL_URL)[0];
  const claudeInstall = callsAt(iw, (c) => c.cmd === 'claude-installer')[0];
  const signIn = callsAt(iw, (c) => c.cmd === 'claude' && c.argv[0] === 'auth' && c.argv[1] === 'login')[0];
  const tools = callsAt(iw, (c) => c.cmd === 'xcode-select' && c.argv.includes('--install'))[0];
  assertNamesStep(timeline, claudeDownload.at, /Claude Code/, 'while Claude Code\'s installer downloads');
  assertNamesStep(timeline, claudeInstall.at, /Claude Code/, 'while Claude Code installs');
  for (const c of browserCurls(iw)) assertNamesStep(timeline, c.at, /browser/i, `while the browser's part ${c.url} downloads`);
  assertNamesStep(timeline, signIn.at, /sign/i, 'while the Claude sign-in runs');
  assertNamesStep(timeline, tools.at, /Apple|tools/i, 'while Apple\'s tools install');
});

// Set-up's own steps, in order from naming on, as this case expects them:
// each step's own step N of M (11 steps in all, both halves; naming is step
// 5) and words that name its activity. The speech helper is built while
// Squire is laid down, so its window is under laying down's step. Each step
// runs from the moment its window opens until the next step's window opens
// (set-up opens a step's window, then does its work), the last until the
// window that says set-up is ready; the window in front at a moment is the
// last opened of those on screen, as every window comes to the front.
const OWN_STEPS = [
  ['naming done', 'the Squire folder', 'ownerFolder', 'Step 6 of 11', /\bfolder\b/i],
  ['ownerFolder done', 'laying Squire down', 'layDown', 'Step 7 of 11', /\bparts\b|\bspeech helper\b/i],
  ['layDown done', 'backup', 'backup', 'Step 8 of 11', /\bbackup\b/i],
  ['backup done', 'the health check', 'health', 'Step 9 of 11', /\bcheck/i],
  ['health done', 'the phone', 'phone', 'Step 10 of 11', /\bphone\b/i],
  ['phone done', 'the wait for the session', 'firstConversation', 'Step 11 of 11', /\bsession\b|\bconversation\b/i],
];

function frontAt(timeline, at) {
  const up = I.windowsAt(timeline, at);
  return up.length ? up[up.length - 1] : null;
}

test("set-up's own steps from naming on, the Squire folder, laying Squire down, the speech helper, backup, the health check, the phone and the wait for the session, keep a Squire window on screen at every moment, each naming its activity and showing step N of M", LONG, async (t) => {
  // A Mac that can build the speech helper (macOS 26 and Apple's tools; the
  // world's swiftc takes 1.5 seconds), so its window is one of the steps'.
  const iw = I.makeInstallerWorld(t, { mac: { macos: '26.1', speechBuild: { ms: 1500 } } });
  const { run, timeline } = await setUp(iw);
  const naming = titled(timeline, TITLES.name, 0);
  const ready = titled(timeline, TITLES.ready);
  assert.ok(naming && ready, `set-up must run from naming to its ready window; ${I.describeRun(run)}`);
  assertNoGap(timeline, naming.opened, ready.closed, 'from naming to the end of set-up');
  const progress = timeline.filter((x) => x.opened >= naming.opened && x.title === TITLES.progress);
  assert.ok(progress.length >= 1 && progress.every((x) => STEP_N_OF_M.test(x.text)), `every progress window from naming on must show step N of M; ${show(progress)}`);
  const done = (step) => {
    const log = fs.readFileSync(path.join(iw.squireHome, 'logs', 'set-up.log'), 'utf8').split('\n');
    const line = log.find((l) => l.endsWith(`set-up: ${step} done`));
    return line ? new Date(line.slice(0, 19)).getTime() : null;
  };
  for (const step of ['ownerFolder', 'layDown', 'backup', 'health', 'phone']) {
    const at = done(step);
    assert.ok(at, `set-up's log must record ${step} done`);
    // The log's time is to the second: the window up across that second.
    assertNoGap(timeline, at, at + 999, `the second set-up recorded ${step} done`);
  }
  // Which step each window names: at each of set-up's own steps, the window
  // in front names that step's activity and its own step N of M, never the
  // step before it.
  const doneAt = (line) => {
    const log = fs.readFileSync(path.join(iw.squireHome, 'logs', 'set-up.log'), 'utf8').split('\n');
    const found = log.find((l) => l.endsWith(`set-up: ${line}`));
    return found ? new Date(found.slice(0, 19)).getTime() : null;
  };
  const after = timeline.filter((x) => x.opened >= naming.opened);
  const firstOf = (stepOf) => after.find((x) => x.text && x.text.includes(stepOf)) || null;
  for (const [i, [before, what, step, stepOf, words]] of OWN_STEPS.entries()) {
    const own = firstOf(stepOf);
    assert.ok(own && words.test(own.text),
      `while set-up runs ${what}, a window of that step's own must be in front naming its activity (${words}) and its own step (${stepOf}); windows from naming on: ${show(after)}`);
    // Until the first window of a later step opens, or the ready window.
    const later = OWN_STEPS.slice(i + 1).map((x) => firstOf(x[3])).filter(Boolean).map((x) => x.opened);
    const until = Math.min(...later, ready.opened);
    const started = doneAt(before);
    const finished = doneAt(`${step} done`);
    assert.ok(started !== null && finished !== null && own.opened >= started && own.opened <= finished + 999,
      `${what}: its window must open while set-up runs that step, after "${before}" (${started}) and by the second it records "${step} done" (${finished}); opened ${own.opened}`);
    // Every moment the step runs, from its window's opening to the next
    // step's: the window in front is one of this step's.
    const moments = [own.opened, ...timeline.flatMap((x) => [x.opened, x.closed === null ? null : x.closed + 1])
      .filter((m) => m !== null && m > own.opened && m < until)];
    for (const m of moments) {
      const front = frontAt(timeline, m);
      assert.ok(front && (front.text || '').includes(stepOf) && (front === own || words.test(front.text)),
        `while set-up runs ${what}, the window in front must name that step's activity (${words}) and its own step (${stepOf}), never the step before it; at ${m} in front: ${front ? show([front]) : 'none'}; windows from naming on: ${show(after)}`);
    }
  }
  // The speech helper is built under laying Squire down: its window is in
  // front while it builds, naming the speech helper and laying down's step.
  const build = callsAt(iw, (c) => c.cmd === 'swiftc' && !c.ended)[0];
  assert.ok(build, `set-up must build the speech helper on macOS 26 with Apple's tools (the world's swiftc); ${I.describeRun(run)}`);
  const front = frontAt(timeline, build.at);
  assert.ok(front && (front.text || '').includes('Step 7 of 11') && /\bspeech helper\b/i.test(front.text),
    `while the speech helper builds, the window in front must name the speech helper and laying Squire down's step (Step 7 of 11); in front: ${front ? show([front]) : 'none'}`);
});

test("the moments between set-up's steps, after the Claude sign-in returns, at the hand-over from the installer to set-up's own steps, after naming and after the phone step, each show a Squire window, and every window is closed or replaced at its step's end with none left on screen after set-up ends", LONG, async (t) => {
  const iw = I.makeInstallerWorld(t);
  const { run, timeline } = await setUp(iw);
  const login = callsAt(iw, (c) => c.cmd === 'claude' && c.argv[0] === 'auth' && c.argv[1] === 'login')[0];
  const back = callsAt(iw, (c) => c.cmd === 'claude' && c.argv[0] === 'auth' && c.argv[1] === 'status' && login && c.at > login.at)[0];
  const naming = titled(timeline, TITLES.name, 0);
  const personality = titled(timeline, TITLES.personality, 0);
  const phone = titled(timeline, TITLES.phone, 0);
  assert.ok(login && back && naming && personality && phone, `set-up must run through the sign-in, naming and the phone step; ${I.describeRun(run)}`);
  const lastZsh = callsAt(iw, (c) => c.at < naming.opened && ['xcode-select', 'claude'].includes(c.cmd)).pop();
  const moments = [['the sign-in returning from the browser', back.at], ['the hand-over to set-up\'s own steps', lastZsh.at],
    ['the end of naming', personality.closed], ['the end of the phone step', phone.closed]];
  for (const [what, at] of moments) assertNoGap(timeline, at, at + 2000, `the moment of ${what}`);
  assertNoGap(timeline, lastZsh.at, naming.opened, 'the hand-over from the installer to set-up\'s own steps');
  const left = I.windowTimeline(iw).filter((x) => x.closed === null);
  assert.deepEqual(left.map((x) => x.title), [], `no Squire window may be left on screen once set-up has ended; still up: ${show(left)}`);
});

test('a Squire window is on screen within about 3 seconds of the first click', LONG, async (t) => {
  const iw = I.makeInstallerWorld(t);
  const { run, clicked, timeline } = await setUp(iw);
  assert.ok(timeline.length >= 1, `set-up must show a window; ${I.describeRun(run)}`);
  assert.ok(timeline[0].opened - clicked <= 3000, `the first Squire window must be on screen within about 3 seconds of the click; it opened after ${timeline[0].opened - clicked} ms`);
});

test("every window for a step that can run longer than about 10 seconds says how long it usually takes; during the two large downloads the window changes at each part, the browser's part N of its parts and Claude Code's download then its install; and no window is drawn while the Claude sign-in or Apple's own tools window is up", LONG, async (t) => {
  const iw = I.makeInstallerWorld(t, { mac: { toolsPresent: false } });
  const { run, timeline } = await setUp(iw);
  const at = (test) => callsAt(iw, test)[0];
  const claudeDownload = at((c) => c.cmd === 'curl' && c.url === I.INSTALL_URL);
  const claudeInstall = at((c) => c.cmd === 'claude-installer');
  const login = at((c) => c.cmd === 'claude' && c.argv[0] === 'auth' && c.argv[1] === 'login');
  const tools = at((c) => c.cmd === 'xcode-select' && c.argv.includes('--install'));
  assert.ok(claudeDownload && claudeInstall && login && tools, `set-up must download and install Claude Code, sign in and install Apple's tools; ${I.describeRun(run)}`);
  const long = [['Claude Code\'s download', claudeDownload.at], ['Claude Code\'s install', claudeInstall.at], ['Apple\'s tools', tools.at],
    ...browserCurls(iw).map((c, i) => [`the browser's part ${i + 1}`, c.at])];
  for (const [what, moment] of long) {
    const up = I.windowsAt(timeline, moment);
    assert.ok(up.some((x) => HOW_LONG.test(x.text)), `during ${what}, a step that can run longer than about 10 seconds, the window must say how long it usually takes; on screen: ${show(up)}`);
  }
  const parts = browserCurls(iw);
  parts.forEach((c, i) => {
    const up = I.windowsAt(timeline, c.at);
    assert.ok(up.some((x) => new RegExp(`\\b${i + 1} of ${parts.length}\\b`).test(x.text)),
      `the browser's download window must change at each part: part ${i + 1} of ${parts.length} while ${c.url} downloads; on screen: ${show(up)}`);
  });
  const dl = I.windowsAt(timeline, claudeDownload.at).map((x) => x.text);
  const inst = I.windowsAt(timeline, claudeInstall.at).map((x) => x.text);
  assert.ok(!inst.every((x) => dl.includes(x)), `Claude Code's window must change from its download to its install; download: ${JSON.stringify(dl)}, install: ${JSON.stringify(inst)}`);
  const back = callsAt(iw, (c) => c.cmd === 'claude' && c.argv[0] === 'auth' && c.argv[1] === 'status' && c.at > login.at)[0];
  const duringSignIn = timeline.filter((x) => x.opened > login.at + 200 && back && x.opened < back.at - 200);
  assert.deepEqual(duringSignIn.map((x) => x.title), [], `no window may be drawn while the Claude sign-in is up in the browser; drawn: ${show(duringSignIn)}`);
  const toolsDone = callsAt(iw, (c) => c.cmd === 'xcode-select' && c.at > tools.at && c.present === true)[0];
  const duringTools = timeline.filter((x) => x.opened > tools.at + 200 && toolsDone && x.opened < toolsDone.at - 200);
  assert.deepEqual(duringTools.map((x) => x.title), [], `no window may be drawn while Apple's own tools window is up; drawn: ${show(duringTools)}`);
});

test("opening Squire again while set-up runs brings a window to the front naming the current step and starts nothing; and when set-up pauses, the paused window takes the progress window's place", LONG, async (t) => {
  const iw = I.makeInstallerWorld(t);
  const go = path.join(iw.root, 'phone-answered');
  iw.set({ answers: { [TITLES.phone]: { waitFor: go, then: 'button returned:Done' } } });
  const first = setUp(iw);
  const atPhone = await s.waitFor(() => I.readJsonLines(iw.dialogsFile).some((d) => d.title === TITLES.phone), 200000, 200);
  assert.ok(atPhone, 'set-up must reach the phone step');
  await s.sleep(1000);
  const recordBefore = fs.readFileSync(iw.record, 'utf8');
  const callsBefore = I.readJsonLines(iw.callsFile).length;
  const opened = Date.now();
  const second = I.startApp(iw);
  t.after(() => second.kill());
  await s.sleep(6000);
  const shown = I.windowTimeline(iw).filter((x) => x.opened >= opened);
  const firstLine = (x) => (x.lines[0] === 'on run argv' ? x.lines[1] : x.lines[0]) || '';
  assert.ok(shown.some((x) => /phone/i.test(x.text) && STEP_N_OF_M.test(x.text) && /^\s*activate\s*$/i.test(firstLine(x))),
    `opening Squire again must bring a window to the front (activate first) naming the current step (the phone, step N of M); shown since: ${show(shown)}`);
  const newCalls = I.readJsonLines(iw.callsFile).slice(callsBefore).filter((c) => ['curl', 'claude', 'claude-installer', 'xcode-select'].includes(c.cmd));
  assert.deepEqual(newCalls.map((c) => c.cmd), [], 'the second open must start nothing');
  assert.equal(fs.readFileSync(iw.record, 'utf8'), recordBefore, 'the second open must leave set-up\'s record as it was');
  fs.writeFileSync(go, '');
  await first;
  await second.kill();
  // A pause: the paused window opens before the progress window closes.
  const paused = I.makeInstallerWorld(t, { mac: { download: 'fail' } });
  const r = await setUp(paused);
  const p = titled(r.timeline, TITLES.paused);
  assert.ok(p, `a failed download must pause set-up; ${I.describeRun(r.run)}`);
  const before = r.timeline.filter((x) => x.title === TITLES.progress && x.opened < p.opened);
  assert.ok(before.length >= 1, `a progress window must be up before the pause; ${show(r.timeline)}`);
  assertNoGap(r.timeline, r.timeline[0].opened, p.opened + 500, 'up to the paused window');
  assert.deepEqual(I.windowTimeline(paused).filter((x) => x.closed === null).map((x) => x.title), [], 'no progress window is left on screen after the pause');
});

test("every window set-up shows, from the installer's half and from set-up's own steps, comes to the front (activate first in its script), and the window before the Claude sign-in tells the owner to come back to Squire afterwards", LONG, async (t) => {
  const iw = I.makeInstallerWorld(t);
  const { run, timeline } = await setUp(iw);
  assert.ok(I.doneSteps(iw).includes('phone'), `set-up must run its steps; ${I.describeRun(run)}`);
  const firstLine = (x) => (x.lines[0] === 'on run argv' ? x.lines[1] : x.lines[0]) || '';
  const behind = timeline.filter((x) => !/^\s*activate\s*$/i.test(firstLine(x)));
  assert.deepEqual(behind.map((x) => ({ title: x.title, first: firstLine(x) })), [],
    'every set-up window must come to the front of every other app\'s window when it opens: activate first in its script');
  const login = callsAt(iw, (c) => c.cmd === 'claude' && c.argv[0] === 'auth' && c.argv[1] === 'login')[0];
  const before = [...I.windowsAt(timeline, login.at), timeline.filter((x) => x.opened < login.at).pop()].filter(Boolean);
  assert.ok(before.some((x) => /back to Squire/i.test(x.text)), `the window before the Claude sign-in must tell the owner to come back to Squire afterwards; it said: ${show(before)}`);
});

test('on an Apple silicon Mac that opens Squire under Rosetta, set-up runs itself again as Apple silicon before it downloads anything, and every download is the Apple silicon build', LONG, async (t) => {
  const iw = I.makeInstallerWorld(t, { mac: { cpu: 'translated' } });
  const { run } = await setUp(iw);
  const parts = browserCurls(iw);
  assert.ok(parts.length >= 1, `set-up must download the browser's parts; ${I.describeRun(run)}`);
  const intel = parts.filter((c) => /x64|x86_64|intel/i.test(c.url));
  assert.deepEqual(intel.map((c) => c.url), [], 'under Rosetta on Apple silicon no Intel build may be downloaded');
  assert.ok(parts.filter((c) => /nodejs\.org|chrome/.test(c.url)).every((c) => /arm64/.test(c.url)), `the runtime and the browser build must be the arm64 builds; got ${JSON.stringify(parts.map((c) => c.url))}`);
  const reexec = callsAt(iw, (c) => c.cmd === 'arch' && c.argv[0] === '-arm64' && c.argv.some((a) => a.endsWith(path.join('Contents', 'MacOS', 'Squire'))));
  const firstDownload = callsAt(iw, (c) => c.cmd === 'curl')[0];
  assert.ok(reexec.length >= 1 && (!firstDownload || reexec[0].at < firstDownload.at),
    `set-up must run itself again through arch -arm64 before its first download, so what it builds and runs runs as Apple silicon; arch calls: ${JSON.stringify(callsAt(iw, (c) => c.cmd === 'arch'))}`);
});

test('on an Intel Mac, whether macOS answers it is not translated or cannot answer at all, set-up takes the Intel builds and never asks for Apple silicon', LONG, async (t) => {
  for (const cpu of ['intel', 'intel-unreadable']) {
    const iw = I.makeInstallerWorld(t, { mac: { cpu } });
    const { run } = await setUp(iw);
    const parts = browserCurls(iw).filter((c) => /nodejs\.org|chrome/.test(c.url));
    assert.ok(parts.length >= 1, `${cpu}: set-up must download the browser's parts; ${I.describeRun(run)}`);
    assert.ok(parts.every((c) => /x64/.test(c.url)), `${cpu}: the Intel builds must be taken; got ${JSON.stringify(parts.map((c) => c.url))}`);
    assert.deepEqual(callsAt(iw, (c) => c.cmd === 'arch' && c.argv[0] === '-arm64'), [], `${cpu}: an Intel Mac is never asked to run Apple silicon`);
  }
});

// Apple's own tools take some seconds here (the world's toolsInstall
// 'installsAfter'): its window is up for all of them, so set-up's window
// stays on screen under it, drawn before and not drawn again until they are
// done.
test("while Apple's own tools install, over the seconds they take, a Squire window is on screen at every moment and none is drawn again until they are done", LONG, async (t) => {
  const iw = I.makeInstallerWorld(t, { mac: { toolsPresent: false, toolsInstall: 'installsAfter', toolsInstallMs: 6000 } });
  const { run, timeline } = await setUp(iw);
  const tools = callsAt(iw, (c) => c.cmd === 'xcode-select' && c.argv.includes('--install'))[0];
  const toolsDone = tools ? callsAt(iw, (c) => c.cmd === 'xcode-select' && c.at > tools.at && c.present === true)[0] : null;
  assert.ok(tools && toolsDone && toolsDone.at - tools.at >= 5000,
    `set-up must ask for Apple's tools and see them installed some seconds later (the world's take 6 seconds); asked ${JSON.stringify(tools)}, seen ${JSON.stringify(toolsDone)}; ${I.describeRun(run)}`);
  const drawn = timeline.filter((x) => x.opened > tools.at + 200 && x.opened < toolsDone.at - 200);
  assert.deepEqual(drawn.map((x) => x.title), [], `no window may be drawn while Apple's own tools window is up; drawn: ${show(drawn)}`);
  assertNoGap(timeline, tools.at, toolsDone.at, `while Apple's own tools install, for the ${toolsDone.at - tools.at} ms they took`);
});

// The speech helper's build, on a Mac that can build it (macOS 26 and Apple's
// tools): the world's swiftc takes 4 seconds (mac.speechBuild).
test('while set-up builds the speech helper on a Mac that can build it, a Squire window naming the speech helper is on screen for the whole build', LONG, async (t) => {
  const iw = I.makeInstallerWorld(t, { mac: { macos: '26.1', speechBuild: { ms: 4000 } } });
  const { run, timeline } = await setUp(iw);
  const build = callsAt(iw, (c) => c.cmd === 'swiftc' && !c.ended)[0];
  const built = build ? callsAt(iw, (c) => c.cmd === 'swiftc' && c.ended && c.pid === build.pid)[0] : null;
  assert.ok(build && built, `set-up must build the speech helper on macOS 26 with Apple's tools (the world's swiftc); calls: ${JSON.stringify(callsAt(iw, (c) => ['xcrun', 'swiftc'].includes(c.cmd)))}; ${I.describeRun(run)}`);
  const up = I.windowsAt(timeline, build.at + 500);
  assert.ok(up.some((x) => /speech/i.test(x.text)), `while the speech helper builds, the window on screen must name what set-up is doing (the speech helper); on screen: ${show(up)}`);
  assertNoGap(timeline, build.at, built.at, 'while the speech helper builds');
});

// The evidence of an Apple silicon build this case accepts: an arm64 target
// in swiftc's arguments (-target arm64-..., or -arch arm64), or swiftc run
// as Apple silicon, as the world records it once set-up has run itself again
// through arch -arm64 (installer-world.js: swiftc's runsAs).
test('under Rosetta on an Apple silicon Mac, the speech helper set-up builds is an Apple silicon build', LONG, async (t) => {
  const iw = I.makeInstallerWorld(t, { mac: { cpu: 'translated', macos: '26.1', speechBuild: { ms: 1000 } } });
  const { run } = await setUp(iw);
  const builds = callsAt(iw, (c) => c.cmd === 'swiftc' && !c.ended);
  assert.ok(builds.length >= 1, `set-up must build the speech helper on macOS 26 with Apple's tools (the world's swiftc); calls: ${JSON.stringify(callsAt(iw, (c) => ['xcrun', 'swiftc', 'arch'].includes(c.cmd)))}; ${I.describeRun(run)}`);
  const targetsArm64 = (argv) => argv.some((a, i) => ((a === '-target' && /^arm64-/.test(argv[i + 1] || '')) || /^-target=arm64-/.test(a) || (a === '-arch' && argv[i + 1] === 'arm64')));
  const intel = builds.filter((c) => !(c.runsAs === 'arm64' || targetsArm64(c.argv)));
  assert.deepEqual(intel.map((c) => ({ runsAs: c.runsAs, argv: c.argv })), [],
    'under Rosetta on Apple silicon the speech helper must be built for Apple silicon: an arm64 target in swiftc\'s arguments, or swiftc run as Apple silicon once set-up has run itself again through arch -arm64');
});
