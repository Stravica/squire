"""Squire's video tool: a clip, just the sound, or a smaller copy of a video
of the owner's own, each made on this Mac by Apple's own avconvert
(/usr/bin/avconvert) as a new file in the owner's folder.

    /usr/bin/python3 '<Squire home>/core/tools/video.py' clip '<file>' '<from>' '<to>'
        the part between two times (M:SS, H:MM:SS or seconds, as a transcript
        writes them).
    /usr/bin/python3 '<Squire home>/core/tools/video.py' audio '<file>'
        just its sound, as an audio file with no picture.
    /usr/bin/python3 '<Squire home>/core/tools/video.py' smaller '<file>'
        a smaller copy to share, its picture at most 1280 by 720.

Each new file goes in workspace/files in the owner's folder, named after the
original's stem, a space and the verb (`Bread class clip.mov`); where that
name is taken by anything already there (a file, a link, a folder), the next
free name of the same stem and verb (`Bread class clip 2.mov`). What is
already there is never written, followed, replaced or moved, and the
original is never written over or changed. avconvert writes into a folder of
the tool's own beside the new file, which is put in place only when whole,
and the folder removed; a failed run leaves nothing. Every new file is made
without the video's location data: avconvert's metadata filter, which
leaves it out, is never turned off.

The safety floor asks the owner first, at every run, as video and audio
work. A file that is not there or cannot be read stops before anything runs,
with a plain reason; nothing is changed. Nothing is sent anywhere.

Standard library only; run by /usr/bin/python3.
"""

import os
import re
import shutil
import subprocess
import sys
import tempfile

CORE = os.path.dirname(os.path.dirname(os.path.realpath(__file__)))
sys.path.insert(0, os.path.join(CORE, 'lib'))
sys.path.insert(0, os.path.join(CORE, 'tools'))

from squire import Config, SquireError, System  # noqa: E402
from transcribe import VIDEO, Stop, readable  # noqa: E402

AVCONVERT = '/usr/bin/avconvert'
FILES = os.path.join('workspace', 'files')
WITHIN = 1800
# The verb's preset and the extension it writes; a clip of a recording with
# no picture is cut as sound.
PRESETS = {'clip': ('PresetHighestQuality', '.mov'), 'audio': ('PresetAppleM4A', '.m4a'),
           'smaller': ('Preset1280x720', '.mov')}
SOUND = ('PresetAppleM4A', '.m4a')
WHAT = {'clip': 'the clip', 'audio': 'just the sound', 'smaller': 'the smaller copy'}
USE = ('Use: video.py clip \'<file>\' \'<from>\' \'<to>\' | audio \'<file>\' | smaller \'<file>\' '
       '(times as M:SS, H:MM:SS or seconds)')


def seconds_of(text):
    """A time in the recording as M:SS, H:MM:SS or seconds, in seconds; None
    when it is not one."""
    text = text.strip()
    if re.fullmatch(r'\d+(\.\d+)?', text):
        return float(text)
    found = re.fullmatch(r'(?:(\d+):)?(\d{1,2}):(\d{2}(?:\.\d+)?)', text)
    if not found:
        return None
    hours, minutes, secs = int(found.group(1) or 0), int(found.group(2)), float(found.group(3))
    if secs >= 60 or (found.group(1) is not None and minutes >= 60):
        return None
    return hours * 3600 + minutes * 60 + secs


def avconvert_args(verb, source, output, start=None, end=None):
    """The request in (the verb, the original, where avconvert writes, and a
    clip's two times in seconds), avconvert's argument list out: one argument
    a value, no shell, the metadata filter left on so no location data is
    kept."""
    preset = (SOUND if verb == 'clip' and os.path.splitext(source)[1].lower() not in VIDEO else PRESETS[verb])[0]
    argv = [System.command(AVCONVERT), '--source', source, '--preset', preset, '--output', output]
    if verb == 'clip':
        argv += ['--start', f'{start:.3f}', '--duration', f'{end - start:.3f}']
    return argv


def make(config, verb, given, times):
    """One request: (exit code, what to say)."""
    source = os.path.abspath(os.path.expanduser(given))
    name = os.path.basename(source)
    try:
        readable(source)
    except Stop as e:
        return e.code, str(e)
    start = end = None
    if verb == 'clip':
        start, end = (seconds_of(t) for t in times)
        if start is None or end is None:
            return 2, (f'Squire cuts a clip between two times written as M:SS, H:MM:SS or seconds, and '
                       f'{times[0]!r} to {times[1]!r} is not that. Nothing was made and nothing changed.')
        if start >= end:
            return 2, (f'A clip runs from an earlier time to a later one, and {times[0]} is not before {times[1]}. '
                       'Nothing was made and nothing changed.')
    if verb == 'smaller' and os.path.splitext(name)[1].lower() not in VIDEO:
        return 2, (f'A smaller copy is of a video, and {name} is a recording with no picture. Nothing was made and '
                   'nothing changed.')
    ext = SOUND[1] if verb == 'clip' and os.path.splitext(name)[1].lower() not in VIDEO else PRESETS[verb][1]
    folder = os.path.join(config.owner_folder, FILES)
    stem = os.path.splitext(name)[0]
    try:
        os.makedirs(folder, exist_ok=True)
        work = tempfile.mkdtemp(prefix='.squire-video-', dir=folder)
    except OSError as e:
        return 1, f'Squire could not make {WHAT[verb]} of {name} ({e.strerror or type(e).__name__}). Nothing changed.'
    try:
        made = os.path.join(work, f'{stem} {verb}{ext}')
        try:
            r = subprocess.run(avconvert_args(verb, source, made, start, end), cwd='/', env=System.env(),
                               stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=WITHIN)
        except subprocess.TimeoutExpired:
            return 1, f'Squire could not make {WHAT[verb]} of {name}: it took too long. Nothing changed.'
        except OSError:
            return 1, (f'Squire could not make {WHAT[verb]} of {name}: Apple\'s avconvert is not on this Mac. '
                       'Nothing changed.')
        if r.returncode != 0 or not os.path.isfile(made) or os.path.getsize(made) == 0:
            return 1, f'Squire could not make {WHAT[verb]} of {name}: avconvert could not read it. Nothing changed.'
        # The first free name of the stem and verb; put in place by a link,
        # which never goes over or through anything already there.
        for n in range(1, 10000):
            target = os.path.join(folder, f'{stem} {verb}{ext}' if n == 1 else f'{stem} {verb} {n}{ext}')
            if os.path.lexists(target):
                continue
            try:
                os.link(made, target)
            except FileExistsError:
                continue
            except OSError as e:
                return 1, f'Squire made {WHAT[verb]} of {name} but could not keep it ({e.strerror}). Nothing changed.'
            return 0, f'Made {WHAT[verb]} of {name} on this Mac, without its location data: {os.path.relpath(target, config.owner_folder)}'
        return 1, f'Squire could not find a free name for {WHAT[verb]} of {name}. Nothing changed.'
    finally:
        shutil.rmtree(work, ignore_errors=True)


def main(argv):
    if not argv or argv[0] not in PRESETS or len(argv) != (4 if argv[0] == 'clip' else 2) \
            or not argv[1] or argv[1].startswith('-'):
        sys.stderr.write(USE + '\n')
        return 2
    try:
        config = Config()
    except SquireError as e:
        sys.stderr.write(f'Squire cannot work on videos right now: {e}.\n')
        return 1
    code, words = make(config, argv[0], argv[1], argv[2:])
    (sys.stdout if code == 0 else sys.stderr).write(words + '\n')
    return code


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
