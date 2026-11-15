'use strict';

// The loopback stand-ins of an updates world, run as their own process so a
// test can wait on a product process synchronously while they answer: a
// release host that serves the files a case put in <state>/serve under
// /releases/, and a support intake at /tickets that records every post's bytes
// and answers as told. Neither is Squire's; neither reaches beyond loopback.
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
//            after 40 seconds); "hang" (filed, no answer ever); "redirect" (a
//            307 to /tickets/moved on the same host, where a post would be
//            filed and answered 201, nothing filed at /tickets); "redirectOther"
//            (a 307 to the other intake, below, nothing filed here)
// The other intake: a second server on the IPv6 loopback address ([::1]), at
// /tickets, which files any post it gets and answers 201: a 2xx from a host
// that is not the configured intake. Its port is written to <state>/port-other.
// Records, one JSON line each: <state>/requests.jsonl (every request: method,
// path, the Host it named, every header as sent, which server took it, at),
// <state>/posts.jsonl (every post that reached an intake: its bytes as base64,
// method, path, Host, every header as sent, its content type, the ticket id
// read from it, whether it was filed new or already, the mode, the answer
// given, which server took it). The port is written to <state>/port once
// listening.

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
let otherPort = null;

function serve(server) {
  return (req, res) => {
    const how = control();
    const seen = { method: req.method, path: req.url, host: req.headers.host || null, headers: req.rawHeaders, server };
    record('requests.jsonl', seen);
    if (server === 'intake' && req.method === 'GET' && req.url.startsWith('/releases/')) {
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
        // The other intake, and the place a redirect points at, take every post.
        const mode = (server === 'other' || req.url.startsWith('/tickets/moved')) ? 'ok' : (how.intake || 'ok');
        const body = Buffer.concat(chunks);
        if (mode === 'offline') { req.socket.destroy(); record('requests.jsonl', { ...seen, outcome: 'offline' }); return; }
        let ticketId = null;
        try { ticketId = JSON.parse(body.toString('utf8')).ticketId || null; } catch (e) { ticketId = null; }
        const posted = { bytes: body.toString('base64'), method: req.method, path: req.url, host: seen.host, headers: req.rawHeaders,
          contentType: req.headers['content-type'] || null, ticketId, mode, server };
        if (mode === 'redirect' || mode === 'redirectOther') {
          const location = mode === 'redirect' ? '/tickets/moved' : `http://[::1]:${otherPort}/tickets`;
          record('posts.jsonl', { ...posted, filedAs: null, status: 307, location });
          res.writeHead(307, { Location: location, 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ moved: location }));
          return;
        }
        const already = filed();
        let filedAs = null;
        let status = 500;
        if (mode !== 'fail' && ticketId) {
          filedAs = already.includes(ticketId) ? 'already' : 'new';
          if (filedAs === 'new') fs.writeFileSync(filedFile, JSON.stringify([...already, ticketId]));
          status = filedAs === 'new' ? 201 : 200;
        } else if (mode !== 'fail') status = 400;
        record('posts.jsonl', { ...posted, filedAs, status });
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
  };
}

const intake = http.createServer(serve('intake'));
const other = http.createServer(serve('other'));
intake.keepAliveTimeout = 1000;
other.keepAliveTimeout = 1000;
const startIntake = () => intake.listen(0, '127.0.0.1', () => {
  fs.writeFileSync(path.join(state, 'port.tmp'), String(intake.address().port));
  fs.renameSync(path.join(state, 'port.tmp'), path.join(state, 'port'));
});
// With no IPv6 loopback on the Mac, the other intake is missing (no
// port-other) and the configured intake starts as before.
other.on('error', startIntake);
other.listen(0, '::1', () => {
  otherPort = other.address().port;
  fs.writeFileSync(path.join(state, 'port-other.tmp'), String(otherPort));
  fs.renameSync(path.join(state, 'port-other.tmp'), path.join(state, 'port-other'));
  startIntake();
});
process.on('SIGTERM', () => process.exit(0));
