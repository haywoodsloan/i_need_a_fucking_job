# Status

**Last updated: 2026-11-24.**

Where the project stands: what works, what comes next, what only Sloan can settle, and what is known to be wrong or
unchecked. This file is rewritten whenever one of those changes, so it is always about today. What happened and
when is in [worklog.md](worklog.md). Why things are the way they are is in [decisions/](decisions/README.md).

Contents: [Built](#built) · [Not built](#not-built) · [Next](#next) · [Waiting on Sloan](#waiting-on-sloan) ·
[Known gaps](#known-gaps) · [Not yet tried on a real machine](#not-yet-tried-on-a-real-machine)

## Built

| Part | What works | Read |
| --- | --- | --- |
| Job search | One search bar over many sources: Google for Jobs (needs a key), employer hiring systems (Greenhouse, Lever, Ashby, SmartRecruiters, Workday, Amazon Jobs), USAJOBS (needs a key), LinkedIn's public pages (off unless switched on), Remote OK and Remotive. Duplicates are merged into one posting. A posting is read inside the app. | [job-sources.md](job-sources.md) |
| Reaching job sources | Every request the server makes goes through one pipeline: cache, plain HTTP, an optional browser, and a place to plug in more. A bot check is reported as blocked. | [fetch-tiers.md](fetch-tiers.md) |
| Resume | PDF, Word and text files are read in the browser, by rules, into fields that are exact slices of the file. A review screen shows the file and the fields side by side. Stored in the browser only. | [resume-model.md](resume-model.md) |
| Accounts | Invite-only sign-in, sessions, recovery codes and admin commands. Off until set up. This is step 0 of the plan. | [accounts.md](accounts.md) |
| The served app | The server can serve the built app from its own address, under a strict content security policy. | [accounts.md](accounts.md#the-app-served-by-the-server) |
| Tests | Unit, component, integration and browser tests, with a coverage minimum. Checked on Linux and Windows on every push. | [testing.md](testing.md) |
| Demo | A static copy on GitHub Pages, deployed from `main` when the checks pass. No server is hosted yet, so search there reaches only the sources a browser may call. | [architecture.md](architecture.md#three-ways-it-runs) |

## Not built

- **The application tracker**, the login vault, and applying through employer systems: steps 1 to 3 of
  [applications-plan.md](applications-plan.md#15-build-order).
- **Hosting for friends**, with accounts: step 4.
- **Claude** for breaking down and reviewing a resume and for finding job boards: step A.
- **Dayforce and iCIMS** as job sources. Their feeds differ per employer and need research against the live sites.
- **Interview prep and a resume builder.** The README names them as goals. Nothing is planned in detail.

## Next

From the plan's [build order](applications-plan.md#15-build-order):

1. **Step 1: the tracker without logins.** Records, one-click add, paste a link, stages and a timeline, "Open on
   site". It stores application records in the account, so it needs decision 5 below.
2. **Step A, in parallel:** Claude for resume breakdown and review. Needs decisions 5, 6 and 7, and an API key.

Work that needs no decision and can be picked up any time is under [Known gaps](#known-gaps).

## Waiting on Sloan

Only Sloan can settle these. An agent that needs one of them asks. It does not guess, and it does not build past
the question.

| # | What | Why it matters | Recommended |
| --- | --- | --- | --- |
| 1 | **Try the Google for Jobs key on the laptop, and get a USAJOBS key.** Sloan has a JSearch key from OpenWeb Ninja since 2026-11-24. It goes into `server/.env` as `OPENWEBNINJA_API_KEY`. Then `git pull`, start the server again, and run `npm run smoke --prefix server` ([the steps](job-sources.md#getting-an-openweb-ninja-key)). | Without the Google key, listings from LinkedIn, Indeed, Glassdoor and ZipRecruiter mostly do not arrive. The route was written from the service's description and has never run with a key, so this first run is its real test. USAJOBS has never run against the real service either. `server/.env.example` names the settings. | Stay on JSearch's free plan to start: 200 requests a month, up to 2 for a search ([what a search costs](job-sources.md#what-a-search-costs)). The USAJOBS key is free. |
| 2 | **Decisions 2 to 7 of the plan** ([the table](applications-plan.md#2-decisions-for-sloan)): who presses Submit, a domain, forgotten passwords and stored logins, whether data may leave the browser, whether AI may suggest wording, hosting a small model | Step 1 needs decision 5. Step 2 needs 2. Step 4 needs 3. Step A needs 5, 6 and 7. Step 0 was built on the recommended answer to 4. | The default written next to each one in the plan |
| 3 | **Delete the old Indeed route?** `server/src/indeed.ts` loads Indeed in a browser that hides that it is automated. | It goes against rule 2 ([0007](decisions/0007-no-bot-check-bypass.md)). It is off unless `ENABLE_PLAYWRIGHT` is set, and nothing tests it. | Delete it, and the "Direct site access" wording for Indeed with it. Indeed listings still arrive through Google for Jobs. |
| 4 | **Try accounts on the laptop:** `git pull`, both installs, then `npm run admin -- setup you@example.com` | The account tests pass on Windows in CI, but nobody has used sign-in on a real Windows machine yet. | |
| 5 | **Record real answers from the job sites** on the laptop: `npm run fixtures:record`, read the diff, commit | Every recording the tests replay was typed by hand ([testing.md](testing.md#recorded-answers-from-job-sources)). Real ones would catch a site that changed. | Do it once the keys are in, so the keyed sources are recorded too. |
| 6 | **Run the browser tests on the laptop** with Edge: `$env:BROWSER_CHANNEL='msedge'; npm run test:e2e` | They pass in CI on Windows with Playwright's Chromium. Edge on the laptop needs no download. | |

## Known gaps

Things that are wrong, weak or missing, and that nobody has decided to leave that way. Each can be fixed without
asking, with a test first. Take one out of this list in the commit that fixes it.

**Search server** (`server/src/app.ts`, `server/src/discover.ts`)

- The limit on searches believes the `Fly-Client-IP` and `X-Forwarded-For` headers from any caller, so a caller can
  dodge it by making addresses up. The account routes already do this properly with `TRUST_PROXY`
  (`clientAddress` in `server/src/accounts/index.ts`). Search should use the same setting.
- `GET /api/job` answers 500 for a source that is switched off or unknown, and logs it as a fault. It should be
  a 400 or a 404 with a reason.
- Company lookup remembers "not found" for a day, also when the reason was a network failure that has passed. Its
  memory has no size limit.

**Job sources** (`src/jobs/`)

- A Google for Jobs posting that comes through SerpAPI with no apply options and no share link gets an empty web
  address (`src/jobs/adapters/googleJobs.ts`).
- Nothing limits how much of the month's Google for Jobs allowance one search may use. Each chosen company that
  has no feed of its own is a search of its own, and picking an industry adds every such company in it
  ([what a search costs](job-sources.md#what-a-search-costs)). On a plan that stops at 200 requests that adds up
  fast. Those searches also go out side by side, which a plan with a limit per second may refuse.
- `htmlToText` leaves an empty line between the items of a list (`src/jobs/adapters/common.ts`).

**Resume** (`src/resume/`)

- `parsePartialDate` reads any word that starts like a month as that month ("Marketing 2020" as March). The
  parser only hands it text that already matched a date, so nothing wrong reaches a person today.
- Two-column PDFs, scanned PDFs and old `.doc` files: see [resume-model.md](resume-model.md#known-limits).

**Accounts**

- See [accounts.md](accounts.md#known-limits). The ones to fix before hosting: `connect-src` allows any HTTPS
  address, `TRUST_PROXY` for the host is not worked out, and a reset link must delete stored logins once the vault
  holds any.

**Tests**

- All thirteen recordings of job sources are hand-typed (row 5 above).
- [testing.md](testing.md#what-is-not-tested) lists what a green run does not cover.

**Tooling**

- Playwright is held at one exact version in both `package.json` files, to match the image in
  `server/Dockerfile`, and the Linux job in CI is pinned to Ubuntu 24.04 for it
  ([testing.md](testing.md#ci)). Upgrading Playwright means moving all four together.
- CI warns that the GitHub actions it uses (`checkout`, `setup-node` and `upload-artifact` at v4) are built for
  an older Node. They still run. They need moving to their next major versions at some point.
- `npm audit` reports 6 findings rated high in the root project. All six are one weakness in `picomatch`, which
  Vite and Vitest use to match file names: a pattern can be written so that matching takes very long. Those tools
  are only handed the patterns in this repository's own config, and none of it is in the built app or in the
  server. The offered fix would move Vite back a major version, so this waits for a patched release. `server/`
  reports none.

## Not yet tried on a real machine

Built and tested with stand-ins, never yet run for real:

- Sign-in on Windows by a person (row 4 above).
- The breached-password lookup against the real service. To check: try to create an account with
  `password1234567`. It should be refused.
- The fixture recorder against the live job sites (row 5 above).
- Google for Jobs with a real key, through any of its three services, and USAJOBS (row 1 above). What JSearch
  answers when a plan's requests run out has not been seen either
  ([job-sources.md](job-sources.md#when-google-for-jobs-does-not-answer)).
- The points in [applications-plan.md](applications-plan.md#16-to-confirm-on-live-sites), section 16.
