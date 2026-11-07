# Knowledge

This directory is the project's memory. Everything an agent working on
this repo should not have to relearn from scratch belongs here.

## The convention

- **`notes/`**: internal facts. Decisions, gotchas, runtime facts,
  the small things that always cost time to rediscover ("the CI matrix
  uses Node 22 not 24", "the pnpm store path on this machine is
  non-default", "the local Postgres is on port 5433 not 5432"). Written
  for future agents and future you, not for public readers.
- **`docs/`**: user-facing prose the project might surface elsewhere.
  Design notes the operator wants tidy, sections that might land in a
  README or a spec, prose intended for a wider audience.

## The rules

1. **One topic per file.** The filename is the topic
   (`notes/ci-node-version.md`, not `notes/general.md`). One paragraph
   is enough. An empty file that only carries a pointer to somewhere
   else is fine. A file called `misc.md` or `general.md` is not.
2. **Write on learn.** If this session established a fact the next
   session should not have to rediscover, write it here before the
   session ends.
3. **Grep before asking.** Before asking the stakeholder a question,
   `rg -n '<topic>' rcf/knowledge/` to see whether the answer is
   already here.

## `INDEX.md`

`INDEX.md` is a human table of contents. Add a bullet when you add a
file. Keep it grouped by area if it grows. Nobody scans it
programmatically in v1; it is for the person landing on the repo cold.

## What this is not

This is not a knowledge graph. There is no CLI verb, no indexer, no
vector search. If a project needs one, that is a v2 decision, not a v1
default. The convention above is deliberately cheap. The value is in
the discipline of using it.
