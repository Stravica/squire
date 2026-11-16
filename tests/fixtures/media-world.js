'use strict';

// What the video, audio and voice-note cases share, on top of the base world
// (squire-world.js). Nothing here imports or copies product logic; every
// product process is run as the Mac or the session would run it, in the
// product's environment, with three things of this world's own in place of
// the world outside the Mac:
//
//   the speech engine   a stand-in program the product runs as its one local
//                       speech engine, named to it by SQUIRE_SPEECH_ENGINE
//                       (the seam the builder makes: with the variable set,
//                       the product runs that program in place of its own
//                       engine, and with it unset, its own). The engine is
//                       run as <engine> <audio file>: it prints the text on
//                       stdout and exits 0; where the Mac cannot recognise
//                       speech on the Mac itself it exits 69 with the reason
//                       on stderr; any other failure is any other non-zero
//                       exit. The stand-in records every call and never
//                       touches the network.
//   YouTube             a stand-in server on this Mac's loopback, named to the
//                       captions reader by SQUIRE_YOUTUBE_ORIGIN (the seam the
//                       builder makes: with the variable set, the reader reads
//                       from that origin in place of https://www.youtube.com).
//                       It answers as YouTube's own pages do, on two routes
//                       only: GET /watch?v=<id>, a video's page, whose
//                       ytInitialPlayerResponse lists the video's caption
//                       tracks (each a baseUrl and a languageCode), and GET
//                       /api/timedtext?v=<id>&lang=<code>, a track's captions
//                       as timedtext XML. One video has captions, one has
//                       none, and one is refused (429, the page a refusal
//                       shows). Every other path is 404. It records every
//                       request: method, path and query, and headers.
//   the network         every proxy variable a client honours points at a
//                       recorder on this Mac's loopback, with the loopback
//                       itself left out (NO_PROXY), so a request for any host
//                       but this Mac reaches the recorder, which counts it.
//
// The fixture recording is a generated tone, never anyone's voice.

const { spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
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

// The stand-in speech engine, written into the world: behaviour 'transcribe'
// prints the given text, 'unavailable' says the Mac cannot recognise speech on
// the Mac itself (exit 69), 'fail' fails (exit 1). calls() lists every run.
function speechEngine(world, { behaviour = 'transcribe', text = `Buy flour on Thursday. ${mark('spoken')}` } = {}) {
  const dir = path.join(world.root, 'speech-engine');
  fs.mkdirSync(dir, { recursive: true });
  const callsFile = path.join(dir, 'calls.jsonl');
  const program = path.join(dir, 'engine');
  fs.writeFileSync(program, `#!${process.execPath}
const fs = require('fs');
fs.appendFileSync(${JSON.stringify(callsFile)}, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), at: Date.now(),
  read: process.argv[2] && fs.existsSync(process.argv[2]) ? fs.statSync(process.argv[2]).size : null }) + '\\n');
const behaviour = ${JSON.stringify(behaviour)};
if (behaviour === 'unavailable') { process.stderr.write('speech recognition on this Mac itself is not available for this language\\n'); process.exit(69); }
if (behaviour === 'fail') { process.stderr.write('the recording could not be opened\\n'); process.exit(1); }
process.stdout.write(${JSON.stringify(text)} + '\\n');
`);
  fs.chmodSync(program, 0o755);
  const calls = () => (fs.existsSync(callsFile) ? fs.readFileSync(callsFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  return { program, text, calls, env: { SQUIRE_SPEECH_ENGINE: program } };
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

// YouTube's video ids are eleven letters, digits, - and _.
const VIDEOS = { captioned: 'Capti0nsOk1', uncaptioned: 'N0Captions1', refused: 'Refused0001' };

function playerResponse(origin, id, withCaptions) {
  const response = { videoDetails: { videoId: id, title: 'Sourdough in ten minutes' }, playabilityStatus: { status: 'OK' } };
  if (withCaptions) {
    response.captions = { playerCaptionsTracklistRenderer: { captionTracks: [
      { baseUrl: `${origin}/api/timedtext?v=${id}&lang=en`, languageCode: 'en', name: { simpleText: 'English' } },
    ] } };
  }
  return response;
}

// The YouTube stand-in on loopback. Resolves { origin, requests, link(id),
// captionWords, env } once it listens.
async function youtubeStandIn(t) {
  const requests = [];
  const captionWords = `Fold the dough every thirty minutes. ${mark('caption')}`;
  let origin = '';
  const server = http.createServer((req, res) => {
    requests.push({ method: req.method, url: req.url, headers: req.headers });
    const u = new URL(req.url, origin);
    const id = u.searchParams.get('v');
    const send = (status, type, body) => { res.writeHead(status, { 'content-type': type }); res.end(body); };
    if (req.method === 'GET' && u.pathname === '/watch' && id === VIDEOS.refused) {
      return send(429, 'text/html; charset=utf-8', '<!doctype html><title>YouTube</title><p>Sign in to confirm you’re not a bot.</p>');
    }
    if (req.method === 'GET' && u.pathname === '/watch' && (id === VIDEOS.captioned || id === VIDEOS.uncaptioned)) {
      const player = JSON.stringify(playerResponse(origin, id, id === VIDEOS.captioned));
      return send(200, 'text/html; charset=utf-8', `<!doctype html><html><head><title>Sourdough in ten minutes - YouTube</title></head><body>` +
        `<script>var ytInitialPlayerResponse = ${player};</script></body></html>`);
    }
    if (req.method === 'GET' && u.pathname === '/api/timedtext' && id === VIDEOS.captioned) {
      return send(200, 'text/xml; charset=utf-8', '<?xml version="1.0" encoding="utf-8" ?><transcript>' +
        `<text start="0" dur="2.5">${captionWords.split('. ')[0]}.</text><text start="2.5" dur="2">${captionWords.split('. ')[1]}</text></transcript>`);
    }
    return send(404, 'text/plain', 'not here');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  t.after(() => server.close());
  return {
    origin,
    requests,
    captionWords,
    link: (id) => `https://www.youtube.com/watch?v=${id}`,
    env: { SQUIRE_YOUTUBE_ORIGIN: origin },
  };
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
const MEDIA = /\.(mp4|m4a|m4v|webm|mkv|mov|mp3|aac|opus|ogg|wav|flac|3gp)$/i;
function mediaFiles(dir) {
  const r = spawnSync('/usr/bin/find', [dir, '-type', 'f'], { encoding: 'utf8' });
  return (r.stdout || '').split('\n').filter((f) => MEDIA.test(f));
}

module.exports = {
  mark,
  fixtureRecording,
  speechEngine,
  networkRecorder,
  VIDEOS,
  youtubeStandIn,
  digestOf,
  changedIn,
  mediaFiles,
};
