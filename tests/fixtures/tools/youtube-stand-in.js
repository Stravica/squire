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
// written before it is answered: method, path and query, headers, the status
// it was answered with, and the address it reached (to). The port is written
// to <state>/port once listening.
//
// With config.also (one of this Mac's own addresses on a network), the same
// stand-in also listens there, on a port of its own written to
// <state>/port-also, for the life of the case: an origin that is not the
// loopback but answers on this Mac. It answers there only connections from
// this Mac's own addresses and drops any other unanswered and unrecorded. A
// failure to listen is written to <state>/error.

const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const state = process.argv[2];
const config = JSON.parse(fs.readFileSync(path.join(state, 'config.json'), 'utf8'));
const VIDEOS = config.videos;
const captionWords = config.captionWords;
const inUrl = (host) => (host.includes(':') ? `[${host}]` : host);
const bare = (address) => String(address || '').replace(/^::ffff:/i, '').replace(/%.*$/, '');
const ownAddresses = () => new Set(Object.values(os.networkInterfaces()).flat().map((a) => bare(a.address)));

function standIn(host, portFile) {
  let origin = '';
  const server = http.createServer(answer(() => origin));
  if (host !== '127.0.0.1') {
    server.on('connection', (socket) => { if (!ownAddresses().has(bare(socket.remoteAddress))) socket.destroy(); });
  }
  server.keepAliveTimeout = 1000;
  server.on('error', (e) => { fs.writeFileSync(path.join(state, 'error'), `${host}: ${e.message}\n`); });
  server.listen(0, host, () => {
    origin = `http://${inUrl(host)}:${server.address().port}`;
    fs.writeFileSync(path.join(state, `${portFile}.tmp`), String(server.address().port));
    fs.renameSync(path.join(state, `${portFile}.tmp`), path.join(state, portFile));
  });
}

function playerResponse(origin, id, withCaptions) {
  const response = { videoDetails: { videoId: id, title: 'Sourdough in ten minutes' }, playabilityStatus: { status: 'OK' } };
  if (withCaptions) {
    response.captions = { playerCaptionsTracklistRenderer: { captionTracks: [
      { baseUrl: `${origin}/api/timedtext?v=${id}&lang=en`, languageCode: 'en', name: { simpleText: 'English' } },
    ] } };
  }
  return response;
}

const answer = (originOf) => (req, res) => {
  const origin = originOf();
  const u = new URL(req.url, origin);
  const id = u.searchParams.get('v');
  const send = (status, type, body) => {
    fs.appendFileSync(path.join(state, 'requests.jsonl'),
      JSON.stringify({ method: req.method, url: req.url, headers: req.headers, status, to: bare(req.socket.localAddress), at: Date.now() }) + '\n');
    res.writeHead(status, { 'content-type': type });
    res.end(body);
  };
  if (req.method === 'GET' && u.pathname === '/watch' && id === VIDEOS.refused) {
    return send(429, 'text/html; charset=utf-8', '<!doctype html><title>YouTube</title><p>Sign in to confirm you’re not a bot.</p>');
  }
  if (req.method === 'GET' && u.pathname === '/watch' && (id === VIDEOS.captioned || id === VIDEOS.uncaptioned)) {
    const player = JSON.stringify(playerResponse(origin, id, id === VIDEOS.captioned));
    return send(200, 'text/html; charset=utf-8', '<!doctype html><html><head><title>Sourdough in ten minutes - YouTube</title></head><body>' +
      `<script>var ytInitialPlayerResponse = ${player};</script></body></html>`);
  }
  if (req.method === 'GET' && u.pathname === '/api/timedtext' && id === VIDEOS.captioned) {
    return send(200, 'text/xml; charset=utf-8', '<?xml version="1.0" encoding="utf-8" ?><transcript>' +
      `<text start="0" dur="2.5">${captionWords.split('. ')[0]}.</text><text start="2.5" dur="2">${captionWords.split('. ')[1]}</text></transcript>`);
  }
  return send(404, 'text/plain', 'not here');
};

standIn('127.0.0.1', 'port');
if (config.also) standIn(config.also, 'port-also');
// Ends with the test process that started it, so nothing outlives the test.
setInterval(() => {
  try { process.kill(config.parent, 0); } catch (e) { process.exit(0); }
}, 500);
process.on('SIGTERM', () => process.exit(0));
