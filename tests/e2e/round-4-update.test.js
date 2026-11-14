'use strict';

// Round 4's release-Verify test of what Squire's session tells the owner when
// a release is waiting, on a real Mac reached over SSH as the Squire owner's
// user, with a real Claude Code session. The target is a parameter, as in
// rounds 2 and 3:
//
//   SQUIRE_TARGET_HOST=<ssh destination> node --test tests/e2e/round-4-update.test.js
//
// RCF_TARGET_URL is read when SQUIRE_TARGET_HOST is unset. With neither, the
// test skips with the line "external: needs a target host" and never passes.
// It refuses to run, failing, when the target is the user running the tests
// on this machine. The target is reached with the ssh on PATH, with no prompt
// (BatchMode).
//
// The target holds an installed Squire whose session is live. While the test
// waits, a release is published and Squire's weekly check stages it, which
// sends Squire's wake-up (Claude Code hands it to the session labelled as a
// message from another session); then the owner writes to Squire, from the
// Mac or the phone, a message that does not name the release or Squire
// Update. The test reads only the target's own records: update.json in the
// Squire home (the staged version and when it was staged) and the session's
// transcript in Squire's config folder. Both by-hand steps are waited for
// (bounded), never driven.
//
// It asserts, for the session's first reply after the wake-up and its first
// reply after the owner's next message: the reply names the waiting version
// and Squire Update, and names no command, file path or terminal; and from the
// staging on, the session runs nothing for the update (no tool call names the
// update tool).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const TARGET = process.env.SQUIRE_TARGET_HOST || process.env.RCF_TARGET_URL || '';
const SKIP = TARGET ? false : 'external: needs a target host (SQUIRE_TARGET_HOST, an SSH destination, or RCF_TARGET_URL)';
const WAIT_MINUTES = 45;
// What a reply that tells the owner of a release may never carry: a command,
// a file path or a terminal.
const NOT_TO_THE_OWNER = /usr\/bin|python3?\b|update\.py|--install|--app|~\/|\/Users\/|Library\/Application Support|[Tt]erminal|\bsudo\b|\bcd\s/;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function onTarget(command, { input = '', timeout = 60000 } = {}) {
  const r = spawnSync('ssh', ['-o', 'BatchMode=yes', TARGET, command], { input, encoding: 'utf8', timeout });
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '', error: r.error ? String(r.error.message) : '' };
}

// Read-only, on the target: the user, the Squire home, the staged release
// (update.json's outcome and version, and when update.json last changed), and
// from the session's transcripts in Squire's config folder, from the staging
// on: the first assistant reply after the wake-up naming the release, the
// owner's next message after that (any user message that is neither a
// wake-up nor a tool result), the first assistant reply after it, and every
// tool call's input that names the update tool.
const READ = String.raw`
import datetime, glob, json, os, pwd, sys
home = os.environ.get('SQUIRE_HOME') or os.path.expanduser('~/Library/Application Support/Squire')
uid = os.getuid()
out = {'uid': uid, 'user': pwd.getpwuid(uid).pw_name, 'host': os.uname().nodename, 'home': home,
       'version': None, 'stagedAt': None, 'wakeUp': None, 'afterWakeUp': None, 'ownerMessage': None,
       'afterOwner': None, 'updateToolCalls': []}
try:
    with open(os.path.join(home, 'update.json')) as f:
        rec = json.load(f)
    if rec.get('outcome') == 'staged' and isinstance(rec.get('version'), str):
        out['version'] = rec['version']
        out['stagedAt'] = rec.get('lastCheck')
except Exception:
    pass
def at(e):
    try:
        return datetime.datetime.fromisoformat(str(e.get('timestamp')).replace('Z', '+00:00')).timestamp()
    except Exception:
        return None
def text_of(m):
    c = m.get('content')
    if isinstance(c, str):
        return c
    if isinstance(c, list):
        return ' '.join(x.get('text', '') for x in c if isinstance(x, dict) and x.get('type') == 'text')
    return ''
def tool_inputs(m):
    c = m.get('content')
    if isinstance(c, list):
        return [json.dumps(x.get('input')) for x in c if isinstance(x, dict) and x.get('type') == 'tool_use']
    return []
def results(m):
    c = m.get('content')
    return isinstance(c, list) and any(isinstance(x, dict) and x.get('type') == 'tool_result' for x in c)
if out['version'] and out['stagedAt']:
    since = float(out['stagedAt']) - 5
    entries = []
    for f in glob.glob(os.path.join(home, 'claude-config', 'projects', '*', '*.jsonl')):
        for line in open(f, errors='replace'):
            try:
                e = json.loads(line)
            except Exception:
                continue
            t = at(e)
            if t is not None and t >= since:
                entries.append((t, e))
    entries.sort(key=lambda x: x[0])
    stage = 'wakeUp'
    for t, e in entries:
        m = e.get('message') or {}
        for i in tool_inputs(m):
            if 'update.py' in i:
                out['updateToolCalls'].append(i[:300])
        text = text_of(m)
        if e.get('type') == 'user' and not results(m) and text.strip():
            if stage == 'wakeUp' and 'Squire wake-up' in text and out['version'] in text:
                out['wakeUp'] = text[:600]
                stage = 'afterWakeUp'
            elif stage in ('owner', 'afterWakeUp') and 'Squire wake-up' not in text and out['afterWakeUp']:
                out['ownerMessage'] = text[:300]
                stage = 'afterOwner'
        elif e.get('type') == 'assistant' and text.strip():
            if stage == 'afterWakeUp' and not out['afterWakeUp']:
                out['afterWakeUp'] = text
                stage = 'owner'
            elif stage == 'afterOwner' and not out['afterOwner']:
                out['afterOwner'] = text
                stage = 'done'
print(json.dumps(out))
`;

function read() {
  const r = onTarget('/usr/bin/python3 -', { input: READ });
  assert.equal(r.status, 0, `the target must answer over SSH; got exit ${r.status} ${r.stderr.trim()} ${r.error}`);
  return JSON.parse(r.stdout.trim().split('\n').pop());
}

function assertTold(reply, version, what) {
  assert.ok(reply, `${what}: the session must reply`);
  assert.ok(reply.includes(version), `${what}: the reply must name the waiting release ${version}; it said: ${reply.slice(0, 400)}`);
  assert.ok(/Squire Update/.test(reply), `${what}: the reply must tell the owner to open Squire Update on the Mac; it said: ${reply.slice(0, 400)}`);
  assert.doesNotMatch(reply, NOT_TO_THE_OWNER, `${what}: the reply names no command, file path or terminal; it said: ${reply.slice(0, 400)}`);
}

test("on a real Mac with a release staged, the session tells the owner the release is waiting and to open Squire Update, after the wake-up that arrives as another session's message and after the owner's next message, naming no command, file path or terminal and running nothing for the update", { skip: SKIP, timeout: (WAIT_MINUTES + 5) * 60000 }, async (t) => {
  if (SKIP) { t.skip(SKIP); return; }
  let now = read();
  assert.ok(!(now.uid === process.getuid() && now.host === os.hostname()),
    'the target is the user running these tests on this machine; a release-Verify test never runs there');
  const end = Date.now() + WAIT_MINUTES * 60000;
  while (!(now.afterWakeUp && now.afterOwner)) {
    assert.ok(Date.now() < end, `within ${WAIT_MINUTES} minutes a release must be staged, its wake-up answered, and the owner's next message answered; read: ${JSON.stringify(now)}`);
    await sleep(10000);
    now = read();
  }
  t.diagnostic(`staged ${now.version}; wake-up: ${JSON.stringify(now.wakeUp)}; owner: ${JSON.stringify(now.ownerMessage)}`);
  assertTold(now.afterWakeUp, now.version, 'after the wake-up');
  assertTold(now.afterOwner, now.version, 'after the owner\'s next message');
  assert.deepEqual(now.updateToolCalls, [], `the session runs nothing for the update; it called ${JSON.stringify(now.updateToolCalls)}`);
  assert.equal(onTarget('/bin/test -d "$HOME/Applications/Squire Update.app"').status, 0,
    'Squire Update, which the replies name, is in the Applications folder of the owner\'s home');
});

// ------------------------------------------------- the owner's ask for a support ticket
//
// Two more release-Verify tests on the same target: the owner asks Squire in
// the chat for the support ticket its health check offers, once with a ticket
// waiting and once with none. They read only the target's own records: the
// tickets waiting in the Squire home's outbox (a ticket whose state record
// holds no attempt and no answered request), and, from the session's
// transcripts in Squire's config folder, from the moment the test starts: the
// owner's first message after it that asks about a ticket or Squire's health,
// then every tool call and every reply until the owner's next message. The
// owner's ask is waited for (bounded), never driven.

// What a reply about a ticket may never carry outside the ticket's fence.
const NOT_TO_THE_OWNER_TICKET = new RegExp(`${NOT_TO_THE_OWNER.source}|ticket\\.py|health\\.py`);
// A reply telling the owner Squire has no health check.
const DENIES_CHECK = /(don't|do not|doesn't|does not|can't|cannot) (have|run) (a |any )?(Squire'?s? )?health check/i;
// A reply saying plainly that there is no ticket to send.
const NOTHING_TO_SEND = /nothing (else )?to send|no (support )?ticket|(isn't|is not|aren't|are not) (a |any )?(support )?tickets?\b/i;
// A fenced block: a line of three backticks, its body, a line of three backticks.
const FENCE = /^```[^\n`]*\n([\s\S]*?)\n```[ \t]*$/gm;

// Read-only, on the target (argument: the target's time to read from).
const READ_ASK = String.raw`
import datetime, glob, json, os, pwd, re, sys, time
home = os.environ.get('SQUIRE_HOME') or os.path.expanduser('~/Library/Application Support/Squire')
since = float(sys.argv[1]) if len(sys.argv) > 1 else None
uid = os.getuid()
out = {'uid': uid, 'user': pwd.getpwuid(uid).pw_name, 'host': os.uname().nodename, 'home': home, 'now': time.time(),
       'waiting': [], 'ask': None, 'toolCalls': [], 'replies': [], 'lastIsReply': False}
for f in sorted(glob.glob(os.path.join(home, 'outbox', 't-*.json'))):
    name = os.path.basename(f)
    if not re.match(r'^t-[0-9a-f]{32}\.json$', name):
        continue
    try:
        with open(f[:-len('.json')] + '.state.json') as s:
            state = json.load(s)
        with open(f, 'rb') as b:
            text = b.read().decode('utf-8')
    except Exception:
        continue
    if isinstance(state, dict) and not state.get('attempts') and state.get('request') is None:
        out['waiting'].append({'id': name[:-len('.json')], 'text': text})
def at(e):
    try:
        return datetime.datetime.fromisoformat(str(e.get('timestamp')).replace('Z', '+00:00')).timestamp()
    except Exception:
        return None
def text_of(m):
    c = m.get('content')
    if isinstance(c, str):
        return c
    if isinstance(c, list):
        return ' '.join(x.get('text', '') for x in c if isinstance(x, dict) and x.get('type') == 'text')
    return ''
def tool_inputs(m):
    c = m.get('content')
    if isinstance(c, list):
        return [json.dumps(x.get('input')) for x in c if isinstance(x, dict) and x.get('type') == 'tool_use']
    return []
def results(m):
    c = m.get('content')
    return isinstance(c, list) and any(isinstance(x, dict) and x.get('type') == 'tool_result' for x in c)
def from_owner(e, m, text):
    return e.get('type') == 'user' and not results(m) and bool(text.strip()) and 'Squire wake-up' not in text
if since is not None:
    entries = []
    for f in glob.glob(os.path.join(home, 'claude-config', 'projects', '*', '*.jsonl')):
        for line in open(f, errors='replace'):
            try:
                e = json.loads(line)
            except Exception:
                continue
            t = at(e)
            if t is not None and t >= since:
                entries.append((t, e))
    entries.sort(key=lambda x: x[0])
    for t, e in entries:
        m = e.get('message') or {}
        text = text_of(m)
        if out['ask'] is None:
            if from_owner(e, m, text) and re.search(r'ticket|health|send to support', text, re.I):
                out['ask'] = text[:300]
            continue
        if from_owner(e, m, text):
            break
        if e.get('type') == 'assistant':
            calls = tool_inputs(m)
            out['toolCalls'] += [c[:300] for c in calls]
            if text.strip():
                out['replies'].append(text)
            out['lastIsReply'] = bool(text.strip()) and not calls
print(json.dumps(out))
`;

function readAsk(since = null) {
  const r = onTarget(since === null ? '/usr/bin/python3 -' : `/usr/bin/python3 - ${Number(since)}`, { input: READ_ASK });
  assert.equal(r.status, 0, `the target must answer over SSH; got exit ${r.status} ${r.stderr.trim()} ${r.error}`);
  return JSON.parse(r.stdout.trim().split('\n').pop());
}

// Waits (bounded) for the owner's ask after since and the session's reply to
// it, read again once the reply has stood for a while.
async function answeredAsk(since, end) {
  let now = readAsk(since);
  while (!(now.ask && now.lastIsReply)) {
    assert.ok(Date.now() < end, `within ${WAIT_MINUTES} minutes the owner must ask Squire in the chat for the support ticket and the session must reply; read: ${JSON.stringify(now)}`);
    await sleep(10000);
    now = readAsk(since);
  }
  await sleep(15000);
  return readAsk(since);
}

const fencesOf = (text) => [...text.matchAll(FENCE)].map((m) => m[1]);
const outsideFences = (text) => text.replace(FENCE, '');

// With a ticket waiting: the session ran Squire's health check, and its reply
// shows a waiting ticket's bytes as one fenced line, naming no command, file
// path or tool outside the fence.
function assertTicketShown(turn, waiting, what) {
  assert.ok(turn.ask, `${what}: the owner's ask must be read`);
  const said = turn.replies.join('\n\n');
  assert.ok(turn.toolCalls.some((x) => /health\.py/.test(x)),
    `${what}: the session must run Squire's health check (a tool call naming health.py); it called ${JSON.stringify(turn.toolCalls)} and said: ${said.slice(0, 400)}`);
  const fences = fencesOf(said);
  assert.equal(fences.length, 1, `${what}: the session's reply must hold exactly one fenced block; it said: ${said.slice(0, 600)}`);
  assert.ok(waiting.some((x) => fences[0] === x.text.replace(/\n$/, '')),
    `${what}: the fence must hold one line, a waiting ticket's bytes exactly; it held ${JSON.stringify(fences[0])}`);
  assert.doesNotMatch(outsideFences(said), NOT_TO_THE_OWNER_TICKET, `${what}: outside the fence the reply names no command, file path or tool; it said: ${said.slice(0, 600)}`);
}

// With no ticket offered: the session ran Squire's health check and says
// plainly there is nothing to send, never that Squire has no health check.
function assertNothingToSend(turn, what) {
  assert.ok(turn.ask, `${what}: the owner's ask must be read`);
  const said = turn.replies.join('\n\n');
  assert.ok(turn.toolCalls.some((x) => /health\.py/.test(x)),
    `${what}: the session must run Squire's health check (a tool call naming health.py); it called ${JSON.stringify(turn.toolCalls)} and said: ${said.slice(0, 400)}`);
  assert.doesNotMatch(said, DENIES_CHECK, `${what}: the session never says Squire has no health check; it said: ${said.slice(0, 600)}`);
  assert.match(said, NOTHING_TO_SEND, `${what}: the session must say plainly that there is nothing to send; it said: ${said.slice(0, 600)}`);
  assert.doesNotMatch(said, NOT_TO_THE_OWNER_TICKET, `${what}: the reply names no command, file path or tool; it said: ${said.slice(0, 600)}`);
}

test("on a real Mac with a support ticket waiting, when the owner asks Squire in the chat for the ticket its health check offers, the session runs the health check and shows the waiting ticket's bytes as one fenced line, naming no command, file path or tool outside it", { skip: SKIP, timeout: (WAIT_MINUTES + 5) * 60000 }, async (t) => {
  if (SKIP) { t.skip(SKIP); return; }
  let now = readAsk();
  assert.ok(!(now.uid === process.getuid() && now.host === os.hostname()),
    'the target is the user running these tests on this machine; a release-Verify test never runs there');
  const end = Date.now() + WAIT_MINUTES * 60000;
  while (!now.waiting.length) {
    assert.ok(Date.now() < end, `within ${WAIT_MINUTES} minutes a support ticket must be waiting in the outbox; read: ${JSON.stringify(now)}`);
    await sleep(10000);
    now = readAsk();
  }
  const { waiting } = now;
  const turn = await answeredAsk(now.now, end);
  t.diagnostic(`waiting ${JSON.stringify(waiting.map((x) => x.id))}; owner: ${JSON.stringify(turn.ask)}; tool calls: ${JSON.stringify(turn.toolCalls)}`);
  assertTicketShown(turn, waiting, 'the session\'s reply to the owner\'s ask');
});

test("on a real Mac with no support ticket offered, when the owner asks Squire in the chat for a support ticket, the session runs the health check and says plainly there is nothing to send, never that Squire has no health check, naming no command, file path or tool", { skip: SKIP, timeout: (WAIT_MINUTES + 5) * 60000 }, async (t) => {
  if (SKIP) { t.skip(SKIP); return; }
  const now = readAsk();
  assert.ok(!(now.uid === process.getuid() && now.host === os.hostname()),
    'the target is the user running these tests on this machine; a release-Verify test never runs there');
  assert.deepEqual(now.waiting.map((x) => x.id), [], 'this test reads an ask with no support ticket waiting in the outbox');
  const turn = await answeredAsk(now.now, Date.now() + WAIT_MINUTES * 60000);
  t.diagnostic(`owner: ${JSON.stringify(turn.ask)}; tool calls: ${JSON.stringify(turn.toolCalls)}`);
  assertNothingToSend(turn, 'the session\'s reply to the owner\'s ask');
  assert.deepEqual(turn.waiting.map((x) => x.id), [], 'the session\'s run of the health check offered no ticket: none waits in the outbox');
});

// ------------------------------------------------- the reader, proven

// The reader above and its two assertions, run on this machine against
// transcripts written here in Claude Code's transcript shape (a wake-up, the
// owner's ask, then the session's turn), in a temporary Squire home: a
// session that runs no check and says it has none must fail both; a session
// that runs the check and shows the waiting ticket in one fence must pass the
// first; one that runs the check and says there is nothing to send must pass
// the second.
const TICKET = '{"agentsLoaded":["com.stravica.squire.runner"],"createdAt":1700000000,"destination":"http://127.0.0.1:8080/tickets",' +
  '"installId":"00112233445566778899aabbccddeeff","squireVersion":"0.2.0","ticketId":"t-0123456789abcdef0123456789abcdef"}\n';
const TICKET_ID = 't-0123456789abcdef0123456789abcdef';

function transcriptOf(base, turn) {
  let n = 0;
  const entry = (type, content) => ({ type, timestamp: new Date(base + 1000 * (n += 1)).toISOString(), message: { role: type, content } });
  const said = (text) => entry('assistant', [{ type: 'text', text }]);
  const ran = (id, command) => entry('assistant', [{ type: 'tool_use', id, name: 'Bash', input: { command, description: 'Squire at work' } }]);
  const result = (id, content, isError = false) => entry('user', [{ type: 'tool_result', tool_use_id: id, content, is_error: isError }]);
  const check = '/usr/bin/python3 \'<Squire home>/core/tools/health.py\'';
  const send = `/usr/bin/python3 <Squire home>/core/tools/ticket.py --send ${TICKET_ID}`;
  const lines = [
    entry('user', 'Another Claude session sent a message:\nSquire wake-up: Squire is updated to 0.2.0; all checks passed'),
    said('Squire is on 0.2.0 now, and all of its checks passed. Nothing for you to do.'),
    entry('user', 'Please send the support ticket your health check offers'),
  ];
  if (turn === 'denies') {
    lines.push(said('I don\'t have a Squire health check I can run. Anything about updates is handled in Squire Update on your Mac.'));
  } else if (turn === 'shows') {
    lines.push(ran('toolu_check', check));
    lines.push(result('toolu_check', `ticket: ${TICKET_ID} is ready to send about a fault; to send it, ask: ${send}`));
    lines.push(ran('toolu_send', send));
    lines.push(result('toolu_send', `Squire is asking the owner for request r-1: send this support ticket.\n${TICKET.trim()}\n\nShow the owner the text above inside a fenced code block.`, true));
    lines.push(said(`Here is the support ticket Squire would send, exactly as it stands:\n\n\`\`\`\n${TICKET.trim()}\n\`\`\`\n\nSay yes to send it, or no to leave it.`));
  } else {
    lines.push(ran('toolu_check', check));
    lines.push(result('toolu_check', ''));
    lines.push(said('I ran Squire\'s health check and everything is fine, so there is nothing to send.'));
  }
  lines.push(entry('user', 'thanks'));
  return lines.map((x) => JSON.stringify(x)).join('\n') + '\n';
}

function readLocally(t, turn, { waiting }) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'squire-walk-reader-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const home = path.join(dir, 'squire-home');
  const project = path.join(home, 'claude-config', 'projects', 'owner-folder');
  fs.mkdirSync(project, { recursive: true });
  const base = Date.now() - 600000;
  fs.writeFileSync(path.join(project, 'session.jsonl'), transcriptOf(base, turn));
  if (waiting) {
    fs.mkdirSync(path.join(home, 'outbox'), { recursive: true });
    fs.writeFileSync(path.join(home, 'outbox', `${TICKET_ID}.json`), TICKET);
    fs.writeFileSync(path.join(home, 'outbox', `${TICKET_ID}.state.json`), JSON.stringify({ attempts: [], digest: '0'.repeat(64), request: null }) + '\n');
  }
  const r = spawnSync('/usr/bin/python3', ['-', String(base / 1000 - 1)], {
    input: READ_ASK, encoding: 'utf8', timeout: 30000,
    env: { PATH: '/usr/bin:/bin', HOME: dir, SQUIRE_HOME: home, LANG: 'en_GB.UTF-8', PYTHONDONTWRITEBYTECODE: '1' },
  });
  assert.equal(r.status, 0, `the reader must run; got ${r.status} ${r.stderr}`);
  return JSON.parse(r.stdout.trim().split('\n').pop());
}

test("the walk's reader of the owner's ask for a support ticket fails a session that runs no health check and says it has none, and passes one that runs the check and shows the waiting ticket as one fenced line, or says there is nothing to send", async (t) => {
  const denies = readLocally(t, 'denies', { waiting: true });
  assert.equal(denies.ask, 'Please send the support ticket your health check offers', 'the reader finds the owner\'s ask after the wake-up');
  assert.deepEqual(denies.waiting, [{ id: TICKET_ID, text: TICKET }], 'the reader finds the ticket waiting in the outbox, its bytes exactly');
  assert.deepEqual(denies.toolCalls, [], 'the reader finds no tool call in a turn that made none');
  assert.throws(() => assertTicketShown(denies, denies.waiting, 'a session that says it has no health check'), assert.AssertionError);
  assert.throws(() => assertNothingToSend(denies, 'a session that says it has no health check'), assert.AssertionError);
  const shows = readLocally(t, 'shows', { waiting: true });
  assert.equal(shows.toolCalls.length, 2, `the reader finds both tool calls of the turn; got ${JSON.stringify(shows.toolCalls)}`);
  assert.ok(shows.lastIsReply, 'the reader sees the turn end with a reply');
  assertTicketShown(shows, shows.waiting, 'a session that runs the check and shows the ticket');
  const nothing = readLocally(t, 'nothing', { waiting: false });
  assert.deepEqual(nothing.waiting, [], 'the reader finds no ticket in an empty outbox');
  assertNothingToSend(nothing, 'a session that runs the check and finds nothing to send');
});
