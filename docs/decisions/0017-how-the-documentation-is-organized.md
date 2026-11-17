# 0017. How the documentation is organized

- **Status:** Accepted
- **Date:** 2026-11-17
- **Decided by:** Claude, on Sloan's instruction: "Let's make sure we have documentation to track our work and the
  design decisions. The documentation should be organized so it is best for agentic work."

## Context

Most work here is done by AI agents, each in a session of its own that remembers nothing of the ones before.
Whatever is not written in the repository is lost between sessions, and Sloan has to say it again. An agent reads
what it is pointed at and little else, and it believes what it reads, so a stale doc does more harm than a missing
one. Before this there were good topic docs, but no entry point, no record of why things are the way they are, and
no record of what was done and what was left.

## Decision

- **One entry point.** `AGENTS.md` at the root holds the rules, a map, the commands, what "done" means and where
  to read more. `CLAUDE.md` loads it. It is read at the start of every session, so it stays short, and details
  live elsewhere.
- **One home for each fact.** `docs/README.md` lists every doc and what it is the source of truth for. Other
  places link to it and do not copy it.
- **Four kinds of doc, kept apart:**
  - *Reference*: how a part works now. Changed together with the code.
  - *Plan*: what is intended. Says clearly what is built and what is not.
  - *Record*: one decision per file in `docs/decisions/`, numbered, with who decided. Never rewritten. A changed
    decision gets a new record, and the old one is marked as replaced. Only its pointers are kept alive: links,
    and the paths under "In the code".
  - *Log and state*: `docs/worklog.md` is a dated log, newest first, that is only added to. `docs/status.md` is
    the current state and is rewritten: what is built, what is next, what waits on Sloan, known gaps.
- **Docs are part of the change.** A change is not done until the docs are true again, in the same commit.
- **Docs are tested.** A test fails when a link, a file path or a command in the docs points at nothing, or when
  a decision record is missing from the index. History is checked for dead links only: a log entry and the body
  of a record may name a file as it was on their day.
- **Plain words.** Sloan reads these too. Short sentences, no jargon that is not explained.

## Consequences

- A new session can start from `AGENTS.md`, `status.md` and the top of the work log, without Sloan retelling
  anything.
- Every change costs a few minutes of writing. Skipping it shifts the cost to the next session, with interest.
- The entry point has to be defended against growth. When it passes about 120 lines, move something out.
- Who decided is written on every record, so an agent can tell a choice Sloan made (ask before changing it) from
  a default an agent picked (change it with a new record when there is a reason).

## In the code

- `AGENTS.md`, `CLAUDE.md`, `docs/README.md`, `docs/decisions/`, `docs/worklog.md`, `docs/status.md`.
- `test/docs/docs.test.ts`.
