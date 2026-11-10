'use strict';

// The loopback stand-ins of an updates world, run as their own process so a
// test can wait on a product process synchronously while they answer: a
// release host that serves the files a case put in <state>/serve under
// /releases/, and a support intake at /tickets that records every post's bytes
// and answers as told. Neither is Squire's; neither reaches beyond 127.0.0.1.
//
//   node stand-ins.js <state folder>
//
// <state>/control.json, read at every request (the test changes it between
// runs):
//   archive  how a release archive (*.tar.gz) is served: "ok"; "fail" (an
//            answer of 500); "hang" (the headers and half the bytes, then
//            nothing, ever); "cut" (half the bytes, then the connection closed)
//   latest   how latest.json is served: "ok" or "fail" (500)
//   intake   how a post is answered: "ok" (201 for a ticket id not filed
//            before, 200 for one already filed: it is filed once); "fail"
//            (500, nothing filed); "offline" (the connection closed before
//            any answer, nothing filed); "late" (filed, then the answer only
//            after 40 seconds); "hang" (filed, no answer ever)
// Records, one JSON line each: <state>/requests.jsonl (every request: method,
// path, at), <state>/posts.jsonl (every post that reached the intake: its
// bytes as base64, its content type, the ticket id read from it, whether it
// was filed new or already, the answer given). The port is written to
// <state>/port once listening.

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const state = process.argv[2];
const control = () => {
  try { return JSON.parse(fs.readFileSync(path.join(state, 'control.json'), 'utf8')); } catch (e) { return {}; }
};
const record = (name, rec) => fs.appendFileSync(path.join(state, name), JSON.stringify({ at: Date.now() / 1000, ...rec }) + '\n');
const filedFile = path.join(state, 'filed.json');
const filed = () => { try { return JSON.parse(fs.readFileSync(filedFile, 'utf8')); } catch (e) { return []; } };
const never = () => {};

const server = http.createServer((req, res) => {
  const how = control();
  record('requests.jsonl', { method: req.method, path: req.url });
  if (req.method === 'GET' && req.url.startsWith('/releases/')) {
    const name = path.basename(decodeURIComponent(req.url.slice('/releases/'.length)));
    const file = path.join(state, 'serve', name);
    if (name === 'latest.json' && how.latest === 'fail') { res.writeHead(500); res.end('down'); return; }
    if (!name || !fs.existsSync(file)) { res.writeHead(404); res.end('no such file'); return; }
    const bytes = fs.readFileSync(file);
    const mode = name.endsWith('.tar.gz') ? (how.archive || 'ok') : 'ok';
    if (mode === 'fail') { res.writeHead(500); res.end('down'); return; }
    res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': bytes.length });
    if (mode === 'hang') { res.write(bytes.subarray(0, Math.floor(bytes.length / 2))); req.socket.setTimeout(0); return never(); }
    if (mode === 'cut') { res.write(bytes.subarray(0, Math.floor(bytes.length / 2)), () => req.socket.destroy()); return undefined; }
    res.end(bytes);
    return undefined;
  }
  if (req.method === 'POST' && req.url.startsWith('/tickets')) {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const mode = how.intake || 'ok';
      const body = Buffer.concat(chunks);
      if (mode === 'offline') { req.socket.destroy(); record('requests.jsonl', { method: 'POST', path: req.url, outcome: 'offline' }); return; }
      let ticketId = null;
      try { ticketId = JSON.parse(body.toString('utf8')).ticketId || null; } catch (e) { ticketId = null; }
      const already = filed();
      let filedAs = null;
      let status = 500;
      if (mode !== 'fail' && ticketId) {
        filedAs = already.includes(ticketId) ? 'already' : 'new';
        if (filedAs === 'new') fs.writeFileSync(filedFile, JSON.stringify([...already, ticketId]));
        status = filedAs === 'new' ? 201 : 200;
      } else if (mode !== 'fail') status = 400;
      record('posts.jsonl', { bytes: body.toString('base64'), contentType: req.headers['content-type'] || null, ticketId, filedAs, mode, status });
      const answer = () => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ filed: filedAs })); };
      if (mode === 'hang') { req.socket.setTimeout(0); return; }
      if (mode === 'late') { setTimeout(answer, 40000); return; }
      answer();
    });
    return undefined;
  }
  res.writeHead(404);
  res.end('no such place');
  return undefined;
});
server.keepAliveTimeout = 1000;
server.listen(0, '127.0.0.1', () => {
  fs.writeFileSync(path.join(state, 'port.tmp'), String(server.address().port));
  fs.renameSync(path.join(state, 'port.tmp'), path.join(state, 'port'));
});
process.on('SIGTERM', () => process.exit(0));
