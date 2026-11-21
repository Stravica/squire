'use strict';

// Squire keeps versions of what it builds for the owner, on this Mac only:
// after changes, an earlier version can be got back on request, the later
// ones are kept, and nothing leaves the Mac. Through the real entry points:
// Squire's versions command as the session runs it (its path in the Squire
// home, run by /usr/bin/python3, in the product's environment, from the
// owner's folder), and lay-down (what the session loads, Squire's own block,
// which names that command).
//
// What the builder provides (none of it at the base head; a case fails at its
// own first assertion while it is absent):
//   core/tools/versions.py, Squire's versions command, run as
//     versions.py keep '<folder>'    keeps a version of the folder as it is
//                                    now, exit 0;
//     versions.py list '<folder>'    one line for each version kept, oldest
//                                    first, each led by its number (1, 2,
//                                    ...), exit 0;
//     versions.py back '<folder>' <number>
//                                    puts the folder's files back as they were
//                                    at that version, exit 0, and keeps every
//                                    version kept so far, so a later one can
//                                    be got back too. Before it does, any
//                                    change made since the last keep is kept
//                                    as a version of its own (a new number),
//                                    so going back never loses work; and the
//                                    folder is left whole as that version
//                                    was: a file added since is gone.
//   The versions are kept on this Mac (in the Squire home or beside the
//   folder), never sent anywhere: no remote, no push, no upload.
//   Squire's own block in what the session loads names the command and tells
//   the session to keep a version of what it builds for the owner after each
//   change, and to get an earlier one back when the owner asks.
//   The safety floor lets the session run the command, as the session runs
//   it (/usr/bin/python3 '<Squire home>/core/tools/versions.py' keep or list
//   '<folder>', or back '<folder>' <number>), with no question asked and
//   without marking the job, when the one folder it names is an app's folder
//   in workspace/apps in the owner's folder: the command works on this Mac
//   only, going back first keeps any change not yet kept so it loses
//   nothing, and a command the floor asked for would mark the job as holding
//   the owner's private things and so cost the job its browsing and its web
//   reads. Any other folder (the owner's operator folder, Squire's home, a
//   path climbing out of an app's folder), any other verb, and any extra
//   argument or option is refused, not asked: a session cannot use the
//   command to copy or put back anything outside the place Squire builds in.
//
// Design decisions, on the fail-closed reading (each also a question in the
// return): the command's name, its three verbs and their output are this
// file's; an app's folder is workspace/apps/<name> in the owner's folder.
// The floor's cases run the command through the laid floor in an app job the
// owner said yes to (as app-jobs.test.js does), in the default mode and in
// auto mode; that the job is left unmarked is seen the way the floor shows
// it: a web fetch is let through, with no question, only while the job holds
// none of the owner's private things.
//
// Usage model (assumptions, none measured): typical, an app changed twice,
// the first version asked for back; heavy, the later version asked for again
// after that, so going back loses nothing.
//
// No case reaches a model, the network beyond this Mac's loopback or any host
// but this Mac: every proxy variable points at a recorder that counts any
// connection.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const w = require('../fixtures/squire-world.js');
const U = require('../fixtures/usage-world.js');
const M = require('../fixtures/media-world.js');
const B = require('../fixtures/browser-world.js');

const versionsScript = (world) => path.join(world.home, 'core', 'tools', 'versions.py');

test("after two changes to an app Squire built for the owner, the earlier version is got back on request through Squire's versions command, the later version is still kept and can be got back too, and nothing leaves the Mac", { timeout: 180000 }, async (t) => {
  const world = U.usageWorld(t);
  const net = await M.networkRecorder(t);
  const folder = path.join(world.owner, 'workspace', 'apps', 'order-board');
  const page = path.join(folder, 'index.html');
  const run = (args) => w.runPython(world, versionsScript(world), args, { env: net.env, timeout: 60000 });
  const versions = [
    '<!doctype html><title>Orders</title><p>First version: this week\'s orders.</p>\n',
    '<!doctype html><title>Orders</title><p>Second version: orders by day.</p>\n',
    '<!doctype html><title>Orders</title><p>Third version: orders by day, with totals.</p>\n',
  ];
  fs.mkdirSync(folder, { recursive: true });
  for (const [i, content] of versions.entries()) {
    fs.writeFileSync(page, content);
    const kept = run(['keep', folder]);
    assert.equal(kept.status, 0, `Squire's versions command must keep version ${i + 1} of the app; got ${w.describe(kept)}`);
  }
  const listed = run(['list', folder]);
  assert.equal(listed.status, 0, `the versions command must list the versions kept; got ${w.describe(listed)}`);
  const numbers = listed.stdout.split('\n').map((l) => (l.trim().match(/^(\d+)\b/) || [])[1]).filter(Boolean).map(Number);
  assert.deepEqual(numbers.slice(0, 3), [1, 2, 3], `the list must show the three versions kept, oldest first, each led by its number; got ${w.describe(listed)}`);

  const back = run(['back', folder, '1']);
  assert.equal(back.status, 0, `the first version must be got back on request; got ${w.describe(back)}`);
  assert.equal(fs.readFileSync(page, 'utf8'), versions[0], 'the app must be as it was at the first version');
  const after = run(['list', folder]);
  const still = after.stdout.split('\n').map((l) => (l.trim().match(/^(\d+)\b/) || [])[1]).filter(Boolean).map(Number);
  assert.ok([1, 2, 3].every((n) => still.includes(n)), `going back must keep every version kept so far; got ${w.describe(after)}`);
  const forward = run(['back', folder, '3']);
  assert.equal(forward.status, 0, `the later version must be got back too; got ${w.describe(forward)}`);
  assert.equal(fs.readFileSync(page, 'utf8'), versions[2], 'the app must be as it was at the third version');

  await w.sleep(200);
  assert.equal(net.seen.length, 0, `nothing may leave this Mac: reached the network ${net.seen.length} time(s)`);
});

test("going back to an earlier version first keeps any change made since the last keep as a version of its own, which can be got back, and leaves the app's folder whole as that earlier version was, a file added in a later version gone; nothing leaves the Mac", { timeout: 180000 }, async (t) => {
  const world = U.usageWorld(t);
  const net = await M.networkRecorder(t);
  const folder = path.join(world.owner, 'workspace', 'apps', 'order-board');
  const page = path.join(folder, 'index.html');
  const totals = path.join(folder, 'totals.js');
  const run = (args) => w.runPython(world, versionsScript(world), args, { env: net.env, timeout: 60000 });
  const numbersIn = (r) => r.stdout.split('\n').map((l) => (l.trim().match(/^(\d+)\b/) || [])[1]).filter(Boolean).map(Number);
  const first = '<!doctype html><title>Orders</title><p>First version: this week\'s orders.</p>\n';
  const second = '<!doctype html><title>Orders</title><p>Second version: orders with totals.</p><script src="totals.js"></script>\n';
  const added = 'document.title = "Orders: 3";\n';
  const unkept = '<!doctype html><title>Orders</title><p>Changed after the last keep: orders by day.</p><script src="totals.js"></script>\n';

  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(page, first);
  const one = run(['keep', folder]);
  assert.equal(one.status, 0, `Squire's versions command must keep version 1 of the app; got ${w.describe(one)}`);
  fs.writeFileSync(page, second);
  fs.writeFileSync(totals, added);
  const two = run(['keep', folder]);
  assert.equal(two.status, 0, `the versions command must keep version 2, with a file added; got ${w.describe(two)}`);
  fs.writeFileSync(page, unkept);
  const before = numbersIn(run(['list', folder]));

  const back = run(['back', folder, '1']);
  assert.equal(back.status, 0, `version 1 must be got back on request; got ${w.describe(back)}`);
  assert.deepEqual(fs.readdirSync(folder).sort(), ['index.html'], 'the app\'s folder must be whole as version 1 was: the file added in a later version is gone, and nothing else is there');
  assert.equal(fs.readFileSync(page, 'utf8'), first, 'the app must be as it was at version 1');
  const after = numbersIn(run(['list', folder]));
  const kept = after.filter((n) => !before.includes(n));
  assert.ok([1, 2].every((n) => after.includes(n)) && kept.length >= 1,
    `going back must first keep the change made since the last keep as a version of its own, and keep every version kept so far; listed ${JSON.stringify(before)} before and ${JSON.stringify(after)} after`);
  const again = run(['back', folder, String(Math.max(...kept))]);
  assert.equal(again.status, 0, `the change kept on the way back must be got back too; got ${w.describe(again)}`);
  assert.equal(fs.readFileSync(page, 'utf8'), unkept, 'the change made since the last keep must be got back as it was');
  assert.equal(fs.existsSync(totals) && fs.readFileSync(totals, 'utf8'), added, 'with the file added in version 2');

  await w.sleep(200);
  assert.equal(net.seen.length, 0, `nothing may leave this Mac: reached the network ${net.seen.length} time(s)`);
});

test("what the session loads names Squire's versions command and says to keep a version of what Squire builds for the owner after each change, kept on this Mac only, and to get an earlier version back when the owner asks", { timeout: 120000 }, (t) => {
  const world = U.usageWorld(t, { core: false });
  const laid = w.layDown(world, w.CORE);
  assert.equal(laid.status, 0, `laying down core must succeed; got ${w.describe(laid)}`);
  const sentences = B.personaSentences(world);
  const kept = sentences.filter((x) => /version/i.test(x));
  assert.ok(kept.some((x) => /versions․py|versions\.py/.test(x)), `Squire's own block must name Squire's versions command; got ${JSON.stringify(kept)}`);
  assert.ok(kept.some((x) => /keep/i.test(x) && /(each|every) change|after (each|every)/i.test(x)), `it must say to keep a version after each change to what Squire builds for the owner; got ${JSON.stringify(kept)}`);
  assert.ok(kept.some((x) => /back|earlier/i.test(x) && /ask/i.test(x)), `it must say to get an earlier version back when the owner asks; got ${JSON.stringify(kept)}`);
  assert.ok(kept.some((x) => /this Mac/i.test(x) && /\b(only|never|nothing)\b/i.test(x)), `it must say the versions stay on this Mac; got ${JSON.stringify(kept)}`);
});

// ---------------------------------------- the versions command through the floor

const MODES = ['default', 'auto'];

function laidWorld(t) {
  const world = U.usageWorld(t, { core: false });
  const laid = w.layDown(world, w.CORE);
  assert.equal(laid.status, 0, `laying down core must succeed; got ${w.describe(laid)}`);
  U.writeSnapshot(world, {
    fiveHour: { used: 30, resetsAt: U.onMinute(U.now() + 3 * 3600) },
    sevenDay: { used: 40, resetsAt: U.onMinute(U.now() + 4 * U.DAY) },
  });
  return world;
}

// The owner's yes to building an app, through the laid floor.
function startApp(world, floor, job, mode) {
  const first = floor.run(job, U.heavyJob(world, 'app'), mode);
  w.assertBlocked(first, `building an app, in ${mode} mode, with no yes`);
  U.sayYesTo(world, job, first, { env: U.UTC });
  w.assertAllowed(floor.run(job, U.heavyJob(world, 'app'), mode), `building an app, in ${mode} mode, once the owner said yes`);
}

const versionsCommand = (world, words) => `/usr/bin/python3 '${versionsScript(world)}' ${words}`;

function refusedNotAsked(r, what) {
  w.assertBlocked(r, what);
  assert.equal(w.requestIdIn(r.stderr), null, `${what}: refused, not asked; got a request the owner could answer: ${w.describe(r)}`);
}

test("through the safety floor, in an app job the owner said yes to, the session keeps, lists and gets back versions of an app's folder in workspace/apps with Squire's versions command, each with no question asked, in the default mode and in auto mode, and the job is left holding none of the owner's private things", { timeout: 180000 }, (t) => {
  const world = laidWorld(t);
  const floor = U.laidFloor(world, U.UTC);
  for (const mode of MODES) {
    const job = `job-app-versions-${mode}`;
    startApp(world, floor, job, mode);
    const folder = path.join(world.owner, 'workspace', 'apps', `order-board-${mode}`);
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, 'index.html'), '<!doctype html><title>Orders</title><p>This week\'s orders.</p>\n');
    for (const [what, words] of [
      ['keeping a version of the app', `keep '${folder}'`],
      ['listing the versions kept', `list '${folder}'`],
      ['getting version 1 back', `back '${folder}' 1`],
    ]) {
      const r = floor.run(job, w.tools.bash(versionsCommand(world, words)), mode);
      w.assertAllowed(r, `${what} with Squire's versions command, in ${mode} mode, in the app job the owner said yes to`);
      assert.equal(w.requestIdIn(r.stderr), null, `${what}, in ${mode} mode: no question the owner must answer; got ${w.describe(r)}`);
    }
    w.assertAllowed(floor.run(job, w.tools.webFetch('https://example.com/order-board-help'), mode),
      `a web fetch after the versions command, in ${mode} mode: the command must leave the job holding none of the owner's private things`);
  }
});

// A regression guard: the floor at the base head refuses every run of the
// versions command from the session, and letting an app's folder through
// must keep refusing, not asking, everything else.
test("through the safety floor, Squire's versions command on a folder outside workspace/apps (the owner's operator folder, Squire's home, a path climbing out of an app's folder), with a fourth verb, or with an extra argument or an option, is refused, not asked, in an app job the owner said yes to, in the default mode and in auto mode", { timeout: 180000 }, (t) => {
  const world = laidWorld(t);
  const floor = U.laidFloor(world, U.UTC);
  for (const mode of MODES) {
    const job = `job-app-versions-refused-${mode}`;
    startApp(world, floor, job, mode);
    const folder = path.join(world.owner, 'workspace', 'apps', `order-board-${mode}`);
    fs.mkdirSync(folder, { recursive: true });
    const outside = [
      ["the owner's operator folder", path.join(world.owner, 'operator')],
      ["Squire's home", world.home],
      ["a path climbing out of an app's folder", `${folder}/../../../operator`],
    ];
    for (const [where, place] of outside) {
      for (const words of [`keep '${place}'`, `list '${place}'`, `back '${place}' 1`]) {
        refusedNotAsked(floor.run(job, w.tools.bash(versionsCommand(world, words)), mode), `the versions command ${words.split(' ')[0]} on ${where}, in ${mode} mode`);
      }
    }
    for (const [what, words] of [
      ['a fourth verb', `delete '${folder}'`],
      ['keep with an extra argument', `keep '${folder}' '${path.join(world.owner, 'operator')}'`],
      ['list with an extra argument', `list '${folder}' extra`],
      ['back with an extra argument', `back '${folder}' 1 2`],
      ['keep with an option', `keep --all '${folder}'`],
      ['list with an option', `list --all '${folder}'`],
      ['back with an option', `back --force '${folder}' 1`],
    ]) {
      refusedNotAsked(floor.run(job, w.tools.bash(versionsCommand(world, words)), mode), `the versions command with ${what}, in ${mode} mode`);
    }
  }
});
