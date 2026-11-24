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

## 2026-11-24: Google for Jobs through a JSearch key from OpenWeb Ninja

**Asked for:** Sloan: "RapidAPI isn't working right, it gives me an error when I try to setup and account. We need
another options". And, a little later: "I found OpenWeb Ninja has JSearch. I've got an API key now".

**Changed** ([decisions/0019](decisions/0019-jsearch-is-read-from-its-maker-first.md),
[job-sources.md](job-sources.md#google-for-jobs-the-key-and-what-a-search-costs)):

- A new setting, `OPENWEBNINJA_API_KEY`, reads Google for Jobs through JSearch at its maker's own address
  (`api.openwebninja.com`), with the key in the `x-api-key` header. No RapidAPI account is needed.
- The RapidAPI key (`JSEARCH_API_KEY`) and SerpAPI (`SERPAPI_KEY`) still work. When more than one is set, the
  server uses the first of the three, in that order, and `/api/health` says which.
- JSearch is now one piece of code with two doors. Both ask `/search-v2`, the search the service lists today.
- A search that is turned down says what the service said and which setting to look at, for a key that is not
  accepted (401, 403) and for a used-up plan (429). The key is never part of that sentence.
- `GOOGLE_JOBS_PAGES` sets how many pages of ten a search asks for. It stays at two. Every page is one request of
  the plan, and the free plan stops at 200 a month.
- [job-sources.md](job-sources.md#getting-an-openweb-ninja-key) has the steps to get a key, what a search costs,
  and what each failure message means. `server/.env.example` names the new settings.
- `JobQuery.page` is gone. Only the old JSearch code read it.
- Tests: `src/jobs/adapters/googleJobs.test.ts` is new, and a thirteenth stored answer,
  `test/fixtures/sources/openwebninja.json`, is replayed like the others.

**Found on the way:**

- **SerpAPI was already supported.** The first idea was to add it. It was in the code from the first build, so
  nothing had to be added to have a second service.
- **The RapidAPI route asked for a search that JSearch no longer lists** (`/search`, with `page` and
  `remote_jobs_only`, answered with a bare list). It moved to `/search-v2` with the new route. Nobody had run it
  with a key, so nobody had seen it fail.
- **Two postings could get the same id** when they came through SerpAPI. Its ids are long, encoded text that
  begins with the job's title, and they were cut off at 120 characters. To the results list such a pair would be
  one posting: choosing the second shows the first. This was found by reading the code, not seen in use. Long ids
  are now cut and closed with a checksum of the whole id. JSearch's newer answers have long ids as well, next to
  a short one that is used when it is there.
- **The cloud machine this was written on cannot reach the job services**, so nothing here ran against the real
  one. The service's published description was read through the browser on Sloan's computer, and one request
  without a key was sent to see how it refuses.

**Left open:**

- The new route has never run with a key. Its first run is on the laptop
  ([status.md](status.md#waiting-on-sloan), row 1). The same goes for the RapidAPI route after its move.
- What JSearch answers when the free allowance is used up is not documented and was not seen.
- A search does not move on to another service when the one in use refuses. That is on purpose
  ([0019](decisions/0019-jsearch-is-read-from-its-maker-first.md)) and is Sloan's to change.
- Nothing limits how many requests one search may use ([status.md](status.md#known-gaps)).

## 2026-11-24: Search options as fields and lists, in place of pills

**Asked for:** Sloan: "I don't like having a shit done of pills you can toggle on and off for the search options,
it should be a more clean and organized UI that doesn't just look like a big cluster of labels".

**Changed** ([decisions/0018](decisions/0018-search-options-are-fields-and-lists-not-pills.md)):

- **The search box.** The filters are four fields in one row, each with its name over it: Location, Within,
  Workplace, Posted. Workplace was three buttons to press in and out. It is one field now, which says what is
  chosen ("Any", "Remote, Hybrid") and opens a list to tick.
- **The settings behind the gear.** Four sections that fold away: Job boards, Companies and industries, Direct site
  access, Search server. Each heading says what is chosen inside ("9 of 14 selected", "2 companies, 1 industry",
  "Off", "Connected"), and warns there when no search server is set. Only the job boards are unfolded on a first
  visit, and the panel opens the way it was left. The chosen companies are a list with one row each, where they
  were chips. The industries are a list to tick, where they were buttons to press in and out.
- **After a search.** The row of one pill per source is one line: "9 of 12 sources answered · 1 failed · 1
  blocked · 1 off". Pressing it opens a table with a row for each source: what went wrong and why at the top, then
  how many jobs each one found.
- **What a search does is the same.** The same filters and settings, stored the same way, so nothing saved in a
  browser is lost. One thing more is kept there: which sections of the settings are unfolded.
- **For the code:** the controls the pages share are in `src/ui/controls.tsx`. The browser test now sets a filter
  and opens the table of sources.

**Found on the way:**

- The results list said "1 jobs" for a single job. It was a known gap in [status.md](status.md). It says "1 job"
  now, with a test.
- While this was built, a new style named `.field` met the resume page's `.field`, and the filters lay over each
  other. Nothing but a browser showed it, because the component tests do not load the stylesheet. The style was
  renamed before anything landed, and the browser test now presses the filters, which a browser refuses when
  something lies over them.

**Left open:** nothing from this request.

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
