'use strict';

// Squire's browser: by default it gives a website none of the owner's details,
// it signs in to the owner's accounts only on the owner's yes, and it runs in
// a window of its own on the Mac that the owner can watch and take over in
// (AC-1801-1, AC-1801-2). The browser is the session's tool: the model reads
// pages and decides what to type and click, through browser calls the safety
// floor judges. What code decides is bound here, through the real entry
// points: lay-down (what the session loads: Squire's own block, and Squire's
// browser set up in Squire's Claude Code config folder), and the safety floor
// as the session runs it (the PreToolUse hooks of the settings lay-down
// writes, the event on stdin), with each call the floor lets through carried
// out in a real headless browser against a test site on this Mac's loopback
// (tests/fixtures/browser-world.js). The suite runs headless; the visible
// window and the owner's takeover are shown on a real Mac at TEST.
//
// What the builder provides (none of it at the base head; a case fails at its
// own first assertion while it is absent):
//   The floor, for a browser call (any mcp__playwright__browser_* tool), by
//   default refuses one that carries any of the owner's details, whatever the
//   field is called and by whatever route (typed, filled in a form, set by a
//   script, or carried in an address), even when the owner said yes to that
//   call: a yes to a browser call is not a switch of this default. The
//   owner's details are what the owner's profile holds (operator/profile.md
//   in the owner's folder, which Squire's first conversation keeps); here the
//   name, email address, postal address, phone number and card number written
//   there as labelled lines, matched in any letter case and, for the phone
//   and card numbers, by their digits. Every other browser call is asked,
//   each on its own, and a browsing job makes many of them: a browser call
//   marks the job as holding untrusted input only, never as having read the
//   owner's private things merely by being a browser call, so the job's next
//   browser call is asked again on its own rather than refused as one job.
//   A job that has read the owner's private things by another route (the
//   owner's profile read, for one) and has taken in untrusted input is still
//   refused as one job at its next asked call, as for any other tool.
//   By default the floor also refuses, even after a yes, a browser call it
//   cannot check for the owner's details: one made while the owner's profile
//   cannot be read (unreadable, or not there yet), one that runs a script in
//   the page (_evaluate, whose text can build a value only when it runs), and
//   one that sends a file (_file_upload). In version 1 the owner uploads a
//   file by taking over the browser's window.
//   The owner's details are found wherever they are kept: in the profile,
//   whose details Squire's own block tells the guided first conversation to
//   keep, when the owner gives them, as labelled lines (name, email address,
//   postal address, phone number, card number); and the owner's first name,
//   which set-up keeps in squire.json in the owner's folder, which the floor
//   reads too. The choice, and why: the floor decides in code, and labelled
//   lines are a form it can match without guessing at prose; the first name
//   is the one detail set-up itself writes outside the profile.
//   Squire's own block in what the session loads tells the session that its
//   browser runs in a window of its own on the Mac, which the owner can watch
//   and take over in; that when the browser reaches a sign-in page it stops,
//   tells the owner which site wants a sign-in, and waits for the owner's yes
//   to that sign-in before it goes on; and never signs in without it. When
//   Squire cannot tell whether a page or a step would sign the owner in or
//   open an account (a "Continue with" button for an account held elsewhere,
//   with no password field, is one such shape), the block tells the session
//   to treat it as a sign-in: stop, tell the owner which site, and wait for
//   their yes.
//   Lay-down sets Squire's browser up in Squire's Claude Code config folder
//   (claude-config/.claude.json in the Squire home, its mcpServers): a
//   Playwright browser server, never run headless, with a profile of its own
//   (in the Squire home, or kept in memory), never the owner's own browser
//   profile. It is the only server there and is keyed playwright, so its
//   tools are the ones the floor guards; it never attaches to a browser
//   already running (no --cdp-endpoint, --extension or the like); and its
//   command and the browser it drives are the ones set-up wrote in the
//   browser's place, browser/ in the Squire home (the browser's
//   --executable-path, or PLAYWRIGHT_BROWSERS_PATH, inside it), so nothing
//   is fetched when it starts or at the browser's first use.
//
// Design decisions, on the fail-closed reading (each also a question in the
// return): the browser calls take the Playwright tools' names and inputs, as
// the floor's own cases name them; every call of one case's browsing is made
// in one job, each asked on its own and carried out on its own yes; a check
// that one call is refused outright is made as the first call of a job of its
// own, so that it is the call itself, not the job's earlier calls, that the
// floor refuses; the owner's details are read from the owner's profile.
//
// Usage model (assumptions, none measured): typical, one page with a form,
// a handful of calls; heavy, a page whose fields go by other names, filled
// field by field, by a script and through its address.
//
// The class is open (any field, any spelling, any page that is a sign-in);
// these are instances. No case reaches a model, a real website, the network
// beyond this Mac's loopback or any host but this Mac.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const w = require('../fixtures/squire-world.js');
const U = require('../fixtures/usage-world.js');
const B = require('../fixtures/browser-world.js');

const T = B.browserTools;
const { OWNER } = B;
const refsOf = (page) => Object.fromEntries(((page && page.elements) || []).map((e) => [e.name, e.ref]));
const decode = (s) => { try { return decodeURIComponent(String(s).replace(/\+/g, ' ')); } catch (e) { return String(s); } };

// The details a page asks for, with the owner's values for them.
const DETAILS = [
  ['name', OWNER.name],
  ['email address', OWNER.email],
  ['postal address', `${OWNER.street}, ${OWNER.town}, ${OWNER.postcode}`],
  ['phone number', OWNER.phone],
  ['card number', OWNER.card],
];

const MODES = ['default', 'auto'];

// A browser call the floor asked the owner about, with a request the owner
// could answer, and carried out once the owner said yes to it.
function assertAskedThenDone(r, what) {
  assert.equal(r.first.status, 2, `${what}: the browser call must be asked first; the floor said ${w.describe(r.first)}`);
  assert.ok(w.requestIdIn(r.first.stderr), `${what}: each browser call in the job must be asked on its own, with a request the owner can answer, never refused as one job; the floor said ${w.describe(r.first)}`);
  assert.ok(r.performed, `${what}: the browser call must go through on the owner's yes to it; the floor said ${w.describe(r.last)}`);
}

// A call the floor refuses outright: blocked with no request the owner could
// answer, and still blocked after the owner says yes.
function assertRefusedEvenAfterYes(world, floor, job, call, mode, what) {
  const first = floor.run(job, call, mode);
  w.assertBlocked(first, `${what}, in ${mode} mode`);
  assert.equal(w.requestIdIn(first.stderr), null, `${what}, in ${mode} mode: refused, not asked; got a request the owner could answer: ${w.describe(first)}`);
  w.ownerSays(world, job, 'yes', { env: U.UTC });
  const again = floor.run(job, call, mode);
  w.assertBlocked(again, `${what}, in ${mode} mode, even after the owner said yes`);
  assert.equal(w.requestIdIn(again.stderr), null, `${what}, in ${mode} mode, after a yes: still refused, not asked; got ${w.describe(again)}`);
}

test("a page on the loopback test site asking for a name, an email address, a postal address, a phone number and a card number gets none of the owner's details from Squire's browser, filled in as a form or typed field by field, though the owner said yes to each browser call; the page's own message field and its send button still go through, and no socket leaves the loopback", { skip: B.browserGate(), timeout: 300000 }, async (t) => {
  const world = B.laidWorld(t);
  const { site, call, beyond, browser } = await B.browserCase(t, world);
  t.after(() => t.diagnostic(`browser pid ${browser.pid}; held beyond the Mac ${JSON.stringify(browser.recorder.seen.map((s) => s.first))}`));

  const opened = await call('open', T.navigate(site.url('/order')));
  assert.ok(opened.performed, `Squire's browser must open the page on the owner's yes; the floor said ${w.describe(opened.last)}`);
  const refs = refsOf(opened.page);
  const fields = { 'name': 'Full name', 'email address': 'Email address', 'postal address': 'Postal address', 'phone number': 'Phone number', 'card number': 'Card number' };
  for (const label of [...Object.values(fields), 'Message', 'Send']) assert.ok(refs[label], `the page must show ${label}; got ${JSON.stringify(opened.page)}`);

  const message = await call('message', T.type('Message', refs.Message, 'Please send a brochure'));
  assert.ok(message.performed, `the page's own message field must be filled on the owner's yes; the floor said ${w.describe(message.last)}`);
  await call('details', T.fillForm(DETAILS.map(([what, value]) => ({ name: fields[what], ref: refs[fields[what]], value }))));
  for (const [what, value] of DETAILS) await call(`detail-${what}`, T.type(fields[what], refs[fields[what]], value));
  const sent = await call('send', T.click('Send', refs.Send));
  assert.ok(sent.performed, `the page's send button must go through on the owner's yes; the floor said ${w.describe(sent.last)}`);

  const posted = site.received.filter((r) => r.method === 'POST' && r.url.startsWith('/order'));
  assert.equal(posted.length, 1, `the site must receive the form once; it received ${JSON.stringify(site.received)}`);
  assert.match(decode(posted[0].body), /Please send a brochure/, `the page's own message field must reach the site; it received ${decode(posted[0].body)}`);
  const given = B.ownerDetailsIn(site.text());
  assert.deepEqual(given, [], `by default Squire's browser must supply none of the owner's details; the site received the owner's ${given.join(', ')}: ${decode(posted[0].body)}`);
  assert.deepEqual(beyond, [], `no socket of the browser may leave this Mac's loopback; lsof read ${JSON.stringify(beyond)}`);
});

test("a second page on the loopback test site that hides the asks under other names gets none of the owner's details from Squire's browser, typed field by field, set by a script in another letter case or carried in the page's address with the numbers run together, though the owner said yes to each browser call; the page's own question still goes through, and no socket leaves the loopback", { skip: B.browserGate(), timeout: 300000 }, async (t) => {
  const world = B.laidWorld(t);
  const { site, call, beyond, browser } = await B.browserCase(t, world);
  t.after(() => t.diagnostic(`browser pid ${browser.pid}; held beyond the Mac ${JSON.stringify(browser.recorder.seen.map((s) => s.first))}`));

  const opened = await call('open', T.navigate(site.url('/survey')));
  assert.ok(opened.performed, `Squire's browser must open the page on the owner's yes; the floor said ${w.describe(opened.last)}`);
  const refs = refsOf(opened.page);
  const hidden = ['Who should we thank', 'Where can we reply', 'Line one', 'Best number', 'Sixteen digits for the draw'];
  for (const label of [...hidden, 'Favourite loaf', 'Go']) assert.ok(refs[label], `the page must show ${label}; got ${JSON.stringify(opened.page)}`);

  const loaf = await call('loaf', T.type('Favourite loaf', refs['Favourite loaf'], 'Sourdough'));
  assert.ok(loaf.performed, `the page's own question must be answered on the owner's yes; the floor said ${w.describe(loaf.last)}`);
  for (let i = 0; i < hidden.length; i += 1) await call(`hidden-${i}`, T.type(hidden[i], refs[hidden[i]], DETAILS[i][1]));
  await call('script', T.evaluate(`() => { document.querySelector('[data-ref="${refs['Where can we reply']}"]').value = '${OWNER.email.toUpperCase()}'; }`));
  const go = await call('go', T.click('Go', refs.Go));
  assert.ok(go.performed, `the page's own button must go through on the owner's yes; the floor said ${w.describe(go.last)}`);
  const digits = (s) => s.replace(/[^0-9]/g, '');
  await call('address', T.navigate(site.url(`/survey-done?ref=${digits(OWNER.card)}&tel=${digits(OWNER.phone)}&to=${encodeURIComponent(OWNER.name)}`)));

  const answered = site.received.filter((r) => r.method === 'GET' && r.url.startsWith('/survey-done') && /a6=Sourdough/.test(r.url));
  assert.equal(answered.length, 1, `the site must receive the page's own answer once; it received ${JSON.stringify(site.received.map((r) => `${r.method} ${decode(r.url)}`))}`);
  const given = B.ownerDetailsIn(site.text());
  assert.deepEqual(given, [], `by default Squire's browser must supply none of the owner's details, whatever the field is called; the site received the owner's ${given.join(', ')}: ${JSON.stringify(site.received.map((r) => `${r.method} ${decode(r.url)} ${decode(r.body)}`))}`);
  assert.deepEqual(beyond, [], `no socket of the browser may leave this Mac's loopback; lsof read ${JSON.stringify(beyond)}`);
});

test("Squire's browser stops at a sign-in page on the loopback test site and does not sign in until the owner's yes for that sign-in: what the session loads says to stop there, tell the owner which site wants a sign-in and wait for their yes; the floor holds the call that would go on, the site records no sign-in before the yes, and after the yes the browser goes on and the site records the sign-in; no socket leaves the loopback", { skip: B.browserGate(), timeout: 300000 }, async (t) => {
  const world = B.laidWorld(t);
  const sentences = B.personaSentences(world);
  const stops = sentences.filter((x) => /browser/i.test(x) && /sign(-| )?in/i.test(x) && /\byes\b/i.test(x) && /stop|wait/i.test(x));
  assert.ok(stops.length > 0, `Squire's own block must tell the session that when its browser reaches a sign-in page it stops and waits for the owner's yes to that sign-in; got ${JSON.stringify(sentences.filter((x) => /browser|sign(-| )?in/i.test(x)))}`);
  assert.ok(stops.some((x) => /site|website/i.test(x)) || sentences.some((x) => /sign(-| )?in/i.test(x) && /which (site|website)/i.test(x)),
    `it must say to tell the owner which site wants the sign-in; got ${JSON.stringify(stops)}`);
  assert.ok(sentences.some((x) => /never/i.test(x) && /sign(-| )?in/i.test(x)), `it must say never to sign in without that yes; got ${JSON.stringify(stops)}`);

  const { site, browser, floor, call, beyond, job } = await B.browserCase(t, world);
  t.after(() => t.diagnostic(`browser pid ${browser.pid}; held beyond the Mac ${JSON.stringify(browser.recorder.seen.map((s) => s.first))}`));
  const opened = await call('open', T.navigate(site.url('/signin')));
  assert.ok(opened.performed, `Squire's browser must open the page on the owner's yes; the floor said ${w.describe(opened.last)}`);
  const refs = refsOf(opened.page);
  assert.ok(refs.Continue, `the sign-in page must show its Continue button; got ${JSON.stringify(opened.page)}`);
  assert.equal(site.signIns(), 0, 'no sign-in before the browser tries to go on');

  // In the same browsing job as the page was opened in.
  const goOn = T.click('Continue', refs.Continue);
  const first = floor.run(job, goOn);
  w.assertBlocked(first, 'the browser going on from the sign-in page before the owner\'s yes');
  assert.equal(site.signIns(), 0, 'the site must record no sign-in before the owner\'s yes');
  U.sayYesTo(world, job, first, { env: U.UTC });
  const again = floor.run(job, goOn);
  w.assertAllowed(again, 'the browser going on from the sign-in page once the owner said yes to that sign-in');
  const page = await B.perform(browser, goOn);
  assert.equal(site.signIns(), 1, `after the yes the browser goes on and the site records the sign-in once; it received ${JSON.stringify(site.received.map((r) => `${r.method} ${r.url}`))}`);
  assert.match(page.heading, /signed in/i, `the browser must be on the signed-in page; got ${JSON.stringify(page)}`);
  beyond.push(...B.offLoopbackSockets(browser));
  assert.deepEqual(beyond, [], `no socket of the browser may leave this Mac's loopback; lsof read ${JSON.stringify(beyond)}`);
});

test("Squire's browser is set up in what the session loads in a window of its own on the Mac that the owner can watch and take over in: a Playwright browser server in Squire's config folder, never headless, with a profile of its own and never the owner's browser profile, and what the session loads tells the session the owner can watch it and take over", { timeout: 120000 }, (t) => {
  const world = B.laidWorld(t);
  const file = path.join(world.home, 'claude-config', '.claude.json');
  let state = null;
  try { state = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { state = null; }
  const servers = (state && state.mcpServers) || {};
  const words = (s) => [s.command, ...(Array.isArray(s.args) ? s.args : [])].map(String);
  // Exactly one server, keyed playwright: its tools are then the
  // mcp__playwright__browser_* tools the floor guards, and no other server
  // gives the session a browser the floor does not know by name.
  assert.deepEqual(Object.keys(servers), ['playwright'], `lay-down must set Squire's one browser up in Squire's Claude Code config folder (${file}, mcpServers) as exactly one server, keyed playwright, so that its tools are the mcp__playwright__browser_* tools the safety floor guards; got ${state ? JSON.stringify(servers) : 'no readable file'}`);
  const server = servers.playwright;
  const args = words(server);
  const env = (server && typeof server.env === 'object' && server.env) || {};
  const valueOf = (flag) => {
    const i = args.findIndex((a) => a === flag || a.startsWith(`${flag}=`));
    return i < 0 ? null : (args[i].includes('=') ? args[i].split('=').slice(1).join('=') : args[i + 1]);
  };
  assert.ok(!args.some((a) => /^--headless(=|$)/.test(a)), `Squire's browser must run in a window the owner can see, never headless; got ${JSON.stringify(args)}`);
  const profile = valueOf('--user-data-dir');
  const own = args.includes('--isolated') || (profile && path.resolve(profile).startsWith(world.home + path.sep));
  assert.ok(own, `Squire's browser must have a profile of its own, in the Squire home or kept in memory, never the owner's browser profile; got ${JSON.stringify(args)}`);
  // A browser of its own, started by the server: never one already running.
  const attach = args.filter((a) => /^--(cdp-endpoint|cdp-header|extension|remote-debugging-(port|address|pipe)|ws-endpoint|browser-url|connect|endpoint)(=|$)/.test(a));
  assert.deepEqual(attach, [], `Squire's browser must never attach to a browser already running (the owner's or any other); got ${JSON.stringify(args)}`);
  assert.deepEqual(Object.keys(env).filter((k) => /CDP|EXTENSION|ENDPOINT|CONNECT/i.test(k)), [], `nor through the server's environment; got ${JSON.stringify(env)}`);
  // The server and the browser it drives are the ones set-up wrote in the
  // browser's place, browser/ in the Squire home; nothing is fetched when the
  // server starts or at the browser's first use.
  const place = path.join(world.home, 'browser');
  const inPlace = (p) => typeof p === 'string' && path.isAbsolute(p) && path.resolve(p).startsWith(place + path.sep);
  assert.ok(inPlace(server.command), `the browser server's command must be the one set-up wrote in the browser's place (${place}); got ${JSON.stringify(server.command)}`);
  assert.ok(!args.some((a) => /(^|\/)(npx|npm|pnpm|yarn|bunx|pipx|uvx)$/.test(a) || /^@playwright\/|@latest$/.test(a) || /^(--yes|-y)$/.test(a)),
    `nothing may be fetched when the browser server starts (no package run through npx or npm); got ${JSON.stringify(args)}`);
  assert.ok(inPlace(valueOf('--executable-path')) || inPlace(env.PLAYWRIGHT_BROWSERS_PATH),
    `the browser the server drives must be the one set-up wrote in ${place} (its --executable-path, or PLAYWRIGHT_BROWSERS_PATH, inside it), so none is downloaded at its first use; got ${JSON.stringify({ args, env })}`);

  const sentences = B.personaSentences(world);
  assert.ok(sentences.some((x) => /browser/i.test(x) && /window/i.test(x) && /watch/i.test(x) && /take (it )?over|takeover/i.test(x)),
    `Squire's own block must tell the session that its browser runs in a window of its own on the Mac, which the owner can watch and take over in; got ${JSON.stringify(sentences.filter((x) => /browser/i.test(x)))}`);
});

test("one browsing job on the loopback test site makes several calls in a row, each asked on its own and carried out on the owner's yes to it (opening the page, reading it, typing into the page's own field and clicking its button), in the default mode and in auto mode; a call in that same job carrying one of the owner's details is still refused, even after a yes, and the site receives the page's own message and none of the owner's details; no socket leaves the loopback", { skip: B.browserGate(), timeout: 300000 }, async (t) => {
  const world = B.laidWorld(t);
  for (const mode of MODES) {
    const { site, call, beyond, browser, floor, job } = await B.browserCase(t, world, { mode });
    t.after(() => t.diagnostic(`${mode}: browser pid ${browser.pid}; held beyond the Mac ${JSON.stringify(browser.recorder.seen.map((s) => s.first))}`));

    const opened = await call('open', T.navigate(site.url('/order')));
    assertAskedThenDone(opened, `opening the page, the job's first browser call, in ${mode} mode`);
    const read = await call('read', T.snapshot());
    assertAskedThenDone(read, `reading the page, the job's second browser call, in ${mode} mode`);
    const refs = refsOf(read.page);
    for (const label of ['Message', 'Email address', 'Send']) assert.ok(refs[label], `the page must show ${label}; got ${JSON.stringify(read.page)}`);
    const typed = await call('message', T.type('Message', refs.Message, 'Please send a brochure'));
    assertAskedThenDone(typed, `typing into the page's own message field, the job's third browser call, in ${mode} mode`);

    assertRefusedEvenAfterYes(world, floor, job, T.type('Email address', refs['Email address'], OWNER.email),
      mode, 'typing the owner\'s email address, in the same browsing job');

    const sent = await call('send', T.click('Send', refs.Send));
    assertAskedThenDone(sent, `clicking the page's send button, the job's next browser call, in ${mode} mode`);
    const posted = site.received.filter((r) => r.method === 'POST' && r.url.startsWith('/order'));
    assert.equal(posted.length, 1, `the site must receive the form once, in ${mode} mode; it received ${JSON.stringify(site.received)}`);
    assert.match(decode(posted[0].body), /Please send a brochure/, `the page's own message must reach the site, in ${mode} mode; it received ${decode(posted[0].body)}`);
    const given = B.ownerDetailsIn(site.text());
    assert.deepEqual(given, [], `by default Squire's browser must supply none of the owner's details, in ${mode} mode; the site received the owner's ${given.join(', ')}`);
    assert.deepEqual(beyond, [], `no socket of the browser may leave this Mac's loopback, in ${mode} mode; lsof read ${JSON.stringify(beyond)}`);
  }
});

test("by default Squire's browser does not make a call Squire cannot check for the owner's details: a script whose function builds what it sets only when it runs, a file upload of a file in the owner's folder, and, with the owner's profile unreadable or absent, a typed text, are each refused rather than asked, even after a yes, in the default mode and in auto mode, and the site receives nothing from them; no socket leaves the loopback", { skip: B.browserGate(), timeout: 300000 }, async (t) => {
  const world = B.laidWorld(t);
  const profile = path.join(world.owner, 'operator', 'profile.md');
  t.after(() => { try { fs.chmodSync(profile, 0o644); } catch (e) { /* gone */ } });
  for (const mode of MODES) {
    B.writeOwnerProfile(world);
    const { site, call, beyond, browser, floor } = await B.browserCase(t, world, { mode });
    t.after(() => t.diagnostic(`${mode}: browser pid ${browser.pid}; held beyond the Mac ${JSON.stringify(browser.recorder.seen.map((s) => s.first))}`));
    const opened = await call('open', T.navigate(site.url('/order')));
    assert.ok(opened.performed, `Squire's browser must open the page on the owner's yes, in ${mode} mode; the floor said ${w.describe(opened.last)}`);
    const refs = refsOf(opened.page);
    assert.ok(refs.Message, `the page must show Message; got ${JSON.stringify(opened.page)}`);

    // Each as the first call of a job of its own.
    const own = (what) => `job-browser-unchecked-${what}-${mode}`;
    const built = `() => { const el = document.querySelector('[data-ref="${refs.Message}"]'); el.value = ['Please', 'send', 'a', 'brochure'].join(' '); el.form.requestSubmit(); }`;
    assertRefusedEvenAfterYes(world, floor, own('script'), T.evaluate(built), mode, 'a browser script whose function builds what it sets only when it runs');
    const file = path.join(world.owner, 'workspace', 'files', 'notes.txt');
    assert.ok(fs.existsSync(file), `the owner's folder must hold ${file}`);
    assertRefusedEvenAfterYes(world, floor, own('upload'), T.fileUpload([file]), mode, 'a browser file upload of a file in the owner\'s folder');
    const text = T.type('Message', refs.Message, 'Please send a brochure');
    fs.chmodSync(profile, 0o000);
    assertRefusedEvenAfterYes(world, floor, own('unreadable'), text, mode, 'a typed text with the owner\'s profile unreadable');
    fs.chmodSync(profile, 0o644);
    fs.rmSync(profile);
    assertRefusedEvenAfterYes(world, floor, own('absent'), text, mode, 'a typed text with the owner\'s profile absent');

    const after = site.received.filter((r) => !(r.method === 'GET' && (r.url === '/order' || r.url === '/favicon.ico')));
    assert.deepEqual(after, [], `the site must receive nothing from a call Squire could not check, in ${mode} mode; it received ${JSON.stringify(after)}`);
    assert.deepEqual(beyond, [], `no socket of the browser may leave this Mac's loopback, in ${mode} mode; lsof read ${JSON.stringify(beyond)}`);
  }
});

test("when Squire cannot tell whether a page or a step would sign the owner in or open an account, its browser treats it as a sign-in: what the session loads says so, to stop, tell the owner which site and wait for their yes; and on a second shape of sign-in on the loopback test site, a Continue with button for a provider and no password field, the site records no sign-in before the owner's yes and one after it; no socket leaves the loopback", { skip: B.browserGate(), timeout: 300000 }, async (t) => {
  const world = B.laidWorld(t);
  const sentences = B.personaSentences(world);
  const unsure = sentences.filter((x) => /browser/i.test(x) && /sign(-| )?in/i.test(x) && /account/i.test(x) && /(cannot|can't|not) tell|unsure|not sure|uncertain/i.test(x));
  assert.ok(unsure.length > 0, `Squire's own block must tell the session that when its browser cannot tell whether a page or a step would sign the owner in or open an account, it treats it as a sign-in; got ${JSON.stringify(sentences.filter((x) => /sign(-| )?in|account/i.test(x)))}`);
  assert.ok(unsure.some((x) => /stop/i.test(x) && /\byes\b/i.test(x) && /site|website/i.test(x)),
    `it must say to stop there, tell the owner which site and wait for their yes; got ${JSON.stringify(unsure)}`);

  const { site, browser, floor, call, beyond, job } = await B.browserCase(t, world);
  t.after(() => t.diagnostic(`browser pid ${browser.pid}; held beyond the Mac ${JSON.stringify(browser.recorder.seen.map((s) => s.first))}`));
  const opened = await call('open', T.navigate(site.url('/join')));
  assert.ok(opened.performed, `Squire's browser must open the page on the owner's yes; the floor said ${w.describe(opened.last)}`);
  const button = 'Continue with Example ID';
  const refs = refsOf(opened.page);
  assert.ok(refs[button], `the page must show its ${button} button; got ${JSON.stringify(opened.page)}`);
  assert.ok(!opened.page.elements.some((e) => /password/i.test(e.name)), `this shape of sign-in has no password field; got ${JSON.stringify(opened.page)}`);

  const goOn = T.click(button, refs[button]);
  const first = floor.run(job, goOn);
  w.assertBlocked(first, 'the browser going on from a Continue with button before the owner\'s yes');
  assert.equal(site.signIns(), 0, 'the site must record no sign-in before the owner\'s yes');
  U.sayYesTo(world, job, first, { env: U.UTC });
  w.assertAllowed(floor.run(job, goOn), 'the browser going on from the Continue with button once the owner said yes');
  await B.perform(browser, goOn);
  assert.equal(site.signIns(), 1, `after the yes the browser goes on and the site records the sign-in once; it received ${JSON.stringify(site.received.map((r) => `${r.method} ${r.url}`))}`);
  beyond.push(...B.offLoopbackSockets(browser));
  assert.deepEqual(beyond, [], `no socket of the browser may leave this Mac's loopback; lsof read ${JSON.stringify(beyond)}`);
});

test("the owner's details are found wherever they are kept: what the session loads tells the guided first conversation to keep the owner's name, email address, postal address, phone number and card number, when the owner gives them, as labelled lines in the owner's profile; and the owner's first name, which set-up keeps in squire.json in the owner's folder, is refused in a browser call even after a yes while the profile holds it nowhere, in the default mode and in auto mode", { timeout: 120000 }, (t) => {
  const world = B.laidWorld(t);
  const sentences = B.personaSentences(world);
  const labelled = sentences.filter((x) => /profile/i.test(x) && /label/i.test(x));
  assert.ok(labelled.some((x) => /\bname\b/i.test(x) && /email/i.test(x) && /address/i.test(x) && /phone/i.test(x) && /card/i.test(x)),
    `Squire's own block must tell the guided first conversation to keep the owner's name, email address, postal address, phone number and card number, when the owner gives them, as labelled lines in the owner's profile; got ${JSON.stringify(sentences.filter((x) => /profile/i.test(x)))}`);

  const owner = JSON.parse(fs.readFileSync(path.join(world.owner, 'squire.json'), 'utf8'));
  assert.ok(owner.firstName, `set-up's squire.json in the owner's folder must hold the owner's first name; got ${JSON.stringify(owner)}`);
  fs.writeFileSync(path.join(world.owner, 'operator', 'profile.md'), '# About the owner\n\n- Runs a small bakery. Prefers short answers. Allergic to jargon.\n');
  const floor = U.laidFloor(world, U.UTC);
  for (const mode of MODES) {
    assertRefusedEvenAfterYes(world, floor, `job-browser-first-name-${mode}`, T.type('Message', 'e6', `Thanks, ${owner.firstName}`),
      mode, 'typing the owner\'s first name, kept by set-up in squire.json, as the first call of a browsing job');
  }
});

test("a browsing job that has also read the owner's private things by another route is still stopped as one job: with the owner's profile read before the job's first browser call, or after it, the job's next asked browser call is refused, not asked, even after a yes, in the default mode and in auto mode", { timeout: 120000 }, (t) => {
  const world = B.laidWorld(t);
  const floor = U.laidFloor(world, U.UTC);
  const profile = path.join(world.owner, 'operator', 'profile.md');
  const page = 'http://127.0.0.1:9/order';
  const harmless = T.type('Message', 'e6', 'Please send a brochure');
  for (const mode of MODES) {
    // The profile read first, then the browsing.
    const before = `job-browser-read-first-${mode}`;
    w.assertAllowed(floor.run(before, w.tools.read(profile), mode), `reading the owner's profile, in ${mode} mode`);
    const opened = floor.run(before, T.navigate(page), mode);
    w.assertBlocked(opened, `the job's first browser call after the profile was read, in ${mode} mode`);
    if (w.requestIdIn(opened.stderr)) {
      U.sayYesTo(world, before, opened, { env: U.UTC });
      w.assertAllowed(floor.run(before, T.navigate(page), mode), `the job's first browser call on the owner's yes, in ${mode} mode`);
    }
    assertRefusedEvenAfterYes(world, floor, before, harmless, mode, 'the next browser call in a job that read the owner\'s profile and then browsed');

    // The browsing first, then the profile read.
    const after = `job-browser-read-after-${mode}`;
    const first = floor.run(after, T.navigate(page), mode);
    w.assertBlocked(first, `the job's first browser call, in ${mode} mode`);
    U.sayYesTo(world, after, first, { env: U.UTC });
    w.assertAllowed(floor.run(after, T.navigate(page), mode), `the job's first browser call on the owner's yes, in ${mode} mode`);
    w.assertAllowed(floor.run(after, w.tools.read(profile), mode), `reading the owner's profile after browsing, in ${mode} mode`);
    assertRefusedEvenAfterYes(world, floor, after, harmless, mode, 'the next browser call in a job that browsed and then read the owner\'s profile');
  }
});
