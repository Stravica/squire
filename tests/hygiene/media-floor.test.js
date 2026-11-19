'use strict';

// Code hygiene for the floor's media rules, through its entry point: a web
// fetch of a YouTube address, a tool an earlier core held for YouTube, and the
// video tool spelt with a verb it does not have or the wrong count of values.
// Bound to no criterion.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const w = require('../fixtures/squire-world.js');

function world(t) {
  const it = w.makeWorld();
  t.after(() => w.cleanUp(it));
  return it;
}

const NO_YOUTUBE = /fetches nothing from YouTube/;
const refused = (r) => r.status === 2 && w.requestIdIn(r.stderr) === null;

test('a web fetch of an address on any of YouTube\'s hosts, in any form, is refused and never asked; an address that only looks like one is not refused as YouTube', { timeout: 60000 }, (t) => {
  const it = world(t);
  for (const url of [
    'https://youtube.com/watch?v=N0Captions1', 'HTTPS://WWW.YOUTUBE.COM/', 'http://youtu.be/N0Captions1',
    'https://www.youtube-nocookie.com/embed/N0Captions1', 'https://youtube.com./watch?v=N0Captions1',
    'https://someone@m.youtube.com:443/watch?v=N0Captions1', 'https://www.youtubekids.com/watch?v=N0Captions1',
    'https://i.ytimg.com/vi/N0Captions1/0.jpg', 'https://rr1---sn-abc.googlevideo.com/videoplayback',
    'www.youtube.com/watch?v=N0Captions1', ' https://music.youtube.com/playlist?list=PL0 ',
  ]) {
    const r = w.attempt(it, 'session-hygiene-youtube', w.tools.webFetch(url));
    assert.ok(refused(r), `the web fetch of ${JSON.stringify(url)} must be refused, never asked or free; got ${w.describe(r)}`);
    assert.match(r.stderr, NO_YOUTUBE, `the refusal of ${url} must say Squire fetches nothing from YouTube; got ${w.describe(r)}`);
  }
  for (const url of ['https://notyoutube.com/watch', 'https://youtube.com.example.org/', 'https://example.org/?u=youtube.com',
    'https://example.org/youtube.com/watch']) {
    const r = w.attempt(it, 'session-hygiene-web', w.tools.webFetch(url));
    assert.doesNotMatch(r.stderr, NO_YOUTUBE, `${url} is not on a YouTube host; got ${w.describe(r)}`);
  }
});

test('a command naming the tool an earlier core held for YouTube is refused, never asked, in the Squire home\'s core and in the hook\'s own, alone or inside a shell', { timeout: 60000 }, (t) => {
  const it = world(t);
  for (const reader of [path.join(it.home, 'core', 'tools', 'captions.py'), path.join(w.CORE, 'tools', 'captions.py')]) {
    for (const command of [
      `/usr/bin/python3 '${reader}' 'https://youtu.be/N0Captions1'`,
      `/usr/bin/python3 '${reader}'`,
      `sh -c "/usr/bin/python3 '${reader}' https://youtu.be/N0Captions1"`,
    ]) {
      const r = w.attempt(it, 'session-hygiene-earlier', w.tools.bash(command));
      assert.ok(refused(r), `${command} must be refused, never asked or free; got ${w.describe(r)}`);
      assert.match(r.stderr, NO_YOUTUBE, `the refusal must say Squire fetches nothing from YouTube; got ${w.describe(r)}`);
    }
  }
});

test('the video tool is asked only as one of its three verbs with its own count of values; another verb, another count or a value taken for an option is refused, never asked', { timeout: 60000 }, (t) => {
  const it = world(t);
  const tool = path.join(w.CORE, 'tools', 'video.py');
  const file = path.join(it.owner, 'workspace', 'files', 'Bread class.mov');
  for (const values of [`clip '${file}' '0:01' '0:03'`, `audio '${file}'`, `smaller '${file}'`]) {
    const r = w.attempt(it, 'session-hygiene-video', w.tools.bash(`/usr/bin/python3 '${tool}' ${values}`));
    assert.ok(r.status === 2 && w.requestIdIn(r.stderr), `the video tool's ${values.split(' ')[0]} must be asked; got ${w.describe(r)}`);
    assert.match(r.stderr, /video and audio work/, `its question must name video and audio work; got ${w.describe(r)}`);
  }
  for (const values of [`rotate '${file}'`, `clip '${file}' '0:01'`, `audio '${file}' '${file}'`, `smaller '--help'`,
    `clip '${file}' '0:01' '0:03' '0:05'`, '']) {
    const r = w.attempt(it, 'session-hygiene-video', w.tools.bash(`/usr/bin/python3 '${tool}' ${values}`.trim()));
    assert.ok(refused(r), `the video tool as ${JSON.stringify(values)} must be refused, never asked; got ${w.describe(r)}`);
  }
});
