'use strict';

// Video and audio work uses YouTube captions and the Squire owner's own
// files, transcribed on the Mac, and never downloads a YouTube video
// (AC-1701-1); a missing or unreadable file of the owner's stops the job with
// an explanation, with nothing downloaded and nothing changed (AC-1701-2).
// Through the real entry points: lay-down (what the session loads), the
// safety floor as the session runs it (the PreToolUse hooks of the settings
// lay-down writes, the event on stdin), and the two commands below, run as
// the session runs a command once the floor lets it through (a process with
// /usr/bin/python3 from the Squire home, in the product's environment).
//
// What the builder provides (none of it exists at the base head; the names
// are this file's, and a case fails at its own first assertion while they
// are absent):
//   core/tools/captions.py '<YouTube link>'
//       the captions reader: reads the captions of the one video the link
//       names, from YouTube's own watch page and the caption track it lists
//       (the routes the stand-in in tests/fixtures/media-world.js answers),
//       keeps them in the owner's folder (where is the builder's) and says
//       where, exit 0. It never asks for the video or its audio. When the
//       video has no captions, or YouTube refuses (any answer of 400 or more),
//       it stops at once with no further request of any kind (no second try,
//       no other identity, no cookie or login from a browser, no access
//       token, no proxy, no other transcript service), exits non-zero, and
//       says that it cannot, offering the two honest routes: paste the
//       transcript from YouTube's own "Show transcript", or give Squire your
//       own file. The origin it reads from is https://www.youtube.com, or the
//       one SQUIRE_YOUTUBE_ORIGIN names (the stand-in's seam).
//   core/tools/transcribe.py '<file>'
//       the one local speech engine for the owner's own audio and video files
//       and for voice notes: transcribes the file on the Mac through the
//       engine (the stand-in's seam is SQUIRE_SPEECH_ENGINE, as the media
//       world describes), keeps the text as a note in the owner's folder
//       (where is the builder's), says where, exit 0. A file that is missing
//       or cannot be read stops it before the engine runs: a plain reason,
//       a non-zero exit, nothing downloaded and no file in the owner's folder
//       changed.
//   What the session loads names both, each as one command in a code span
//   inside Squire's own block, its path in quotes and a <placeholder> for the
//   link or the file, as the health check and the job command are named:
//   /usr/bin/python3 '<Squire home>/core/tools/captions.py' '<YouTube link>'
//   and /usr/bin/python3 '<Squire home>/core/tools/transcribe.py' '<file>'.
//   Fed to the floor exactly as written (placeholder filled), each is free or
//   asked, never refused, in the default permission mode and in auto mode; a
//   video job starts through Squire's one job command (heavy-job.py media),
//   which the floor asks for.
//
// Usage model: typical, one video or one recording a request; heavy, a
// request for a whole playlist or channel, which the reader never takes (one
// video per request; a playlist or channel link is outside this criterion's
// present wording and is proposed as a wording change, not tested here).
//
// The class is open (any link, any file, any answer YouTube gives); these are
// instances, and the answer for any answer the reader cannot use is to stop
// and say so. No case reaches the network beyond this Mac's loopback, a real
// speech engine, real YouTube or a model.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const w = require('../fixtures/squire-world.js');
const U = require('../fixtures/usage-world.js');
const M = require('../fixtures/media-world.js');

const captionsScript = (world) => path.join(world.home, 'core', 'tools', 'captions.py');
const transcribeScript = (world) => path.join(world.home, 'core', 'tools', 'transcribe.py');
const ROUTES = /Show transcript/i;
const OWN_FILE = /own (audio |video )?(file|recording)/i;
const MODES = ['default', 'auto'];

function run(world, script, args, env) {
  return w.runPython(world, script, args, { env, timeout: 60000 });
}

// The commands Squire's instructions name, read from what lay-down wrote for
// the session: every code span of Squire's own block.
function personaSpans(world) {
  const loaded = fs.readFileSync(path.join(world.home, 'claude-config', 'CLAUDE.md'), 'utf8');
  const open = loaded.indexOf('<!-- squire persona -->');
  const close = loaded.indexOf('<!-- end squire persona -->');
  const block = open >= 0 && close > open ? loaded.slice(open, close) : '';
  return [...block.matchAll(/`([^`\n]+)`/g)].map((m) => m[1]);
}

const said = (r) => `${r.stdout}\n${r.stderr}`;

test("a YouTube video's captions are read from its own page and kept in the owner's folder, on one request to the video's page and its caption track, with no video or audio asked for and nothing sent beyond this Mac", { timeout: 120000 }, async (t) => {
  const world = U.usageWorld(t);
  const yt = await M.youtubeStandIn(t);
  const net = await M.networkRecorder(t);
  const r = run(world, captionsScript(world), [yt.link(M.VIDEOS.captioned)], { ...yt.env, ...net.env });
  assert.equal(r.status, 0, `the captions reader (core/tools/captions.py '<YouTube link>') must read the video's captions and exit 0; got ${w.describe(r)}`);
  const kept = w.filesHolding([world.owner], yt.captionWords.split('. ')[1]);
  assert.ok(kept.length > 0, `the captions must be kept in the owner's folder; no file there holds them; requests: ${JSON.stringify(yt.requests.map((q) => q.url))}`);
  const paths = yt.requests.map((q) => new URL(q.url, yt.origin).pathname);
  assert.deepEqual([...new Set(paths)].sort(), ['/api/timedtext', '/watch'], `only the video's page and its caption track may be asked for; got ${JSON.stringify(yt.requests.map((q) => q.url))}`);
  for (const q of yt.requests) {
    assert.equal(q.headers.cookie, undefined, `no request may carry a cookie or a login; got ${JSON.stringify(q.headers)}`);
    const u = new URL(q.url, yt.origin);
    assert.ok(!['pot', 'po_token', 'token'].some((k) => u.searchParams.has(k)), `no request may carry an access token; got ${q.url}`);
  }
  assert.deepEqual(M.mediaFiles(world.owner).filter((f) => !f.includes(`${path.sep}workspace${path.sep}files${path.sep}`)), [], 'no video or audio may be downloaded into the owner\'s folder');
  await w.sleep(200);
  assert.equal(net.seen.length, 0, `nothing may be sent beyond this Mac: the reader reached the network ${net.seen.length} time(s)`);
});

test("for a video with no captions, and for a video YouTube refuses, Squire downloads no video or audio, makes no further request after the refusal, says it cannot and offers the two honest routes: the transcript from YouTube's own Show transcript, or the owner's own file", { timeout: 120000 }, async (t) => {
  const world = U.usageWorld(t);
  const yt = await M.youtubeStandIn(t);
  const net = await M.networkRecorder(t);
  const before = M.digestOf(world.owner);
  for (const [what, id] of [['a video with no captions', M.VIDEOS.uncaptioned], ['a video YouTube refuses', M.VIDEOS.refused]]) {
    const from = yt.requests.length;
    const r = run(world, captionsScript(world), [yt.link(id)], { ...yt.env, ...net.env });
    assert.notEqual(r.status, 0, `${what}: the captions reader must stop with a non-zero exit; got ${w.describe(r)}`);
    assert.doesNotMatch(r.stderr, /Traceback|can't open file/, `${what}: the captions reader must stop with its own words, never a crash; got ${w.describe(r)}`);
    assert.match(said(r), /cannot|can't|could not|couldn't/i, `${what}: Squire must say it cannot; got ${w.describe(r)}`);
    assert.match(said(r), ROUTES, `${what}: Squire must offer the transcript from YouTube's own "Show transcript"; got ${w.describe(r)}`);
    assert.match(said(r), OWN_FILE, `${what}: Squire must offer the owner's own file; got ${w.describe(r)}`);
    const asked = yt.requests.slice(from);
    const paths = asked.map((q) => new URL(q.url, yt.origin).pathname);
    assert.ok(paths.every((p) => p === '/watch'), `${what}: only the video's page may be asked for; got ${JSON.stringify(asked.map((q) => q.url))}`);
    const refusedAt = asked.findIndex((q) => new URL(q.url, yt.origin).searchParams.get('v') === M.VIDEOS.refused);
    if (refusedAt >= 0) {
      assert.equal(asked.length, refusedAt + 1, `${what}: after YouTube's refusal no further request may be made (no second try, no other identity, token, cookie or proxy); got ${JSON.stringify(asked.map((q) => ({ url: q.url, ua: q.headers['user-agent'] })))}`);
    }
    for (const q of asked) assert.equal(q.headers.cookie, undefined, `${what}: no request may carry a cookie or a login`);
  }
  assert.deepEqual(M.mediaFiles(world.root).filter((f) => !f.startsWith(path.join(world.owner, 'workspace', 'files'))), [], 'no video or audio may be downloaded anywhere');
  assert.deepEqual(M.changedIn(before, M.digestOf(world.owner)), [], 'nothing in the owner\'s folder may change when Squire cannot read the captions');
  await w.sleep(200);
  assert.equal(net.seen.length, 0, `nothing may be sent beyond this Mac: the reader reached the network ${net.seen.length} time(s)`);
});

test("the owner's own recording is transcribed on the Mac by the one local speech engine and the text kept in the owner's folder, the recording left as it was and nothing sent beyond this Mac", { timeout: 120000 }, async (t) => {
  const world = U.usageWorld(t);
  const engine = M.speechEngine(world);
  const net = await M.networkRecorder(t);
  const recording = M.fixtureRecording(path.join(world.owner, 'workspace', 'files', 'shop-meeting.wav'));
  const bytes = fs.readFileSync(recording);
  const r = run(world, transcribeScript(world), [recording], { ...engine.env, ...net.env });
  assert.equal(r.status, 0, `Squire's transcription (core/tools/transcribe.py '<file>') must transcribe the owner's own file and exit 0; got ${w.describe(r)}`);
  const calls = engine.calls();
  assert.equal(calls.length, 1, `the one local speech engine must be run once for the file; got ${JSON.stringify(calls)}`);
  assert.ok(calls[0].read === bytes.length, `the engine must be given the recording itself (or a copy of it) on the Mac; got ${JSON.stringify(calls[0])}`);
  const kept = w.filesHolding([world.owner], engine.text.split(' ').pop());
  assert.ok(kept.some((f) => f !== recording), `the text must be kept as a note in the owner's folder; no file there holds it; got ${w.describe(r)}`);
  assert.ok(fs.readFileSync(recording).equals(bytes), 'the owner\'s recording must be left as it was');
  await w.sleep(200);
  assert.equal(net.seen.length, 0, `nothing may be sent beyond this Mac: the transcription reached the network ${net.seen.length} time(s)`);
});

test("the captions reader and the transcription, each named by what the session loads, are free or asked by the safety floor as the session runs it, never refused, in the default mode and in auto mode; a video job starts through Squire's one job command, which the floor asks for", { timeout: 120000 }, (t) => {
  const world = U.usageWorld(t, { core: false });
  const laid = w.layDown(world, w.CORE);
  assert.equal(laid.status, 0, `laying down core must succeed; got ${w.describe(laid)}`);
  const spans = personaSpans(world);
  const captions = spans.find((s) => s.includes(captionsScript(world)));
  const transcribe = spans.find((s) => s.includes(transcribeScript(world)));
  assert.ok(captions, `what the session loads must name the captions reader by its path in the Squire home, as one command in Squire's own block; its commands are ${JSON.stringify(spans)}`);
  assert.ok(transcribe, `what the session loads must name the transcription by its path in the Squire home, as one command in Squire's own block; its commands are ${JSON.stringify(spans)}`);
  const recording = M.fixtureRecording(path.join(world.owner, 'workspace', 'files', 'shop-meeting.wav'));
  const floor = U.laidFloor(world, U.UTC);
  assert.ok(floor.hooks.length > 0, `the settings lay-down writes must run the safety floor before every tool call; got ${floor.settings ? JSON.stringify(floor.settings.hooks || null) : 'no settings file'}`);
  const filled = {
    'the captions reader': captions.replace(/<[^<>]+>/g, `https://www.youtube.com/watch?v=${M.VIDEOS.captioned}`),
    'the transcription': transcribe.replace(/<[^<>]+>/g, recording),
  };
  for (const mode of MODES) {
    for (const [what, command] of Object.entries(filled)) {
      const r = floor.run(`job-${mode}-${what.replace(/\s+/g, '-')}`, w.tools.bash(command), mode);
      const verdict = r.status === 0 ? 'free' : (r.status === 2 && w.requestIdIn(r.stderr) ? 'asked' : 'refused');
      t.diagnostic(`${mode}: ${verdict}: ${command}`);
      assert.notEqual(verdict, 'refused', `${what}, exactly as the session loads it, in ${mode} mode, must be free or asked by the floor, never refused; got ${w.describe(r)}`);
    }
    const job = floor.run(`job-${mode}-media`, U.heavyJob(world, 'media'), mode);
    w.assertBlocked(job, `a video job, in ${mode} mode, with no yes`);
    assert.match(job.stderr, /video and audio work/i, `a video job is warned of as a big job, in ${mode} mode; got ${w.describe(job)}`);
  }
});

test("a file of the owner's that is missing stops the job with a plain reason before anything runs: nothing downloaded, the engine never run, and no file in the owner's folder changed", { timeout: 120000 }, async (t) => {
  const world = U.usageWorld(t);
  const engine = M.speechEngine(world);
  const net = await M.networkRecorder(t);
  const before = M.digestOf(world.owner);
  const missing = path.join(world.owner, 'workspace', 'files', 'interview.m4a');
  const r = run(world, transcribeScript(world), [missing], { ...engine.env, ...net.env });
  assert.notEqual(r.status, 0, `a missing file must stop the job with a non-zero exit; got ${w.describe(r)}`);
  assert.doesNotMatch(r.stderr, /Traceback|can't open file/, `the job must stop with Squire's own words, never a crash or a missing tool; got ${w.describe(r)}`);
  assert.match(said(r), /not (there|found)|missing|no such|does not exist|doesn't exist|cannot find|can't find|could not find/i, `Squire must explain that the file is not there; got ${w.describe(r)}`);
  assert.deepEqual(engine.calls(), [], 'the speech engine must never run for a missing file');
  assert.deepEqual(M.changedIn(before, M.digestOf(world.owner)), [], 'no file in the owner\'s folder may change');
  await w.sleep(200);
  assert.equal(net.seen.length, 0, `nothing may be downloaded or sent: the job reached the network ${net.seen.length} time(s)`);
});

test("a file of the owner's that cannot be read stops the job with a plain reason: nothing downloaded, the engine never run on it, and no file in the owner's folder changed", { timeout: 120000 }, async (t) => {
  const world = U.usageWorld(t);
  const engine = M.speechEngine(world);
  const net = await M.networkRecorder(t);
  const closed = M.fixtureRecording(path.join(world.owner, 'workspace', 'files', 'closed-memo.wav'));
  fs.chmodSync(closed, 0o000);
  t.after(() => { try { fs.chmodSync(closed, 0o600); } catch (e) { /* gone */ } });
  const before = M.digestOf(world.owner);
  const r = run(world, transcribeScript(world), [closed], { ...engine.env, ...net.env });
  assert.notEqual(r.status, 0, `a file that cannot be read must stop the job with a non-zero exit; got ${w.describe(r)}`);
  assert.doesNotMatch(r.stderr, /Traceback|can't open file/, `the job must stop with Squire's own words, never a crash or a missing tool; got ${w.describe(r)}`);
  assert.match(said(r), /cannot be read|can't be read|could not be read|couldn't be read|unreadable|not readable|cannot read|can't read|could not read|couldn't read|cannot open|can't open|could not open|couldn't open/i, `Squire must explain that the file cannot be read; got ${w.describe(r)}`);
  assert.ok(!engine.calls().some((c) => c.argv[0] === closed), `the speech engine must never be run on the file that cannot be read; got ${JSON.stringify(engine.calls())}`);
  // The file that cannot be read is compared by its size and time; every
  // other file by its bytes.
  assert.deepEqual(M.changedIn(before, M.digestOf(world.owner)), [], 'no file in the owner\'s folder may change, the one that cannot be read included');
  await w.sleep(200);
  assert.equal(net.seen.length, 0, `nothing may be downloaded or sent: the job reached the network ${net.seen.length} time(s)`);
});
