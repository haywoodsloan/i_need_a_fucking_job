# Work log

What was done and why, newest first. One entry for each piece of work that landed on `main`.

- **Add an entry at the top**, in the commit that lands the work. Use the shape below.
- **Do not rewrite an old entry.** If one turns out to be wrong, add a line to it that starts with
  "Correction (date):".
- **This is the past.** What is true today is in [status.md](status.md). What was chosen and why is in
  [decisions/](decisions/README.md). An entry links to those and does not repeat them.
- Dates are UTC, like the decision records.

The shape of an entry:

```
## YYYY-MM-DD: What changed, in a few words

**Asked for:** who asked for what, in their own words where the words matter.
**Changed:** what is different now, for someone using the app and for someone working on the code.
**Found on the way:** bugs and surprises. Leave the line out when there were none.
**Left open:** what was not done. Each item is also in status.md.
**Commits:** short hashes, when the entry is written after them.
```

## 2026-11-17: Tests at every layer, and documentation written for agents

**Asked for:** Sloan: "Let's make sure we have documentation to track our work and the design decisions. The
documentation should be organized so it is best for agentic work. Also, on the code side we need to have testing so
we avoid bugs and regression. Consider the best practices for testing when building the testing suite."

**Changed, tests** ([testing.md](testing.md), [decisions/0016](decisions/0016-how-the-code-is-tested.md)):

- The suite went from 394 tests in 10 files to 909 tests in 40 files, in three layers: unit, component (pages in
  a simulated browser) and integration (the server over real HTTP, the admin command and the server as real
  processes, real PDF and Word files). A fourth layer takes five journeys through the built app in a real
  browser. All of it runs in about 20 seconds, the browser part in 10 more.
- A guard fails any test that reaches for the live network. Job sources are tested against recorded answers
  (`test/fixtures/sources/`), one per source, and `npm run fixtures:record` records new ones.
- Property tests make up inputs by the hundred for the resume parser, the sanitizer and the merging of jobs.
- Coverage is measured and has a floor: 94% of lines overall, and every line in the account code that handles
  passwords and keys, in the sanitizer and in the resume model.
- CI checks every push on every branch, on Linux and on Windows, and now runs the browser tests too. The demo
  deploys only when both systems pass.
- New commands: `npm run check` (what to run before a push), `npm run test:unit`, `npm run test:integration`,
  `npm run test:coverage`, `npm run test:e2e`, `npm run typecheck`, `npm run fixtures:record`.
- To make the server testable, request handling moved out of `server/src/index.ts` into `createApp` in
  `server/src/app.ts`. `index.ts` is now only the process: settings, the port, shutdown.
- Tests moved: `test/*.test.ts` to `test/server/` and `test/integration/`, the sample resume to
  `test/fixtures/resumes/`.
- `.gitattributes` keeps line endings the same on Windows and Linux.
- Vitest 5 needs Node 22.12 or newer.

**Changed, documentation** ([decisions/0017](decisions/0017-how-the-documentation-is-organized.md)):

- `AGENTS.md` at the root is the entry point: the rules, a map, the commands, what "done" means. `CLAUDE.md`
  loads it.
- [decisions/](decisions/README.md) holds 17 records of what was decided so far and who decided it, taken from
  the project chat, the commits and the code.
- New: [architecture.md](architecture.md), [testing.md](testing.md), [status.md](status.md), this log, and
  [README.md](README.md) as the index of the docs.
- `test/docs/docs.test.ts` fails when a link, a path or a command in the docs points at nothing.

**Found on the way** (each fixed, with a test that fails without the fix):

- **PDF resumes:** a line that began with blank space and then a wide gap was joined to the line above it, so
  two fields could run together. A property test found it (`buildPdfSource` in `src/resume/extract.ts`).
- **Word resumes:** a table row such as "Data Analyst | Mar 2020 – Present" was read as one line per cell,
  because the Word reader wraps each cell in a paragraph. A test with a real Word file found it
  (`docxHtmlToText`).
- **Search server:** a search with a body that is not JSON was answered 500 and is now 400. A body that is too
  large is now 413. The table behind the search limit grew without bound and is now capped at 5000 addresses.
  The company lookup kept one memory for the whole process and now keeps one per server.
- **CI:** the first run passed on Windows and failed on Linux before the browser tests could start. GitHub's
  "latest" Ubuntu had moved to a release that the pinned Playwright has no browser for. The Linux job is now
  pinned to Ubuntu 24.04, the system the server's Docker image is built on.

**Left open:** the gaps found and not fixed are listed in [status.md](status.md#known-gaps). The recordings of
job sources are hand-typed until someone records real ones on the laptop.

**Commits:** 4f5e535 (the server), db8cba3 (the tests), 927662e (the docs), and one after it that pins the Linux
job in CI.

## 2026-11-17: Accounts and sign-in (step 0 of the plan)

*Written afterwards from the commits and the project chat.*

**Asked for:** Sloan answered "Yep go ahead" to building accounts, the first step of
[applications-plan.md](applications-plan.md#15-build-order).

**Changed:**

- Invite-only accounts on the server: passwords, sessions, recovery codes, admin reset links, deleting an
  account, an audit log, and the keys the login vault will use. Off until `npm run admin -- setup <email>` has
  been run ([accounts.md](accounts.md)).
- Pages to sign in, accept an invite, reset and recover, and an account page.
- The server can serve the built app itself under a strict content security policy (`npm run local:built`).
- The sanitizer for job descriptions got 92 attack tests, and now drops SVG and MathML whole.
- Decisions: [0010](decisions/0010-sign-in-is-built-here-not-bought.md) to
  [0015](decisions/0015-job-html-is-sanitized-and-the-app-runs-under-a-strict-policy.md).

**Left open:** not tried on Windows by a person, and the breached-password lookup has only met a stand-in.

**Commits:** 7b89721, c520fea, 58f9525, 14610ea, 89f37e3.

## 2026-11-17: LinkedIn and Indeed logins wait

*Written afterwards from the commits and the project chat.*

**Asked for:** the plan asked Sloan whether the first version should log in to LinkedIn and Indeed from the
server. Sloan chose "Not yet, employer systems first".

**Changed:** the plan records the decision and was brought in line with the fetch pipeline
([decisions/0009](decisions/0009-linkedin-and-indeed-logins-wait.md)).

**Commits:** e3e60c1.

## 2026-11-16: The fetch layer becomes a pipeline of tiers

*Written afterwards from the commits and the project chat.*

**Asked for:** Sloan proposed fetching in tiers, cheapest first. Getting past a site's bot check came up too. The
tiers were built. Nothing here gets past a bot check, and there is a plug-in point where Sloan can put tiers of
their own ([decisions/0006](decisions/0006-job-sources-are-reached-through-a-pipeline-of-tiers.md),
[0007](decisions/0007-no-bot-check-bypass.md)).

**Changed:** requests go through cache, plain HTTP, an optional standard browser (`ENABLE_BROWSER_TIER`), then any
tiers loaded from `FETCH_TIERS_MODULE`. A source that every tier was turned away from is reported as blocked
([fetch-tiers.md](fetch-tiers.md)).

**Commits:** c3e8397.

## 2026-11-16: The plan for accounts, site logins and application tracking

*Written afterwards from the commits and the project chat.*

**Asked for:** Sloan asked for stored site logins that the server can only read while the user is signed in, no
background checks, an easy way to the real site, Claude for resume breakdown and for new job boards, and a cheap
home for a lighter model.

**Changed:** [applications-plan.md](applications-plan.md) was written: a proposal with seven decisions for Sloan
and a build order. Nothing in it was built at that point.

**Commits:** 3427092.

## 2026-11-16: A fetch layer for the server, and one command to run everything

*Written afterwards from the commits and the project chat.*

**Asked for:** Sloan asked to host and try the app on the laptop.

**Changed:** every request the server makes goes through `server/src/fetcher.ts`: answers are cached, requests
are spaced out per site, dropped connections are retried, and a bot check is reported and not retried.
`npm run local` starts the server and the app together
([decisions/0005](decisions/0005-a-static-app-plus-one-server-run-on-the-laptop-first.md)).

**Commits:** 5148c55.

## 2026-11-16: Job sources fixed against the live services

*Written afterwards from the commits and the project chat.*

**Changed:** every source was run from a home connection and fixed where the real answers differed from what the
code expected: Ashby, Workday, Amazon Jobs, SmartRecruiters, LinkedIn's public pages, and the catalog of companies.
The server loads `server/.env` by itself. `npm run smoke` and `npm run check:catalog` in `server/` check the
sources and the catalog against the live sites. What was learned is in [job-sources.md](job-sources.md).

**Left open:** Google for Jobs and USAJOBS were not run, for lack of keys.

**Commits:** d4e5ea0.

## 2026-11-16: First build: job search and the resume analyzer

*Written afterwards from the commits and the project chat.*

**Asked for:** Sloan asked for a job search across many boards behind one search bar, postings readable inside
the app, and a resume read into fields that are the user's own words
([decisions/0001](decisions/0001-applications-use-the-users-own-words.md),
[0002](decisions/0002-the-search-page-is-one-bar-with-sources-behind-a-gear.md),
[0003](decisions/0003-everything-happens-inside-the-app.md)).

**Changed:** the static app (search page, settings, resume upload and review) and the search server with its
first sources. Work goes straight to `main`
([decisions/0004](decisions/0004-work-lands-on-main-without-pull-requests.md)).

**Commits:** 8dc3b7f, efd4770.
