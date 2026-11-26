'use strict';

// Code hygiene for the version the two app bundles carry: Squire's app
// (installer/Squire.app) and Squire Update (core/update-app) each read the
// release version core/release.json holds, in CFBundleShortVersionString and
// CFBundleVersion. Bound to no criterion. Nothing is run: the three files are
// read as text.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const PLISTS = [
  path.join(ROOT, 'installer', 'Squire.app', 'Contents', 'Info.plist'),
  path.join(ROOT, 'core', 'update-app', 'Info.plist'),
];

function stringOf(text, key) {
  const found = [...text.matchAll(new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`, 'g'))];
  assert.equal(found.length, 1, `exactly one ${key}; found ${found.length}`);
  return found[0][1];
}

test('both app bundles carry the release version core/release.json holds, as their short version and their build version', () => {
  const release = JSON.parse(fs.readFileSync(path.join(ROOT, 'core', 'release.json'), 'utf8'));
  assert.match(String(release.version), /^\d+\.\d+\.\d+$/, 'core/release.json holds a version of three whole numbers');
  for (const plist of PLISTS) {
    const text = fs.readFileSync(plist, 'utf8');
    for (const key of ['CFBundleShortVersionString', 'CFBundleVersion']) {
      assert.equal(stringOf(text, key), release.version, `${path.relative(ROOT, plist)}: ${key} is the release version`);
    }
  }
});
