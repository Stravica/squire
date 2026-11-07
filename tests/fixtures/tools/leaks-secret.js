'use strict';

// A tool that needs a secret and leaks it every way a careless tool can: it
// prints the secret as text, base64, lower and upper hex and percent-encoded;
// it prints it again in two writes with a pause between, so no one write
// holds it whole; and it prints it once more amid bytes that are not UTF-8.
// Between the leaks it prints its own ordinary output, which must still come
// through.
//
//   leaks-secret.js <ENV_VAR> <hash-file> <ran-marker>
//
// Like needs-secret.js it writes the SHA-256 of what it got to <hash-file>
// and marks that it ran.

const crypto = require('node:crypto');
const fs = require('node:fs');

const [, , envVar, hashFile, ranMarker] = process.argv;
fs.writeFileSync(ranMarker, 'ran\n');
const value = process.env[envVar] || '';
const bytes = Buffer.from(value, 'utf8');
fs.writeFileSync(hashFile, crypto.createHash('sha256').update(value).digest('hex'));

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const out = (data) => new Promise((resolve) => process.stdout.write(data, resolve));
const err = (data) => new Promise((resolve) => process.stderr.write(data, resolve));

(async () => {
  await out('status: ok\n');
  await out(`token=${value}\n`);
  await out(`token-base64=${bytes.toString('base64')}\n`);
  await out(`token-hex=${bytes.toString('hex')}\n`);
  await out(`token-HEX=${bytes.toString('hex').toUpperCase()}\n`);
  await out(`callback=https://example.com/cb?token=${encodeURIComponent(value)}\n`);
  await out('rows: 14\n');

  const half = Math.floor(value.length / 2);
  await out(`split=${value.slice(0, half)}`);
  await err(`debug: split=${value.slice(0, half)}`);
  await pause(400);
  await out(`${value.slice(half)}\n`);
  await err(`${value.slice(half)}\n`);

  await out(Buffer.concat([Buffer.from([0xff, 0xfe, 0x80, 0x20]), bytes, Buffer.from([0x20, 0xc3, 0x28, 0x0a])]));
  await err(Buffer.concat([Buffer.from([0xc0, 0xaf]), bytes, Buffer.from([0x0a])]));
  await out('done: 3 invoices\n');
  await err('debug: finished\n');
})();
