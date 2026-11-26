'use strict';

// A loopback stand-in of the email and calendar connectors an owner might
// attach to Claude. Test equipment only, never shipped. Squire builds no
// connector and favours none; this stand-in plays two under invented and
// plainly fake names, so the cases can see what reaches a connector:
//
//   pretend_post    a mail connector
//   pretend_diary   a calendar connector
//
// Claude Code names a connector's tool mcp__<connector>__<tool>. How a call
// reaches it in the test world (the cases' choice, named here): the session's
// call goes to Squire's safety floor first, as the session runs it (the
// PreToolUse hooks of the settings lay-down writes; usage-world.js
// laidFloor), and only a call the floor lets through is then handed to this
// stand-in, by the case, as Claude Code would hand it on (connector-world.js
// call). A call the floor holds never reaches it, so what the stand-in
// records is what ran.
//
// Its tools, each with its input shape and its answer; every call, offered
// or not, is recorded as one JSON line { at, tool, input, key, status }, key
// being the connector key the call carried (its X-Connector-Key header, or
// null):
//   mcp__pretend_post__list_messages   { folder, max }            -> { messages: [{ id, from, subject }] }
//   mcp__pretend_post__read_message    { message_id }             -> the message { id, from, to, subject, body }
//   mcp__pretend_post__save_draft      { to, subject, body }      -> { draft_id }
//   mcp__pretend_post__send_message    { to, subject, body }      -> { sent_id }
//   mcp__pretend_post__reply           { message_id, body }       -> { sent_id }
//   mcp__pretend_post__forward         { message_id, to, body }   -> { sent_id }
//   mcp__pretend_post__delete_message  { message_id }             -> { deleted }
//   mcp__pretend_diary__read_invite    { invite_id }              -> the invite { id, from, title, starts, words }
//   mcp__pretend_diary__answer_invite  { invite_id, answer }      -> { answered }
//   mcp__pretend_diary__create_event   { title, starts, ends, guests } -> { event_id }
//   mcp__pretend_diary__change_event   { event_id, starts, title } -> { changed }
//   mcp__pretend_diary__delete_event   { event_id }               -> { deleted }
// A tool it does not offer is answered 404 and still recorded. Its mailbox
// and invites come from options.json (messages, invites), so a case can plant
// words that try to steer whoever reads them. Its own description of its
// tools (GET /tools) carries each tool's annotations, which a case may set
// (annotations: { <tool>: { readOnlyHint: true } }); a connector's word on its
// own tools is content Squire reads, never a class.
//
// Every name, address and message in it is invented; no vendor's connector,
// address or account appears anywhere. It listens on 127.0.0.1 on a port the
// system picks, in a process of its own (so the product's command lines, run
// with spawnSync, can reach it), and a request for another host (sent here as
// a proxy) is recorded as off the loopback and refused.
//
// Run as a program: node connector-stand-in.js <folder>, reading
// <folder>/options.json at start and on each call, writing <folder>/port once
// it listens and appending each call to <folder>/calls.jsonl. Run as
//   node connector-stand-in.js call <origin> <tool> <input json> [<key variable>]
// it is the connector's own program as an owner might run it through Squire's
// secret helper: it sends one call to the stand-in at <origin>, carrying the
// key from the environment variable named (if any), and prints the answer.

const { spawn, spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const POST = 'mcp__pretend_post__';
const DIARY = 'mcp__pretend_diary__';
const TOOLS = {
  list: `${POST}list_messages`,
  read: `${POST}read_message`,
  draft: `${POST}save_draft`,
  send: `${POST}send_message`,
  reply: `${POST}reply`,
  forward: `${POST}forward`,
  deleteMessage: `${POST}delete_message`,
  readInvite: `${DIARY}read_invite`,
  answerInvite: `${DIARY}answer_invite`,
  createEvent: `${DIARY}create_event`,
  changeEvent: `${DIARY}change_event`,
  deleteEvent: `${DIARY}delete_event`,
};

// The mailbox and diary unless a case plants its own: invented people at
// example addresses.
const MESSAGES = [
  { id: 'm-1', from: 'flour@example.net', to: 'ada@example.com', subject: 'Thursday delivery', body: 'Your 25 kg of flour comes on Thursday.' },
  { id: 'm-2', from: 'alice@example.com', to: 'ada@example.com', subject: 'Saturday order', body: 'Is the cake ready for Saturday?' },
];
const INVITES = [
  { id: 'i-1', from: 'market@example.org', title: 'Farmers market stall', starts: '2026-12-05T08:00:00Z', words: 'A stall at the Saturday market.' },
];

function serve(folder) {
  const read = () => {
    try { return JSON.parse(fs.readFileSync(path.join(folder, 'options.json'), 'utf8')); } catch (e) { return {}; }
  };
  const record = (entry) => fs.appendFileSync(path.join(folder, 'calls.jsonl'), JSON.stringify({ at: Date.now(), ...entry }) + '\n');
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const options = read();
      let input = null;
      try { input = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null; } catch (e) { input = null; }
      const key = req.headers['x-connector-key'] === undefined ? null : String(req.headers['x-connector-key']);
      let answer;
      if (/^https?:\/\//i.test(req.url)) {
        answer = { status: 403, json: { error: 'off the loopback' } };
        record({ tool: null, input, key, status: 403, offLoopback: req.url });
      } else if (req.method === 'GET' && req.url === '/tools') {
        answer = { status: 200, json: { tools: Object.values(TOOLS).map((name) => ({ name, annotations: (options.annotations || {})[name] || {} })) } };
      } else {
        const m = /^\/tools\/([^/?#]+)$/.exec(req.url);
        const tool = m ? decodeURIComponent(m[1]) : null;
        answer = tool ? answerOf(tool, input || {}, options) : { status: 404, json: { error: 'no such route' } };
        record({ tool, input, key, status: answer.status, offLoopback: null });
      }
      res.writeHead(answer.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(answer.json));
    });
  });
  server.on('connect', (req, socket) => {
    record({ tool: null, input: null, key: null, status: 403, offLoopback: req.url });
    socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
  });
  server.listen(0, '127.0.0.1', () => fs.writeFileSync(path.join(folder, 'port'), String(server.address().port)));
}

const id = (kind) => `${kind}-${crypto.randomBytes(4).toString('hex')}`;

function answerOf(tool, input, options) {
  const messages = options.messages || MESSAGES;
  const invites = options.invites || INVITES;
  const ok = (json) => ({ status: 200, json });
  switch (tool) {
    case TOOLS.list: return ok({ messages: messages.map(({ id: mid, from, subject }) => ({ id: mid, from, subject })) });
    case TOOLS.read: {
      const found = messages.find((x) => x.id === input.message_id);
      return found ? ok(found) : { status: 404, json: { error: 'no such message' } };
    }
    case TOOLS.draft: return ok({ draft_id: id('draft') });
    case TOOLS.send: case TOOLS.reply: case TOOLS.forward: return ok({ sent_id: id('sent') });
    case TOOLS.deleteMessage: return ok({ deleted: true });
    case TOOLS.readInvite: {
      const found = invites.find((x) => x.id === input.invite_id);
      return found ? ok(found) : { status: 404, json: { error: 'no such invite' } };
    }
    case TOOLS.answerInvite: return ok({ answered: String(input.answer || '') });
    case TOOLS.createEvent: return ok({ event_id: id('event') });
    case TOOLS.changeEvent: return ok({ changed: true });
    case TOOLS.deleteEvent: return ok({ deleted: true });
    default: return { status: 404, json: { error: 'this connector offers no such tool' } };
  }
}

// One call to the stand-in at origin, synchronously: the Mac's own curl, to
// the loopback only. key, when given, rides in X-Connector-Key.
function callStandIn(origin, tool, input, key = null) {
  const args = ['-s', '-o', '-', '-w', '\n%{http_code}', '--noproxy', '*', '-X', 'POST', '-H', 'Content-Type: application/json'];
  if (key) args.push('-H', `X-Connector-Key: ${key}`);
  args.push('--data', JSON.stringify(input || {}), `${origin}/tools/${encodeURIComponent(tool)}`);
  const r = spawnSync('/usr/bin/curl', args, { encoding: 'utf8', timeout: 15000 });
  const out = r.stdout || '';
  const cut = out.lastIndexOf('\n');
  let json = null;
  try { json = JSON.parse(out.slice(0, cut)); } catch (e) { json = null; }
  return { status: Number(out.slice(cut + 1)), json };
}

// Starts a stand-in for one case, in a folder of the world's, stopped when
// the case ends. options: messages, invites, annotations.
function startConnector(t, world, options = {}) {
  const folder = path.join(world.root, `connector-stand-in-${crypto.randomBytes(3).toString('hex')}`);
  fs.mkdirSync(folder, { recursive: true });
  const optionsFile = path.join(folder, 'options.json');
  fs.writeFileSync(optionsFile, JSON.stringify(options));
  const child = spawn(process.execPath, [__filename, folder], { stdio: 'ignore' });
  const stop = () => { try { child.kill('SIGKILL'); } catch (e) { /* gone */ } };
  t.after(stop);
  const portFile = path.join(folder, 'port');
  const end = Date.now() + 10000;
  while (!fs.existsSync(portFile) && Date.now() < end) spawnSync('/bin/sleep', ['0.05']);
  if (!fs.existsSync(portFile)) throw new Error('the connector stand-in did not start');
  const origin = `http://127.0.0.1:${Number(fs.readFileSync(portFile, 'utf8'))}`;
  const calls = () => {
    const file = path.join(folder, 'calls.jsonl');
    return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  };
  return {
    folder,
    origin,
    calls,
    callsOf: (tool) => calls().filter((c) => c.tool === tool),
    offLoopback: () => calls().filter((c) => c.offLoopback),
    set: (changes) => fs.writeFileSync(optionsFile, JSON.stringify({ ...JSON.parse(fs.readFileSync(optionsFile, 'utf8')), ...changes })),
    call: (tool, input, key = null) => callStandIn(origin, tool, input, key),
    // The connector's own program, as the owner might run it through Squire's
    // secret helper: [program, ...arguments].
    program: (tool, input, keyVariable) => [process.execPath, __filename, 'call', origin, tool, JSON.stringify(input || {}), keyVariable],
    stop,
  };
}

module.exports = { TOOLS, MESSAGES, INVITES, startConnector, callStandIn };

if (require.main === module) {
  if (process.argv[2] === 'call') {
    const [, , , origin, tool, input, keyVariable] = process.argv;
    const key = keyVariable ? process.env[keyVariable] || null : null;
    const r = callStandIn(origin, tool, JSON.parse(input || '{}'), key);
    process.stdout.write(`${r.status} ${JSON.stringify(r.json)}\n`);
    process.exit(r.status === 200 ? 0 : 1);
  } else {
    serve(process.argv[2]);
  }
}
