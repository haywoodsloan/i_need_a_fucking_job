# Architecture

How the parts fit together: where the code is, what happens during a search, a resume upload, a sign-in and the
work on an application, what is stored where, and what must stay true. Why it is built this way is in
[decisions/](decisions/README.md).

Contents: [The picture](#the-picture) · [Three ways it runs](#three-ways-it-runs) · [The code](#the-code) ·
[What happens when](#what-happens-when) · [What is stored where](#what-is-stored-where) ·
[What must stay true](#what-must-stay-true) · [Settings](#settings)

## The picture

```
┌──────────────────────────── the browser ─────────────────────────────┐
│  React app (src/)                                                    │
│                                                                      │
│  Find jobs    ──► src/jobs/client.ts ───────────────────┐            │
│  My resume    ──► src/resume/  read, parse, review      │            │
│                   └► localStorage + IndexedDB           │            │
│                      (the resume never leaves here)     │            │
│  Applications ──► src/apply/client.ts ──────────┐       │            │
│  Account      ──► src/account/client.ts ────────┤       │            │
└─────────────────────────────────────────────────┼───────┼────────────┘
          same address, with a cookie for accounts│       │ POST /api/search
                                                  │       │ GET  /api/job
┌─────────────────────────────────────────────────▼───────▼────────────┐
│  the server (server/src/), one Node process                          │
│                                                                      │
│  app.ts ─┬─► accounts/ ──► db/ ──► PGlite files in server/.data/     │
│          │                                                           │
│          ├─► applications/ ──► one file each in server/.data/        │
│          │     ▲                                                     │
│          │     └─ an assistant on the same computer, same routes     │
│          │                                                           │
│          ├─► src/jobs/aggregate.ts   plan, run sources, merge        │
│          │     └► src/jobs/adapters/*  one per kind of source        │
│          │          └► fetcher.ts  cache → http → browser → yours    │
│          │                                                           │
│          └─► static.ts   the built app, under strict headers         │
└──────────────────────────────────────────────────────────┬───────────┘
                                                           ▼
                           Google for Jobs API, hiring systems' feeds,
                           USAJOBS, remote job boards, LinkedIn pages
```

Three things in this picture are unusual and matter for every change:

- **`src/jobs/` is used by both halves.** The server imports it straight from `../../src/jobs/`. With no server,
  the browser runs the same code itself and reaches the few sources that accept calls from a browser. The rules of
  a tracked application, in `src/apply/`, are shared the same way.
- **The resume has no arrow to the server.** It is read, stored and reviewed in the browser only.
- **The applications have two kinds of callers.** The user works on them on the app's page. An assistant, an AI
  agent that prepares applications for the user outside the app, calls the same routes from the same computer.
  The tracker has no sign-in, so it exists only where nobody else can reach the server
  ([applications.md](applications.md#where-the-tracker-is-on)).

## Three ways it runs

A change has to work in all three.

| | Public demo | On Sloan's computer | Served by the server |
| --- | --- | --- | --- |
| Started by | CI, on a push to `main` | `npm run local` | `npm run local:built`, and a hosted copy later |
| The app comes from | GitHub Pages (static files) | Vite's dev server, port 5173 | The server itself, port 8787, with the security headers |
| A search goes to | The server named when the app was built (`VITE_API_URL`) or in the app's settings. With none: straight from the browser. | The server on port 8787 | The page's own address |
| Accounts | Never. The app does not even ask. | When set up. Vite passes the account routes on to the server, so the cookie belongs to the page's address. | When set up |
| Applications | Never. The app does not even ask. | Kept, in a folder on that computer. Vite passes the tracker's routes on to the server as well. | Kept with `npm run local:built`. A hosted copy keeps none: other computers can reach it, and the tracker has no sign-in. |

`src/jobs/client.ts` decides where a search goes. `src/account/client.ts` decides whether the app looks for
accounts at all (`ACCOUNTS_ENABLED`), and `src/apply/client.ts` whether it looks for a tracker (`TRACKER_ENABLED`).

Left alone, the server answers the computer it runs on and no other. A hosted copy says with `HOST=0.0.0.0` that
other computers reach it ([0022](decisions/0022-the-server-answers-its-own-computer-unless-told-otherwise.md)).

Sloan's computer is a Windows desktop since 2026-11-24. It was a Windows laptop before. The
[plan](applications-plan.md), the decision records and the older entries of the work log still call it "the
laptop".

## The code

### `src/jobs/`: job search (browser and server)

| File | What it does |
| --- | --- |
| `types.ts` | The shapes everything shares: `JobQuery`, `SearchSettings`, `JobPosting`, `JobListing`, `SourceStatus`, `SearchResponse`, and `AdapterContext` (`fetch`, `env`, `signal`), which is how a source reaches the network. |
| `adapters/ats.ts` | Hiring systems: Greenhouse, Lever, Ashby, SmartRecruiters, Workday, Amazon. |
| `adapters/feeds.ts` | USAJOBS, Remotive, Remote OK. |
| `adapters/googleJobs.ts` | Google for Jobs through one of three services: JSearch from its maker (OpenWeb Ninja), JSearch through RapidAPI, or SerpAPI. |
| `adapters/linkedin.ts`, `adapters/indeed.ts` | LinkedIn's public pages, and the parser for an Indeed results page. |
| `adapters/common.ts` | What sources share: reading JSON, HTML to text, places, dates, `SourceError`, `BlockedError`. |
| `aggregate.ts` | `planSearch` picks the sources for a search. `aggregate` runs them side by side, each with a time limit and a status of its own. `mergeJobs` folds the same job from several boards into one. |
| `boards.ts`, `catalog.ts` | The job boards a user can choose, and the companies and industries with the hiring system each uses. |
| `client.ts` | What the pages call: `searchJobs`, `fetchJobDetail`, `fetchHealth`. |

More in [job-sources.md](job-sources.md).

### `src/resume/`: reading a resume (browser only)

| File | What it does |
| --- | --- |
| `load.ts` | Opens the file with pdf.js or mammoth. Loaded only when a resume is added. |
| `extract.ts` | Turns what those give into a `SourceDocument`: the text, its lines, and for a PDF where each run sits on the page. |
| `parse.ts`, `dates.ts` | Text to fields, by fixed rules. |
| `model.ts` | The fields and the guarantee: `checkIntegrity`, `toApplicationProfile`. |

More in [resume-model.md](resume-model.md).

### `src/apply/`: tracked applications (browser and server)

| File | What it does |
| --- | --- |
| `model.ts` | The record of an application, and every rule about one: what a valid record is, who wrote an answer, who may change what (`newApplication`, `changeApplication`), and what is left for the user (`leftForUser`). The server and the page both use it, so it has no `node:` imports and no DOM. |
| `api.ts` | The tracker's routes as both halves see them: the shapes of what is sent and answered, and the error codes. |
| `posting.ts` | A search result as a job to track, with the posting's facts copied and not reworded, and whether a posting is tracked already. |
| `client.ts`, `TrackerProvider.tsx` | Calls to the routes, whether this copy of the app has a tracker, and the list of applications for the whole app. |

More in [applications.md](applications.md).

### `src/account/`, `src/ui/`, `src/lib/`, `src/App.tsx`

| File | What it does |
| --- | --- |
| `src/account/api.ts` | The account routes as both halves see them: paths, shapes, password rules. Shared with the server. |
| `src/account/client.ts`, `AccountProvider.tsx` | Calls to those routes, and who is signed in, for the whole app. |
| `src/App.tsx` | The top bar and which page shows. Addresses are after the `#`: `#/`, `#/applications`, `#/applications/<id>`, `#/resume`, `#/sign-in`, `#/invite/<code>`, `#/reset/<code>`, `#/recover`, `#/account`. |
| `src/ui/SearchPage.tsx`, `SettingsPanel.tsx` | Search, results, a posting with "Save to applications", and the settings behind the gear. |
| `src/ui/ApplicationsPage.tsx` | The list of applications, and one application: what is left for the user, every answer with who wrote it, notes and history. |
| `src/ui/controls.tsx` | The controls those two share: a field with a list to tick, a section that folds away. Search options are built from these and never as pills ([0018](decisions/0018-search-options-are-fields-and-lists-not-pills.md)). |
| `src/ui/ResumePage.tsx` | Adding a resume and reviewing its fields against the original. |
| `src/ui/SignInPages.tsx`, `AccountPage.tsx`, `AccountForms.tsx` | The account pages. |
| `src/ui/sanitize.ts` | The barrier between a job site's HTML and the page. |
| `src/ui/hooks.ts`, `src/lib/storage.ts` | The address after the `#`, and what is kept in the browser. |
| `src/testing/` | Helpers for component tests. Not part of the app. |

### `server/src/`: the server

| File | What it does |
| --- | --- |
| `index.ts` | The process: reads the settings, starts the pipeline, accounts and the tracker, listens. Nothing else. |
| `listen.ts` | Which network connections the server answers on: its own computer only, unless `HOST` says otherwise. |
| `app.ts` | `createApp(parts)`: what the server does with a request. Search, a posting's details, health, CORS, the rate limit, the search cache. Everything it needs is handed in. |
| `fetcher.ts`, `tiers.ts`, `browser.ts` | The fetch pipeline every source request goes through ([fetch-tiers.md](fetch-tiers.md)). |
| `discover.ts` | Finds the hiring system behind a company name the user typed. |
| `detail.ts` | Loads a posting's full description when the search only gave a summary. |
| `static.ts` | Serves the built app and its security headers. |
| `accounts/` | Sign-in: `service.ts` (what an account can do), `http.ts` (routes, cookie, origin rules), `crypto.ts` and `keys.ts`, `policy.ts`, `limits.ts`, `index.ts` (settings and startup), `cli.ts` and `admin-commands.ts` (`npm run admin`). More in [accounts.md](accounts.md). |
| `db/` | The database interface, its lock file, and the tables. |
| `applications/` | The tracker: `http.ts` (the routes, who is answered, and who a change is from), `store.ts` (one file for each application, replaced in one step, with its earlier versions), `records.ts` (what the routes need from wherever the records are kept), `index.ts` (whether this server keeps applications, and startup). More in [applications.md](applications.md). |
| `indeed.ts` | The old Indeed browser route. Off by default and not to be extended ([decisions/0007](decisions/0007-no-bot-check-bypass.md)). |
| `smoke.ts`, `check-catalog.ts`, `record-fixtures.ts` | Tools run by hand against the live sites. |

### `test/`

Tests for the server, the sources, the parts put together, and the browser, with their helpers and fixtures.
Tests for code in `src/` sit next to that code. [testing.md](testing.md) has the layout and the rules.

## What happens when

### A search

1. `SearchPage` calls `searchJobs(query, settings)` in `src/jobs/client.ts`.
2. With a server, that is `POST /api/search`. `app.ts` checks the request, counts it against the caller's limit
   (40 searches in 5 minutes), and answers from its cache when the same search ran in the last 10 minutes.
3. `aggregate` asks `planSearch` which sources this search uses: the boards and companies the user chose, cut down
   to what this server has keys and switches for. A source that cannot run is listed as skipped, with the reason.
4. Each source runs with the `fetch` in its context. On the server that is the pipeline: cache, then a paced plain
   request, then the optional tiers. A source that is turned away as automated traffic is reported as blocked.
5. `mergeJobs` folds postings with the same company, title and city into one that lists every board, and sorts
   newest first.
6. The page shows the list, and one line that says how the sources did. The line opens to a table with a row for
   each source. Descriptions go through `sanitizeHtml` before they are shown.

Without a server, step 2 is skipped and `aggregate` runs in the browser with the browser's own `fetch`.

A company typed in by hand has no known board. `discover.ts` tries its name against each hiring system's public
feed and remembers the answer for a day.

### Opening a posting

Some sources return only a summary. The page then asks `GET /api/job?id=…`, and `detail.ts` loads the rest from
the source the id names.

### Adding a resume

1. `ResumePage` hands the file to `fileToSource` in `src/resume/load.ts`.
2. pdf.js gives the runs of text with their positions, and `buildPdfSource` rebuilds the lines. For a Word file,
   mammoth gives HTML and `docxHtmlToText` turns it into lines. A text file is used as it is.
3. `parseResume` turns the text into fields. Each field holds its value and the place in the text it came from.
4. The fields are kept in `localStorage`, the original file in IndexedDB, both in this browser only.
5. The user confirms, removes or corrects each field next to the original. A correction made by selecting text
   stays an exact slice. A typed one is marked as typed.
6. `toApplicationProfile` gives the confirmed fields to whatever fills an application. Today that is only
   "Export confirmed".

### Signing in

1. When the app starts and accounts may exist, `AccountProvider` asks `GET /api/auth/session`.
2. The sign-in page posts the email and password to `POST /api/auth/sign-in`. The server answers with a cookie
   that scripts cannot read. From then on the browser sends it with every call to the page's own address.
3. On the server, `app.ts` hands every account route to `accounts/index.ts`, which reads the body and calls
   `http.ts`. That checks where the request came from and who the cookie belongs to, and calls `service.ts`, which
   does the work against the database.
4. Nothing about the session is kept in the browser's storage. The app always asks the server who is signed in.

### An admin command

`npm run admin -- invite someone@example.com` starts `server/src/admin.ts`. Only one process may have the database
open. If the lock file says a server holds it, the command is sent to that server at `/api/admin/run`, which
answers only to a caller on the same machine that knows a secret worked out from `AUTH_PEPPER`. Otherwise the
command opens the database itself.

### Saving an application and working on it

1. On a search result, "Save to applications" turns the posting into a job to track (`src/apply/posting.ts`) and
   sends it to `POST /api/applications` at the page's own address. "Add an application" on the Applications page
   does the same for a job found somewhere else.
2. On the server, `app.ts` hands every tracker route to `applications/index.ts`, which reads the body and calls
   `http.ts`. That checks that the request comes from this computer and, when a browser sent it, from the app's own
   page. It decides who is asking: the user, when the page says so, and an assistant otherwise.
3. `changeApplication` in `src/apply/model.ts` applies the change, or turns it down with a sentence that says
   why. `store.ts` then replaces the application's file in one step and keeps the version before.
4. An assistant on the same computer calls the same routes to record a form it has filled in: every question,
   what went in, and what is left for the user. Whatever it sends is marked as an assistant's.
5. The Applications page asks the server again when its window gets the focus, and every quarter of a minute, so
   the user sees what the assistant did. The user answers what waits for them, rewrites or keeps the drafts, and
   sets the stage.
6. Nothing of this is held in memory or in the browser. After a restart of the server or the computer, every
   application is as it was left ([applications.md](applications.md#after-a-restart)).

## What is stored where

| Where | What |
| --- | --- |
| Browser, `localStorage` | `resume:v1` (the fields of the resume and its text), `search-settings:v1`, `last-query:v1`, `settings-open:v1` (which sections of the settings are unfolded) |
| Browser, IndexedDB `job-hunt` | The original resume file, under its SHA-256 |
| Browser, cookie | `session` (named `__Host-session` on HTTPS): a random token. Not readable by scripts. |
| `server/.env` | Settings, API keys, and `AUTH_PEPPER`. Gitignored. |
| `server/.data/` | The account database. Gitignored. |
| `server/.data/applications/` | One readable file for each tracked application, its earlier versions, and the ones that were removed. Only on a person's own computer, and not encrypted ([applications.md](applications.md#where-the-applications-are-kept)). |
| The server's memory | Answers to recent searches, answers from job sources, counters for the rate limits. Gone on restart. |

The server stores nothing about resumes or searches. Of the jobs someone looked at, it keeps only the ones that
were saved as applications, and only on that person's own computer.

## What must stay true

Each of these is checked by tests. If a change breaks one, the change is wrong, not the test.

| What | Guarded by |
| --- | --- |
| A resume field is the file's exact words, or typed by the user | `checkIntegrity`, and `src/resume/model.test.ts`, `parse.property.test.ts` |
| Only confirmed fields can reach an application | `toApplicationProfile`, same tests |
| A job site's HTML cannot run script or load anything in the page | `src/ui/sanitize.test.ts`, `sanitize.property.test.ts`, and the policy in `test/server/static.test.ts` and `test/e2e/app.e2e.ts` |
| A bot check is reported as blocked, never worked around | `test/server/fetcher.test.ts`, `pipeline.test.ts` |
| A source reaches the network only through the `fetch` it is handed | The network guard fails any test where one does not |
| Every posting a source returns is fit to show | `postingProblems` in `test/helpers/sources.ts`, run for every source by `test/sources/contract.test.ts` |
| The database never holds a password, a token or a key in the clear | "what the database holds" in `test/server/accounts.test.ts` |
| Search and the app work with accounts off | `test/integration/search-server.test.ts` (the server), `src/App.test.tsx` (the app) |
| An answer says who wrote it, and nothing turns an assistant's text into the user's | `changeApplication`, and `src/apply/model.test.ts`. Only a request from a page can be the user's: "saying who makes a change" in `test/server/applications.test.ts` |
| The tracker answers only the computer it runs on, and only the app's own page | "who is answered" in `test/server/applications.test.ts`, and `test/integration/applications-server.test.ts` |
| A server that other computers can reach keeps no applications | `test/server/listen.test.ts`, and `test/integration/applications-restart.test.ts`, which asks a real server at the address other computers use |
| An application survives the server being ended, and a file that cannot be read is never written over | `test/server/applications-store.test.ts`, `test/integration/applications-restart.test.ts` |
| The demo, which has no server, asks for no tracker | `src/apply/TrackerProvider.test.tsx` |
| Code in `src/jobs/` runs in a browser and in Node | It is type-checked as browser code and run by the server's tests |
| No test touches the live network or writes to `server/.env` | `test/setup/network.ts`, and the last test in `test/integration/admin-cli.test.ts` |
| No test touches the applications in `server/.data/` | `startServerProcess` in `test/helpers/process.ts` switches the tracker off unless a test gives it a folder of its own |

## Settings

Everything the server can be told is listed with an explanation in `server/.env.example`. The app has two
build-time settings: `VITE_API_URL` (the search server for a copy on a static host) and `VITE_ACCOUNTS` (for a
setup where the app and the account routes share an address without the server serving the app).

How to run and deploy is in the [README](../README.md).
