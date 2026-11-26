'use strict';

// What the connector and record cases share, on top of the base world
// (squire-world.js), the usage world (usage-world.js) and the loopback
// connector stand-in (connector-stand-in.js). Nothing here imports or copies
// product logic.
//
// What the cases pin, each decided on the fail-closed reading under the
// owner's standard and named here (none is in a design record yet):
//   The owner's classes  connectorTools in the owner's squire.json:
//                        { read: [exact full tool names Squire may read
//                        with], draft: [exact full tool names that only
//                        draft] }. A tool counts as allowed or drafting only
//                        by its exact full name as the owner set it; every
//                        other connector tool is one that acts.
//   Squire's command     core/tools/connector-tools.py, run by the session
//                        only as one command, on the owner's yes (the floor
//                        asks first, naming the tools):
//                          connector-tools.py read <tool name> [...]
//                          connector-tools.py draft <tool name> [...]
//                          connector-tools.py remove <tool name> [...]
//                        read and draft add the exact names given to their
//                        class, remove takes them off both; each says in one
//                        line what it set, naming the tools, and every other
//                        setting of the file stays as it was.
//   The floor's rule     an allowed read runs with no ask and leaves its job
//                        holding untrusted input and the owner's private
//                        things; a draft tool runs with no ask and no mark;
//                        every other connector tool is asked, naming the
//                        tool, and once it runs its job holds untrusted input
//                        and private things.
//   The record           workspace/pages/squire-record.md in the owner's
//                        folder, a Markdown page the page server shows, written
//                        only by Squire's floor and hooks. Each decision is one
//                        list line ("- ...") holding its time (UTC, as
//                        2026-11-24T21:40:03Z), "job <job>", the decision, the
//                        tool and the target the floor names (a recipient, a
//                        folder, a site), with no message body and no secret.
//                        The decision is one of: asked <request> (an ask);
//                        answered yes <request> or answered no <request> (the
//                        owner's answer); used <request> (a yes used); refused
//                        (a refusal, with its reason); split (refused as one
//                        job); ran (a connector call that ran with no ask).
// Usage model (assumptions, none measured): typical, one connector for mail
// and one for the calendar, two or three reads allowed and one draft tool,
// a morning check-in reading mail and a reply drafted then sent on a yes;
// heavy, every acting tool of both connectors used in one day in both
// permission modes, words in mail and invites that try to steer Squire, and
// a record that cannot be written. No case reaches a model, a mail or
// calendar account, or any host but this Mac.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const w = require('./squire-world.js');
const U = require('./usage-world.js');
const C = require('./connector-stand-in.js');

const T = C.TOOLS;
const READS = [T.list, T.read, T.readInvite];
const ACTS = [T.send, T.reply, T.forward, T.deleteMessage, T.answerInvite, T.createEvent, T.changeEvent, T.deleteEvent];
const MODES = ['default', 'auto'];

// The input a case gives each tool.
const INPUT = {
  [T.list]: { folder: 'inbox', max: 10 },
  [T.read]: { message_id: 'm-1' },
  [T.draft]: { to: 'alice@example.com', subject: 'Saturday order', body: 'The cake is ready on Saturday.' },
  [T.send]: { to: 'alice@example.com', subject: 'Saturday order', body: 'The cake is ready on Saturday.' },
  [T.reply]: { message_id: 'm-2', body: 'Yes, it is ready.' },
  [T.forward]: { message_id: 'm-1', to: 'bob@example.com', body: 'For the bakery file.' },
  [T.deleteMessage]: { message_id: 'm-1' },
  [T.readInvite]: { invite_id: 'i-1' },
  [T.answerInvite]: { invite_id: 'i-1', answer: 'accept' },
  [T.createEvent]: { title: 'Wedding cake tasting', starts: '2026-12-02T15:00:00Z', ends: '2026-12-02T16:00:00Z', guests: ['carol@example.com'] },
  [T.changeEvent]: { event_id: 'e-1', starts: '2026-12-03T15:00:00Z', title: 'Wedding cake tasting' },
  [T.deleteEvent]: { event_id: 'e-1' },
};
const callOf = (tool, input = INPUT[tool] || {}) => w.tools.mcp(tool, input);

// A laid world (core laid down, as the session runs it), a connector
// stand-in and the floor as the session runs it. classes: the owner's own
// earlier choice, planted in their squire.json ({ read, draft }); none, no
// connectorTools at all.
function connectorWorld(t, { classes = null, messages, invites, annotations } = {}) {
  const world = U.usageWorld(t, { core: false });
  const done = w.layDown(world, w.CORE);
  assert.equal(done.status, 0, `laying down core must succeed; got ${w.describe(done)}`);
  U.writeSnapshot(world, {
    fiveHour: { used: 30, resetsAt: U.onMinute(U.now() + 3 * 3600) },
    sevenDay: { used: 40, resetsAt: U.onMinute(U.now() + 4 * U.DAY) },
  });
  const options = {};
  if (messages) options.messages = messages;
  if (invites) options.invites = invites;
  if (annotations) options.annotations = annotations;
  const connector = C.startConnector(t, world, options);
  if (classes) w.classConnectorTools(world, classes);
  const floor = U.laidFloor(world, U.UTC);
  return { world, connector, floor };
}

// A call as the session makes it: the floor first, as the session runs it;
// only a call the floor lets through is handed to the connector.
function call(ctx, job, toolCall, mode = 'default') {
  const r = ctx.floor.run(job, toolCall, mode);
  if (r.status !== 0) return { r, ran: false, answer: null };
  return { r, ran: true, answer: ctx.connector.call(toolCall[0], toolCall[1]) };
}

const yes = (ctx, job, r) => U.sayYesTo(ctx.world, job, r, { env: U.UTC });
const say = (ctx, job, words) => w.ownerSays(ctx.world, job, words, { env: U.UTC });

function assertFree(r, what) {
  w.assertAllowed(r, what);
}

function assertAsked(r, what, mentions = []) {
  w.assertBlocked(r, `${what}, with no yes`);
  assert.ok(w.requestIdIn(r.stderr), `${what}: expected it to be asked, with a request the owner can answer; got ${w.describe(r)}`);
  assert.doesNotMatch(r.stderr, /split/i, `${what}: expected it to be asked, not split; got ${w.describe(r)}`);
  for (const m of mentions) assert.ok(r.stderr.includes(m), `${what}: the question must name ${m}; got ${w.describe(r)}`);
}

function assertSplit(r, what, mentions = []) {
  w.assertBlocked(r, what);
  assert.match(r.stderr, /split/i, `${what}: expected it refused as one job, saying the work must be split; got ${w.describe(r)}`);
  for (const m of mentions) assert.ok(r.stderr.includes(m), `${what}: the refusal must name ${m}; got ${w.describe(r)}`);
}

// Squire's connector-tools command: as the session spells it for the floor,
// and as the session runs it once the floor lets it.
const connectorToolsScript = (world) => path.join(world.home, 'core', 'tools', 'connector-tools.py');
const connectorToolsCommand = (world, verb, names) => `/usr/bin/python3 '${connectorToolsScript(world)}' ${verb} ${names.join(' ')}`;
const runConnectorTools = (world, verb, names) => w.runPython(world, connectorToolsScript(world), [verb, ...names], { timeout: 30000 });

// The owner sets a class through the command, on his yes, in a job of its
// own: asked first naming every tool, then let through on the yes, then run.
function ownerClasses(ctx, verb, names, mode = 'default') {
  const job = `job-owner-${verb}-${Math.random().toString(16).slice(2, 8)}`;
  const command = w.tools.bash(connectorToolsCommand(ctx.world, verb, names));
  const asked = ctx.floor.run(job, command, mode);
  assertAsked(asked, `Squire's connector-tools command (${verb}) run by the session`, names);
  yes(ctx, job, asked);
  w.assertAllowed(ctx.floor.run(job, command, mode), `Squire's connector-tools command (${verb}), once the owner said yes`);
  const r = runConnectorTools(ctx.world, verb, names);
  assert.doesNotMatch(`${r.stderr}\n${r.error}`, /can't open file|No such file or directory|Traceback \(most recent call last\)/,
    `Squire's connector-tools command (core/tools/connector-tools.py ${verb}) must run; got ${w.describe(r)}`);
  assert.equal(r.status, 0, `the connector-tools command sets the owner's ${verb} class; got ${w.describe(r)}`);
  for (const n of names) assert.ok(r.stdout.includes(n), `it says what it set, naming ${n}; got ${w.describe(r)}`);
  return r;
}

// The owner's classes as kept in their squire.json.
function classesKept(world) {
  try {
    const data = JSON.parse(fs.readFileSync(path.join(world.owner, 'squire.json'), 'utf8'));
    return data.connectorTools || null;
  } catch (e) {
    return null;
  }
}

// The record.
const recordFile = (world) => path.join(world.owner, 'workspace', 'pages', 'squire-record.md');
function recordText(world) {
  const file = recordFile(world);
  try { return fs.statSync(file).isFile() ? fs.readFileSync(file, 'utf8') : null; } catch (e) { return null; }
}
function recordLines(world) {
  const text = recordText(world);
  assert.notEqual(text, null, `Squire's record must be in the owner's folder at workspace/pages/squire-record.md, written by the floor and hooks; there is no such page`);
  return text.split('\n').filter((l) => /^\s*[-*]\s+\S/.test(l));
}
const TIME = /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z\b/;
const linesOfJob = (world, job) => recordLines(world).filter((l) => l.includes(`job ${job}`));

module.exports = {
  T,
  MESSAGE_BODY: C.MESSAGES[0].body,
  READS,
  ACTS,
  MODES,
  INPUT,
  callOf,
  connectorWorld,
  call,
  yes,
  say,
  assertFree,
  assertAsked,
  assertSplit,
  connectorToolsScript,
  connectorToolsCommand,
  runConnectorTools,
  ownerClasses,
  classesKept,
  recordFile,
  recordText,
  recordLines,
  linesOfJob,
  TIME,
};
