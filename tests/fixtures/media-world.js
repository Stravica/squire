'use strict';

// What the video, audio and voice-note cases share, on top of the base world
// (squire-world.js). Nothing here imports or copies product logic; every
// product process is run as the Mac or the session would run it, in the
// product's environment, with two things of this world's own in place of the
// world outside the Mac:
//
//   the speech engine   a stand-in program the product runs as its one local
//                       speech engine, named to it by SQUIRE_SPEECH_ENGINE
//                       (the seam: with the variable set, the product runs
//                       that program in place of its own speech helper, and
//                       with it unset, its own). The engine is run as
//                       <engine> <audio or video file>. It prints the words
//                       it heard on stdout as timed phrases, one JSON object
//                       a line, in the order heard:
//                           {"start": <seconds>, "end": <seconds>, "text": "<words>"}
//                       (start and end are seconds from the start of the
//                       recording, as numbers), and exits 0. Squire's own
//                       speech helper answers in the same form: the builder
//                       makes it do so from the engine's time ranges. Where
//                       the Mac cannot recognise speech on the Mac itself the
//                       engine exits 69 with the reason on stderr; any other
//                       failure is any other non-zero exit. The stand-in
//                       records every call and never touches the network.
//   the network         every proxy variable a client honours points at a
//                       recorder on this Mac's loopback, with the loopback
//                       itself left out (NO_PROXY), so a request for any host
//                       but this Mac reaches the recorder, which counts it.
//                       It is in the test process: while a run holds that
//                       process, the Mac itself takes each connection and
//                       keeps it until the recorder accepts it, so a case
//                       counts every one once the run returns and the case
//                       waits a moment (w.sleep).
//
// The fixture recording is a generated tone, never anyone's voice. The made
// video (made by madeVideo, at run time, in the test's own temporary folder)
// is a picture this world draws and, when asked, spoken words from the Mac's
// own synthetic voice (`say`) or this world's own tone, put together by
// tools/video-fixture.swift, which is built on the Mac with Apple's command
// line tools (xcrun swiftc) and uses only Apple's AVFoundation. Nothing is
// downloaded, nothing third-party is used and no recording, video or voice of
// anyone is kept in the repository. The same tool reads a file's tracks, size
// and location data (describeMedia), and each track's time range and the
// sound inside a window (mediaTracks), so a case reads what a video holds
// from the file itself.

const { spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const w = require('./squire-world.js');

const mark = (what) => `${what}-${crypto.randomBytes(6).toString('hex')}`;

// A WAV file of a one-second 440 Hz tone: 16 kHz, mono, 16-bit.
function fixtureRecording(file, { seconds = 1 } = {}) {
  const rate = 16000;
  const samples = rate * seconds;
  const data = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i += 1) data.writeInt16LE(Math.round(8000 * Math.sin((2 * Math.PI * 440 * i) / rate)), i * 2);
  const head = Buffer.alloc(44);
  head.write('RIFF', 0, 'ascii');
  head.writeUInt32LE(36 + data.length, 4);
  head.write('WAVE', 8, 'ascii');
  head.write('fmt ', 12, 'ascii');
  head.writeUInt32LE(16, 16);
  head.writeUInt16LE(1, 20);
  head.writeUInt16LE(1, 22);
  head.writeUInt32LE(rate, 24);
  head.writeUInt32LE(rate * 2, 28);
  head.writeUInt16LE(2, 32);
  head.writeUInt16LE(16, 34);
  head.write('data', 36, 'ascii');
  head.writeUInt32LE(data.length, 40);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.concat([head, data]));
  return file;
}

// The stand-in engine's own reason, on stderr, where the Mac cannot recognise
// speech on the Mac itself (one line, the engine's words, never Squire's).
const SPEECH_UNAVAILABLE = 'speech recognition on this Mac itself is not available for this language';

// The stand-in speech engine, written into the world: behaviour 'transcribe'
// prints the given phrases (by default one phrase, the given text, from 0 to
// 1.5 seconds) as timed phrases, 'unavailable' says the Mac cannot recognise
// speech on the Mac itself (exit 69, SPEECH_UNAVAILABLE on stderr), 'fail'
// fails (exit 1), and 'untimed' exits 0 with an answer that is not timed
// phrases: one timed phrase of the given text, then a phrase whose times are
// not numbers, then a line of plain words (an engine's answer Squire cannot
// read). calls() lists every run.
function speechEngine(world, { behaviour = 'transcribe', text = `Buy flour on Thursday. ${mark('spoken')}`, phrases = null } = {}) {
  const dir = path.join(world.root, 'speech-engine');
  fs.mkdirSync(dir, { recursive: true });
  const callsFile = path.join(dir, 'calls.jsonl');
  const program = path.join(dir, 'engine');
  const said = phrases || [{ start: 0, end: 1.5, text }];
  const lines = said.map((p) => JSON.stringify({ start: p.start, end: p.end, text: p.text })).join('\n') + '\n';
  const untimed = `${JSON.stringify({ start: 0, end: 1.5, text })}\n${JSON.stringify({ start: 'soon', end: 'later', text })}\nheard: ${text}\n`;
  fs.writeFileSync(program, `#!${process.execPath}
const fs = require('fs');
fs.appendFileSync(${JSON.stringify(callsFile)}, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), at: Date.now(),
  read: process.argv[2] && fs.existsSync(process.argv[2]) ? fs.statSync(process.argv[2]).size : null }) + '\\n');
const behaviour = ${JSON.stringify(behaviour)};
if (behaviour === 'unavailable') { process.stderr.write(${JSON.stringify(`${SPEECH_UNAVAILABLE}\n`)}); process.exit(69); }
if (behaviour === 'fail') { process.stderr.write('the recording could not be opened\\n'); process.exit(1); }
if (behaviour === 'untimed') { process.stdout.write(${JSON.stringify(untimed)}); process.exit(0); }
process.stdout.write(${JSON.stringify(lines)});
`);
  fs.chmodSync(program, 0o755);
  const calls = () => (fs.existsSync(callsFile) ? fs.readFileSync(callsFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  return { program, text, phrases: said, calls, env: { SQUIRE_SPEECH_ENGINE: program } };
}

// A recorder on this Mac's loopback that counts every connection made to it,
// with every proxy variable pointed at it and the loopback left out.
async function networkRecorder(t) {
  const seen = [];
  const server = net.createServer((socket) => { seen.push(Date.now()); socket.destroy(); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const url = `http://127.0.0.1:${server.address().port}`;
  const env = { NO_PROXY: '127.0.0.1,localhost,::1', no_proxy: '127.0.0.1,localhost,::1' };
  for (const name of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']) env[name] = url;
  return { env, seen };
}

// A digest of every file under a folder: relative path to SHA-256, links by
// their target, folders by name.
function digestOf(dir) {
  const out = {};
  const walk = (rel) => {
    const abs = path.join(dir, rel);
    let st;
    try { st = fs.lstatSync(abs); } catch (e) { return; }
    if (st.isSymbolicLink()) out[rel] = `link:${fs.readlinkSync(abs)}`;
    else if (st.isDirectory()) {
      if (rel) out[rel] = 'folder';
      let names = [];
      try { names = fs.readdirSync(abs); } catch (e) { out[rel] = 'folder (unreadable)'; return; }
      for (const n of names.sort()) walk(path.join(rel, n));
    } else {
      try { out[rel] = w.sha256(fs.readFileSync(abs)); } catch (e) { out[rel] = `unreadable:${st.size}:${st.mtimeMs}`; }
    }
  };
  walk('');
  return out;
}

const changedIn = (before, after) => [...new Set([...Object.keys(before), ...Object.keys(after)])]
  .filter((k) => before[k] !== after[k]).sort();

// Every audio or video file under a folder, by extension.
const MEDIA = /\.(mp4|m4a|m4v|webm|mkv|mov|mp3|aac|opus|ogg|wav|flac|3gp|aif|aiff|aifc|caf)$/i;
function mediaFiles(dir) {
  const r = spawnSync('/usr/bin/find', [dir, '-type', 'f'], { encoding: 'utf8' });
  return (r.stdout || '').split('\n').filter((f) => MEDIA.test(f));
}

// --------------------------------------------- the timed form, as read

// A time in a recording as the owner reads it in a transcript: M:SS, or
// H:MM:SS from an hour (whole seconds, rounded down).
function clockOf(seconds) {
  const s = Math.floor(seconds);
  const two = (n) => String(n).padStart(2, '0');
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h ? `${h}:${two(m)}:${two(s % 60)}` : `${m}:${two(s % 60)}`;
}

// The paragraphs of a note: its blocks of text between blank lines.
const paragraphsOf = (text) => text.split(/\n[ \t]*\n/).map((p) => p.trim()).filter(Boolean);

// Fails unless the note keeps the phrases in the paragraphs given (each a
// list of phrase indexes, in order): every phrase's words are in the note as
// written, each paragraph holds exactly its own phrases, and each is led by
// the time its first phrase starts, before that phrase's words.
function assertTimedForm(note, phrases, groups, what) {
  const assert = require('node:assert/strict');
  const paragraphs = paragraphsOf(note);
  const where = (i) => paragraphs.findIndex((p) => p.includes(phrases[i].text));
  for (const [i, p] of phrases.entries()) {
    assert.ok(where(i) >= 0, `${what}: the words of phrase ${i + 1} ("${p.text}") must be in the transcript as heard, to search and quote; the note reads:\n${note}`);
  }
  for (const group of groups) {
    const at = where(group[0]);
    for (const i of group) {
      assert.equal(where(i), at, `${what}: phrase ${i + 1} ("${phrases[i].text}") must be in the same paragraph as phrase ${group[0] + 1}, a moment after it; the note reads:\n${note}`);
    }
    for (const i of phrases.keys()) {
      if (!group.includes(i)) assert.ok(!paragraphs[at].includes(phrases[i].text), `${what}: phrase ${i + 1} ("${phrases[i].text}") must not be in the paragraph of phrase ${group[0] + 1}: a long pause starts a new paragraph; the note reads:\n${note}`);
    }
    const clock = clockOf(phrases[group[0]].start);
    const lead = paragraphs[at].indexOf(clock);
    assert.ok(lead >= 0 && lead < paragraphs[at].indexOf(phrases[group[0]].text), `${what}: the paragraph of phrase ${group[0] + 1} must be led by its time in the recording, ${clock}; it reads:\n${paragraphs[at]}`);
  }
}

// A time as a captions file (.srt) writes it: HH:MM:SS,mmm.
function srtTimeOf(seconds) {
  const ms = Math.round(seconds * 1000);
  const two = (n) => String(n).padStart(2, '0');
  return `${two(Math.floor(ms / 3600000))}:${two(Math.floor((ms % 3600000) / 60000))}:${two(Math.floor((ms % 60000) / 1000))},${String(ms % 1000).padStart(3, '0')}`;
}

// The cues of a captions file (.srt): [{ index, start, end, text }], start and
// end as the file writes them.
function srtCues(text) {
  return text.replace(/\r\n/g, '\n').trim().split(/\n[ \t]*\n/).filter(Boolean).map((block) => {
    const lines = block.split('\n');
    const times = /^(\d\d:\d\d:\d\d,\d\d\d) --> (\d\d:\d\d:\d\d,\d\d\d)$/.exec((lines[1] || '').trim());
    return { index: lines[0].trim(), start: times ? times[1] : null, end: times ? times[2] : null, text: lines.slice(2).join(' ').trim() };
  });
}

// ------------------------------------------------------- the made video

// The Mac's major macOS version, read with its own sw_vers (0 when unread).
function macosMajor() {
  const r = spawnSync('/usr/bin/sw_vers', ['-productVersion'], { encoding: 'utf8' });
  return Number(((r.stdout || '').trim().match(/^(\d+)/) || [])[1] || 0);
}

// Why a case that needs the real speech helper cannot run here, or false: it
// is target-gated below macOS 26, as the speech helper is.
const helperGateFor = (major) => (major >= 26 ? false : `target-gated: needs macOS 26 or later for Squire's own speech helper; this Mac runs macOS ${major || 'unknown'}`);
function realHelperGate() {
  return helperGateFor(macosMajor());
}

// ------------------------------------------- the guard on real speech

// The guard on the cases that hear speech through Squire's own speech helper
// for real (the owner's own recording by the helper, the made video's
// transcript, the video with no sound). A hosted virtual Mac cannot recognise
// speech on the Mac itself, so there the helper answers "cannot" before any
// of its other code runs, and such a case cannot pass on any product. The
// guard asks Apple, not Squire: its own probe (tools/speech-availability.swift,
// built here as the video tool is) reads SpeechTranscriber.isAvailable and the
// installed speech locales and prints one line. It never runs the product,
// never reads the product's exit 69 and never looks at whether the product's
// helper builds.
//
// The decision (speechGuard, pure: the major macOS version and the probe's
// outcome in, a skip reason or false out):
//   1. macOS below 26: skipped, with today's reason (helperGateFor).
//   2. 26 or later, isAvailable true, an installed locale for the language: runs.
//   3. 26 or later, isAvailable false: skipped, the reason naming the
//      property, the reading and the macOS version the probe read.
//   4. 26 or later, isAvailable true, no installed locale: runs.
//   5. the product's helper fails to build: not looked at; runs.
//   6. the probe fails to build, crashes, times out or prints anything but
//      its one well-formed line: runs, the failure in the reading.
//   7. sw_vers unread (major 0): falls through to the probe, never a skip of
//      its own.
// The only skip it adds is row 3, a clean reading of false from Apple's own
// property. The case prints the reading (speechGuardReading) when it runs.
// The probe's outcome: { line } when it exited 0 (its whole stdout), else
// { failed: 'failed to build' | 'timed out building' | 'crashed' |
// 'timed out', detail }.

const PROBE_LINE = /^\{[^\n]*\}$/;

// The probe's line read, or null when it is not one well-formed reading.
function speechReadingOf(line) {
  const text = typeof line === 'string' ? line.trim() : '';
  if (!PROBE_LINE.test(text)) return null;
  let r;
  try { r = JSON.parse(text); } catch (e) { return null; }
  if (!r || typeof r !== 'object' || Array.isArray(r)) return null;
  if (typeof r.isAvailable !== 'boolean' || !Number.isInteger(r.installedLocales) || r.installedLocales < 0) return null;
  if (!(r.localeForLanguage === null || (typeof r.localeForLanguage === 'string' && r.localeForLanguage))) return null;
  if (typeof r.macos !== 'string' || !/^\d+\.\d+(\.\d+)?$/.test(r.macos)) return null;
  return r;
}

function speechGuard(major, outcome) {
  if (major > 0 && major < 26) return helperGateFor(major);
  const reading = outcome && typeof outcome.line === 'string' ? speechReadingOf(outcome.line) : null;
  if (reading && reading.isAvailable === false && Number(reading.macos.split('.')[0]) >= 26) {
    return `environment: this Mac cannot recognise speech on the Mac itself (the test's own probe read SpeechTranscriber.isAvailable false on macOS ${reading.macos}), as on a hosted virtual machine; this case runs in full on a Mac that can`;
  }
  return false;
}

// The guard's reading, in words, for the case to print.
function speechGuardReading(major, outcome) {
  const skip = speechGuard(major, outcome);
  const macos = `sw_vers major ${major || 'unread'}`;
  const verdict = skip ? `this case is skipped: ${skip}` : 'this case runs';
  if (major > 0 && major < 26) return `the guard did not probe (${macos}); ${verdict}`;
  if (!outcome || typeof outcome.line !== 'string') {
    const failed = outcome && outcome.failed ? outcome.failed : 'gave no outcome';
    return `the guard's own probe ${failed}${outcome && outcome.detail ? ` (${String(outcome.detail).trim().slice(0, 400)})` : ''}; no reading, so ${verdict} (${macos})`;
  }
  const r = speechReadingOf(outcome.line);
  if (!r) return `the guard's own probe printed no well-formed reading (${JSON.stringify(outcome.line.slice(0, 400))}); so ${verdict} (${macos})`;
  const locale = r.localeForLanguage ? `an installed speech locale for the language, ${r.localeForLanguage}` : 'no installed speech locale for the language';
  return `the guard's own probe read SpeechTranscriber.isAvailable ${r.isAvailable}, ${r.installedLocales} installed speech locale(s), ${locale}, on macOS ${r.macos} (${macos}); ${verdict}`;
}

let probed = null;
// The guard's own probe, built and run once per test process, its build in a
// temporary folder of its own, removed when the process exits.
function speechProbe() {
  if (probed) return probed;
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'squire-speech-probe-')));
  process.on('exit', () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* gone */ } });
  const out = path.join(dir, 'speech-availability');
  const b = spawnSync('/usr/bin/xcrun', ['swiftc', '-O', '-swift-version', '5', '-suppress-warnings', '-parse-as-library', '-module-cache-path', path.join(dir, 'cache'),
    path.join(__dirname, 'tools', 'speech-availability.swift'), '-o', out], { encoding: 'utf8', timeout: 300000, env: { ...process.env, TMPDIR: dir } });
  if (b.error || b.status !== 0 || !fs.existsSync(out)) {
    probed = { failed: b.error && b.error.code === 'ETIMEDOUT' ? 'timed out building' : 'failed to build', detail: (b.stderr || (b.error && b.error.message) || `exit ${b.status}`).toString() };
    return probed;
  }
  const r = spawnSync(out, [], { encoding: 'utf8', timeout: 30000, cwd: dir });
  if (r.error && r.error.code === 'ETIMEDOUT') probed = { failed: 'timed out', detail: 'no line within 30 seconds' };
  else if (r.error || r.status !== 0) probed = { failed: 'crashed', detail: `${r.signal ? `signal ${r.signal}` : `exit ${r.status}`} ${(r.stderr || (r.error && r.error.message) || '').toString().trim()}` };
  else probed = { line: r.stdout || '' };
  return probed;
}

// The guard as a case's skip option: a reason, or false. The probe runs only
// where the major version does not already decide.
function realSpeechGate() {
  const major = macosMajor();
  return speechGuard(major, major > 0 && major < 26 ? null : speechProbe());
}

// The guard's reading on this Mac, for a case to print.
function realSpeechReading() {
  const major = macosMajor();
  return speechGuardReading(major, major > 0 && major < 26 ? null : speechProbe());
}

// Why a case that needs Apple's avconvert cannot run here, or false, naming
// what was found.
function avconvertGate() {
  if (fs.existsSync('/usr/bin/avconvert')) return false;
  const r = spawnSync('/bin/sh', ['-c', 'command -v avconvert'], { encoding: 'utf8' });
  return `target-gated: Apple's avconvert is not at /usr/bin/avconvert on this runner (command -v avconvert found ${(r.stdout || '').trim() || 'nothing'})`;
}

// Why the made video cannot be made here, or false: it needs Apple's command
// line tools with a Swift compiler, and `say`.
function madeVideoGate() {
  const r = spawnSync('/usr/bin/xcrun', ['--find', 'swiftc'], { encoding: 'utf8' });
  if (r.status !== 0 || !(r.stdout || '').trim()) return `target-gated: the made video needs Apple's Swift compiler (xcrun --find swiftc: ${(r.stderr || r.stdout || 'nothing').trim()})`;
  if (!fs.existsSync('/usr/bin/say')) return 'target-gated: the made video needs the Mac\'s own /usr/bin/say';
  return false;
}

let built = null;
// The video tool, built once per test process into a temporary folder of its
// own, removed when the process exits.
function videoTool() {
  if (built) return built;
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'squire-video-fixture-')));
  process.on('exit', () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* gone */ } });
  const out = path.join(dir, 'video-fixture');
  const r = spawnSync('/usr/bin/xcrun', ['swiftc', '-O', '-swift-version', '5', '-suppress-warnings', '-module-cache-path', path.join(dir, 'cache'),
    path.join(__dirname, 'tools', 'video-fixture.swift'), '-o', out], { encoding: 'utf8', timeout: 300000, env: { ...process.env, TMPDIR: dir } });
  if (r.status !== 0) throw new Error(`the video fixture tool must build: ${(r.stderr || r.error || '').toString().trim()}`);
  built = out;
  return out;
}

// Spoken words from the Mac's own synthetic voice, as an AIFF file.
function spokenWords(file, words) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const r = spawnSync('/usr/bin/say', ['-o', file, words], { encoding: 'utf8', timeout: 60000 });
  if (r.status !== 0 || !fs.existsSync(file)) throw new Error(`say must make the spoken words: ${(r.stderr || '').trim()}`);
  return file;
}

// A made video: a picture of width x height, seconds long at least, with the
// spoken words as its one sound track (words given), or the sound of an audio
// file of this world's own (audio given, a fixtureRecording tone), or no
// sound track at all (neither), and location metadata when location (ISO
// 6709) is given.
function madeVideo(file, { words = null, audio = null, seconds = 2, width = 640, height = 360, location = null } = {}) {
  const tool = videoTool();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const args = ['make', file, String(width), String(height), String(seconds)];
  let speech = null;
  if (words) {
    speech = path.join(fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'squire-words-'))), 'words.aiff');
    spokenWords(speech, words);
    args.push('--audio', speech);
  } else if (audio) {
    args.push('--audio', audio);
  }
  if (location) args.push('--location', location);
  const r = spawnSync(tool, args, { encoding: 'utf8', timeout: 120000 });
  if (speech) fs.rmSync(path.dirname(speech), { recursive: true, force: true });
  if (r.status !== 0) throw new Error(`the made video must be made: ${(r.stderr || '').trim()}`);
  return file;
}

// What a media file holds, read from the file: { duration, videoTracks,
// audioTracks, width, height, location }.
function describeMedia(file) {
  const r = spawnSync(videoTool(), ['describe', file], { encoding: 'utf8', timeout: 60000 });
  if (r.status !== 0) throw new Error(`the video fixture tool must read ${file}: ${(r.stderr || '').trim()}`);
  return JSON.parse(r.stdout);
}

// Every track of a media file, read from the file, with what each sound
// track decodes to inside a window (from and to, in seconds from the file's
// start): { file, duration, window, tracks: [{ id, type, enabled, start,
// duration, and for sound: decoded, rate, frames, framesInWindow,
// loudFramesInWindow, peak, or why }] }.
function mediaTracks(file, from, to) {
  const r = spawnSync(videoTool(), ['tracks', file, String(from), String(to)], { encoding: 'utf8', timeout: 60000 });
  if (r.status !== 0) throw new Error(`the video fixture tool must list the tracks of ${file}: ${(r.stderr || '').trim()}`);
  return JSON.parse(r.stdout);
}

// Whether a file sounds inside a window: a sound track whose loud frames
// fill at least half of the window.
function soundsIn(tracks) {
  const [from, to] = tracks.window;
  return tracks.tracks.some((t) => t.type === 'soun' && t.decoded && t.rate > 0
    && t.loudFramesInWindow >= 0.5 * (to - from) * t.rate);
}

module.exports = {
  SPEECH_UNAVAILABLE,
  mark,
  fixtureRecording,
  speechEngine,
  networkRecorder,
  digestOf,
  changedIn,
  mediaFiles,
  clockOf,
  paragraphsOf,
  assertTimedForm,
  srtTimeOf,
  srtCues,
  macosMajor,
  realHelperGate,
  speechReadingOf,
  speechGuard,
  speechGuardReading,
  speechProbe,
  realSpeechGate,
  realSpeechReading,
  avconvertGate,
  madeVideoGate,
  spokenWords,
  madeVideo,
  describeMedia,
  mediaTracks,
  soundsIn,
};
