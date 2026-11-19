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
//                                    be got back too.
//   The versions are kept on this Mac (in the Squire home or beside the
//   folder), never sent anywhere: no remote, no push, no upload.
//   Squire's own block in what the session loads names the command and tells
//   the session to keep a version of what it builds for the owner after each
//   change, and to get an earlier one back when the owner asks.
//
// Design decisions, on the fail-closed reading (each also a question in the
// return): the command's name, its three verbs and their output are this
// file's; an app's folder is workspace/apps/<name> in the owner's folder.
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
