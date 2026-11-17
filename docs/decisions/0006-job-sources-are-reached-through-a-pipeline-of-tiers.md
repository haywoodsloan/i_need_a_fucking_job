# 0006. Job sources are reached through a pipeline of tiers

- **Status:** Accepted
- **Date:** 2026-11-16
- **Decided by:** Sloan proposed the approach. Claude designed and built it.

## Context

Job sources fail in different ways: some answer a plain request, some only render with JavaScript, some turn
automated clients away. Sloan pointed at tools that use a multi-level approach, solving simple cases fast and
keeping the heavy tooling for when the easy options fail, and asked for the same on the backend.

## Decision

Every request the server makes to a job source goes through one pipeline of tiers, cheapest first. A request moves
to the next tier only when the one before it could not answer.

1. `cache`: a fresh copy of the same request. No network.
2. `http`: a plain request, spaced out per site, retried with backoff when the site is briefly unavailable.
3. `browser` (off unless `ENABLE_BROWSER_TIER` is set): a standard headless browser, for pages that need
   JavaScript.
4. Your own tiers (off unless `FETCH_TIERS_MODULE` is set): a plug-in point.

A tier answers, fails or passes. An error status from the site is an answer. The full rules are in
[fetch-tiers.md](../fetch-tiers.md). What a tier may not do is in [0007](0007-no-bot-check-bypass.md).

## Consequences

- A source never calls the global `fetch`. It gets a `fetch` in its context (`AdapterContext`), and on the server
  that is the pipeline. So pacing, caching and blocked reporting apply to every source without it knowing.
- The same slot is how tests work: a test hands a source a `fetch` that replays recorded answers
  ([testing.md](../testing.md#recorded-answers-from-job-sources)).
- `/api/health` and the smoke test show which tiers are on and what each has answered.
- A new way of reaching sites is a new tier, not a change to every source.

## In the code

- `server/src/fetcher.ts` (the pipeline, the cache and the `http` tier), `server/src/tiers.ts` (putting it
  together from the settings), `server/src/browser.ts` (the browser tier), `server/tiers.example.mjs`.
- `test/server/fetcher.test.ts` and `test/server/pipeline.test.ts`.
