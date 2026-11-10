'use strict';

// Round 4's additions to the test world: Squire's updates and support
// tickets, driven at the product's own entry points as processes. Nothing here
// imports or copies product logic. What stands in for the outside:
//
//   test keys            two Ed25519 keys made with the Mac's own ssh-keygen
//                        in the world's temporary folder at run time (never
//                        Stravica's key, never committed); "one" is the key the
//                        installed core trusts, "two" is another
//   a release host       on loopback, serving the releases a case builds
//                        (latest.json and squire-<version>.tar.gz) and able to
//                        fail, hang or cut a download short (tools/stand-ins.js)
//   a support intake     on loopback, recording each post's bytes and answering
//                        as told, filing a ticket id once (tools/stand-ins.js)
//   launchd              a supervisor that starts the installed runner and
//                        starts it again after a lay-down, or when a case asks
//                        for a runner start (tools/supervisor.js)
//   Claude Code          round 2's fake behind a launcher link into
//                        ~/.local/share/claude/versions/, as Claude Code's
//                        installer lays it, answering --version as told
//   the Mac              the world's system folders (SQUIRE_SYSTEM_ROOT, the
//                        design record's route to the Mac's own commands): the
//                        real ssh-keygen as a link by default, or a fake that
//                        fails or hangs, or none; sysctl, scutil and sw_vers
//                        answering a model, a computer name and a version
//
// The core a world lays down is this repository's core with two files the
// world writes, as a release names its own: core/release.json (the version,
// and the world's loopback release host and intake) and core/release-key.pub
// (test key one). No environment variable or other switch redirects updates
// or tickets: the addresses and the key arrive in the core, as item 22 rules.

const { spawn, spawnSync } = require('node:child_process');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const w = require('./squire-world.js');
const s = require('./session-world.js');
const I = require('./installer-world.js');

const SSH_KEYGEN = '/usr/bin/ssh-keygen';
const TAR = '/usr/bin/tar';
const NAMESPACE = 'squire-release';
const INSTALLED = '0.1.0';
const CLAUDE_CODE = '2.1.319';
// The install's named steps, in order (the design record's line 10).
const INSTALL_STEPS = ['record', 'keep', 'stop', 'lay', 'switch', 'reload', 'check', 'clear'];
// The words a floor block ends with, measured to make a session show the text
// above them byte for byte inside a fenced code block (the relay probe's third
// run): "shown" and "previewed" mean the body of that fence.
const FENCE_WORDS = 'Show the owner the text above inside a fenced code block: a line of three backticks with no language name, ' +
  'then the text exactly as written, unchanged, with nothing added inside the fence, then a line of three backticks. ' +
  'Your own words go only outside the fence. Then wait for their answer.';
const CHANGELOG = 'The morning brief lists today\'s wake-ups in the order they arrive, and a wake-up that could not be delivered ' +
  'is tried again for up to ten minutes. The health check names an unplugged backup_drive instead of a *general* failure.\n' +
  'Nothing in the owner\'s folder changes.';
// Personal details a ticket must never carry, planted where a careless
// diagnostic could pick them up.
const PLANTED = {
  computerName: 'Ada Lovelace\'s MacBook Air',
  hostName: 'ada-lovelace-macbook',
  fullName: 'Ada Lovelace',
  email: 'ada.lovelace@example.net',
  phone: '+44 7700 900123',
  card: '4111 1111 1111 1111',
};

const sleepSync = (seconds) => spawnSync('/bin/sleep', [String(seconds)]);
// Gone, or ended and waiting only to be reaped by its parent (this test).
const ended = (pid) => {
  const r = spawnSync('/bin/ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' });
  const stat = (r.stdout || '').trim();
  return !stat || stat.startsWith('Z');
};
const readJson = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return null; } };
const readJsonLines = (file) => (fs.existsSync(file)
  ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const nowSeconds = () => Date.now() / 1000;

// ------------------------------------------------------------- test keys

// Two Ed25519 test keys made with the Mac's own ssh-keygen in dir.
function makeKeys(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const keys = {};
  for (const name of ['one', 'two']) {
    const key = path.join(dir, name);
    const r = spawnSync(SSH_KEYGEN, ['-q', '-t', 'ed25519', '-N', '', '-C', `squire-test-${name}`, '-f', key], { encoding: 'utf8' });
    assert.equal(r.status, 0, `the world must make test key ${name}; got ${r.stderr}`);
    keys[name] = { key, pub: `${key}.pub`, text: fs.readFileSync(`${key}.pub`, 'utf8') };
  }
  return keys;
}

// Signs a file's exact bytes with a test key and namespace squire-release:
// writes <file>.sig, as the release is signed.
function sign(key, file) {
  fs.rmSync(`${file}.sig`, { force: true });
  const r = spawnSync(SSH_KEYGEN, ['-Y', 'sign', '-f', key, '-n', NAMESPACE, file], { encoding: 'utf8' });
  assert.equal(r.status, 0, `the world must sign ${path.basename(file)}; got ${r.stderr}`);
}

// ------------------------------------------------------------- the Mac

// A fake command at a system path: answers the arguments given in answers
// (joined by spaces) with that text, and runs the real command otherwise.
function answeringCommand(real, answers) {
  return `#!${process.execPath}
'use strict';
const answers = ${JSON.stringify(answers)};
const key = process.argv.slice(2).join(' ');
if (key in answers) { process.stdout.write(answers[key] + '\\n'); process.exit(0); }
const r = require('child_process').spawnSync(${JSON.stringify(real)}, process.argv.slice(2), { stdio: 'inherit' });
process.exit(r.status === null ? 1 : r.status);
`;
}

// The world's system folders: real commands as links, and the Mac's identity
// answered with planted details where a careless diagnostic would read them.
// mac changes the answers: { model, macOSVersion, sshKeygen: 'real' | 'none' |
// 'fails' | 'hangs' }.
function makeSystem(root, mac = {}) {
  const how = { model: 'MacBookAir10,1', macOSVersion: '26.3.1', sshKeygen: 'real', ...mac };
  const files = {
    'usr/sbin/sysctl': answeringCommand('/usr/sbin/sysctl', { '-n hw.model': how.model, 'hw.model': `hw.model: ${how.model}` }),
    'usr/sbin/scutil': answeringCommand('/usr/sbin/scutil', {
      '--get ComputerName': PLANTED.computerName, '--get LocalHostName': PLANTED.hostName, '--get HostName': PLANTED.hostName,
    }),
    'bin/hostname': answeringCommand('/bin/hostname', { '': PLANTED.hostName, '-s': PLANTED.hostName }),
    'usr/bin/sw_vers': answeringCommand('/usr/bin/sw_vers', { '-productVersion': how.macOSVersion }),
  };
  if (how.sshKeygen === 'fails') {
    files['usr/bin/ssh-keygen'] = `#!${process.execPath}\nprocess.stderr.write('ssh-keygen: the key could not be read\\n');\nprocess.exit(255);\n`;
  } else if (how.sshKeygen === 'hangs') {
    files['usr/bin/ssh-keygen'] = `#!${process.execPath}\nprocess.on('SIGTERM', () => {});\nsetInterval(() => {}, 1000);\n`;
  }
  I.makeSystemRoot(root, files);
  if (how.sshKeygen === 'none') fs.rmSync(path.join(root, 'usr', 'bin', 'ssh-keygen'), { force: true });
  return root;
}

// ------------------------------------------------------------- the cores

// A core as a release carries it: this repository's core (or from), with the
// world's release.json and release-key.pub written in.
function makeCore(rw, dir, { version, key = rw.keys.one.pub, from = w.CORE }) {
  fs.rmSync(dir, { recursive: true, force: true });
  w.copyTree(from, dir);
  fs.writeFileSync(path.join(dir, 'release.json'),
    JSON.stringify({ version, releaseHost: rw.releaseHost, intake: rw.intake }, null, 2) + '\n');
  fs.copyFileSync(key, path.join(dir, 'release-key.pub'));
  return dir;
}

// Every file under a core, by its path relative to the core, to its SHA-256.
function filesOf(dir) {
  const out = {};
  for (const [rel] of Object.entries(w.treeOf(dir))) out[rel] = w.sha256(fs.readFileSync(path.join(dir, rel)));
  return out;
}

// A release, built and published on the world's release host. shape is one
// of: good; unsigned (no signature); wrongKey (signed with key two); altered
// (manifest.json changed by one byte after signing); ownKeyOnly (signed with
// key two and carrying key two as its own release-key.pub); newKey (signed
// with the installed key, carrying key two); unknownField; badManifest (not
// JSON); badVersion; unlisted (a file under core/ the manifest does not
// list); missing (a listed file absent); notAnArchive; runnerExits (its
// runner exits at once); runnerExitsAndSignsOut (also ends the world's
// Claude sign-in, so the check after the rollback fails too). signWith names
// the key that signs (default the one the installed core trusts).
function buildRelease(rw, { version, shape = 'good', changelog = CHANGELOG, signWith = null, carryKey = null, publish = true } = {}) {
  rw.built = (rw.built || 0) + 1;
  const src = path.join(rw.root, 'build', `${rw.built}-${version}-${shape}`);
  const core = path.join(src, 'core');
  fs.mkdirSync(src, { recursive: true });
  const keyName = carryKey || ((shape === 'newKey' || shape === 'ownKeyOnly') ? 'two' : 'one');
  makeCore(rw, core, { version: shape === 'badVersion' ? `${version}-beta` : version, key: rw.keys[keyName].pub, from: rw.appCore });
  // One line more in a file outside the floor and in a floor file, so the
  // installed core shows which release it is.
  fs.appendFileSync(path.join(core, 'tools', 'backup.py'), `# release ${version}\n`);
  fs.appendFileSync(path.join(core, 'hooks', 'config-change.py'), `# release ${version}\n`);
  if (shape === 'runnerExits' || shape === 'runnerExitsAndSignsOut') {
    const signOut = shape === 'runnerExitsAndSignsOut'
      ? `open(${JSON.stringify(path.join(rw.root, 'fake-claude-code.json'))}, 'w').write('{"signedIn": false}')\n` : '';
    fs.writeFileSync(path.join(core, 'tools', 'runner.py'), `import sys\n${signOut}sys.exit(1)\n`);
  }
  const manifest = { version: shape === 'badVersion' ? `${version}-beta` : version, files: filesOf(core), changelog, claudeCodeTested: CLAUDE_CODE };
  if (shape === 'unknownField') manifest.installAlso = 'tools/extra.py';
  if (shape === 'unlisted') fs.writeFileSync(path.join(core, 'tools', 'extra.py'), 'print("not in the manifest")\n');
  if (shape === 'missing') fs.rmSync(path.join(core, 'tools', 'backup.py'));
  const manifestFile = path.join(src, 'manifest.json');
  const text = shape === 'badManifest' ? `{"version": "${version}", "files": {` : JSON.stringify(manifest, null, 2) + '\n';
  fs.writeFileSync(manifestFile, text);
  if (shape !== 'unsigned') {
    sign(rw.keys[signWith || ((shape === 'wrongKey' || shape === 'ownKeyOnly') ? 'two' : 'one')].key, manifestFile);
  }
  if (shape === 'altered') {
    const bytes = fs.readFileSync(manifestFile);
    const at = bytes.indexOf(Buffer.from('Nothing'));
    bytes[at] = 'M'.charCodeAt(0);
    fs.writeFileSync(manifestFile, bytes);
  }
  const archiveName = `squire-${version}.tar.gz`;
  const archive = path.join(rw.state, 'serve', archiveName);
  fs.mkdirSync(path.dirname(archive), { recursive: true });
  if (shape === 'notAnArchive') {
    fs.writeFileSync(archive, crypto.randomBytes(4096));
  } else {
    const parts = ['core', 'manifest.json', ...(fs.existsSync(`${manifestFile}.sig`) ? ['manifest.json.sig'] : [])];
    const r = spawnSync(TAR, ['--no-mac-metadata', '-czf', archive, '-C', src, ...parts],
      { encoding: 'utf8', env: { PATH: w.PRODUCT_PATH, COPYFILE_DISABLE: '1' } });
    assert.equal(r.status, 0, `the world must pack release ${version}; got ${r.stderr}`);
  }
  if (publish) fs.writeFileSync(path.join(rw.state, 'serve', 'latest.json'), JSON.stringify({ version, archive: archiveName }) + '\n');
  return { version, shape, core, manifest, manifestBytes: fs.readFileSync(manifestFile), changelog, archive, archiveName };
}

// ------------------------------------------------------------- archives

// The entry shapes no release may hold, each refused on the archive's listing
// before anything is extracted (the design record's line 5): what each one is.
const ARCHIVE_SHAPES = {
  absolute: 'an entry with an absolute path',
  dotSegment: 'an entry whose path holds a dot segment',
  duplicate: 'two entries with the same path',
  caseFolded: 'two entries whose paths are the same once case is folded',
  unicodeEquivalent: 'two entries whose paths are the same once Unicode is normalised',
  symlinkInside: 'a symbolic link to a file inside core',
  symlinkOutside: 'a symbolic link to a folder outside the release, and a file written through it',
  hardLinkInside: 'a hard link to a file inside core',
  hardLinkOutside: 'a hard link to a file outside the release',
  appleDouble: 'an AppleDouble entry',
  emptyFolder: 'a folder that is the parent of no listed file',
  trailingBytes: 'bytes after the end of the gzip stream',
};
// Every odd entry's name carries this, so an extraction anywhere shows.
const MARKER = 'squire-marker-';

const octal = (n, width) => n.toString(8).padStart(width - 1, '0') + '\0';

// One POSIX ustar header for an entry: type '0' a file, '1' a hard link, '2' a
// symbolic link, '5' a folder; a name past 100 bytes is split into prefix and
// name at a slash, as ustar holds it.
function tarHeader({ name, type, size, mode, linkname = '' }) {
  const h = Buffer.alloc(512, 0);
  let nameBytes = Buffer.from(name, 'utf8');
  let prefixBytes = Buffer.alloc(0);
  if (nameBytes.length > 100) {
    let split = false;
    for (let i = name.length - 1; i > 0 && !split; i--) {
      if (name[i] !== '/') continue;
      const p = Buffer.from(name.slice(0, i), 'utf8');
      const n = Buffer.from(name.slice(i + 1), 'utf8');
      if (p.length <= 155 && n.length > 0 && n.length <= 100) { prefixBytes = p; nameBytes = n; split = true; }
    }
    assert.ok(split, `the world's archive cannot hold the name ${name}`);
  }
  nameBytes.copy(h, 0);
  h.write(octal(mode, 8), 100, 'ascii');
  h.write(octal(0, 8), 108, 'ascii');
  h.write(octal(0, 8), 116, 'ascii');
  h.write(octal(size, 12), 124, 'ascii');
  h.write(octal(Math.floor(Date.now() / 1000), 12), 136, 'ascii');
  h.write('        ', 148, 'ascii');
  h.write(type, 156, 'ascii');
  Buffer.from(linkname, 'utf8').copy(h, 157);
  h.write('ustar\0', 257, 'ascii');
  h.write('00', 263, 'ascii');
  prefixBytes.copy(h, 345);
  let sum = 0;
  for (const b of h) sum += b;
  h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 'ascii');
  return h;
}

// A tar stream of the entries, in order, as written (a duplicate stays a
// duplicate): [{ name, type, mode, data, linkname }].
function tarBytes(entries) {
  const parts = [];
  // A POSIX extended header carries a link target past ustar's 100 bytes.
  const paxRecord = (key, value) => {
    const body = ` ${key}=${value}\n`;
    let n = Buffer.byteLength(body) + 1;
    while (String(n).length + Buffer.byteLength(body) !== n) n = String(n).length + Buffer.byteLength(body);
    return Buffer.from(`${n}${body}`, 'utf8');
  };
  for (const e of entries) {
    const data = e.type === '0' ? (e.data || Buffer.alloc(0)) : Buffer.alloc(0);
    let linkname = e.linkname || '';
    if (Buffer.byteLength(linkname) > 100) {
      const pax = paxRecord('linkpath', linkname);
      parts.push(tarHeader({ name: 'PaxHeader/link', type: 'x', size: pax.length, mode: 0o644 }), pax, Buffer.alloc((512 - (pax.length % 512)) % 512));
      linkname = linkname.slice(0, 100);
      while (Buffer.byteLength(linkname) > 100) linkname = linkname.slice(0, -1);
    }
    parts.push(tarHeader({ name: e.name, type: e.type, size: data.length, mode: e.mode || (e.type === '5' ? 0o755 : 0o644), linkname }));
    if (data.length) parts.push(data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  parts.push(Buffer.alloc(1024));
  return Buffer.concat(parts);
}

// A release whose archive holds one entry of the given shape (a key of
// ARCHIVE_SHAPES) and is otherwise a good release, signed with the installed
// key, its manifest listing every file the archive carries under core/ with its
// digest, and well inside the bound (a few hundred entries, under a megabyte
// unpacked), so the shape alone is what the check refuses. The archive is
// written entry by entry, since a folder on this Mac cannot hold two names
// that differ only in case. Published on the world's release host.
function buildArchiveRelease(rw, { version, shape }) {
  assert.ok(shape in ARCHIVE_SHAPES, `no archive shape is named ${shape}`);
  rw.built = (rw.built || 0) + 1;
  const src = path.join(rw.root, 'build', `${rw.built}-${version}-${shape}`);
  const core = path.join(src, 'core');
  fs.mkdirSync(src, { recursive: true });
  makeCore(rw, core, { version, from: rw.appCore });
  fs.appendFileSync(path.join(core, 'tools', 'backup.py'), `# release ${version}\n`);
  fs.appendFileSync(path.join(core, 'hooks', 'config-change.py'), `# release ${version}\n`);
  const files = filesOf(core);
  const entries = [{ name: 'core/', type: '5' }];
  const walk = (abs, rel) => {
    for (const n of fs.readdirSync(abs).sort()) {
      const a = path.join(abs, n);
      const st = fs.lstatSync(a);
      if (st.isDirectory()) { entries.push({ name: `${rel}/${n}/`, type: '5' }); walk(a, `${rel}/${n}`); }
      else entries.push({ name: `${rel}/${n}`, type: '0', mode: st.mode & 0o777, data: fs.readFileSync(a) });
    }
  };
  walk(core, 'core');
  const outside = path.join(rw.root, 'outside');
  fs.mkdirSync(outside, { recursive: true });
  const victim = path.join(outside, 'victim.txt');
  if (!fs.existsSync(victim)) fs.writeFileSync(victim, 'a file outside the release\n');
  const backup = fs.readFileSync(path.join(core, 'tools', 'backup.py'));
  const file = (name, data, listed = true) => {
    entries.push({ name, type: '0', data });
    if (listed) files[name.slice('core/'.length)] = w.sha256(data);
  };
  const odd = (text) => Buffer.from(`${MARKER}${shape}: ${text}\n`);
  if (shape === 'absolute') file(path.join(outside, `${MARKER}absolute.txt`), odd('an absolute entry'), false);
  if (shape === 'dotSegment') file(`core/tools/../../../../${MARKER}dot-segment.txt`, odd('past a dot segment'), false);
  if (shape === 'duplicate') entries.push({ name: 'core/tools/backup.py', type: '0', data: odd('the same path again') });
  if (shape === 'caseFolded') {
    file(`core/tools/${MARKER}Case.py`, odd('one spelling'));
    file(`core/tools/${MARKER}case.py`, odd('the other spelling'));
  }
  if (shape === 'unicodeEquivalent') {
    file(`core/tools/${MARKER}café.py`, odd('composed'));
    file(`core/tools/${MARKER}café.py`, odd('decomposed'));
  }
  if (shape === 'symlinkInside') {
    entries.push({ name: `core/tools/${MARKER}alias.py`, type: '2', linkname: 'backup.py' });
    files[`tools/${MARKER}alias.py`] = w.sha256(backup);
  }
  if (shape === 'symlinkOutside') {
    entries.push({ name: `core/tools/${MARKER}link`, type: '2', linkname: outside });
    file(`core/tools/${MARKER}link/${MARKER}through.txt`, odd('written through a link'));
  }
  if (shape === 'hardLinkInside') {
    entries.push({ name: `core/tools/${MARKER}hard.py`, type: '1', linkname: 'core/tools/backup.py' });
    files[`tools/${MARKER}hard.py`] = w.sha256(backup);
  }
  if (shape === 'hardLinkOutside') {
    entries.push({ name: `core/tools/${MARKER}hard-outside.txt`, type: '1', linkname: victim });
    files[`tools/${MARKER}hard-outside.txt`] = w.sha256(fs.readFileSync(victim));
  }
  if (shape === 'appleDouble') {
    file(`core/tools/._${MARKER}backup.py`, Buffer.concat([Buffer.from('0005160700020000', 'hex'), Buffer.alloc(16), Buffer.from('0000', 'hex')]));
  }
  if (shape === 'emptyFolder') entries.push({ name: `core/${MARKER}empty/`, type: '5' });
  const manifest = { version, files, changelog: CHANGELOG, claudeCodeTested: CLAUDE_CODE };
  const manifestFile = path.join(src, 'manifest.json');
  fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2) + '\n');
  sign(rw.keys.one.key, manifestFile);
  entries.push({ name: 'manifest.json', type: '0', data: fs.readFileSync(manifestFile) });
  entries.push({ name: 'manifest.json.sig', type: '0', data: fs.readFileSync(`${manifestFile}.sig`) });
  assert.ok(entries.length < 2000, 'the world\'s adversarial archive stays well inside the entry bound');
  let gz = require('node:zlib').gzipSync(tarBytes(entries));
  if (shape === 'trailingBytes') gz = Buffer.concat([gz, odd('after the gzip stream')]);
  const archiveName = `squire-${version}.tar.gz`;
  fs.mkdirSync(path.join(rw.state, 'serve'), { recursive: true });
  fs.writeFileSync(path.join(rw.state, 'serve', archiveName), gz);
  fs.writeFileSync(path.join(rw.state, 'serve', 'latest.json'), JSON.stringify({ version, archive: archiveName }) + '\n');
  return { version, shape, what: ARCHIVE_SHAPES[shape], victim, victimBytes: fs.readFileSync(victim) };
}

// One run of the scheduler's tick while the world watches the Squire home:
// every path created or changed in it during the run, relative to the home.
async function tickWatching(rw) {
  const seen = new Set();
  const watcher = fs.watch(rw.home, { recursive: true }, (event, name) => { if (name) seen.add(String(name)); });
  try {
    const run = startTick(rw);
    await s.waitFor(() => run.exited(), 600000, 50);
    await s.sleep(1000);
  } finally {
    watcher.close();
  }
  return [...seen].sort();
}

// Paths under the world's root, outside the release builds and the release
// host's files, whose names carry the marker: anything an archive's odd entry
// put there.
function markersOutside(rw) {
  const out = [];
  const skip = new Set([path.join(rw.root, 'build'), path.join(rw.state, 'serve')]);
  const walk = (dir) => {
    let names = [];
    try { names = fs.readdirSync(dir); } catch (e) { return; }
    for (const n of names) {
      const p = path.join(dir, n);
      if (skip.has(p)) continue;
      if (n.includes(MARKER)) out.push(path.relative(rw.root, p));
      let st = null;
      try { st = fs.lstatSync(p); } catch (e) { continue; }
      if (st.isDirectory()) walk(p);
    }
  };
  walk(rw.root);
  return out;
}

// ------------------------------------------------------------- stand-ins

function startStandIns(rw) {
  fs.mkdirSync(path.join(rw.state, 'serve'), { recursive: true });
  fs.writeFileSync(path.join(rw.state, 'control.json'), JSON.stringify({ archive: 'ok', latest: 'ok', intake: 'ok' }));
  const child = spawn(process.execPath, [path.join(__dirname, 'tools', 'stand-ins.js'), rw.state],
    { cwd: rw.root, stdio: 'ignore', detached: true });
  child.unref();
  rw.standInsPid = child.pid;
  const portFile = path.join(rw.state, 'port');
  const end = Date.now() + 10000;
  while (!fs.existsSync(portFile) && Date.now() < end) sleepSync(0.05);
  assert.ok(fs.existsSync(portFile), 'the world\'s loopback stand-ins must start');
  const port = Number(fs.readFileSync(portFile, 'utf8'));
  rw.releaseHost = `http://127.0.0.1:${port}/releases/`;
  rw.intake = `http://127.0.0.1:${port}/tickets`;
}

// Changes how the stand-ins answer from now on: { archive, latest, intake }.
function standIns(rw, changes) {
  const file = path.join(rw.state, 'control.json');
  fs.writeFileSync(file, JSON.stringify({ ...readJson(file), ...changes }));
}

const hostRequests = (rw) => readJsonLines(path.join(rw.state, 'requests.jsonl'));
const latestFetches = (rw) => hostRequests(rw).filter((r) => r.method === 'GET' && /latest\.json$/.test(r.path));
const intakePosts = (rw) => readJsonLines(path.join(rw.state, 'posts.jsonl')).map((p) => ({ ...p, bytes: Buffer.from(p.bytes, 'base64') }));

// ------------------------------------------------------------- Claude Code

// Round 2's fake Claude Code behind a launcher at ~/.local/bin/claude, a link
// into ~/.local/share/claude/versions/<version>, as Claude Code lays itself.
// The versions file answers --version from <root>/claude-version.json
// ({ answer } prints "<answer> (Claude Code)"; { fail: true } exits 1 with
// nothing; { hang: true } never answers) and hands every other command to the
// fake.
function installClaudeCode(rw, { signedIn = true } = {}) {
  const inner = s.installFakeClaudeCode(rw.world, { signedIn }, { dir: path.join(rw.root, 'claude-code-inner') });
  rw.inner = inner;
  rw.claudeVersionFile = path.join(rw.root, 'claude-version.json');
  fs.writeFileSync(rw.claudeVersionFile, JSON.stringify({ answer: CLAUDE_CODE }));
  setLauncherTarget(rw, CLAUDE_CODE);
  return inner;
}

function versionsScript(rw) {
  return `#!${process.execPath}
'use strict';
const fs = require('fs');
const { spawn } = require('child_process');
const argv = process.argv.slice(2);
if (argv[0] === '--version' || argv[0] === '-v') {
  const how = JSON.parse(fs.readFileSync(${JSON.stringify(rw.claudeVersionFile)}, 'utf8'));
  if (how.hang) { process.on('SIGTERM', () => {}); setInterval(() => {}, 1000); }
  else if (how.fail) process.exit(1);
  else { process.stdout.write(how.answer + ' (Claude Code)\\n'); process.exit(0); }
} else {
  const child = spawn(${JSON.stringify(rw.inner.bin)}, argv, { stdio: 'inherit' });
  const forward = (sig) => () => { try { child.kill(sig); } catch (e) {} };
  process.on('SIGTERM', forward('SIGTERM'));
  process.on('SIGINT', forward('SIGINT'));
  child.on('exit', (code) => process.exit(code === null ? 1 : code));
}
`;
}

// Points the launcher at versions/<name> (written if new), as an update of
// Claude Code made outside Squire does; null leaves it pointing at nothing.
// With replace, the file at versions/<name> is written again even though it
// is there: new contents at the same path, put in place by a rename (a new
// file), answering --version the same, as a reinstall of the same version
// would leave it.
function setLauncherTarget(rw, name, { replace = false } = {}) {
  const versions = path.join(rw.world.userHome, '.local', 'share', 'claude', 'versions');
  const bin = path.join(rw.world.userHome, '.local', 'bin');
  fs.mkdirSync(versions, { recursive: true });
  fs.mkdirSync(bin, { recursive: true });
  const target = path.join(versions, name || 'gone');
  if (name && (replace || !fs.existsSync(target))) {
    rw.rewrites = (rw.rewrites || 0) + 1;
    const extra = replace ? `// written again (${rw.rewrites})\n` : '';
    fs.writeFileSync(`${target}.new`, versionsScript(rw) + extra);
    fs.chmodSync(`${target}.new`, 0o755);
    fs.renameSync(`${target}.new`, target);
  }
  const launcher = path.join(bin, 'claude');
  fs.rmSync(launcher, { force: true });
  fs.symlinkSync(target, launcher);
  return target;
}

// What claude --version answers from now on.
function setVersionAnswer(rw, how) {
  fs.writeFileSync(rw.claudeVersionFile, JSON.stringify(typeof how === 'string' ? { answer: how } : how));
}

// ------------------------------------------------------------- the world

// An installed, healthy Squire at version installed, set up as set-up leaves
// it (its record, its release folder), with the stand-ins, the test keys,
// Claude Code signed in, and the world's system folders (persona, when given,
// is the owner's squire.json before the first lay-down). Nothing runs until
// startSquire.
function makeReleaseWorld(t, { installed = INSTALLED, mac = {}, signedIn = true, approvalTimeoutSeconds = 600, persona = null } = {}) {
  const world = w.makeWorld({ approvalTimeoutSeconds });
  // The owner's own wake-ups are left out, so every wake-up a case reads is
  // one an update, a ticket or a recovery sent.
  const ownerConfig = persona || (({ wakeUps, ...rest }) => rest)(JSON.parse(fs.readFileSync(path.join(world.owner, 'squire.json'), 'utf8')));
  fs.writeFileSync(path.join(world.owner, 'squire.json'), JSON.stringify(ownerConfig, null, 2) + '\n');
  const rw = { world, root: world.root, home: world.home, owner: world.owner, state: path.join(world.root, 'stand-ins'),
    supervisorState: path.join(world.root, 'supervisor') };
  t.after(() => {
    stopSquire(rw);
    try { if (rw.standInsPid) process.kill(-rw.standInsPid, 'SIGKILL'); } catch (e) { /* gone */ }
    s.killFakes(world);
    // A case may close a folder or a file in the owner's folder; opened again so the world can be removed.
    spawnSync('/bin/chmod', ['-R', 'u+rwX', world.owner]);
    w.cleanUp(world);
  });
  world.system = makeSystem(path.join(world.root, 'system'), mac);
  rw.system = world.system;
  rw.keys = makeKeys(path.join(world.root, 'keys'));
  startStandIns(rw);
  rw.appCore = makeCore(rw, path.join(world.root, 'app-core'), { version: installed });
  s.layDownCore(world, rw.appCore);
  world.release = path.join(world.home, 'release', 'core');
  w.copyTree(rw.appCore, world.release);
  fs.writeFileSync(path.join(world.home, 'set-up.json'),
    JSON.stringify({ done: I.STEPS, added: [], release: world.release }, null, 2) + '\n');
  installClaudeCode(rw, { signedIn });
  // The config folder signed in, as a sign-in leaves it.
  const claudeJson = path.join(world.home, 'claude-config', '.claude.json');
  const state = readJson(claudeJson) || {};
  if (signedIn) state.oauthAccount = { accountUuid: 'acct-test', organizationUuid: 'org-test' };
  fs.writeFileSync(claudeJson, JSON.stringify(state, null, 2));
  return rw;
}

const env = (rw, extra = {}) => ({ SQUIRE_SYSTEM_ROOT: rw.system, USER: process.env.USER || 'owner', ...extra });

// Squire set up by its own app (round 3's installer world: the app opened as
// Finder opens it, on a Mac of fakes) from an app whose core is a release of
// version appVersion naming the world's stand-ins and trusting test key one;
// the runner is kept by the world's launchd stand-in from the moment set-up
// writes its agent. The same helpers then drive it: the Squire home is the
// app's (~/Library/Application Support/Squire), the owner's folder ~/Squire.
async function makeInstalledApp(t, { appVersion = INSTALLED } = {}) {
  const iw = I.makeInstallerWorld(t);
  const world = { ...iw.world, home: iw.squireHome, owner: iw.ownerFolder, userHome: iw.userHome };
  const rw = { iw, world, root: iw.root, home: iw.squireHome, owner: iw.ownerFolder, system: iw.system,
    state: path.join(iw.root, 'stand-ins'), supervisorState: path.join(iw.root, 'supervisor'), inner: iw.inner };
  t.after(() => {
    stopSquire(rw);
    try { if (rw.standInsPid) process.kill(-rw.standInsPid, 'SIGKILL'); } catch (e) { /* gone */ }
  });
  rw.keys = makeKeys(path.join(iw.root, 'keys'));
  startStandIns(rw);
  rw.appCore = path.join(iw.app, 'Contents', 'Resources', 'core');
  makeCore(rw, rw.appCore, { version: appVersion });
  const plist = path.join(iw.userHome, 'Library', 'LaunchAgents', 'com.stravica.squire.runner.plist');
  const run = await I.runApp(iw, {
    launchd: false,
    killWhen: () => {
      if (!rw.supervisorPid && fs.existsSync(plist)) launchSquire(rw, { ...I.appEnv(iw), PATH: I.MAC_PATH, ...plistEnv(plist) });
      return false;
    },
  });
  assert.deepEqual(I.doneSteps(iw), I.STEPS, `set-up must finish from the app; got ${I.describeRun(run)}`);
  const healthy = await s.waitFor(() => health(rw).status === 0, 60000, 500);
  assert.ok(healthy, `the Squire the app set up must be healthy; health: ${w.describe(health(rw))}`);
  return rw;
}

// A core as the round 3 app carried it: this repository's core without the
// two files a release names its own (core/release.json, core/release-key.pub).
function makeRound3Core(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
  w.copyTree(w.CORE, dir);
  for (const name of ['release.json', 'release-key.pub']) fs.rmSync(path.join(dir, name), { force: true });
  return dir;
}

// Makes the Squire the app set up (makeInstalledApp) a home as the round 3 app
// left it: core laid down from a round 3 core (no release.json, no key), that
// core as the release folder set-up keeps (release/core), no
// current-release.json, no releases/, no staging/ and no update.json, and
// set-up.json holding only what round 3's set-up wrote. Squire then runs
// again, healthy. Returns the round 3 core.
async function layRound3Home(rw) {
  stopSquire(rw);
  const core = makeRound3Core(path.join(rw.root, 'round-3-core'));
  s.layDownCore(rw.world, core);
  const release = path.join(rw.home, 'release', 'core');
  fs.rmSync(release, { recursive: true, force: true });
  w.copyTree(core, release);
  for (const name of ['current-release.json', 'releases', 'staging', 'update.json', 'install.json']) {
    fs.rmSync(path.join(rw.home, name), { recursive: true, force: true });
  }
  const record = readJson(path.join(rw.home, 'set-up.json')) || {};
  const round3 = {};
  for (const k of ['done', 'squireName', 'personality', 'release']) if (k in record) round3[k] = record[k];
  fs.writeFileSync(path.join(rw.home, 'set-up.json'), JSON.stringify(round3, null, 2) + '\n', { mode: 0o600 });
  for (const name of ['release.json', 'release-key.pub']) {
    assert.ok(!fs.existsSync(path.join(installedCore(rw), name)), `a home the round 3 app laid down holds no core/${name}`);
  }
  launchSquire(rw);
  const healthy = await s.waitFor(() => health(rw).status === 0, 60000, 500);
  assert.ok(healthy, `the home the round 3 app laid down must be healthy; health: ${w.describe(health(rw))}`);
  return core;
}

function plistEnv(file) {
  const r = spawnSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', file], { encoding: 'utf8' });
  try { return JSON.parse(r.stdout).EnvironmentVariables || {}; } catch (e) { return {}; }
}

// Opens the app again as Finder would, the world's launchd stand-in still
// keeping the runner.
function runAppAgain(rw) {
  return I.runApp(rw.iw, { launchd: false });
}

// Starts the world's launchd stand-in, which starts Squire's runner (as at
// login, or when the Mac starts again), without waiting.
function launchSquire(rw, runnerEnv = null) {
  fs.mkdirSync(rw.supervisorState, { recursive: true });
  rw.runnerEnv = runnerEnv || rw.runnerEnv || w.productEnv(rw.world, env(rw));
  fs.writeFileSync(path.join(rw.supervisorState, 'supervisor.json'), JSON.stringify({
    python: w.PYTHON, home: rw.home, env: rw.runnerEnv,
  }));
  const child = spawn(process.execPath, [path.join(__dirname, 'tools', 'supervisor.js'), rw.supervisorState],
    { cwd: rw.root, stdio: 'ignore', detached: true });
  child.unref();
  rw.supervisorPid = child.pid;
}

// The same, waiting for a live session and a health check with nothing to say.
async function startSquire(rw) {
  launchSquire(rw);
  const session = await s.waitFor(() => s.sessionRecords(rw.world).find((r) => !w.processGone(r.pid)), 30000);
  assert.ok(session, `the installed Squire must start its session; runner output: ${runnerOutput(rw).slice(-600) || '(none)'}`);
  const healthy = await s.waitFor(() => health(rw).status === 0, 30000, 500);
  assert.ok(healthy, `the installed Squire must be healthy once started; health: ${w.describe(health(rw))}`);
  return session;
}

function stopSquire(rw) {
  if (!rw.supervisorPid) return;
  try { process.kill(-rw.supervisorPid, 'SIGTERM'); } catch (e) { /* gone */ }
  const end = Date.now() + 5000;
  while (!ended(rw.supervisorPid) && Date.now() < end) sleepSync(0.05);
  try { process.kill(-rw.supervisorPid, 'SIGKILL'); } catch (e) { /* gone */ }
  for (const st of runnerStarts(rw)) {
    try { process.kill(-st.started, 'SIGKILL'); } catch (e) { /* gone */ }
  }
  s.killFakes(rw.world);
  rw.supervisorPid = null;
}

// A runner start, as launchd makes one at login or when the Mac starts again.
function askRunnerStart(rw) {
  fs.writeFileSync(path.join(rw.supervisorState, 'start'), '');
}

const runnerStarts = (rw) => readJsonLines(path.join(rw.supervisorState, 'starts.jsonl')).filter((r) => r.started);
const runnerOutput = (rw) => { try { return fs.readFileSync(path.join(rw.supervisorState, 'runner.out'), 'utf8'); } catch (e) { return ''; } };

// ------------------------------------------------------------- running

// One run of the wake-ups scheduler's tick, as its agent runs it (the
// outside job), held until it ends.
function tick(rw, { timeout = 600000 } = {}) {
  const r = w.runPython(rw.world, path.join(rw.home, 'core', 'tools', 'wake-up.py'), ['--due'],
    { cwd: '/', env: env(rw), timeout });
  assert.doesNotMatch(r.stderr, /can't open file|Traceback/, `the scheduler's run must run; got ${w.describe(r)}`);
  return r;
}

// The same, started without waiting, in a process group of its own.
function startTick(rw) {
  const child = spawn(w.PYTHON, [path.join(rw.home, 'core', 'tools', 'wake-up.py'), '--due'],
    { cwd: '/', env: w.productEnv(rw.world, env(rw)), stdio: 'ignore', detached: true });
  let exit = null;
  child.on('exit', (status, signal) => { exit = { status, signal }; });
  return { pid: child.pid, exited: () => exit };
}

// Runs the scheduler's tick and stops the install at exactly the named step.
// The world steps the tick's whole process group (the tick and the install it
// runs as its child): it holds the group (SIGSTOP), reads install.json, and
// lets the group run again (SIGCONT) for a twentieth of a millisecond at a
// time, so the moment the record names the step the group is held there, with
// nothing in the product made to wait for a test. Then it kills the group
// (SIGKILL: a power cut or a crash), or, with hold, leaves it held: the
// returned resume() lets it run to its end, kill() ends it. Returns the step
// the record named when the group was held (null if the tick ended first, or
// the record named a later step: the case then fails on the step).
async function stopInstallAt(rw, step, { hold = false, within = 300000, slice = 0.05 } = {}) {
  const want = INSTALL_STEPS.indexOf(step);
  assert.ok(want >= 0, `no install step is named ${step}`);
  const run = startTick(rw);
  const signal = (sig) => { try { process.kill(-run.pid, sig); return true; } catch (e) { return false; } };
  const spin = (ms) => { const until = process.hrtime.bigint() + BigInt(Math.round(ms * 1e6)); while (process.hrtime.bigint() < until) { /* the group runs */ } };
  const end = Date.now() + within;
  let seen = null;
  let turns = 0;
  while (!run.exited() && Date.now() < end) {
    if (!signal('SIGSTOP')) break;
    const rec = readJson(installRecordFile(rw));
    if (rec && INSTALL_STEPS.indexOf(rec.step) >= want) { seen = rec.step; break; }
    // Held, the world reads whether the tick has ended, now and then.
    turns += 1;
    if (turns % 200 === 0) await new Promise((resolve) => setImmediate(resolve));
    signal('SIGCONT');
    spin(slice);
  }
  const handle = { seen, run, resume: () => signal('SIGCONT'), kill: () => { signal('SIGKILL'); signal('SIGCONT'); } };
  if (hold && seen === step) return handle;
  handle.kill();
  await s.waitFor(() => run.exited(), 5000);
  return handle;
}

// Kills the install at exactly the named step; returns the step the record
// named when it was killed.
async function killInstallAt(rw, step, opts = {}) {
  return (await stopInstallAt(rw, step, opts)).seen;
}

function health(rw) {
  return w.runPython(rw.world, path.join(rw.home, 'core', 'tools', 'health.py'), [], { cwd: '/', env: env(rw), timeout: 60000 });
}

// ------------------------------------------------------------- reading

const installRecordFile = (rw) => path.join(rw.home, 'install.json');
const currentRelease = (rw) => readJson(path.join(rw.home, 'current-release.json'));
const keptReleases = (rw) => { try { return fs.readdirSync(path.join(rw.home, 'releases')).sort(); } catch (e) { return []; } };
const staged = (rw) => { try { return fs.readdirSync(path.join(rw.home, 'staging')).sort(); } catch (e) { return []; } };
const updateRecord = (rw) => readJson(path.join(rw.home, 'update.json'));
const installedCore = (rw) => path.join(rw.home, 'core');
const updateRequest = (rw, version) => `${w.PYTHON} ${path.join(rw.home, 'core', 'tools', 'update.py')} --install ${version}`;
const ticketRequest = (rw, id) => `${w.PYTHON} ${path.join(rw.home, 'core', 'tools', 'ticket.py')} --send ${id}`;
const fixRequest = (rw, which) => `${w.PYTHON} ${path.join(rw.home, 'core', 'tools', 'health.py')} --request ${which}`;

// True when the installed core holds exactly the files of the given release's
// core (or core folder), byte for byte.
function coreIs(rw, release) {
  const want = w.treeOf(release.core || release);
  const got = w.treeOf(installedCore(rw));
  return JSON.stringify(Object.keys(got).map((k) => [k, got[k].sha256])) === JSON.stringify(Object.keys(want).map((k) => [k, want[k].sha256]));
}

// What an update must not move: the installed core, the kept releases, the
// release folder set-up keeps, the agents and the owner's folder, as one
// snapshot of each.
function untouched(rw) {
  const out = {};
  for (const [name, dir] of [['core', installedCore(rw)], ['release', path.join(rw.home, 'release')],
    ['releases', path.join(rw.home, 'releases')], ['agents', path.join(rw.world.userHome, 'Library', 'LaunchAgents')],
    ['owner', rw.owner]]) {
    out[name] = fs.existsSync(dir) ? w.snapshot(dir) : null;
  }
  out.currentRelease = currentRelease(rw);
  return out;
}

function untouchedDifferences(before, after) {
  const diffs = [];
  for (const k of Object.keys(before)) {
    if (k === 'currentRelease') {
      if (JSON.stringify(before[k]) !== JSON.stringify(after[k])) diffs.push('changed: current-release.json');
    } else if (before[k] === null || after[k] === null) {
      if (before[k] !== after[k]) diffs.push(`${k}: ${before[k] === null ? 'added' : 'removed'}`);
    } else diffs.push(...w.snapshotDifferences(before[k], after[k]).map((d) => `${k} ${d}`));
  }
  return diffs;
}

// The files left under the staging folder (a missing folder holds none).
function stagingFiles(rw) {
  const dir = path.join(rw.home, 'staging');
  if (!fs.existsSync(dir)) return [];
  const out = [];
  const walk = (a, r) => {
    for (const n of fs.readdirSync(a)) {
      const p = path.join(a, n);
      const st = fs.lstatSync(p);
      if (st.isDirectory()) walk(p, `${r}${n}/`);
      else out.push(`${r}${n}`);
    }
  };
  walk(dir, '');
  return out;
}

// The owner's folder as content (the design record's line 13): every entry's
// relative path, type, permissions, bytes (as a SHA-256) and link target, not
// its times. A file its owner cannot read is opened for the reading and put
// back; an entry that still cannot be read throws, so a case fails rather
// than passes or skips. except names relative paths left out.
function ownerHash(dir, { except = [] } = {}) {
  const out = {};
  const walk = (abs, rel) => {
    for (const name of fs.readdirSync(abs).sort()) {
      const a = path.join(abs, name);
      const r = rel ? `${rel}/${name}` : name;
      if (except.includes(r)) continue;
      const st = fs.lstatSync(a);
      const mode = (st.mode & 0o7777).toString(8);
      if (st.isSymbolicLink()) out[r] = `link ${mode} ${fs.readlinkSync(a)}`;
      else if (st.isDirectory()) {
        out[r] = `dir ${mode}`;
        if ((st.mode & 0o500) !== 0o500) fs.chmodSync(a, st.mode | 0o500);
        try { walk(a, r); } finally { fs.chmodSync(a, st.mode & 0o7777); }
      } else if (st.isFile()) {
        if ((st.mode & 0o400) === 0) fs.chmodSync(a, st.mode | 0o400);
        try { out[r] = `file ${mode} ${w.sha256(fs.readFileSync(a))}`; } finally { fs.chmodSync(a, st.mode & 0o7777); }
      } else if (st.isFIFO()) out[r] = `fifo ${mode}`;
      else throw new Error(`the owner's folder hash cannot read ${r}`);
    }
  };
  walk(dir, '');
  return out;
}

function hashDifferences(before, after) {
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  return keys.filter((k) => before[k] !== after[k]).map((k) => `${k}: ${before[k] || '(none)'} -> ${after[k] || '(none)'}`);
}

const LEDGER = 'state/approvals.jsonl';
const ledgerRecords = (rw) => readJsonLines(w.ledgerOf(rw.world));

// The wake-ups Squire has sent (their states), from the given count on.
const wakeUpIds = (rw) => s.wakeUpStates(rw.world).map((x) => x.id);
// The wake-ups sent since the ids given were read: their texts.
const newWakeUps = (rw, before) => s.wakeUpStates(rw.world).filter((x) => !before.includes(x.id)).map((x) => x.text || '');

// The session asks for something through the floor: it must be asked (a block
// with a request id), never refused. Returns the block and the request id.
function asked(rw, session, command, what) {
  const r = w.attempt(rw.world, session, w.tools.bash(command), { env: env(rw), coreDir: installedCore(rw) });
  w.assertBlocked(r, what);
  const id = w.requestIdIn(r.stderr);
  assert.ok(id, `${what}: the floor must ask the owner (a block with a request id), never refuse it outright; got ${w.describe(r)}`);
  return { block: r.stderr, id, result: r };
}

// The owner answers one request.
function owner(rw, session, words) {
  return w.ownerSays(rw.world, session, words, { env: env(rw), coreDir: installedCore(rw) });
}

// The world plays time passing for one ledger record: its "at" moved by
// seconds (negative: earlier), as round 3's known-fix cases age a yes.
function moveLedgerTime(rw, test, seconds) {
  const file = w.ledgerOf(rw.world);
  const records = readJsonLines(file);
  const hit = records.filter(test);
  assert.ok(hit.length >= 1, 'the world moves the time of a ledger record that is there');
  for (const r of hit) r.at += seconds;
  fs.writeFileSync(file, records.map((r) => JSON.stringify(r, Object.keys(r).sort())).join('\n') + '\n');
}

const yesFor = (id) => (r) => r.type === 'answer' && r.request === id && r.answer === 'yes';
const requestRecord = (id) => (r) => r.type === 'request' && r.id === id;

// The world plays time passing for Squire's own records of when it last did
// something (update.json's lastCheck, an outbox ticket's attempts): every
// time field named moved by seconds.
function moveRecordTimes(file, seconds, fields = ['lastCheck', 'at']) {
  const data = readJson(file);
  assert.ok(data, `the world moves the times in ${path.basename(file)}, which must be there`);
  const visit = (o) => {
    if (Array.isArray(o)) o.forEach(visit);
    else if (o && typeof o === 'object') for (const k of Object.keys(o)) {
      if (fields.includes(k) && typeof o[k] === 'number') o[k] += seconds;
      else visit(o[k]);
    }
  };
  visit(data);
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
}

// ------------------------------------------------------------- tickets

const TICKET_LINE = /^ticket: (t-[0-9a-f]{32}) is ready to send about (.+); to send it, ask: (.+)$/;
const ticketLines = (out) => out.split('\n').map((l) => TICKET_LINE.exec(l.trim())).filter(Boolean);
const outboxFile = (rw, id) => path.join(rw.home, 'outbox', `${id}.json`);
const outboxState = (rw, id) => readJson(path.join(rw.home, 'outbox', `${id}.state.json`));
const outboxIds = (rw) => { try { return fs.readdirSync(path.join(rw.home, 'outbox')).filter((n) => /^t-[0-9a-f]{32}\.json$/.test(n)).map((n) => n.slice(0, -5)).sort(); } catch (e) { return []; } };
const setAside = (rw) => { try { return fs.readdirSync(path.join(rw.home, 'outbox', 'set-aside')).sort(); } catch (e) { return []; } };
const installId = (rw) => { try { return fs.readFileSync(path.join(rw.home, 'install-id'), 'utf8').trim(); } catch (e) { return null; } };

// The allow-list of a ticket's fields, each value's set or pattern (the
// design record's line 16).
const VERSION = /^\d+\.\d+\.\d+$/;
const TICKET_FIELDS = {
  ticketId: (v) => typeof v === 'string' && /^t-[0-9a-f]{32}$/.test(v),
  installId: (v) => typeof v === 'string' && /^[0-9a-f]{32}$/.test(v),
  destination: null,
  squireVersion: (v) => typeof v === 'string' && VERSION.test(v),
  claudeCodeVersion: (v) => typeof v === 'string' && VERSION.test(v),
  macOSVersion: (v) => typeof v === 'string' && /^\d+(\.\d+)*$/.test(v),
  macModelClass: (v) => ['MacBook Air', 'MacBook Pro', 'Mac mini', 'iMac', 'Mac Studio', 'Mac Pro', 'Mac'].includes(v),
  agentsLoaded: (v) => Array.isArray(v) && v.every((x) => ['com.stravica.squire.runner', 'com.stravica.squire.wake-ups', 'com.stravica.squire.backup'].includes(x)),
  healthCodes: (v) => Array.isArray(v) && v.every((x) => typeof x === 'string' && /^[a-z]+(-[a-z]+)*$/.test(x)),
  lastErrors: (v) => Array.isArray(v) && v.every((x) => x && typeof x === 'object' && Object.keys(x).sort().join() === 'at,code'
    && typeof x.code === 'string' && /^[a-z]+(-[a-z]+)*$/.test(x.code) && typeof x.at === 'number'),
  fixesTried: (v) => Array.isArray(v) && v.every((x) => ['runner', 'floor', 'sign-in'].includes(x)),
  createdAt: (v) => typeof v === 'number' && Number.isFinite(v),
};

// Every way a planted detail could show: as given, lower-cased, and its
// letters and digits alone.
function plantedTraces(extra = []) {
  const out = new Set();
  for (const v of [...Object.values(PLANTED), ...extra]) {
    out.add(v);
    out.add(v.toLowerCase());
    out.add(v.replace(/[^A-Za-z0-9@.]/g, ''));
  }
  return [...out].filter((x) => x.length >= 4);
}

// The account names of whoever runs the tests: the real account the product
// runs under, which a ticket must never carry.
function accountNames() {
  const short = require('node:os').userInfo().username;
  const r = spawnSync('/usr/bin/id', ['-F'], { encoding: 'utf8' });
  return [short, (r.stdout || '').trim()].filter((x) => x && x.length >= 3);
}

// True when the account's short or full name shows in text as a word of its
// own. A closed-set value of the ticket (a health code, a known fix's name, an
// agent's label) is left out of the search first, so an account that happens
// to share a name with one (an account named runner, say) is not a false hit.
function carriesAccountName(text, ticket = null) {
  let scrubbed = text;
  if (ticket) {
    const closed = [...(ticket.healthCodes || []), ...(ticket.fixesTried || []), ...(ticket.agentsLoaded || []),
      ...((ticket.lastErrors || []).map((e) => e && e.code))].filter((v) => typeof v === 'string');
    for (const v of closed) scrubbed = scrubbed.split(JSON.stringify(v)).join('""');
  }
  return accountNames().some((n) => new RegExp(`(^|[^A-Za-z0-9])${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^A-Za-z0-9])`, 'i').test(scrubbed));
}

module.exports = {
  NAMESPACE,
  INSTALLED,
  CLAUDE_CODE,
  INSTALL_STEPS,
  FENCE_WORDS,
  CHANGELOG,
  PLANTED,
  LEDGER,
  TICKET_FIELDS,
  makeKeys,
  sign,
  makeSystem,
  makeCore,
  buildRelease,
  ARCHIVE_SHAPES,
  MARKER,
  buildArchiveRelease,
  tickWatching,
  markersOutside,
  standIns,
  hostRequests,
  latestFetches,
  intakePosts,
  setLauncherTarget,
  setVersionAnswer,
  makeReleaseWorld,
  makeInstalledApp,
  makeRound3Core,
  layRound3Home,
  runAppAgain,
  launchSquire,
  startSquire,
  stopSquire,
  askRunnerStart,
  runnerStarts,
  runnerOutput,
  tick,
  startTick,
  stopInstallAt,
  killInstallAt,
  health,
  installRecordFile,
  currentRelease,
  keptReleases,
  staged,
  stagingFiles,
  updateRecord,
  installedCore,
  updateRequest,
  ticketRequest,
  fixRequest,
  coreIs,
  untouched,
  untouchedDifferences,
  ownerHash,
  hashDifferences,
  ledgerRecords,
  wakeUpIds,
  newWakeUps,
  asked,
  owner,
  moveLedgerTime,
  yesFor,
  requestRecord,
  moveRecordTimes,
  ticketLines,
  outboxFile,
  outboxState,
  outboxIds,
  setAside,
  installId,
  plantedTraces,
  accountNames,
  carriesAccountName,
  readJson,
  nowSeconds,
  env,
};
