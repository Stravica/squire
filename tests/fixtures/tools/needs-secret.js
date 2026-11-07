'use strict';

// A tool that needs a secret, written as carelessly as a real one can be: it
// prints the secret it was given, on both of its outputs.
//
//   needs-secret.js <ENV_VAR> <hash-file> <ran-marker>
//
// It reads the secret from the environment variable it is told, writes the
// SHA-256 of what it got to <hash-file> (so a test can tell it got the right
// secret without the secret being written anywhere), marks that it ran, and
// says "status: ok".

const crypto = require('node:crypto');
const fs = require('node:fs');

const [, , envVar, hashFile, ranMarker] = process.argv;
fs.writeFileSync(ranMarker, 'ran\n');
const value = process.env[envVar] || '';
fs.writeFileSync(hashFile, crypto.createHash('sha256').update(value).digest('hex'));
process.stdout.write('status: ok\n');
process.stdout.write(`token=${value}\n`);
process.stderr.write(`debug: authorising with ${value}\n`);
