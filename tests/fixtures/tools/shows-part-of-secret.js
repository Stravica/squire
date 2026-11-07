'use strict';

// A tool that needs a secret and shows part of it, as many real tools do to
// say which key they are using: never the whole secret, only its first eight
// characters, its last five and four from its middle, on both its outputs.
//
//   shows-part-of-secret.js <ENV_VAR> <hash-file> <ran-marker>
//
// Like needs-secret.js it writes the SHA-256 of what it got to <hash-file>,
// marks that it ran, and says "status: ok".

const crypto = require('node:crypto');
const fs = require('node:fs');

const [, , envVar, hashFile, ranMarker] = process.argv;
fs.writeFileSync(ranMarker, 'ran\n');
const value = process.env[envVar] || '';
fs.writeFileSync(hashFile, crypto.createHash('sha256').update(value).digest('hex'));
const middle = Math.floor(value.length / 2) - 2;
process.stdout.write('status: ok\n');
process.stdout.write(`using the key that begins ${value.slice(0, 8)}...\n`);
process.stdout.write(`key middle: ${value.slice(middle, middle + 4)}\n`);
process.stderr.write(`debug: key ends ...${value.slice(-5)}\n`);
