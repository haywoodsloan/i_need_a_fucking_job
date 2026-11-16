# I need a job

A web app for finding jobs, tracking applications, prepping for interviews, and building resumes.

**Core rule: applications use your own words, verbatim.** The app never writes text on your behalf. Every piece of
resume data is either an exact slice of the file you uploaded (with a pointer to where it came from) or something
you typed yourself.

## What's here

| Feature | Where | Notes |
| --- | --- | --- |
| Job search aggregator | `src/jobs`, `src/ui/SearchPage.tsx`, `server/` | One search bar, one de-duplicated result list, postings readable in-app |
| Resume upload + analyzer | `src/resume`, `src/ui/ResumePage.tsx` | PDF / DOCX / TXT parsed in the browser, side-by-side verification |

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
└───────────────────────────────────────────────────────────────────────┘
```

**What needs the backend, and why**

| Needs | Why it can't live on GitHub Pages | Lives in |
| --- | --- | --- |
| Google for Jobs API key (JSearch or SerpAPI) | secret key | `server/` env |
| USAJOBS API key | secret key | `server/` env |
| Workday, Amazon Jobs, Remote OK | endpoints don't allow browser (CORS) requests | `server/` |
| LinkedIn public pages, company auto-discovery | no CORS, needs server-side requests | `server/` |
| Indeed headless browser | needs a real Chromium process | `server/` (Docker) |

The resume never touches the backend. It is parsed and stored in the browser (localStorage + IndexedDB).

Without a backend the app still loads and the resume tools fully work, but search can only reach the few sources
that allow direct browser access (Greenhouse, Lever, Ashby, SmartRecruiters company boards and Remotive).

See [docs/job-sources.md](docs/job-sources.md) for every source, its cost and its risks,
[docs/fetch-tiers.md](docs/fetch-tiers.md) for how the server fetches (cache, HTTP, optional browser) and how to plug
in a tier of your own, and [docs/resume-model.md](docs/resume-model.md) for the resume data model.

## Run it

Everything on one machine, with one command:

```bash
npm install
npm install --prefix server
cp server/.env.example server/.env   # add keys; the file is gitignored and loaded automatically
npm run local                        # backend on http://localhost:8787, frontend on http://localhost:5173
```

The pieces, separately:

```bash
npm run dev          # frontend only
npm test             # parser, adapter and fetch-layer tests
npm run build        # static build in dist/

cd server
npm start            # backend only
npm run smoke -- "software engineer" "Austin, TX"   # live check of every configured source
npm run check:catalog                               # live check of every catalog company's board id
```

Node 22 is recommended. Vite warns on Node older than 20.19 but still runs.

Point the frontend at the backend either at build time (`VITE_API_URL=https://… npm run build`) or at runtime in
the app: gear icon → Search server. `npm run local` does this for you.

## Deploy

**Frontend (GitHub Pages).** `.github/workflows/ci.yml` tests, builds and deploys `dist/` on every push to `main`.
One-time setup: repo Settings → Pages → Source: **GitHub Actions**, and (once the backend is up) Settings →
Variables → `VITE_API_URL`.

**Backend (Fly.io example).** From the repo root:

```bash
fly launch --no-deploy --copy-config --config server/fly.toml
fly secrets set --config server/fly.toml JSEARCH_API_KEY=… USAJOBS_API_KEY=… USAJOBS_USER_AGENT=you@example.com \
  ALLOWED_ORIGINS=https://haywoodsloan.github.io
fly deploy --config server/fly.toml
```

Any Docker host works: `docker build -f server/Dockerfile -t job-hunt-server .`

## Roadmap hooks already in the data model

- **Resume builder**: will produce the same `ParsedResume` shape, so builder output and uploaded resumes are interchangeable.
- **Automated applying**: reads only `toApplicationProfile(resume)`, which returns confirmed fields and refuses to run
  if any field differs from its source.

The plan for the next phase (accounts, stored site logins, application tracking and submitting) is in
[docs/applications-plan.md](docs/applications-plan.md). None of it is built yet.
