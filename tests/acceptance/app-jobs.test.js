'use strict';

// An app the owner said yes to: a one-page brief runs through plan, build,
// test and preview, a failed step keeps the work so far, and shipping the app
// still needs its own yes (AC-1302-2, its app half; the research half is in
// research-jobs.test.js). Building an app is the session's own work: the model
// plans, writes and tests, through tools the safety floor judges. What code
// decides is bound here, through the real entry points: lay-down (what the
// session loads, Squire's own block) and the safety floor as the session runs
// it (the PreToolUse hooks of the settings lay-down writes, the event on
// stdin, in the default mode and in auto mode).
//
// What the builder provides (none of it at the base head; a case fails at its
// own first assertion while it is absent):
//   Squire's own block in what the session loads tells the session, for an
//   app the owner said yes to:
//     - to start it only through Squire's job command, as app, which the
//       floor asks the owner for;
//     - to agree a one-page brief with the owner, then plan, build, test and
//       preview it, keeping the brief and the work as it goes in the app's
//       own folder in workspace/apps in the owner's folder;
//     - when a step of the build fails, to tell the owner in plain words which
//       step failed and that the work so far is kept in the app's folder, and
//       to pick up from that folder when the owner asks to resume, started
//       again through the job command, which asks the owner again;
//     - to preview the app on this Mac only, served on the loopback from the
//       app's own folder, never through Squire's page server, and only once
//       the floor has asked the owner;
//     - that shipping the app (putting it live, publishing or deploying it, or
//       pushing it anywhere) needs the owner's own yes for that, which the yes
//       to the job is not.
//   The floor lets the job write its brief and work in the app's folder, asks
//   before the preview server starts, and asks before a push or a deploy,
//   as today.
//
// Design decisions, on the fail-closed reading (each also a question in the
// return): an app's folder is workspace/apps/<name> in the owner's folder;
// the preview is a plain loopback server started from that folder, here
// Python's own http.server bound to 127.0.0.1 on a port the system picks.
// No case here serves a page: the preview's words and the floor's ask are
// what is bound.
//
// Usage model (assumptions, none measured): typical, a one-page brief, a
// plan, a handful of files, one test run and one preview; heavy, a build
// whose step fails part-way and is resumed once, which needs the owner's yes
// again (a yes covers one start), then a ship asked for separately.
//
// The class is open (any app, any failing step, any way to ship); these are
// instances. No case reaches a model, the network beyond this Mac's loopback
// or any host but this Mac.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const w = require('../fixtures/squire-world.js');
const U = require('../fixtures/usage-world.js');
const B = require('../fixtures/browser-world.js');

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

const appSentences = (sentences) => sentences.filter((x) => /\bapps?\b/i.test(x));

// The owner's yes to building an app, through the laid floor.
function startApp(world, floor, job, mode) {
  const first = floor.run(job, U.heavyJob(world, 'app'), mode);
  w.assertBlocked(first, `building an app, in ${mode} mode, with no yes`);
  assert.match(first.stderr, U.HEAVY.app, `the floor warns of building an app as a big job, in ${mode} mode; got ${w.describe(first)}`);
  U.sayYesTo(world, job, first, { env: U.UTC });
  w.assertAllowed(floor.run(job, U.heavyJob(world, 'app'), mode), `building an app, in ${mode} mode, once the owner said yes`);
}

test("an approved one-page app brief runs through plan, build, test and preview: what the session loads says so, the brief and the work kept in the app's own folder in workspace/apps, started only through the job command as app; the floor asks for the app job, starts it on the owner's yes and lets the job keep its brief and work in that folder", { timeout: 180000 }, (t) => {
  const world = laidWorld(t);
  const sentences = B.personaSentences(world);
  const apps = appSentences(sentences);
  const steps = apps.filter((x) => /brief/i.test(x) && /\bplan/i.test(x) && /\bbuild/i.test(x) && /\btest/i.test(x) && /preview/i.test(x));
  assert.ok(steps.length > 0, `Squire's own block must tell the session that an app the owner said yes to runs from a one-page brief through plan, build, test and preview; got ${JSON.stringify(apps)}`);
  assert.ok(apps.some((x) => /workspace\/apps/.test(x) && /kept|keep/i.test(x)), `it must say to keep the brief and the work as it goes in the app's own folder in workspace/apps; got ${JSON.stringify(apps)}`);
  assert.ok(sentences.some((x) => /job command/i.test(x) && /\bapp\b/.test(x)) || sentences.some((x) => /heavy-job․py[^`]*app|`[^`]*heavy-job[^`]*`/.test(x) && /\bapp\b/i.test(x)),
    `it must say an app starts only through Squire's job command, as app; got ${JSON.stringify(apps)}`);

  const floor = U.laidFloor(world, U.UTC);
  for (const mode of MODES) {
    const job = `job-app-${mode}`;
    startApp(world, floor, job, mode);
    const folder = path.join(world.owner, 'workspace', 'apps', `order-board-${mode}`);
    w.assertAllowed(floor.run(job, w.tools.write(path.join(folder, 'brief.md'), '# Order board\n\nOne page listing this week\'s cake orders.\n'), mode), `the app's one-page brief kept in its folder, in ${mode} mode`);
    w.assertAllowed(floor.run(job, w.tools.write(path.join(folder, 'plan.md'), '1. A page. 2. A list. 3. A test.\n'), mode), `the app's plan kept in its folder, in ${mode} mode`);
    w.assertAllowed(floor.run(job, w.tools.write(path.join(folder, 'index.html'), '<!doctype html><title>Orders</title><ul id="orders"></ul>\n'), mode), `the app's first file built in its folder, in ${mode} mode`);
  }
});

test("when a step of an app's build fails, what the session loads says to tell the owner plainly which step failed and that the work so far is kept in the app's folder, and to pick up from that folder to resume; the kept work stays, and a resumed build is a new start the floor asks the owner for again", { timeout: 180000 }, (t) => {
  const world = laidWorld(t);
  const sentences = B.personaSentences(world);
  const apps = appSentences(sentences);
  const failing = apps.filter((x) => /fail/i.test(x) && /step/i.test(x));
  assert.ok(failing.length > 0, `Squire's own block must tell the session what to do when a step of an app's build fails; got ${JSON.stringify(apps)}`);
  assert.ok(failing.some((x) => /kept|keep/i.test(x) && /plain/i.test(x)), `it must say to tell the owner in plain words which step failed and that the work so far is kept; got ${JSON.stringify(failing)}`);
  assert.ok(apps.some((x) => /resume|pick up/i.test(x) && /folder/i.test(x)), `it must say to pick up from the app's folder when the owner asks to resume; got ${JSON.stringify(apps)}`);

  const floor = U.laidFloor(world, U.UTC);
  for (const mode of MODES) {
    const job = `job-app-failing-${mode}`;
    startApp(world, floor, job, mode);
    const kept = path.join(world.owner, 'workspace', 'apps', `stock-count-${mode}`, 'index.html');
    w.assertAllowed(floor.run(job, w.tools.write(kept, '<!doctype html><title>Stock</title><p>Flour: 25 kg</p>\n'), mode), `the work so far kept in the app's folder, in ${mode} mode`);
    w.assertAllowed(floor.run(job, w.tools.read(kept), mode), `the kept work read back to resume, in ${mode} mode`);
    w.assertBlocked(floor.run(job, U.heavyJob(world, 'app'), mode), `resuming the app's build, in ${mode} mode, is a new start: the floor asks again`);
  }
});

test("shipping an app still needs its own yes: what the session loads says that putting the app live, publishing, deploying or pushing it waits for the owner's yes to that, which the yes to the job is not; and in the app job the owner said yes to, the floor still asks before a push or a deploy", { timeout: 180000 }, (t) => {
  const world = laidWorld(t);
  const sentences = B.personaSentences(world);
  const apps = appSentences(sentences);
  const ships = apps.filter((x) => /ship|live|publish|deploy|push/i.test(x) && /\byes\b/i.test(x));
  assert.ok(ships.length > 0, `Squire's own block must tell the session that shipping an app waits for the owner's own yes to that; got ${JSON.stringify(apps)}`);
  assert.ok(ships.some((x) => /own yes|separate|its own|not the (same|yes)|the yes to (the|that) (job|build)/i.test(x)), `it must say the yes to the job is not a yes to ship it; got ${JSON.stringify(ships)}`);

  const floor = U.laidFloor(world, U.UTC);
  for (const mode of MODES) {
    const job = `job-app-ship-${mode}`;
    startApp(world, floor, job, mode);
    const folder = path.join(world.owner, 'workspace', 'apps', `order-board-${mode}`);
    w.assertBlocked(floor.run(job, w.tools.bash(`git -C '${folder}' push https://git.example.net/ada/order-board.git main`), mode), `a push of the app, in ${mode} mode, inside the app job the owner said yes to`, 'git.example.net');
    w.assertBlocked(floor.run(job, w.tools.bash(`npx wrangler pages deploy '${folder}' --project-name order-board`), mode), `a deploy of the app, in ${mode} mode, inside the app job the owner said yes to`);
  }
});

test("an app's preview runs on this Mac on the loopback from the app's own folder, never through Squire's page server: what the session loads says so, and the floor asks the owner before the preview starts", { timeout: 180000 }, (t) => {
  const world = laidWorld(t);
  const sentences = B.personaSentences(world);
  const previews = sentences.filter((x) => /preview/i.test(x));
  assert.ok(previews.some((x) => /loopback|127․0․0․1|127\.0\.0\.1|this Mac only|on this Mac/i.test(x) && /folder/i.test(x)),
    `Squire's own block must tell the session that an app's preview runs on this Mac, on the loopback, from the app's own folder; got ${JSON.stringify(previews)}`);
  assert.ok(previews.some((x) => /page server/i.test(x) && /\b(never|not)\b/i.test(x)),
    `it must say the preview is never served through Squire's page server; got ${JSON.stringify(previews)}`);

  const floor = U.laidFloor(world, U.UTC);
  for (const mode of MODES) {
    const job = `job-app-preview-${mode}`;
    startApp(world, floor, job, mode);
    const folder = path.join(world.owner, 'workspace', 'apps', `order-board-${mode}`);
    w.assertBlocked(floor.run(job, w.tools.bash(`/usr/bin/python3 -m http.server 0 --bind 127.0.0.1 --directory '${folder}'`), mode),
      `the app's preview server starting, in ${mode} mode: the floor asks the owner first`);
  }
});
