# Status

**Last updated: 2026-11-25.**

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
| Application tracker | On a person's own computer, the app's server keeps every application as a file: the job, the stage, the address of the form, and every question of the form with what goes in it and who wrote that. The Applications page shows what is left for the user. An assistant that prepares applications works on the same records. A restart of the app or the computer loses nothing. This is step 1 of the plan, for a person's own computer. | [applications.md](applications.md) |
| Who reaches the server | Left alone, the server answers the computer it runs on and no other. A hosted copy says with `HOST=0.0.0.0` that other computers reach it. | [applications.md](applications.md#the-server-answers-this-computer-only) |
| The served app | The server can serve the built app from its own address, under a strict content security policy. | [accounts.md](accounts.md#the-app-served-by-the-server) |
| Tests | Unit, component, integration and browser tests, with a coverage minimum. Checked on Linux and Windows on every push. | [testing.md](testing.md) |
| Demo | A static copy on GitHub Pages, deployed from `main` when the checks pass. No server is hosted yet, so search there reaches only the sources a browser may call. | [architecture.md](architecture.md#three-ways-it-runs) |

## Not built

- **The rest of the tracker:** filling in a job from a pasted link, importing a spreadsheet or another tracker's
  export, checking whether a posting is still listed, and keeping applications in an account, which a hosted copy
  needs ([what step 1 built and what it left](applications-plan.md#70-as-built-in-step-1)).
- **The login vault, and applying through employer systems** from inside the app: steps 2 and 3 of
  [applications-plan.md](applications-plan.md#15-build-order). Today an assistant outside the app fills the forms,
  up to Submit, and the user submits.
- **Hosting for friends**, with accounts: step 4.
- **Claude** for breaking down and reviewing a resume and for finding job boards: step A.
- **Dayforce and iCIMS** as job sources. Their feeds differ per employer and need research against the live sites.
- **Interview prep and a resume builder.** The README names them as goals. Nothing is planned in detail.

## Next

From the plan's [build order](applications-plan.md#15-build-order):

1. **The tracker on Sloan's computer.** It is built and has not run there yet. A session updates the app there,
   brings in the applications that were prepared before the tracker existed, and tries a restart
   ([applications.md](applications.md#after-a-restart)).
2. **Step 2: the vault and assisted apply,** Greenhouse first. Needs decision 2 below, and decision 6 for the
   first drafts an assistant wrote: whether the app may send them, and how they are labelled.
3. **Step A, in parallel:** Claude for resume breakdown and review. Needs decisions 5, 6 and 7, and an API key.

Work that needs no decision and can be picked up any time is under [Known gaps](#known-gaps).

## Waiting on Sloan

Only Sloan can settle these. An agent that needs one of them asks. It does not guess, and it does not build past
the question.

| # | What | Why it matters | Recommended |
| --- | --- | --- | --- |
| 1 | **Get a USAJOBS key, and say what should happen when the free Google for Jobs requests run out.** The JSearch key from OpenWeb Ninja is in `server/.env` on Sloan's computer and works since 2026-11-24. Its free plan stops at 200 requests a month, and a search uses up to 2 ([what a search costs](job-sources.md#what-a-search-costs)). | USAJOBS has never run against the real service. When the 200 are used up, listings from LinkedIn, Indeed, Glassdoor and ZipRecruiter stop arriving until the next month, and every other source carries on. | The USAJOBS key is free. For JSearch, `GOOGLE_JOBS_PAGES=1` halves what a search uses and costs nothing. A paid plan is Sloan's call. |
| 2 | **Decisions 2 to 7 of the plan** ([the table](applications-plan.md#2-decisions-for-sloan)): who presses Submit, a domain, forgotten passwords and stored logins, whether data may leave the browser, whether AI may suggest wording, hosting a small model. Decision 5 is made in part: applications are kept on a person's own computer ([0020](decisions/0020-applications-are-kept-by-the-server-on-its-own-computer.md)). Open from it: records in an account on a hosted copy, and resume text to the Claude API. | Step 2 needs 2 and 6. Step 4 needs 3 and the rest of 5. Step A needs 5, 6 and 7. Step 0 was built on the recommended answer to 4. | The default written next to each one in the plan |
| 3 | **Delete the old Indeed route?** `server/src/indeed.ts` loads Indeed in a browser that hides that it is automated. | It goes against rule 2 ([0007](decisions/0007-no-bot-check-bypass.md)). It is off unless `ENABLE_PLAYWRIGHT` is set, and nothing tests it. | Delete it, and the "Direct site access" wording for Indeed with it. Indeed listings still arrive through Google for Jobs. |
| 4 | **Try accounts on Sloan's computer:** `git pull`, both installs, then `npm run admin -- setup you@example.com` | The account tests pass on Windows in CI, but nobody has used sign-in on a real Windows machine yet. | |
| 5 | **Record real answers from the job sites** on Sloan's computer: `npm run fixtures:record`, read the diff, commit | Every recording the tests replay was typed by hand ([testing.md](testing.md#recorded-answers-from-job-sources)). Real ones would catch a site that changed. | The Google for Jobs key is in, so this can be done now. It uses 2 of the month's requests. USAJOBS is skipped until it has a key, and can be recorded then. |
| 6 | **Run the browser tests on Sloan's computer** with Edge: `$env:BROWSER_CHANNEL='msedge'; npm run test:e2e` | They pass in CI on Windows with Playwright's Chromium. Edge is already on a Windows machine and needs no download. | |
| 7 | **Say so if another device at home should reach the app.** The server now answers Sloan's computer only. Sloan was asked on 2026-11-24 whether it should, and had not answered when the tracker needed it ([0022](decisions/0022-the-server-answers-its-own-computer-unless-told-otherwise.md)). | Before, any device on the same network could run searches, which spend the month's requests. Opening the server again takes one setting, `HOST=0.0.0.0`, and a server that is open keeps no applications. | Leave it closed. |

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
- Workday turned the server away as automated traffic in the first search from Sloan's desktop, on 2026-11-24:
  all eight catalog companies on Workday, each with a 429. They answered on 2026-11-16. Nobody has looked into
  why, or into whether it happens on every search. Rule 2 stands whatever the reason: a bot check is reported and
  not worked around ([what was seen live](job-sources.md#verification-status)).

**Resume** (`src/resume/`)

- `parsePartialDate` reads any word that starts like a month as that month ("Marketing 2020" as March). The
  parser only hands it text that already matched a date, so nothing wrong reaches a person today.
- Two-column PDFs, scanned PDFs and old `.doc` files: see [resume-model.md](resume-model.md#known-limits).

**Accounts**

- See [accounts.md](accounts.md#known-limits). The ones to fix before hosting: `connect-src` allows any HTTPS
  address, `TRUST_PROXY` for the host is not worked out, and a reset link must delete stored logins once the vault
  holds any.

**Applications**

- See [applications.md](applications.md#known-limits). The ones that matter most: the folder is not encrypted,
  any program on the computer can reach the tracker, and a hosted copy has none.
- The folder is read whole for every request. That is what makes a file corrected by hand count at once, and it
  is quick for the few dozen applications of one job hunt. It was not measured with hundreds.
- The page shows who wrote an answer as it is now. The versions before a change are kept in the folder, and no
  page shows them.

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

- The tracker on Sloan's computer. It ran on a Linux machine in the cloud with real applications imported, and
  its tests pass on Windows in CI. Not tried yet: the app on Windows with those applications in it, and a restart
  of the computer in between.
- Sign-in on Windows by a person (row 4 above).
- The breached-password lookup against the real service. To check: try to create an account with
  `password1234567`. It should be refused.
- The fixture recorder against the live job sites (row 5 above).
- Google for Jobs through a RapidAPI key and through SerpAPI, and USAJOBS (row 1 above). JSearch with a key
  from OpenWeb Ninja has run: its first search, on 2026-11-24, brought 20 postings. What JSearch answers when a
  plan's requests run out has still not been seen
  ([job-sources.md](job-sources.md#when-google-for-jobs-does-not-answer)).
- The whole app on Node 24. Sloan's desktop has Node 24 and has run the search server since 2026-11-24. CI
  checks Node 22 only, and `npm run smoke --prefix server` has not been run on the desktop yet.
- The points in [applications-plan.md](applications-plan.md#16-to-confirm-on-live-sites), section 16.
