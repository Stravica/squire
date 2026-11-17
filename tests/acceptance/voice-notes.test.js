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
//                         asked by the floor as the session loads it, its
//                         question naming video and audio work, never free
//                         and never refused, in the default mode and in auto
//                         mode (the design record's media tools line).
//   The engine is reached only through the seam the media world describes
//   (SQUIRE_SPEECH_ENGINE and its stand-in). Where the Mac cannot recognise
//   speech on the Mac itself (the engine exits 69), the recording is never
//   sent anywhere and no other engine or server is tried: Squire says why,
//   plainly, and keeps no note.
//   The seam is honoured only as an absolute path to an executable file: a
//   relative one, or one naming a file that cannot be run, is never run and
//   the recording goes nowhere (core/tools/transcribe.py).
//   The watched folder is the owner's input only: the job makes no note from
//   a link in the folder to a recording outside it, or from a recording in a
//   folder inside it (core/tools/transcribe.py --watch); and the safety floor
//   (core/hooks/pre-tool-use.py) asks, never lets through free, a session
//   Write of a new file there and a copy, move or link into it from the
//   shell, in the default mode and in auto mode.
//   The floor also asks before any session command that sets a SQUIRE_
//   variable (inline before a command, by export, by launchctl setenv) and
//   before a Write of ~/.zshenv or of a LaunchAgents plist naming one, so
//   nothing the session has read can point the owner's recordings at
//   another program (core/hooks/pre-tool-use.py).
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

test("a recording the owner gives Squire is transcribed the same way on request: the transcription, exactly as the session loads it, is asked by the safety floor as the session runs it, its question naming video and audio work, never free and never refused, in the default mode and in auto mode, and run on the owner's yes it keeps a note in the owner's folder", { timeout: 180000 }, async (t) => {
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
    assert.equal(verdict, 'asked', `the transcription of a recording the owner gives, in ${mode} mode, must be asked, never free and never refused; got ${w.describe(r)}`);
    assert.match(r.stderr, U.HEAVY.media, `the question for the transcription, in ${mode} mode, must name video and audio work; got ${w.describe(r)}`);
    U.sayYesTo(world, job, r, { env: U.UTC });
    r = floor.run(job, w.tools.bash(command), mode);
    w.assertAllowed(r, `the transcription, in ${mode} mode, once the owner said yes`);
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

// ------------------------------------------- the folder is the owner's input

// The floor's answer to a call, in the words the floor tests use.
const verdictOf = (r) => (r.status === 0 ? 'free' : (r.status === 2 && w.requestIdIn(r.stderr) ? 'asked' : 'refused'));

// A world with core laid down as set-up lays it, and the safety floor as the
// session runs it (the PreToolUse hooks of the settings lay-down writes).
function laidFloorWorld(t) {
  const world = U.usageWorld(t, { core: false });
  const laid = w.layDown(world, w.CORE);
  assert.equal(laid.status, 0, `laying down core must succeed; got ${w.describe(laid)}`);
  const floor = U.laidFloor(world, U.UTC);
  assert.ok(floor.hooks.length > 0, `the settings lay-down writes must run the safety floor before every tool call; got ${floor.settings ? JSON.stringify(floor.settings.hooks || null) : 'no settings file'}`);
  return { world, floor };
}

test("the voice-notes folder is the owner's input only: the voice-notes job, as launchd runs it, makes no note from a link in the folder to a recording outside it, or from a recording in a folder inside it, and runs the engine on neither, while a recording put in the folder itself is transcribed", { timeout: 180000 }, async (t) => {
  const { world } = laidWorld(t);
  const agent = voiceAgent(world);
  assert.ok(agent, `lay-down must write the voice-notes job (${LABEL}); found ${s.launchAgents(world).map((a) => a.plist.Label).join(', ') || 'none'}`);
  const engine = engineBySize(world);
  const net = await M.networkRecorder(t);
  const own = M.fixtureRecording(path.join(watched(world), 'New Recording.wav'), { seconds: 1 });
  const outside = M.fixtureRecording(path.join(world.userHome, 'Documents', 'Call with the bank.wav'), { seconds: 2 });
  fs.symlinkSync(outside, path.join(watched(world), 'Call with the bank.wav'));
  const inner = M.fixtureRecording(path.join(watched(world), 'Older', 'New Recording 2.wav'), { seconds: 3 });
  const size = { own: fs.statSync(own).size, outside: fs.statSync(outside).size, inner: fs.statSync(inner).size };
  const r = runAgent(world, agent, { ...engine.env, ...net.env });
  assert.equal(r.status, 0, `the voice-notes job must run and exit 0; got ${w.describe(r)}`);
  const notesOf = (n) => w.filesHolding([world.owner], `${engine.words} size-${n}`).filter((x) => !x.startsWith(watched(world)));
  assert.equal(notesOf(size.own).length, 1, `a recording put in the folder itself must become one note (the job ran); got ${JSON.stringify(notesOf(size.own))}; engine calls ${JSON.stringify(engine.calls())}`);
  assert.deepEqual(notesOf(size.outside), [], 'a link in the voice-notes folder to a recording outside it must make no note');
  assert.deepEqual(notesOf(size.inner), [], 'a recording in a folder inside the voice-notes folder must make no note');
  assert.deepEqual(engine.calls().map((c) => c.size), [size.own], `the engine runs on the folder's own recording only, never through the link or on the inner folder's recording; got ${JSON.stringify(engine.calls())}`);
  await w.sleep(200);
  assert.equal(net.seen.length, 0, `no audio or its text may leave the Mac: the job reached the network ${net.seen.length} time(s)`);
});

test("a session Write of a new file in the owner's voice-notes folder, and a copy, a move or a link into it from the shell, are each asked by the safety floor as the session runs it, never free, in the default mode and in auto mode", { timeout: 180000 }, (t) => {
  const { world, floor } = laidFloorWorld(t);
  const folder = watched(world);
  fs.mkdirSync(folder, { recursive: true });
  const from = M.fixtureRecording(path.join(world.owner, 'workspace', 'files', 'attachment.wav'), { seconds: 1 });
  const calls = [
    ['a Write of a new file', w.tools.write(path.join(folder, 'New Recording.wav'), 'RIFF....WAVEfmt ')],
    ['a copy', w.tools.bash(`cp '${from}' '${folder}/'`)],
    ['a move', w.tools.bash(`mv '${from}' '${path.join(folder, 'Moved.wav')}'`)],
    ['a link', w.tools.bash(`ln -s '${from}' '${path.join(folder, 'Linked.wav')}'`)],
  ];
  for (const mode of MODES) {
    for (const [what, call] of calls) {
      const r = floor.run(`job-voice-folder-${mode}-${what.replace(/\W+/g, '-')}`, call, mode);
      t.diagnostic(`${mode}: ${verdictOf(r)}: ${what}`);
      assert.equal(verdictOf(r), 'asked', `${what} into the owner's voice-notes folder, in ${mode} mode, must be asked (a block with a request id), never free; got ${w.describe(r)}`);
    }
  }
});

test("a session command that sets a SQUIRE_ variable (inline before a command, by export, or for every program by launchctl setenv), and a Write of ~/.zshenv or of a LaunchAgents plist that names one, are each asked by the safety floor as the session runs it, never free, in the default mode and in auto mode", { timeout: 180000 }, (t) => {
  // A guard at the base head: the floor already asks for each of these (a
  // command it cannot read as one it knows, and a Write outside the owner's
  // folder); the two test seams must never make any of them free.
  const { world, floor } = laidFloorWorld(t);
  const helper = path.join(world.userHome, 'Downloads', 'helper');
  const plist = '<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict><key>Label</key><string>com.example.helper</string>' +
    `<key>EnvironmentVariables</key><dict><key>SQUIRE_SPEECH_ENGINE</key><string>${helper}</string></dict></dict></plist>\n`;
  const calls = [
    ['a SQUIRE_ variable set inline before a command', w.tools.bash(`SQUIRE_SPEECH_ENGINE='${helper}' ls '${watched(world)}'`)],
    ['a SQUIRE_ variable exported', w.tools.bash('export SQUIRE_YOUTUBE_ORIGIN=https://captions.example.net')],
    ['a SQUIRE_ variable set for every program by launchctl setenv', w.tools.bash(`launchctl setenv SQUIRE_SPEECH_ENGINE '${helper}'`)],
    ['a Write of ~/.zshenv that sets one', w.tools.write(path.join(world.userHome, '.zshenv'), `export SQUIRE_SPEECH_ENGINE='${helper}'\n`)],
    ['a Write of a LaunchAgents plist that names one', w.tools.write(path.join(world.userHome, 'Library', 'LaunchAgents', 'com.example.helper.plist'), plist)],
  ];
  for (const mode of MODES) {
    for (const [what, call] of calls) {
      const r = floor.run(`job-squire-variable-${mode}-${what.replace(/\W+/g, '-')}`, call, mode);
      t.diagnostic(`${mode}: ${verdictOf(r)}: ${what}`);
      assert.equal(verdictOf(r), 'asked', `${what}, in ${mode} mode, must be asked (a block with a request id), never free; got ${w.describe(r)}`);
    }
  }
});

test("a speech engine seam that is not an absolute path, or that names a file that cannot be run, is never run: the recording goes nowhere and no note is kept, while an absolute path to an executable file is the engine", { timeout: 180000 }, async (t) => {
  const world = U.usageWorld(t);
  const engine = engineBySize(world);
  const net = await M.networkRecorder(t);
  const control = M.fixtureRecording(path.join(world.userHome, 'Downloads', 'Voice memo.wav'), { seconds: 1 });
  const ran = w.runPython(world, transcribeScript(world), [control], { env: { ...engine.env, ...net.env }, timeout: 60000 });
  assert.equal(ran.status, 0, `with the seam an absolute path to an executable file, the transcription must run it and exit 0; got ${w.describe(ran)}`);
  assert.ok(w.filesHolding([world.owner], `${engine.words} size-${fs.statSync(control).size}`).length > 0, `the control recording's text must be kept as a note; got ${w.describe(ran)}`);
  const before = engine.calls().length;

  const closed = path.join(path.dirname(engine.env.SQUIRE_SPEECH_ENGINE), 'engine-closed');
  fs.copyFileSync(engine.env.SQUIRE_SPEECH_ENGINE, closed);
  fs.chmodSync(closed, 0o644);
  const seams = [
    ['a path relative to the working folder', path.relative(world.root, engine.env.SQUIRE_SPEECH_ENGINE), 2],
    ['a file that cannot be run', closed, 3],
  ];
  for (const [what, seam, seconds] of seams) {
    const given = M.fixtureRecording(path.join(world.userHome, 'Downloads', `Voice memo ${seconds}.wav`), { seconds });
    const ownerBefore = M.digestOf(world.owner);
    const r = w.runPython(world, transcribeScript(world), [given], { cwd: world.root, env: { SQUIRE_SPEECH_ENGINE: seam, ...net.env }, timeout: 60000 });
    t.diagnostic(`${what}: ${w.describe(r)}`);
    assert.doesNotMatch(r.stderr, /Traceback/, `${what}: the transcription must stop with Squire's own words, never a crash; got ${w.describe(r)}`);
    assert.equal(engine.calls().length, before, `${what}: the program the seam names must never be run; got ${JSON.stringify(engine.calls())}`);
    assert.deepEqual(M.changedIn(ownerBefore, M.digestOf(world.owner)), [], `${what}: no note may be kept and nothing in the owner's folder may change`);
  }
  await w.sleep(200);
  assert.equal(net.seen.length, 0, `no audio or its text may leave the Mac: reached the network ${net.seen.length} time(s)`);
});
