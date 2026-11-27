'use strict';

// Setting Squire up and using it for the first time works end to end with
// the Claude Code that Claude's installer serves that day, whether Claude
// Code makes the session when its server starts or when the Squire owner
// first connects: once Squire's session server is live, set-up opens the
// address where the owner's first message starts the session, says what to
// do there (signing in again included, if Claude asks to check the device),
// and finishes on the session's own record.
//
// Every case opens set-up's app as Finder would, on the installer world's
// Mac of fakes (tests/fixtures/installer-world.js), with the world's launchd
// stand-in starting the runner from the agent lay-down writes, and the fake
// Claude Code under one of the two measured profiles (session-world.js). The
// world's open writes the client record the 2.1.332 profile's server reads:
// the page opened and, unless a case says otherwise, the owner's first
// message one second later. SQUIRE_FIRST_MESSAGE_WAIT_SECONDS, which the last two cases name, is a test setting, never a product bound: set-up's wait for the first message is 30 minutes.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const s = require('../fixtures/session-world.js');
const I = require('../fixtures/installer-world.js');

const { TITLES } = I;
const LONG = { timeout: 600000 };
const RUN = 420000;

const opens = (run) => I.callsOf(run, 'open').map((c) => ({ at: c.at, url: c.argv.find((a) => /^https?:\/\//.test(a)) || '' }));
const envAddressOf = (iw) => (s.environmentOf(iw.world) ? `environment=${s.environmentOf(iw.world)}` : null);
const recordsOf = (iw) => s.sessionRecords({ home: iw.squireHome });

test("set-up under Claude Code 2.1.332 opens, once its session server is live, the address of that server's own environment, never plain claude.ai/code, says to send a first message there and that Claude may ask to sign in again, and finishes on the session record the first message makes", LONG, async (t) => {
  const iw = I.makeInstallerWorld(t, { profile: '2.1.332' });
  const run = await I.runApp(iw, { timeout: RUN });
  const env = envAddressOf(iw);
  const opened = opens(run);
  const envOpen = opened.find((o) => env && o.url.startsWith('https://claude.ai/code') && o.url.includes(env));
  assert.ok(envOpen, `set-up must open the address of its server's own environment (claude.ai/code?${env || 'environment=<the id the server printed>'}), read from the server's output or its bridge pointer; ` +
    `it opened ${JSON.stringify(opened.map((o) => o.url))}; ${I.describeRun(run)}`);
  assert.ok(!opened.some((o) => o.url === 'https://claude.ai/code'), `plain claude.ai/code does not list an environment with no session yet; set-up must not open it; opened ${JSON.stringify(opened)}`);
  const told = I.windowTimeline(iw).filter((x) => x.opened >= envOpen.at - 5000 && /first message/i.test(x.text)
    && /sign in again|check (?:this|your) (?:Mac|device)/i.test(x.text));
  assert.ok(told.length >= 1, `a Squire window must tell the owner to send a first message in the page that opened, and that Claude may ask to sign in again to check the device; windows from then: ` +
    `${JSON.stringify(I.windowTimeline(iw).filter((x) => x.opened >= envOpen.at - 5000).map((x) => x.text.slice(-300)))}`);
  assert.ok(I.doneSteps(iw).includes('firstConversation'), `set-up must finish its first conversation step once the session exists; done ${JSON.stringify(I.doneSteps(iw))}; ${I.describeRun(run)}`);
  const made = recordsOf(iw);
  assert.equal(made.length, 1, `the session the owner's first message made must be recorded (one session record); got ${JSON.stringify(made)}`);
  assert.equal(I.dialogsTitled(run, TITLES.paused).length, 0, `set-up must not pause; ${I.describeRun(run)}`);
  assert.ok(I.dialogsTitled(run, TITLES.ready).length === 1, `set-up must end with its ready window; ${I.describeRun(run)}`);
});

test("set-up under Claude Code 2.1.319, whose server makes its session at start, still finishes its first conversation and opens Claude's page", LONG, async (t) => {
  const iw = I.makeInstallerWorld(t, { profile: '2.1.319' });
  const run = await I.runApp(iw, { timeout: RUN });
  assert.ok(I.doneSteps(iw).includes('firstConversation'), `set-up must finish under the eager profile; done ${JSON.stringify(I.doneSteps(iw))}; ${I.describeRun(run)}`);
  assert.ok(opens(run).some((o) => o.url.startsWith('https://claude.ai/code')), `set-up must open Claude's page; opened ${JSON.stringify(opens(run))}`);
  assert.equal(recordsOf(iw).length, 1, 'one session record');
  assert.equal(I.dialogsTitled(run, TITLES.paused).length, 0, `set-up must not pause; ${I.describeRun(run)}`);
});

test("set-up whose session server is never live within 2 minutes of its start pauses, and the paused window names the server's own last line", LONG, async (t) => {
  const iw = I.makeInstallerWorld(t, { profile: '2.1.332' });
  const LAST = 'The world\'s own last line: this Remote Control server never went live';
  iw.inner.set({ profile: '2.1.332', pointer: false, lastLine: LAST });
  const run = await I.runApp(iw, { timeout: RUN });
  const paused = I.dialogsTitled(run, TITLES.paused);
  assert.ok(paused.length >= 1, `set-up must pause when its server is never live; ${I.describeRun(run)}`);
  assert.ok(paused[paused.length - 1].text.includes(LAST), `the paused window must name the server's own last line ("${LAST}"); it said: ${paused[paused.length - 1].text}`);
  assert.ok(!I.doneSteps(iw).includes('firstConversation'), 'the first conversation step is not done');
});

test("while set-up waits for the owner's first message in the page it opened, it keeps its window up naming that page, and does not pause at 2 minutes or 2 and a half", LONG, async (t) => {
  const iw = I.makeInstallerWorld(t, { profile: '2.1.332', mac: { client: { text: null } } });
  let openedAt = null;
  const run = await I.runApp(iw, {
    timeout: RUN,
    killWhen: (x) => {
      if (openedAt === null) {
        const o = I.readJsonLines(x.callsFile).find((c) => c.cmd === 'open' && c.argv.some((a) => /environment=/.test(a)));
        if (o) openedAt = o.at;
      }
      return openedAt !== null && Date.now() - openedAt > 150000;
    },
  });
  const paused = I.dialogsTitled(run, TITLES.paused);
  assert.equal(paused.length, 0, `with the page open and no first message yet, set-up must keep waiting (its bound is 30 minutes, the owner's, not a machine's 2); it paused: ${paused.map((d) => d.text).join(' | ')}; ${I.describeRun(run)}`);
  assert.ok(openedAt !== null && run.killed, `set-up must have opened the environment's page and still be waiting 150 seconds later; ${I.describeRun(run)}`);
  const timeline = I.windowTimeline(iw);
  const gaps = I.gapsIn(timeline, openedAt, openedAt + 150000);
  assert.deepEqual(gaps, [], `a Squire window must be on screen for the whole wait; moments with none: ${JSON.stringify(gaps)}`);
  const waiting = I.windowsAt(timeline, openedAt + 140000);
  assert.ok(waiting.some((x) => /first message/i.test(x.text) && /claude\.ai\/code/.test(x.text)),
    `the window up while set-up waits must say it waits for the owner's first message and name the page (claude.ai/code...); on screen: ${JSON.stringify(waiting.map((x) => x.text.slice(-300)))}`);
});

// The wait's bound. SQUIRE_FIRST_MESSAGE_WAIT_SECONDS is a test setting the
// world hands set-up's app in its environment (runApp's env), so a case can
// reach the bound in seconds: set-up honours it in place of its own bound,
// which stays 30 minutes, and with it absent the waiting window says so.
const WAIT_SETTING = 'SQUIRE_FIRST_MESSAGE_WAIT_SECONDS';
const THIRTY_MINUTES = /\b(?:30|thirty) minutes\b|\bhalf an hour\b/i;

test("when the owner sends no first message within set-up's wait, shortened here by a test setting, a Squire window is up for the whole wait and the paused window takes its place at the bound, naming the page set-up opened", LONG, async (t) => {
  const WAIT = 20;
  const iw = I.makeInstallerWorld(t, { profile: '2.1.332', mac: { client: { text: null } } });
  const run = await I.runApp(iw, { timeout: RUN, env: { [WAIT_SETTING]: String(WAIT) } });
  const paused = I.dialogsTitled(run, TITLES.paused);
  assert.ok(paused.length >= 1, `with no first message, set-up must pause at the end of its wait; ${I.describeRun(run)}`);
  const env = envAddressOf(iw);
  const last = paused[paused.length - 1];
  assert.ok(env && last.text.includes(`claude.ai/code?${env}`),
    `the paused window must name the page set-up opened (claude.ai/code?${env || 'environment=<the id the server printed>'}), where the owner's first message still starts the session; it said: ${last.text}`);
  const open = opens(run).find((o) => o.url.includes(env));
  assert.ok(open, `set-up must have opened the environment's page before it paused; opened ${JSON.stringify(opens(run))}`);
  const timeline = I.windowTimeline(iw);
  const p = timeline.find((x) => x.pid === last.pid);
  const after = p.opened - open.at;
  assert.ok(after >= WAIT * 1000 - 2000 && after <= WAIT * 1000 + 15000, `the paused window must take the waiting window's place at the bound, ${WAIT} seconds after the page opened; it opened after ${after} ms`);
  const gaps = I.gapsIn(timeline, open.at, p.opened + 500);
  assert.deepEqual(gaps, [], `a Squire window must be on screen for the whole wait, the paused window opened before the waiting one closed; moments with none: ${JSON.stringify(gaps)}`);
  const waiting = I.windowsAt(timeline, open.at + (WAIT * 1000) / 2);
  assert.ok(waiting.some((x) => /first message/i.test(x.text)), `the window up during the wait must say set-up waits for the owner's first message; on screen: ${JSON.stringify(waiting.map((x) => x.text.slice(-300)))}`);
});

test("with no test setting, the window up while set-up waits for the owner's first message says how long it waits: 30 minutes", LONG, async (t) => {
  const iw = I.makeInstallerWorld(t, { profile: '2.1.332', mac: { client: { text: null } } });
  let openedAt = null;
  const run = await I.runApp(iw, {
    timeout: RUN,
    killWhen: (x) => {
      if (openedAt === null) {
        const o = I.readJsonLines(x.callsFile).find((c) => c.cmd === 'open' && c.argv.some((a) => /environment=/.test(a)));
        if (o) openedAt = o.at;
      }
      return openedAt !== null && Date.now() - openedAt > 10000;
    },
  });
  const timeline = I.windowTimeline(iw);
  const phone = timeline.filter((x) => x.title === TITLES.phone).pop();
  const fromPhone = timeline.filter((x) => phone && x.opened >= phone.opened);
  assert.ok(fromPhone.some((x) => /first message/i.test(x.text) && THIRTY_MINUTES.test(x.text)),
    `the window up while set-up waits for the owner's first message must say how long it waits (30 minutes); windows from the phone step on: ${JSON.stringify(fromPhone.map((x) => x.text.slice(-300)))}; ${I.describeRun(run)}`);
  assert.ok(openedAt !== null, `set-up must have opened the environment's page; ${I.describeRun(run)}`);
  const waiting = I.windowsAt(timeline, openedAt + 5000);
  assert.ok(waiting.some((x) => /first message/i.test(x.text) && THIRTY_MINUTES.test(x.text)),
    `5 seconds into the wait, the window on screen must say set-up waits 30 minutes for the first message; on screen: ${JSON.stringify(waiting.map((x) => x.text.slice(-300)))}`);
});
