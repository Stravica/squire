"""Squire's health check.

    /usr/bin/python3 health.py

Names every overlay in the owner's folder that sits at the path of a core
file, one line each, as "ignored: overlay/<path> (safety floor)": in this
release every core path is a safety floor path, so the floor never reads
them. Exits 1 when it names any, 0 when none.
"""

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
        ignored = HealthCheck.ignored_overlays(CORE, config.owner_folder)
        for rel in ignored:
            print(f'ignored: overlay/{rel} (safety floor)')
        return 1 if ignored else 0

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


if __name__ == '__main__':
    try:
        code = HealthCheck.main()
    except Exception as e:
        sys.stderr.write(f'health check failed ({type(e).__name__}).\n')
        code = 2
    sys.exit(code)
