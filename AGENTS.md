# Working in this repository

Read this first, whether you are a person or an AI agent. It holds what the code cannot tell you: the rules, a map,
the commands, and where to read more. It is kept short on purpose. Details live in `docs/`, one topic per file.

`CLAUDE.md` loads this file, so Claude Code reads it at the start of every session.

## What this is

A web app for one person's job hunt, shared with a few friends: search many job boards at once, read a resume into
checked fields, sign in. Tracking and sending applications come next ([docs/status.md](docs/status.md)).

- **Frontend:** React and Vite, in `src/`. A static copy runs on GitHub Pages as a demo.
- **Server:** Node 22 with no web framework, in `server/`. It holds API keys, reaches job sources a browser cannot,
  and runs accounts. Sloan runs it on a Windows laptop with `npm run local`.

## Rules that do not bend

Each has a record of why in [docs/decisions/](docs/decisions/README.md). Do not work around one. If a task seems to
need it, stop and ask Sloan. Rule 2 is different: asking does not change it. Say that you will not build that part,
and what the rule leaves room for.

1. **Your words, verbatim.** Nothing the app writes may enter an application. A resume field is an exact slice of
   the uploaded file or something the user typed, and `toApplicationProfile` is the only way out
   ([0001](docs/decisions/0001-applications-use-the-users-own-words.md)).
2. **No bot-check bypass.** When a site refuses automated traffic, the source is reported as blocked. No disguise,
   no CAPTCHA solving, no proxies, and no extending the old Indeed route in `server/src/indeed.ts`
   ([0007](docs/decisions/0007-no-bot-check-bypass.md)).
3. **The resume stays in the browser.** It is parsed and stored there and is never sent to the server
   ([0008](docs/decisions/0008-resume-is-read-in-the-browser-by-rules.md)).
4. **Job site HTML is hostile.** It reaches the page only through `sanitizeHtml`, and the served app runs under
   a strict content security policy ([0015](docs/decisions/0015-job-html-is-sanitized-and-the-app-runs-under-a-strict-policy.md)).
5. **No secrets in the repository.** Keys live in `server/.env`, the account database in `server/.data/`. Both are
   gitignored. A recorded fixture never holds a key. A test never writes to `server/.env`.
6. **Tests never touch the live network.** A guard fails any test that tries
   ([0016](docs/decisions/0016-how-the-code-is-tested.md)).
7. **It runs on Windows and on Linux.** Sloan's laptop is Windows, CI and hosting are Linux. CI checks both.
8. **Work goes straight to `main`, without pull requests.** A push to `main` deploys the demo, so run
   `npm run check` first ([0004](docs/decisions/0004-work-lands-on-main-without-pull-requests.md)).

Only Sloan decides: spending money, API keys, installing software on the laptop, and the open questions in
[docs/status.md](docs/status.md#waiting-on-sloan).

## Map

| Path | What is there |
| --- | --- |
| `src/jobs/` | Job search: one adapter per source, the catalog of companies, merging. **Runs in the browser and in the server**, so no `node:` imports and no DOM here. |
| `src/resume/` | Reading a resume: file to text (`extract.ts`, `load.ts`), text to fields (`parse.ts`), the model and its guarantee (`model.ts`). Browser only. |
| `src/account/` | The app's side of sign-in. `api.ts` is shared with the server. |
| `src/ui/` | Pages and components. `sanitize.ts` is the barrier for job site HTML. |
| `src/testing/` | Helpers for component tests: a fake server at the `fetch` boundary. |
| `server/src/` | The server: `index.ts` starts it, `app.ts` answers requests, `fetcher.ts` and `tiers.ts` reach job sources, `accounts/` and `db/` are sign-in. |
| `test/` | Tests that are not next to their code: `server/`, `sources/`, `integration/`, `e2e/`, with `helpers/` and `fixtures/`. |
| `docs/` | Everything written down. Start at [docs/README.md](docs/README.md). |
| `.github/workflows/ci.yml` | Checks every push on Linux and Windows. Deploys the demo from `main`. |

[docs/architecture.md](docs/architecture.md) has the full picture: how a search, a resume and a sign-in flow through
these parts.

## Commands

Run from the repository root. Node 22.12 or newer.

| Command | What it does |
| --- | --- |
| `npm install` and `npm install --prefix server` | Install both halves. Needed once, and after a pull that changes a lock file. |
| `npm run local` | The whole app on this machine: server on :8787, app on :5173. |
| `npm run check` | **Run before every push.** Type check, all tests with coverage, build. |
| `npm test` | All unit, component and integration tests. About 20 seconds. |
| `npx vitest run path/to/file.test.ts` | One file. Add `-t "name"` for one test. |
| `npm run test:e2e` | The built app in a real browser. Needs a browser ([docs/testing.md](docs/testing.md#in-a-real-browser)). |
| `npm run typecheck` | Type check only. |
| `npm run admin -- <command>` | Account commands: `setup`, `invite`, `reset`, `users`, `sign-out`. |
| `npm run fixtures:record` | Re-record what job sources answer, for the tests. Only works where the job sites can be reached, which is usually the laptop. |
| `npm run smoke --prefix server` | Live check of every source. Laptop only, for the same reason. |

## Before you call a change done

1. `npm run check` passes. If you touched a page, the served app, sign-in or the security headers, `npm run
   test:e2e` passes too.
2. The change has tests at the right layer ([docs/testing.md](docs/testing.md#where-a-test-goes)). A bug fix starts
   with a test that fails without the fix.
3. The docs are true again, in the same commit:
   - [docs/worklog.md](docs/worklog.md): a dated entry, newest first, saying what changed and why.
   - [docs/status.md](docs/status.md): what is built, what is next, what waits on Sloan, known gaps.
   - A new file in [docs/decisions/](docs/decisions/README.md) if you chose between real alternatives, or Sloan did.
   - The topic doc, if behaviour it describes changed.
4. Tell Sloan what they have to do on the laptop, if anything: `git pull`, an install, a setting.

## Where to read more

| You are about to | Read |
| --- | --- |
| Start any task | [docs/status.md](docs/status.md), then the latest entries in [docs/worklog.md](docs/worklog.md) |
| Change how parts fit together | [docs/architecture.md](docs/architecture.md) |
| Write or fix a test | [docs/testing.md](docs/testing.md) |
| Add or fix a job source | [docs/job-sources.md](docs/job-sources.md), [docs/fetch-tiers.md](docs/fetch-tiers.md), then "Adding a job source" in [docs/testing.md](docs/testing.md#adding-a-job-source) |
| Touch resume reading | [docs/resume-model.md](docs/resume-model.md) |
| Touch sign-in, sessions or the database | [docs/accounts.md](docs/accounts.md) |
| Build tracking, the login vault or applying | [docs/applications-plan.md](docs/applications-plan.md) |
| Wonder why something is the way it is | [docs/decisions/](docs/decisions/README.md) |

## Keeping the docs true

- **One home for each fact.** Link to it; do not copy it. [docs/README.md](docs/README.md) says which file owns what.
- **A decision record is never rewritten.** When a decision changes, write a new record and mark the old one as
  replaced. That keeps the reasons findable.
- **The docs are tested.** `test/docs/docs.test.ts` fails when a link, a file path or an `npm run` command in the
  docs points at something that does not exist, when a decision record is missing from the index, and when
  [docs/status.md](docs/status.md) is older than the newest entry in the work log.
