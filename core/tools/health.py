"""Squire's health check.

    /usr/bin/python3 health.py

Names every overlay in the owner's folder that sits at the path of a core
file, one line each, as "ignored: overlay/<path> (safety floor)": in this
release every core path is a safety floor path, so the floor never reads
them. Then the session runner's lines: why it started no session at its
last check, and each Claude Code settings file it moved out of the owner's
folder, by name. Exits 1 when it names anything, 0 when it names nothing.
"""

import json
import os
import sys

CORE = os.path.dirname(os.path.dirname(os.path.realpath(__file__)))


class HealthCheck:
    @staticmethod
    def main():
        sys.path.insert(0, os.path.join(CORE, 'lib'))
        from squire import Config, SquireError

        try:
            config = Config()
        except SquireError as e:
            sys.stderr.write(f'health check could not run: {e}.\n')
            return 2
        lines = [f'ignored: overlay/{rel} (safety floor)' for rel in HealthCheck.ignored_overlays(CORE, config.owner_folder)]
        lines += HealthCheck.runner_lines(config.home)
        for line in lines:
            print(line)
        return 1 if lines else 0

    @staticmethod
    def ignored_overlays(core, owner):
        overlay = os.path.join(owner, 'overlay')
        found = []
        for folder, _, files in os.walk(core):
            for name in files:
                rel = os.path.relpath(os.path.join(folder, name), core)
                if os.path.lexists(os.path.join(overlay, rel)):
                    found.append(rel)
        return sorted(found)

    @staticmethod
    def runner_lines(home):
        """What the runner left for the owner: its last check's problems, and
        the settings files it moved."""
        lines = []
        try:
            with open(os.path.join(home, 'runner.json'), encoding='utf-8') as f:
                problems = json.load(f).get('problems')
            lines += [p for p in problems if isinstance(p, str)]
        except (OSError, ValueError, AttributeError, TypeError):
            pass
        moved = os.path.join(home, 'moved-settings')
        for folder, _, files in sorted(os.walk(moved)):
            for name in sorted(files):
                lines.append(f'moved: the Claude Code settings file .claude/{name} was in the owner\'s folder, where it '
                             f'could switch the safety floor off; it is kept at {os.path.join(folder, name)}')
        return lines


if __name__ == '__main__':
    try:
        code = HealthCheck.main()
    except Exception as e:
        sys.stderr.write(f'health check failed ({type(e).__name__}).\n')
        code = 2
    sys.exit(code)
