'use strict';

// Voice notes are transcribed on the Mac and no audio leaves it: a new
// recording the owner puts in the voice-notes folder Squire watches is picked
// up and transcribed without the owner telling Squire, and a recording the
// owner gives Squire is transcribed the same way (AC-1702-1). Through the real
// entry points: lay-down (the background jobs it writes and what the session
// loads), the voice-notes job's own command run as launchd runs it (the
// agent's program and environment, as lay-down wrote them), the safety floor
// as the session runs it (the PreToolUse hooks of the settings lay-down
// writes, the event on stdin), and the transcription command run as the
// session runs a command once the floor lets it through.
//
// What the builder provides (none of it exists at the base head; the names
// are this file's, and a case fails at its own first assertion while they
// are absent):
//   the watched folder    "Voice notes" in the owner's folder: the owner
//                         puts (or saves from Voice Memos) a recording there.
//   com.stravica.squire.voice-notes
//                         the fifth background job, written by lay-down under
//                         Library/LaunchAgents beside the other four, which
//                         stay as they are: launchd starts it when the watched
//                         folder changes (WatchPaths names the folder), it
//                         runs the installed core/tools/transcribe.py --watch
//                         with /usr/bin/python3, names the Squire home
//                         (SQUIRE_HOME) and is never kept alive. A test
//                         world's lay-down loads nothing into a real launchd
//                         domain. The label follows the other four's and is a
//                         design question for the stage-keeper.
//   core/tools/transcribe.py --watch
//                         picks up every recording in the watched folder not
//                         yet transcribed, transcribes each once through the
//                         one local speech engine and keeps its text as a note
//                         in the owner's folder (where is the builder's), the
//                         recording left where it was, as it was. A second run
//                         with nothing new makes no new note.
//   core/tools/transcribe.py '<file>'
//                         the same engine for a recording the owner gives
//                         Squire (the command video-and-audio.test.js names),
//                         free or asked by the floor as the session loads it,
//                         never refused, in the default mode and in auto mode.
//   The engine is reached only through the seam the media world describes
//   (SQUIRE_SPEECH_ENGINE and its stand-in). Where the Mac cannot recognise
//   speech on the Mac itself (the engine exits 69), the recording is never
//   sent anywhere and no other engine or server is tried: Squire says why,
//   plainly, and keeps no note.
//
// Usage model (assumptions, none measured): typical, one recording of a few
// minutes a day, dropped alone; heavy, a batch saved from Voice Memos at once
// (three here, of different lengths), each picked up once, none twice.
//
// The class is open (any recording, any engine answer, any way out of the
// Mac); these are instances, and the answer for audio the Mac cannot
// transcribe itself is to keep it on the Mac and say so. No case reaches the
// network beyond this Mac's loopback, a real speech engine, real launchd or a
// model; the recordings are generated tones.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const w = require('../fixtures/squire-world.js');
const s = require('../fixtures/session-world.js');
const U = require('../fixtures/usage-world.js');
const M = require('../fixtures/media-world.js');

const LABEL = 'com.stravica.squire.voice-notes';
const watched = (world) => path.join(world.owner, 'Voice notes');
const transcribeScript = (world) => path.join(world.home, 'core', 'tools', 'transcribe.py');
const MODES = ['default', 'auto'];

// The stand-in engine names each recording by its size, so each note can be
// told from the others.
function engineBySize(world, behaviour = 'transcribe') {
  const dir = path.join(world.root, 'speech-engine');
  fs.mkdirSync(dir, { recursive: true });
  const callsFile = path.join(dir, 'calls.jsonl');
  const program = path.join(dir, 'engine');
  const words = M.mark('spoken');
  fs.writeFileSync(program, `#!${process.execPath}
const fs = require('fs');
const file = process.argv[2];
const size = file && fs.existsSync(file) ? fs.statSync(file).size : null;
fs.appendFileSync(${JSON.stringify(callsFile)}, JSON.stringify({ argv: process.argv.slice(2), size }) + '\\n');
if (${JSON.stringify(behaviour)} === 'unavailable') { process.stderr.write('speech recognition on this Mac itself is not available for this language\\n'); process.exit(69); }
process.stdout.write('Remember the flour order. ${words} size-' + size + '\\n');
`);
  fs.chmodSync(program, 0o755);
  const calls = () => (fs.existsSync(callsFile) ? fs.readFileSync(callsFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  return { env: { SQUIRE_SPEECH_ENGINE: program }, calls, words };
}

function voiceAgent(world) {
  return s.launchAgents(world).find((a) => a.plist.Label === LABEL);
}

// Runs the voice-notes job as launchd would: the agent's program and
// arguments, its environment over the product's, from /.
function runAgent(world, agent, extra) {
  const [program, ...args] = agent.plist.ProgramArguments;
  const r = spawnSync(program, args, {
    cwd: '/', encoding: 'utf8', timeout: 120000,
    env: w.productEnv(world, { ...(agent.plist.EnvironmentVariables || {}), ...extra }),
  });
  return { status: r.status, signal: r.signal, stdout: r.stdout || '', stderr: r.stderr || '', error: r.error ? String(r.error.message || r.error) : '' };
}

function laidWorld(t) {
  const world = w.makeWorld();
  t.after(() => w.cleanUp(world));
  const release = path.join(world.root, 'release');
  w.copyTree(w.CORE, release);
  const installed = s.layDownCore(world, release);
  return { world, installed };
}

test("lay-down writes the voice-notes job beside Squire's other four, which stay as they are: launchd starts it when the owner's voice-notes folder changes, it runs the installed transcription with --watch, names the Squire home and is never kept alive", { timeout: 60000 }, (t) => {
  const { world, installed } = laidWorld(t);
  const agents = s.launchAgents(world);
  const agent = agents.find((a) => a.plist.Label === LABEL);
  assert.ok(agent, `lay-down must write ${LABEL}.plist under the home's Library/LaunchAgents; found ${agents.map((a) => a.plist.Label).join(', ') || 'none'}`);
  assert.deepEqual(agent.plist.ProgramArguments, [w.PYTHON, '-B', path.join(installed, 'tools', 'transcribe.py'), '--watch'],
    'the job runs the installed transcription with /usr/bin/python3, watching');
  assert.ok(Array.isArray(agent.plist.WatchPaths) && agent.plist.WatchPaths.includes(watched(world)),
    `launchd must start the job when the owner's voice-notes folder (${watched(world)}) changes (WatchPaths); got ${JSON.stringify(agent.plist.WatchPaths)}`);
  assert.equal((agent.plist.EnvironmentVariables || {}).SQUIRE_HOME, world.home, 'the job names the Squire home');
  assert.notEqual(agent.plist.KeepAlive, true, 'the voice-notes job runs when the folder changes and is never kept alive');
  for (const label of ['com.stravica.squire.runner', 'com.stravica.squire.wake-ups', 'com.stravica.squire.backup', 'com.stravica.squire.pages']) {
    assert.ok(agents.some((a) => a.plist.Label === label), `${label} must stay beside the voice-notes job; found ${agents.map((a) => a.plist.Label).join(', ')}`);
  }
});

test("a recording put in the voice-notes folder is picked up by the voice-notes job, as launchd runs it, and transcribed on the Mac without the owner telling Squire: each of three recordings dropped at once becomes a note in the owner's folder once, the recordings stay as they were, and nothing is sent beyond this Mac", { timeout: 180000 }, async (t) => {
  const { world } = laidWorld(t);
  const agent = voiceAgent(world);
  assert.ok(agent, `lay-down must write the voice-notes job (${LABEL}); found ${s.launchAgents(world).map((a) => a.plist.Label).join(', ') || 'none'}`);
  const engine = engineBySize(world);
  const net = await M.networkRecorder(t);
  const recordings = [1, 2, 3].map((n) => M.fixtureRecording(path.join(watched(world), `New Recording ${n}.wav`), { seconds: n }));
  const bytes = recordings.map((f) => fs.readFileSync(f));
  const r = runAgent(world, agent, { ...engine.env, ...net.env });
  assert.equal(r.status, 0, `the voice-notes job must run and exit 0; got ${w.describe(r)}`);
  for (const [n, f] of recordings.entries()) {
    const size = fs.statSync(f).size;
    const notes = w.filesHolding([world.owner], `${engine.words} size-${size}`).filter((x) => !x.startsWith(watched(world)));
    assert.equal(notes.length, 1, `recording ${n + 1} must become one note in the owner's folder, outside the voice-notes folder; got ${JSON.stringify(notes)}; engine calls ${JSON.stringify(engine.calls())}`);
    assert.ok(fs.readFileSync(f).equals(bytes[n]), `recording ${n + 1} must stay where it was, as it was`);
  }
  assert.equal(engine.calls().length, 3, `the one local engine transcribes each recording once; got ${JSON.stringify(engine.calls())}`);

  // A later run with nothing new makes no new note and runs the engine no more.
  const again = runAgent(world, agent, { ...engine.env, ...net.env });
  assert.equal(again.status, 0, `a later run of the job must exit 0; got ${w.describe(again)}`);
  assert.equal(engine.calls().length, 3, `a recording already transcribed is never transcribed again; got ${JSON.stringify(engine.calls())}`);
  await w.sleep(200);
  assert.equal(net.seen.length, 0, `no audio or its text may leave the Mac: the job reached the network ${net.seen.length} time(s)`);
});

test("a recording the owner gives Squire is transcribed the same way on request: the transcription, exactly as the session loads it, is free or asked by the safety floor as the session runs it, never refused, in the default mode and in auto mode, and run on the owner's yes it keeps a note in the owner's folder", { timeout: 180000 }, async (t) => {
  const world = U.usageWorld(t, { core: false });
  const laid = w.layDown(world, w.CORE);
  assert.equal(laid.status, 0, `laying down core must succeed; got ${w.describe(laid)}`);
  const loaded = fs.readFileSync(path.join(world.home, 'claude-config', 'CLAUDE.md'), 'utf8');
  const open = loaded.indexOf('<!-- squire persona -->');
  const close = loaded.indexOf('<!-- end squire persona -->');
  const spans = [...(open >= 0 && close > open ? loaded.slice(open, close) : '').matchAll(/`([^`\n]+)`/g)].map((m) => m[1]);
  const named = spans.find((x) => x.includes(transcribeScript(world)));
  assert.ok(named, `what the session loads must name the transcription by its path in the Squire home, as one command in Squire's own block; its commands are ${JSON.stringify(spans)}`);
  const engine = engineBySize(world);
  const net = await M.networkRecorder(t);
  const given = M.fixtureRecording(path.join(world.userHome, 'Downloads', 'Voice memo.wav'), { seconds: 2 });
  const command = named.replace(/<[^<>]+>/g, given);
  const floor = U.laidFloor(world, U.UTC);
  for (const mode of MODES) {
    const job = `job-voice-${mode}`;
    let r = floor.run(job, w.tools.bash(command), mode);
    const verdict = r.status === 0 ? 'free' : (r.status === 2 && w.requestIdIn(r.stderr) ? 'asked' : 'refused');
    t.diagnostic(`${mode}: ${verdict}: ${command}`);
    assert.notEqual(verdict, 'refused', `the transcription of a recording the owner gives, in ${mode} mode, must be free or asked, never refused; got ${w.describe(r)}`);
    if (verdict === 'asked') {
      U.sayYesTo(world, job, r, { env: U.UTC });
      r = floor.run(job, w.tools.bash(command), mode);
      w.assertAllowed(r, `the transcription, in ${mode} mode, once the owner said yes`);
    }
  }
  const ran = w.runPython(world, transcribeScript(world), [given], { env: { ...engine.env, ...net.env }, timeout: 60000 });
  assert.equal(ran.status, 0, `the transcription must run and exit 0; got ${w.describe(ran)}`);
  const size = fs.statSync(given).size;
  assert.ok(w.filesHolding([world.owner], `${engine.words} size-${size}`).length > 0, `the recording's text must be kept as a note in the owner's folder; got ${w.describe(ran)}`);
  await w.sleep(200);
  assert.equal(net.seen.length, 0, `no audio or its text may leave the Mac: the transcription reached the network ${net.seen.length} time(s)`);
});

test("where the Mac cannot recognise speech on the Mac itself, the recording is never sent anywhere and no other engine or server is tried: on request Squire says why, plainly, and keeps no note; the voice-notes job keeps the recording as it was and sends nothing", { timeout: 180000 }, async (t) => {
  const { world } = laidWorld(t);
  const engine = engineBySize(world, 'unavailable');
  const net = await M.networkRecorder(t);
  const given = M.fixtureRecording(path.join(world.userHome, 'Downloads', 'Voice memo.wav'), { seconds: 2 });
  const before = M.digestOf(world.owner);
  const r = w.runPython(world, transcribeScript(world), [given], { env: { ...engine.env, ...net.env }, timeout: 60000 });
  assert.notEqual(r.status, 0, `with no speech recognition on the Mac itself the transcription must stop with a non-zero exit; got ${w.describe(r)}`);
  assert.doesNotMatch(r.stderr, /Traceback|can't open file/, `it must stop with Squire's own words, never a crash or a missing tool; got ${w.describe(r)}`);
  assert.match(`${r.stdout}\n${r.stderr}`, /(this|the|your) Mac/i, `Squire must say plainly that the Mac itself cannot transcribe it; got ${w.describe(r)}`);
  assert.match(`${r.stdout}\n${r.stderr}`, /cannot|can't|could not|couldn't|not available|isn't available/i, `Squire must say it cannot; got ${w.describe(r)}`);
  assert.ok(engine.calls().length <= 1, `the one local engine is tried at most once; got ${JSON.stringify(engine.calls())}`);
  assert.deepEqual(M.changedIn(before, M.digestOf(world.owner)), [], 'no note may be kept and nothing in the owner\'s folder may change');

  const agent = voiceAgent(world);
  assert.ok(agent, `lay-down must write the voice-notes job (${LABEL})`);
  const dropped = M.fixtureRecording(path.join(watched(world), 'New Recording.wav'), { seconds: 1 });
  const bytes = fs.readFileSync(dropped);
  runAgent(world, agent, { ...engine.env, ...net.env });
  assert.ok(fs.readFileSync(dropped).equals(bytes), 'the recording in the voice-notes folder must stay as it was');
  await w.sleep(200);
  assert.equal(net.seen.length, 0, `no audio or its text may leave the Mac, and no server may be tried: reached the network ${net.seen.length} time(s)`);
});
