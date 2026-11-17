# 0016. How the code is tested

- **Status:** Accepted
- **Date:** 2026-11-17
- **Decided by:** Claude, on Sloan's instruction: "we need to have testing so we avoid bugs and regression.
  Consider the best practices for testing when building the testing suite."

## Context

Work goes straight to `main` with no review ([0004](0004-work-lands-on-main-without-pull-requests.md)), and most
of it is done by AI agents that cannot open the app and look. So the tests are the only thing between a mistake
and the live site. Before this, there were tests for the parsers, the sources' sample payloads, the fetch layer and
accounts. Nothing tested the pages, the server over HTTP, a source from request to posting, or anything on
Windows, and nothing ran in a browser.

## Decision

1. **Test at the lowest layer that can show the behaviour**, and have every layer:
   unit (logic) → component (a page in a simulated browser) → integration (real sockets, files and processes on
   this machine) → browser (the built app in a real browser, a handful of journeys).
2. **No test touches the live network.** A guard fails any test that tries. Job sources are tested by replaying
   recorded answers through the same `fetch` slot the server fills, so the source's real code runs end to end.
3. **Fake only the edges:** the network, the clock, and chance. Everything inside is real: a real database (in
   memory), real cryptography, the real parser, the real sanitizer. A page is tested by faking the server at
   `fetch`, never by replacing the app's own modules.
4. **Rules that must hold for any input get property tests**, which make up thousands of inputs: the verbatim
   rule, the sanitizer, the merging of postings.
5. **A bug fix starts with a test that fails without it.**
6. **Tests are repeatable.** Clocks are faked and nothing sleeps. A test may not depend on another test, on the
   time zone, or on what is on the machine.
7. **Coverage is a floor, not a goal.** The build fails when coverage drops under a minimum set just below what
   the suite reaches, and the files that guard passwords, the sanitizer and the verbatim rule must have every
   line run by a test.
8. **Every push is checked on Linux and Windows**, and the demo is only deployed when all of it passed.

One runner, Vitest, runs it all. Where a test goes and how to write one is in [testing.md](../testing.md).

## Consequences

- `npm test` takes about 20 seconds, so it can be run before every push. The browser tests take 10 more and need
  a browser.
- Vitest 5 needs Node 22.12 or newer.
- Recorded answers go stale when a job site changes, and a hand-written one cannot notice at all. Checking against
  the live sites stays a job for the laptop: `npm run fixtures:record` and `npm run smoke --prefix server`.
- Some things are knowingly not tested. They are listed in [testing.md](../testing.md#what-is-not-tested), so that
  nobody takes a green run for more than it is.
- The first run of this suite found two bugs in reading resumes that had been there since the first build
  ([worklog.md](../worklog.md)). That is the argument for keeping it.

## In the code

- `vitest.config.ts` (the layers, the coverage floor), `vitest.e2e.config.ts`, `test/setup/network.ts` (the guard).
- `test/helpers/` (cassettes, the test server, real resume files), `src/testing/` (the fake server for pages).
- `.github/workflows/ci.yml`.
