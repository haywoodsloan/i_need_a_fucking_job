# 0004. Work lands on main without pull requests

- **Status:** Accepted
- **Date:** 2026-11-16
- **Decided by:** Sloan

## Context

The first build went through a pull request. Sloan then said: "I don't want to worry about PRs for now, let's just
keep things updating live on main."

## Decision

Work is committed to `main` directly. There are no pull requests and no review step.

It is "for now". It is worth asking Sloan again when someone else starts contributing.

## Consequences

- A push to `main` deploys the public demo, so nothing stands between a mistake and the live site except the
  checks. Run `npm run check` before pushing. CI runs the same checks after the push, on Linux and Windows, and
  only deploys when they pass.
- With no reviewer, the tests are the review. That is a large part of why the test suite is as wide as it is
  ([0016](0016-how-the-code-is-tested.md)).
- If the tool you work with makes you use a branch, push the branch, wait for CI to pass on it, then move `main`
  forward to the same commit. Still no pull request.
- Commit messages carry the history that pull requests would have: say what changed and why, in plain words.

## In the code

- `.github/workflows/ci.yml` checks every push on any branch, and deploys only from `main`.
