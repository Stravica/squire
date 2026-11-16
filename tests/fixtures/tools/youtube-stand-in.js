'use strict';

// The YouTube stand-in of the media world (tests/fixtures/media-world.js),
// run as its own process so a test can wait on a product process
// synchronously (the base world's runPython) while it answers. It is not
// Squire's and never reaches beyond this Mac's loopback.
//
//   node youtube-stand-in.js <state folder>
//
// <state>/config.json, written by the test before the start: the video ids
// ({ captioned, uncaptioned, refused }), the caption words, and the test
// process's pid (the stand-in ends itself once that process is gone).
//
// It answers as YouTube's own pages do, on two routes only: GET /watch?v=<id>,
// a video's page, whose ytInitialPlayerResponse lists the video's caption
// tracks (each a baseUrl and a languageCode), and GET
// /api/timedtext?v=<id>&lang=<code>, a track's captions as timedtext XML. The
// captioned video has captions; the uncaptioned one has a page with none; the
// refused one is answered 429 (the page a refusal shows). Every other path is
// 404. Every request is recorded, one JSON line in <state>/requests.jsonl,
// written before it is answered: method, path and query, headers, and the
// status it was answered with. The port is written to <state>/port once
// listening.

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const state = process.argv[2];
const config = JSON.parse(fs.readFileSync(path.join(state, 'config.json'), 'utf8'));
const VIDEOS = config.videos;
const captionWords = config.captionWords;
let origin = '';

function playerResponse(id, withCaptions) {
  const response = { videoDetails: { videoId: id, title: 'Sourdough in ten minutes' }, playabilityStatus: { status: 'OK' } };
  if (withCaptions) {
    response.captions = { playerCaptionsTracklistRenderer: { captionTracks: [
      { baseUrl: `${origin}/api/timedtext?v=${id}&lang=en`, languageCode: 'en', name: { simpleText: 'English' } },
    ] } };
  }
  return response;
}

const server = http.createServer((req, res) => {
  const u = new URL(req.url, origin);
  const id = u.searchParams.get('v');
  const send = (status, type, body) => {
    fs.appendFileSync(path.join(state, 'requests.jsonl'),
      JSON.stringify({ method: req.method, url: req.url, headers: req.headers, status, at: Date.now() }) + '\n');
    res.writeHead(status, { 'content-type': type });
    res.end(body);
  };
  if (req.method === 'GET' && u.pathname === '/watch' && id === VIDEOS.refused) {
    return send(429, 'text/html; charset=utf-8', '<!doctype html><title>YouTube</title><p>Sign in to confirm you’re not a bot.</p>');
  }
  if (req.method === 'GET' && u.pathname === '/watch' && (id === VIDEOS.captioned || id === VIDEOS.uncaptioned)) {
    const player = JSON.stringify(playerResponse(id, id === VIDEOS.captioned));
    return send(200, 'text/html; charset=utf-8', '<!doctype html><html><head><title>Sourdough in ten minutes - YouTube</title></head><body>' +
      `<script>var ytInitialPlayerResponse = ${player};</script></body></html>`);
  }
  if (req.method === 'GET' && u.pathname === '/api/timedtext' && id === VIDEOS.captioned) {
    return send(200, 'text/xml; charset=utf-8', '<?xml version="1.0" encoding="utf-8" ?><transcript>' +
      `<text start="0" dur="2.5">${captionWords.split('. ')[0]}.</text><text start="2.5" dur="2">${captionWords.split('. ')[1]}</text></transcript>`);
  }
  return send(404, 'text/plain', 'not here');
});
server.keepAliveTimeout = 1000;
server.listen(0, '127.0.0.1', () => {
  origin = `http://127.0.0.1:${server.address().port}`;
  fs.writeFileSync(path.join(state, 'port.tmp'), String(server.address().port));
  fs.renameSync(path.join(state, 'port.tmp'), path.join(state, 'port'));
});
// Ends with the test process that started it, so nothing outlives the test.
setInterval(() => {
  try { process.kill(config.parent, 0); } catch (e) { process.exit(0); }
}, 500);
process.on('SIGTERM', () => process.exit(0));
