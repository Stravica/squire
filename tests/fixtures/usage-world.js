'use strict';

// What the plan, pacing, heavy-job and handover cases share, on top of the
// base world (squire-world.js). Nothing here imports or copies product logic.
// The design record for plan awareness and the heavy-job gate (ADR-006) names
// every path and record read here:
//
//   runtime/usage.json      the usage snapshot in the Squire home: at (seconds
//                           since 1970, when written), model, contextUsedPercent,
//                           fiveHour and sevenDay, each {usedPercent, resetsAt}
//                           or null (line 2)
//   runtime/advice.json     {givenAt}: when the upgrade advice was last given
//                           (line 7)
//   core/tools/heavy-job.py the one command a big job starts through, gated by
//                           the floor (line 6)
//   statusLine              Claude Code's status line command in core's
//                           settings, which writes the snapshot (line 2)
//   state/handover/<session id>.md
//                           the handover note in the owner's folder (line 8)
//
// The status line's input follows the statusline page's schema (fields the
// command must ignore included: the session id, the transcript path, the
// working folder, the cost).

const { spawnSync } = require('node:child_process');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const w = require('./squire-world.js');

const now = () => Math.floor(Date.now() / 1000);
const DAY = 86400;
// A time on a whole minute, so its HH:MM is the same however it is rounded.
const onMinute = (seconds) => Math.floor(seconds / 60) * 60;
// HH:MM in UTC: the cases run the hooks with TZ=UTC, so the Mac's local time is UTC.
const hhmm = (seconds) => new Date(seconds * 1000).toISOString().slice(11, 16);
const UTC = { TZ: 'UTC' };

// A world whose Squire home has core at core/ (a link to this repository's
// core), as an installed Squire has, so the commands core's settings name
// resolve. With core: false the home has no core, for a lay-down to fill.
function usageWorld(t, { core = true } = {}) {
  const world = w.makeWorld();
  t.after(() => w.cleanUp(world));
  if (core) fs.symlinkSync(w.CORE, path.join(world.home, 'core'));
  return world;
}

const runtimeDir = (world) => path.join(world.home, 'runtime');
const snapshotFile = (world) => path.join(runtimeDir(world), 'usage.json');

// Writes the usage snapshot as the status line command would have: windows
// given as { used, resetsAt } (or null for an absent window), age in seconds
// before now, context as a percentage.
function writeSnapshot(world, { fiveHour = null, sevenDay = null, context = 20, age = 60, model = 'claude-opus-5-5' } = {}) {
  const window = (x) => (x ? { usedPercent: x.used, resetsAt: x.resetsAt } : null);
  fs.mkdirSync(runtimeDir(world), { recursive: true });
  fs.writeFileSync(snapshotFile(world), JSON.stringify({
    at: now() - age, model, contextUsedPercent: context, fiveHour: window(fiveHour), sevenDay: window(sevenDay),
  }, null, 2) + '\n');
}

const readSnapshot = (world) => (fs.existsSync(snapshotFile(world)) ? JSON.parse(fs.readFileSync(snapshotFile(world), 'utf8')) : null);

// The status line JSON Claude Code gives its status line command (statusline
// page). rateLimits: { fiveHour: { used, resetsAt }, sevenDay: { ... } }, a
// window left out is absent, and rateLimits null leaves rate_limits out (before
// the first API response, or a plan without it).
function statusInput(world, { rateLimits = null, context = 41, model = 'claude-opus-5-5', sessionId = 'job-status' } = {}) {
  const input = {
    cwd: world.owner,
    session_id: sessionId,
    session_name: 'Juniper',
    prompt_id: '550e8400-e29b-41d4-a716-446655440000',
    transcript_path: world.transcript,
    model: { id: model, display_name: 'Opus' },
    workspace: { current_dir: world.owner, project_dir: world.owner, added_dirs: [] },
    version: '2.1.319',
    output_style: { name: 'default' },
    cost: { total_cost_usd: 0.01234, total_duration_ms: 45000, total_api_duration_ms: 2300, total_lines_added: 156, total_lines_removed: 23 },
    context_window: {
      total_input_tokens: 15500, total_output_tokens: 1200, context_window_size: 200000,
      used_percentage: context, remaining_percentage: context === null ? null : 100 - context,
      current_usage: { input_tokens: 8500, output_tokens: 1200, cache_creation_input_tokens: 5000, cache_read_input_tokens: 2000 },
    },
    exceeds_200k_tokens: false,
  };
  if (rateLimits) {
    input.rate_limits = {};
    if (rateLimits.fiveHour) input.rate_limits.five_hour = { used_percentage: rateLimits.fiveHour.used, resets_at: rateLimits.fiveHour.resetsAt };
    if (rateLimits.sevenDay) input.rate_limits.seven_day = { used_percentage: rateLimits.sevenDay.used, resets_at: rateLimits.sevenDay.resetsAt };
  }
  return input;
}

// Runs Claude Code's status line command exactly as core's settings set it
// (statusLine, type command), through the shell as Claude Code runs it, with
// the input on stdin, from the owner's folder, in the product's environment.
// The world's home must have core (usageWorld's default).
function runStatusLine(world, input) {
  const settings = JSON.parse(fs.readFileSync(path.join(w.CORE, 'settings.json'), 'utf8'));
  const line = settings.statusLine;
  assert.ok(line && line.type === 'command' && typeof line.command === 'string' && line.command.length > 0,
    `core's settings must set Claude Code's status line to Squire's command (statusLine, type command: the design record's line 2); got ${JSON.stringify(line)}`);
  const r = spawnSync('/bin/sh', ['-c', line.command], {
    input: typeof input === 'string' ? input : JSON.stringify(input), cwd: world.owner, env: w.productEnv(world), encoding: 'utf8', timeout: 30000,
  });
  return { status: r.status, signal: r.signal, stdout: r.stdout || '', stderr: r.stderr || '', error: r.error ? String(r.error.message || r.error) : '' };
}

// The status line command as runStatusLine runs it, when core's settings set
// one; null when they set none. For cases whose own assertions are about what
// the snapshot leads to (the advice), not about the command being there: that
// is asserted in its own case.
function statusLineIfSet(world, input) {
  const settings = JSON.parse(fs.readFileSync(path.join(w.CORE, 'settings.json'), 'utf8'));
  const line = settings.statusLine;
  if (!(line && line.type === 'command' && typeof line.command === 'string' && line.command.length > 0)) return null;
  return runStatusLine(world, input);
}

// The command a big job starts through, as the session runs it: its path in
// the Squire home, single-quoted as the health check's is.
const heavyJobScript = (world) => path.join(world.home, 'core', 'tools', 'heavy-job.py');
const heavyJob = (world, kind) => w.tools.bash(`/usr/bin/python3 '${heavyJobScript(world)}' ${kind}`);

// The four classes of a big job and the words the warning names each by.
const HEAVY = {
  research: /deep research/i,
  app: /building an app/i,
  site: /building a site/i,
  media: /video and audio work/i,
};

// The owner answers a block: "yes <request>" when the block names one, else a bare yes.
function sayYesTo(world, session, r, opts = {}) {
  const id = w.requestIdIn(r.stderr);
  w.ownerSays(world, session, id ? `yes ${id}` : 'yes', opts);
  return id;
}

// A message Squire's own wake-up router posts (ADR-003 line 14's framing):
// Squire's own background work, not the owner's.
function wakeUp(world, session, text = 'Good morning', opts = {}) {
  const r = w.hook(world, 'user-prompt-submit.py',
    w.userPromptEvent(world, session, `Squire wake-up: due 07:30, delivered 07:30 ${text}`), opts);
  assert.equal(r.status, 0, `a wake-up must reach Squire (the hook exits 0); got ${w.describe(r)}`);
  return r;
}

module.exports = {
  now,
  DAY,
  onMinute,
  hhmm,
  UTC,
  usageWorld,
  runtimeDir,
  snapshotFile,
  writeSnapshot,
  readSnapshot,
  statusInput,
  runStatusLine,
  statusLineIfSet,
  heavyJobScript,
  heavyJob,
  HEAVY,
  sayYesTo,
  wakeUp,
};
