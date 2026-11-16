"""Squire's one job command. Every big job (deep research, building an app,
building a site, video and audio work) starts through it, run by the session
as this one command, its path quoted as the health check's is:

    /usr/bin/python3 '<Squire home>/core/tools/heavy-job.py' research|app|site|media

The safety floor asks the owner before every start, and a second time above
90% usage; spelt any other way, the start is refused. Let through, it says
the job has started on the owner's yes, and exits 0. The jobs' own tools,
built later, run only within a start the owner said yes to.
"""

import os
import sys

CORE = os.path.dirname(os.path.dirname(os.path.realpath(__file__)))
sys.path.insert(0, os.path.join(CORE, 'lib'))

from squire import HEAVY_JOBS  # noqa: E402


def main(argv):
    if len(argv) != 1 or argv[0] not in HEAVY_JOBS:
        sys.stderr.write('give the kind of big job: research, app, site or media\n')
        return 2
    print(f'The big job has started on the owner\'s yes: {HEAVY_JOBS[argv[0]]}.')
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
