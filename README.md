# I need a job

A web app for finding jobs, tracking applications, prepping for interviews, and building resumes.

**Core rule: applications use your own words, verbatim.** The app never writes text on your behalf. Every piece of
resume data is either an exact slice of the file you uploaded (with a pointer to where it came from) or something
you typed yourself. When an assistant outside the app drafts an answer for you, the app keeps it marked as the
assistant's draft, and never as yours.

**Working on the code, as a person or as an AI agent?** Start with [AGENTS.md](AGENTS.md): the rules, a map of
the code, the commands, and what "done" means. [docs/status.md](docs/status.md) says where things stand, and
[docs/README.md](docs/README.md) lists everything that is written down.

## What's here

| Feature | Where | Notes |
| --- | --- | --- |
| Job search aggregator | `src/jobs`, `src/ui/SearchPage.tsx`, `server/` | One search bar, one de-duplicated result list, postings readable in-app |
| Resume upload + analyzer | `src/resume`, `src/ui/ResumePage.tsx` | PDF / DOCX / TXT parsed in the browser, side-by-side verification |
| Application tracker | `src/apply`, `src/ui/ApplicationsPage.tsx`, `server/src/applications` | On your own computer: every application with its stage, the questions of its form, what goes in them and who wrote that. A restart loses nothing. See [docs/applications.md](docs/applications.md) |
| Accounts and sign-in | `src/account`, `src/ui/AccountPage.tsx`, `server/src/accounts` | Invite-only and off until you turn it on. The base for a hosted copy. See [docs/accounts.md](docs/accounts.md) |

## Architecture

```
┌──────────────────────── GitHub Pages (static) ────────────────────────┐
│  React + Vite app                                                     │
│   • resume parsing, review, storage  → 100% in the browser            │
│   • job search UI                    → calls the search server        │
└───────────────────────────────┬───────────────────────────────────────┘
                                │ POST /api/search, GET /api/job
┌───────────────────────────────▼───────────────────────────────────────┐
│  server/  (Node container: Fly.io / Render / any Docker host)         │
│   • holds API keys (never shipped to the browser)                     │
│   • reaches job sources that have no browser access (no CORS)         │
│   • caches, paces and retries every outbound request                  │
│   • optional headless Chromium (Playwright)                           │
│   • optional accounts and sign-in, with their own database            │
│   • on your own computer: the applications you track, as files        │
└───────────────────────────────────────────────────────────────────────┘
```

The server can also serve the app itself (`npm run local:built`), so the two share one address. Sign-in needs
that, and a hosted copy with accounts will run that way. The GitHub Pages copy stays a demo without accounts and
without applications. [docs/architecture.md](docs/architecture.md) has the full picture: every folder, and what
happens during a search, a resume upload, a sign-in and the work on an application.

**What needs the backend, and why**

| Needs | Why it can't live on GitHub Pages | Lives in |
| --- | --- | --- |
| Google for Jobs API key (JSearch or SerpAPI: [how to get one](docs/job-sources.md#google-for-jobs-the-key-and-what-a-search-costs)) | secret key | `server/` env |
| USAJOBS API key | secret key | `server/` env |
| Workday, Amazon Jobs, Remote OK | endpoints don't allow browser (CORS) requests | `server/` |
| LinkedIn public pages, company auto-discovery | no CORS, needs server-side requests | `server/` |
| Indeed headless browser | needs a real Chromium process | `server/` (Docker) |
| Accounts and sign-in | a static host cannot check a password or keep a session | `server/` |
| The application tracker | a static host keeps no files, and the tracker has no sign-in, so it answers only the computer it runs on | `server/` on your own computer |

The resume never touches the backend. It is parsed and stored in the browser (localStorage + IndexedDB).

Without a backend the app still loads and the resume tools fully work, but search can only reach the few sources
that allow direct browser access (Greenhouse, Lever, Ashby, SmartRecruiters company boards and Remotive).

See [docs/job-sources.md](docs/job-sources.md) for every source, its cost and its risks,
[docs/fetch-tiers.md](docs/fetch-tiers.md) for how the server fetches (cache, HTTP, optional browser) and how to plug
in a tier of your own, [docs/resume-model.md](docs/resume-model.md) for the resume data model,
[docs/applications.md](docs/applications.md) for the application tracker, [docs/accounts.md](docs/accounts.md) for
accounts and sign-in, [docs/testing.md](docs/testing.md) for the tests, and
[docs/decisions/](docs/decisions/README.md) for why things are the way they are.

## Run it

Everything on one machine, with one command:

```bash
npm install
npm install --prefix server
cp server/.env.example server/.env   # add keys; the file is gitignored and loaded automatically
npm run local                        # backend on http://localhost:8787, frontend on http://localhost:5173
```

The server answers the computer it runs on and no other. The applications you save are kept there, as files in
`server/.data/applications/`, and they are still there after a restart. Nothing starts by itself: after a restart of
the computer, run `npm run local` again. `HOST=0.0.0.0` in `server/.env` lets other computers reach the server, and
a server that others can reach keeps no applications ([docs/applications.md](docs/applications.md#where-the-tracker-is-on)).

Accounts are optional and off by default. To turn them on, run this once and open the link it prints:

```bash
npm run admin -- setup you@example.com   # then start (or restart) npm run local
```

It creates the server's secret in `server/.env` and a local database in `server/.data/`. Both are gitignored.
[docs/accounts.md](docs/accounts.md) has the rest: inviting people, forgotten passwords, what is stored, backups.

The pieces, separately:

```bash
npm run dev          # frontend only
npm run check        # before every push: type check, all tests with coverage, build
npm test             # unit, component and integration tests, about 20 seconds
npm run test:e2e     # the built app in a real browser (docs/testing.md says how to give it one)
npm run build        # static build in dist/
npm run local:built  # build, then let the backend serve the app at http://localhost:8787 with strict security headers
npm run admin        # account commands: setup, invite, reset, users, sign-out

cd server
npm start            # backend only
npm run smoke -- "software engineer" "Austin, TX"   # live check of every configured source
npm run check:catalog                               # live check of every catalog company's board id
```

Node 22.12 or newer is needed. Vite and the test runner do not support anything older.

Point the frontend at the backend either at build time (`VITE_API_URL=https://… npm run build`) or at runtime in
the app: gear icon → Search server. `npm run local` does this for you.

## Deploy

**Frontend (GitHub Pages).** `.github/workflows/ci.yml` checks every push on Linux and on Windows, and deploys
`dist/` from `main` when both pass.
One-time setup: repo Settings → Pages → Source: **GitHub Actions**, and (once the backend is up) Settings →
Variables → `VITE_API_URL`.

**Backend (Fly.io example).** From the repo root:

```bash
fly launch --no-deploy --copy-config --config server/fly.toml
fly secrets set --config server/fly.toml OPENWEBNINJA_API_KEY=… USAJOBS_API_KEY=… USAJOBS_USER_AGENT=you@example.com \
  ALLOWED_ORIGINS=https://haywoodsloan.github.io
fly deploy --config server/fly.toml
```

Any Docker host works: `docker build -f server/Dockerfile -t job-hunt-server .`

This deploys search only. Leave accounts off on a hosted server for now: its database lives in a folder inside the
container, which a redeploy throws away. Hosting with accounts is a later step of the plan
([docs/applications-plan.md](docs/applications-plan.md), section 11). A hosted server keeps no applications
either: the image sets `HOST=0.0.0.0` so that it can be reached, and the tracker is only on where nobody else can
reach the server.

## Roadmap hooks already in the data model

- **Resume builder**: will produce the same `ParsedResume` shape, so builder output and uploaded resumes are interchangeable.
- **Automated applying**: reads only `toApplicationProfile(resume)`, which returns confirmed fields and refuses to run
  if any field differs from its source.

The plan for the next phase (accounts, stored site logins, application tracking and submitting) is in
[docs/applications-plan.md](docs/applications-plan.md). Two of its steps are built: accounts and sign-in
([docs/accounts.md](docs/accounts.md)), and the tracker for a person's own computer
([docs/applications.md](docs/applications.md)). The rest is not built yet.
