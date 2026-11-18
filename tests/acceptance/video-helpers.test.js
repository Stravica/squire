'use strict';

// The video helpers, on the Mac, for the Squire owner's own files: a
// transcript with times, in paragraphs, and a plain "no sound" (AC-1701-3); a
// captions file (.srt) from the same pass, beside the transcript, not burned
// in (AC-1701-4); notes from a recording (AC-1701-5, external: the model's own
// behaviour, one release-Verify test); a clip, just the audio or a smaller
// copy by Apple's avconvert, each a new file, never over the original
// (AC-1701-6). Through the real entry points: the transcription and the new
// video tool, run as the session runs a command once the floor lets it
// through (a process with /usr/bin/python3 from the Squire home, in the
// product's environment), lay-down (what the session loads) and the safety
// floor as the session runs it (the PreToolUse hooks of the settings lay-down
// writes, the event on stdin).
//
// What the builder provides (the names are this file's; a case fails at its
// own first assertion while they are absent):
//   core/tools/transcribe.py '<file>'  (batch 3's, changed)
//       keeps the owner's file's words as a Markdown note in the owner's
//       folder (workspace/transcripts today) in the timed form: paragraphs,
//       each led by the time in the recording at which it starts (M:SS, or
//       H:MM:SS from an hour), a pause of five seconds or more between one
//       phrase's end and the next one's start starting a new paragraph, and
//       phrases a moment apart (half a second here) kept together; the words
//       as heard, so the owner can search and quote them. The times come
//       from the engine (the timed phrases the media world describes, which
//       Squire's own speech helper gives from the engine's time ranges). For
//       a video, the same pass also writes a captions file (.srt) beside the
//       note: in the same folder, with the same name but .srt, one cue a
//       phrase in order, numbered from 1, each cue's times the phrase's start
//       and end (HH:MM:SS,mmm, to the millisecond) and its text the phrase's
//       words. Nothing is burned into the video, which is left as it was. A
//       video with no sound: Squire says plainly that it has no sound (the
//       words "no sound"), keeps no note and no captions file, and never
//       crashes. The writer of the timed note and of the .srt is expected to
//       be one module function of transcribe.py (phrases in, the two texts
//       out), so it can be mutated at unit speed.
//   core/tools/video.py  (new)
//       video.py clip '<file>' '<from>' '<to>'   the part of the owner's
//           video between two times (M:SS, H:MM:SS or seconds, as the
//           transcript writes them)
//       video.py audio '<file>'                  just its sound
//       video.py smaller '<file>'                a smaller copy to share, its
//           picture at most 1280 by 720, without the video's location data
//       Each runs Apple's own /usr/bin/avconvert (a clip with --start and
//       --duration; just the sound with PresetAppleM4A; the smaller copy with
//       Preset1280x720 or an HEVC preset, location data left out, as
//       avconvert's metadata filter leaves it out by default), makes a new
//       file in the owner's folder, never over the original or any file
//       already there, says where, exit 0. The original is never written,
//       moved or changed. The avconvert arguments are expected to be built
//       by one module function of video.py (the request in, the argument
//       list out), so it can be mutated at unit speed.
//       What the session loads names each of the three as one command in a
//       code span inside Squire's own block, the path in quotes and a
//       <placeholder> for each value, as the transcription is named:
//       /usr/bin/python3 '<Squire home>/core/tools/video.py' clip '<file>'
//       '<from>' '<to>', ... audio '<file>' and ... smaller '<file>'. Fed to
//       the floor exactly as written (placeholders filled), each is asked,
//       its question naming video and audio work, never free and never
//       refused, in the default mode and in auto mode.
//
// Usage model for the paragraph pause and the cues (assumptions, none
// measured): typical, a recording of a minute or two in a handful of phrases
// with one long pause; heavy, an hour's recording, eight hundred phrases with
// a long pause every fifty and times past the hour. For a clip: typical, a
// few seconds cut from a short video; heavy, two clips from the same video,
// one after the other, neither over the other.
//
// The made videos are made at run time by the media world (a drawn picture
// and the Mac's own synthetic voice; nothing downloaded, nothing third-party,
// no recording of anyone). Cases that run Squire's own speech helper are
// target-gated below macOS 26, as the helper is; cases that run avconvert are
// target-gated where /usr/bin/avconvert is absent, naming what was found; a
// case that needs the made video is gated where the Mac has no Swift
// compiler. No case reaches the network beyond this Mac's loopback or a
// model.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const w = require('../fixtures/squire-world.js');
const U = require('../fixtures/usage-world.js');
const M = require('../fixtures/media-world.js');

const transcribeScript = (world) => path.join(world.home, 'core', 'tools', 'transcribe.py');
const videoScript = (world) => path.join(world.home, 'core', 'tools', 'video.py');
const MODES = ['default', 'auto'];
const PLACE = '+51.5074-000.1278/';

const gate = (...gates) => gates.map((g) => g()).find(Boolean) || false;
const said = (r) => `${r.stdout}\n${r.stderr}`;

function run(world, script, args, env, timeout = 120000) {
  return w.runPython(world, script, args, { env, timeout });
}

// The files under the owner's folder that are new or changed since a digest.
const newSince = (world, before) => M.changedIn(before, M.digestOf(world.owner)).map((rel) => path.join(world.owner, rel))
  .filter((f) => fs.existsSync(f) && fs.statSync(f).isFile());

// ---------------------------------------------------- the timed transcript

test("the owner's own video, given to Squire's own speech helper with no stand-in engine, becomes a transcript with times read from the video's sound, and its captions file (.srt) beside it, the video left as it was", { skip: gate(M.realHelperGate, M.madeVideoGate), timeout: 900000 }, async (t) => {
  const world = U.usageWorld(t);
  const net = await M.networkRecorder(t);
  const video = M.madeVideo(path.join(world.owner, 'workspace', 'files', 'Bread class.mov'), { words: 'Fold the dough every half hour. Then shape the loaves and leave them overnight.' });
  const bytes = fs.readFileSync(video);
  const before = M.digestOf(world.owner);
  const r = run(world, transcribeScript(world), [video], net.env, 800000);
  assert.equal(r.status, 0, `Squire's own speech helper must read the video's sound and the transcription exit 0; got ${w.describe(r)}`);
  const made = newSince(world, before);
  const note = made.find((f) => f.endsWith('.md') && /dough/i.test(fs.readFileSync(f, 'utf8')));
  assert.ok(note, `the video's words must be kept as a note in the owner's folder; new files ${JSON.stringify(made)}; ${w.describe(r)}`);
  const text = fs.readFileSync(note, 'utf8');
  const paragraph = M.paragraphsOf(text).find((p) => /dough/i.test(p)) || '';
  const lead = paragraph.indexOf('0:0');
  assert.ok(lead >= 0 && lead < paragraph.search(/fold/i), `the transcript's paragraph must be led by its time in the recording (0:00 to 0:09 here); it reads:\n${text}`);
  assert.match(text, /overnight/i, `the transcript must hold the video's words; it reads:\n${text}`);
  const srt = note.replace(/\.md$/, '.srt');
  assert.ok(fs.existsSync(srt), `a captions file must be kept beside the transcript (${srt}); new files ${JSON.stringify(made)}`);
  const cues = M.srtCues(fs.readFileSync(srt, 'utf8'));
  assert.ok(cues.length >= 1 && cues[0].index === '1' && cues[0].start && cues[0].end, `the captions file must hold numbered cues with times; got ${JSON.stringify(cues)}`);
  assert.ok(cues.some((c) => /dough/i.test(c.text)), `the captions must hold the video's words; got ${JSON.stringify(cues)}`);
  assert.ok(fs.readFileSync(video).equals(bytes), 'the video must be left as it was');
  await w.sleep(200);
  assert.equal(net.seen.length, 0, `nothing may be sent beyond this Mac: reached the network ${net.seen.length} time(s)`);
});

test("a video of the owner's with no sound: Squire says plainly that it has no sound, keeps no transcript and no captions file, and never crashes, with Squire's own speech helper and no stand-in engine", { skip: gate(M.realHelperGate, M.madeVideoGate), timeout: 900000 }, async (t) => {
  const world = U.usageWorld(t);
  const net = await M.networkRecorder(t);
  const video = M.madeVideo(path.join(world.owner, 'workspace', 'files', 'Shop tour.mov'), { seconds: 3 });
  assert.equal(M.describeMedia(video).audioTracks, 0, 'the made video must have no sound track');
  const before = M.digestOf(world.owner);
  const r = run(world, transcribeScript(world), [video], net.env, 800000);
  t.diagnostic(w.describe(r));
  assert.doesNotMatch(r.stderr, /Traceback/, `Squire must answer with its own words, never a crash; got ${w.describe(r)}`);
  assert.match(said(r), /\bno sound\b/i, `Squire must say plainly that the video has no sound; got ${w.describe(r)}`);
  assert.deepEqual(M.changedIn(before, M.digestOf(world.owner)), [], 'no transcript and no captions file may be kept, and nothing in the owner\'s folder may change');
  await w.sleep(200);
  assert.equal(net.seen.length, 0, `nothing may be sent beyond this Mac: reached the network ${net.seen.length} time(s)`);
});

// Typical and heavy phrase lists: { phrases, groups } with the paragraphs
// they must make.
function typicalPhrases(words) {
  return {
    phrases: [
      { start: 0.3, end: 3.1, text: `Welcome to the shop ${words}.` },
      { start: 3.4, end: 6.0, text: 'Today we bake rye.' },
      { start: 14.2, end: 17.5, text: 'First, the starter.' },
      { start: 17.9, end: 19.0, text: 'It needs a day.' },
      { start: 64.5, end: 66.0, text: 'Now the dough.' },
    ],
    groups: [[0, 1], [2, 3], [4]],
  };
}
function heavyPhrases(words) {
  const phrases = [];
  const groups = [];
  let at = 0.4;
  for (let i = 0; i < 800; i += 1) {
    if (i % 50 === 0) {
      if (i) at += 6;
      groups.push([]);
    }
    phrases.push({ start: Number(at.toFixed(1)), end: Number((at + 4.4).toFixed(1)), text: `Point ${i + 1} of the hour ${words}.` });
    groups[groups.length - 1].push(i);
    at += 4.9;
  }
  return { phrases, groups };
}

test("a transcript with times, in paragraphs: the owner's own recording is kept as a note whose paragraphs are each led by their time in the recording, phrases a moment apart kept together and a long pause starting a new paragraph, the words as heard, for a short recording and for an hour's", { timeout: 180000 }, async (t) => {
  const world = U.usageWorld(t);
  const net = await M.networkRecorder(t);
  for (const [what, profile] of [['a short recording', typicalPhrases(M.mark('typical'))], ["an hour's recording", heavyPhrases(M.mark('heavy'))]]) {
    const engine = M.speechEngine(world, { phrases: profile.phrases });
    const recording = M.fixtureRecording(path.join(world.owner, 'workspace', 'files', `${what.replace(/\W+/g, ' ').trim()}.wav`));
    const before = M.digestOf(world.owner);
    const r = run(world, transcribeScript(world), [recording], { ...engine.env, ...net.env });
    assert.equal(r.status, 0, `${what}: the transcription must run and exit 0; got ${w.describe(r)}`);
    const note = newSince(world, before).find((f) => f.endsWith('.md'));
    assert.ok(note, `${what}: the transcript must be kept as a note in the owner's folder; got ${w.describe(r)}`);
    M.assertTimedForm(fs.readFileSync(note, 'utf8'), profile.phrases, profile.groups, what);
  }
  await w.sleep(200);
  assert.equal(net.seen.length, 0, `nothing may be sent beyond this Mac: reached the network ${net.seen.length} time(s)`);
});

// ---------------------------------------------------- the captions file

test("a captions file (.srt) from the same pass is kept beside the transcript of the owner's own video, one numbered cue a phrase with the phrase's own times and words, for a short video and an hour's, and nothing is burned into the video, which is left as it was", { skip: gate(M.madeVideoGate), timeout: 300000 }, async (t) => {
  const world = U.usageWorld(t);
  const net = await M.networkRecorder(t);
  const video = M.madeVideo(path.join(world.owner, 'workspace', 'files', 'Shop tour.mov'), { seconds: 2 });
  const bytes = fs.readFileSync(video);
  for (const [what, profile] of [['a short video', typicalPhrases(M.mark('typical'))], ["an hour's video", heavyPhrases(M.mark('heavy'))]]) {
    const engine = M.speechEngine(world, { phrases: profile.phrases });
    const before = M.digestOf(world.owner);
    const r = run(world, transcribeScript(world), [video], { ...engine.env, ...net.env });
    assert.equal(r.status, 0, `${what}: the transcription must run and exit 0; got ${w.describe(r)}`);
    const made = newSince(world, before);
    const note = made.find((f) => f.endsWith('.md'));
    assert.ok(note, `${what}: the transcript must be kept as a note in the owner's folder; got ${w.describe(r)}`);
    const srt = note.replace(/\.md$/, '.srt');
    assert.ok(made.includes(srt), `${what}: a captions file must be kept beside the transcript, in its folder with its name (${srt}); new files ${JSON.stringify(made)}`);
    const cues = M.srtCues(fs.readFileSync(srt, 'utf8'));
    assert.equal(cues.length, profile.phrases.length, `${what}: one cue a phrase; got ${cues.length} for ${profile.phrases.length}`);
    for (const [i, p] of profile.phrases.entries()) {
      assert.deepEqual(cues[i], { index: String(i + 1), start: M.srtTimeOf(p.start), end: M.srtTimeOf(p.end), text: p.text },
        `${what}: cue ${i + 1} must be numbered ${i + 1}, carry the phrase's own times and words`);
    }
    assert.deepEqual(made.filter((f) => f !== note && f !== srt), [], `${what}: nothing but the transcript and its captions file may be made: nothing is burned into a new video`);
    assert.ok(fs.readFileSync(video).equals(bytes), `${what}: the video must be left as it was`);
  }
  await w.sleep(200);
  assert.equal(net.seen.length, 0, `nothing may be sent beyond this Mac: reached the network ${net.seen.length} time(s)`);
});

// ---------------------------------------------- notes from a recording

const TARGET = process.env.SQUIRE_TARGET_HOST || process.env.RCF_TARGET_URL || '';
const TARGET_SQUIRE_HOME = process.env.SQUIRE_TARGET_SQUIRE_HOME || '';
const SKIP = TARGET ? false : 'external: needs a target host (SQUIRE_TARGET_HOST, an SSH destination, or RCF_TARGET_URL)';
const WALK_MINUTES = 20;

function onTarget(command, { timeout = 60000 } = {}) {
  const exported = TARGET_SQUIRE_HOME ? `export SQUIRE_HOME=${JSON.stringify(TARGET_SQUIRE_HOME)}; ` : '';
  const r = spawnSync('ssh', ['-o', 'BatchMode=yes', TARGET.replace(/^ssh:\/\//, ''), exported + command], { encoding: 'utf8', timeout });
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

// External (release Verify; excluded at round TEST). The walk is by hand, as
// the release Verify walks it: on a signed release, the person verifying
// gives Squire one short recording of their own in a session and asks for
// call notes from it, then for creator notes. The test waits for the walk (at
// most WALK_MINUTES) and reads, read-only, the owner's folder on the target:
// a new Markdown note naming decisions, actions and a follow-up draft, and
// one naming chapters, show notes and post drafts; no mail sent by Squire
// (the floor's ledger records no send); the recording unchanged.
test("on a signed release, notes from a recording of the owner's own: call notes with decisions, actions and a follow-up draft for the owner to send, never sent by Squire, and creator notes with chapters, show notes and post drafts, the recording itself left on the Mac as it was", { skip: SKIP, timeout: (WALK_MINUTES + 5) * 60000 }, async (t) => {
  if (!TARGET) { t.skip('external: needs a target host'); return; }
  const look = () => {
    const r = onTarget('/usr/bin/python3 -c "import json,os,sys,time; h=os.environ.get(\'SQUIRE_HOME\') or os.path.expanduser(\'~/Library/Application Support/Squire\'); o=json.load(open(os.path.join(h,\'squire.json\')))[\'ownerFolder\']; out=[]\nfor d,_,fs in os.walk(o):\n  for f in fs:\n    p=os.path.join(d,f)\n    if f.endswith(\'.md\'): out.append({\'path\':p,\'mtime\':os.path.getmtime(p),\'text\':open(p,errors=\'replace\').read()[:20000]})\nprint(json.dumps({\'now\':time.time(),\'notes\':out,\'ledger\':open(os.path.join(o,\'state\',\'approvals.jsonl\'),errors=\'replace\').read() if os.path.exists(os.path.join(o,\'state\',\'approvals.jsonl\')) else \'\'}))"');
    assert.equal(r.status, 0, `the target must answer a read-only look at the owner's folder; got ${r.stderr}`);
    return JSON.parse(r.stdout);
  };
  const first = look();
  t.diagnostic(`give Squire one short recording of your own and ask for call notes from it, then creator notes; waiting up to ${WALK_MINUTES} minutes`);
  const end = Date.now() + WALK_MINUTES * 60000;
  let seen = first;
  const fresh = (s) => s.notes.filter((n) => n.mtime >= first.now);
  const callNotes = (s) => fresh(s).find((n) => /decision/i.test(n.text) && /action/i.test(n.text) && /follow-up|follow up/i.test(n.text));
  const creatorNotes = (s) => fresh(s).find((n) => /chapter/i.test(n.text) && /show notes/i.test(n.text) && /post/i.test(n.text));
  while (!(callNotes(seen) && creatorNotes(seen)) && Date.now() < end) {
    await new Promise((resolve) => setTimeout(resolve, 15000));
    seen = look();
  }
  assert.ok(callNotes(seen), 'call notes from the recording must be kept: decisions, actions and a follow-up draft');
  assert.ok(creatorNotes(seen), 'creator notes from the recording must be kept: chapters, show notes and post drafts');
  assert.doesNotMatch(seen.ledger.slice(first.ledger.length), /"(send|sent)"|gmail.*send|send_message/i, 'Squire must send nothing: the follow-up is a draft for the owner to send');
});

// ------------------------------------------- a clip, the sound, a smaller copy

const AVCONVERT = [M.avconvertGate, M.madeVideoGate];

test("a clip of the owner's own video between two times is cut on the Mac by Apple's avconvert into a new file in the owner's folder, twice from the same video, each a new file, neither over the other, and the original never written over or changed", { skip: gate(...AVCONVERT), timeout: 300000 }, async (t) => {
  const world = U.usageWorld(t);
  const net = await M.networkRecorder(t);
  const original = M.madeVideo(path.join(world.owner, 'workspace', 'files', 'Bread class.mov'), { words: 'One. Two. Three. Four. Five. Six.', seconds: 6 });
  const bytes = fs.readFileSync(original);
  const whole = M.describeMedia(original).duration;
  const clips = [];
  for (const [from, to] of [['0:01', '0:03'], ['0:01', '0:03']]) {
    const before = M.digestOf(world.owner);
    const r = run(world, videoScript(world), ['clip', original, from, to], net.env);
    assert.equal(r.status, 0, `the video tool (core/tools/video.py clip '<file>' '<from>' '<to>') must cut the clip and exit 0; got ${w.describe(r)}`);
    const made = newSince(world, before);
    assert.equal(made.length, 1, `the clip must be one new file in the owner's folder, nothing else changed; got ${JSON.stringify(made)}`);
    assert.ok(said(r).includes(path.basename(made[0])), `Squire must say where the clip is; got ${w.describe(r)}`);
    const clip = M.describeMedia(made[0]);
    assert.ok(clip.videoTracks >= 1 && clip.audioTracks >= 1, `the clip must keep the picture and the sound; got ${JSON.stringify(clip)}`);
    assert.ok(clip.duration >= 1 && clip.duration <= 3.5 && clip.duration < whole - 1, `the clip must be the part between ${from} and ${to} (about two seconds of ${whole}); got ${clip.duration}`);
    clips.push([made[0], fs.readFileSync(made[0])]);
  }
  assert.notEqual(clips[0][0], clips[1][0], 'a second clip must be a new file, never over the first');
  assert.ok(fs.readFileSync(clips[0][0]).equals(clips[0][1]), 'the first clip must be left as it was');
  assert.ok(fs.readFileSync(original).equals(bytes), 'the original must never be written over or changed');
  await w.sleep(200);
  assert.equal(net.seen.length, 0, `nothing may be sent beyond this Mac: reached the network ${net.seen.length} time(s)`);
});

test("just the sound of the owner's own video is kept on the Mac by Apple's avconvert as a new audio file in the owner's folder, with no picture, the original never written over or changed", { skip: gate(...AVCONVERT), timeout: 300000 }, async (t) => {
  const world = U.usageWorld(t);
  const net = await M.networkRecorder(t);
  const original = M.madeVideo(path.join(world.owner, 'workspace', 'files', 'Bread class.mov'), { words: 'Fold the dough every half hour.', seconds: 3 });
  const bytes = fs.readFileSync(original);
  const before = M.digestOf(world.owner);
  const r = run(world, videoScript(world), ['audio', original], net.env);
  assert.equal(r.status, 0, `the video tool (core/tools/video.py audio '<file>') must keep just the sound and exit 0; got ${w.describe(r)}`);
  const made = newSince(world, before);
  assert.equal(made.length, 1, `just the sound must be one new file in the owner's folder, nothing else changed; got ${JSON.stringify(made)}`);
  assert.ok(said(r).includes(path.basename(made[0])), `Squire must say where it is; got ${w.describe(r)}`);
  const sound = M.describeMedia(made[0]);
  assert.ok(sound.audioTracks >= 1 && sound.videoTracks === 0, `the new file must hold the sound and no picture; got ${JSON.stringify(sound)}`);
  assert.ok(fs.readFileSync(original).equals(bytes), 'the original must never be written over or changed');
  await w.sleep(200);
  assert.equal(net.seen.length, 0, `nothing may be sent beyond this Mac: reached the network ${net.seen.length} time(s)`);
});

test("a smaller copy of the owner's own video to share is made on the Mac by Apple's avconvert as a new file in the owner's folder, its picture at most 1280 by 720 and without the video's location data, the original never written over or changed", { skip: gate(...AVCONVERT), timeout: 300000 }, async (t) => {
  const world = U.usageWorld(t);
  const net = await M.networkRecorder(t);
  const original = M.madeVideo(path.join(world.owner, 'workspace', 'files', 'Bread class.mov'), { words: 'Fold the dough every half hour.', seconds: 2, width: 1920, height: 1080, location: PLACE });
  assert.equal(M.describeMedia(original).location, true, 'the made video must carry location data');
  const bytes = fs.readFileSync(original);
  const before = M.digestOf(world.owner);
  const r = run(world, videoScript(world), ['smaller', original], net.env);
  assert.equal(r.status, 0, `the video tool (core/tools/video.py smaller '<file>') must make the smaller copy and exit 0; got ${w.describe(r)}`);
  const made = newSince(world, before);
  assert.equal(made.length, 1, `the smaller copy must be one new file in the owner's folder, nothing else changed; got ${JSON.stringify(made)}`);
  assert.ok(said(r).includes(path.basename(made[0])), `Squire must say where it is; got ${w.describe(r)}`);
  const copy = M.describeMedia(made[0]);
  assert.ok(copy.videoTracks >= 1 && copy.width > 0 && copy.width <= 1280 && copy.height <= 720, `the copy's picture must be at most 1280 by 720 (the original is 1920 by 1080); got ${JSON.stringify(copy)}`);
  assert.equal(copy.location, false, 'the smaller copy must not carry the video\'s location data');
  assert.ok(!fs.readFileSync(made[0]).includes(Buffer.from('+51.5074')), 'the smaller copy must not carry the place, in any form');
  assert.ok(fs.readFileSync(original).equals(bytes), 'the original must never be written over or changed');
  await w.sleep(200);
  assert.equal(net.seen.length, 0, `nothing may be sent beyond this Mac: reached the network ${net.seen.length} time(s)`);
});

test("the clip, just the sound and the smaller copy, each named by what the session loads, are asked by the safety floor as the session runs it, the question naming video and audio work, never free and never refused, in the default mode and in auto mode", { timeout: 180000 }, (t) => {
  const world = U.usageWorld(t, { core: false });
  const laid = w.layDown(world, w.CORE);
  assert.equal(laid.status, 0, `laying down core must succeed; got ${w.describe(laid)}`);
  const loaded = fs.readFileSync(path.join(world.home, 'claude-config', 'CLAUDE.md'), 'utf8');
  const open = loaded.indexOf('<!-- squire persona -->');
  const close = loaded.indexOf('<!-- end squire persona -->');
  const spans = [...(open >= 0 && close > open ? loaded.slice(open, close) : '').matchAll(/`([^`\n]+)`/g)].map((m) => m[1]);
  const video = path.join(world.owner, 'workspace', 'files', 'Bread class.mov');
  fs.mkdirSync(path.dirname(video), { recursive: true });
  fs.writeFileSync(video, 'a video of the owner\'s own\n');
  const floor = U.laidFloor(world, U.UTC);
  assert.ok(floor.hooks.length > 0, `the settings lay-down writes must run the safety floor before every tool call; got ${floor.settings ? JSON.stringify(floor.settings.hooks || null) : 'no settings file'}`);
  for (const verb of ['clip', 'audio', 'smaller']) {
    const named = spans.find((s) => s.includes(videoScript(world)) && new RegExp(`\\b${verb}\\b`).test(s));
    assert.ok(named, `what the session loads must name the video tool's ${verb} by its path in the Squire home, as one command in Squire's own block; its commands are ${JSON.stringify(spans)}`);
    const values = [video, '0:01', '0:03'];
    let n = 0;
    const command = named.replace(/<[^<>]+>/g, () => values[Math.min(n++, values.length - 1)]);
    for (const mode of MODES) {
      const job = `job-${mode}-video-${verb}`;
      const r = floor.run(job, w.tools.bash(command), mode);
      const verdict = r.status === 0 ? 'free' : (r.status === 2 && w.requestIdIn(r.stderr) ? 'asked' : 'refused');
      t.diagnostic(`${mode}: ${verdict}: ${command}`);
      assert.equal(verdict, 'asked', `the video tool's ${verb}, exactly as the session loads it, in ${mode} mode, must be asked by the floor, never free and never refused; got ${w.describe(r)}`);
      assert.match(r.stderr, U.HEAVY.media, `the question for the ${verb}, in ${mode} mode, must name video and audio work; got ${w.describe(r)}`);
      U.sayYesTo(world, job, r, { env: U.UTC });
      w.assertAllowed(floor.run(job, w.tools.bash(command), mode), `the video tool's ${verb}, in ${mode} mode, once the owner said yes`);
    }
  }
});
