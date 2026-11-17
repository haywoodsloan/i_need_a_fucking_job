# 0005. A static app plus one server, run on the laptop first

- **Status:** Accepted
- **Date:** 2026-11-16
- **Decided by:** Sloan chose where it runs (a public repository on GitHub Pages, and the laptop). Claude chose how
  the code is split to fit that.

## Context

Sloan made the repository public so the frontend could be hosted on GitHub Pages for free, and did not mind the
frontend being visible. Pages serves static files only. But several job sources need a secret key, and most refuse
calls made from a browser. After the first build Sloan asked: "Can we host and test the tools locally on this
laptop?"

## Decision

- **The frontend is a static app that works with no server.** The resume tools work fully. Search reaches only
  the few sources that accept calls from a browser.
- **One Node server does what a static page cannot:** it holds keys, reaches the other sources, and runs accounts.
- **The laptop comes first.** `npm run local` starts both halves on one machine. Hosting for friends comes later
  and is not decided ([applications-plan.md](../applications-plan.md), decision 3 and section 11).
- **The server can serve the built app itself** (`npm run local:built`), so app and API share one address. Sign-in
  needs that, and a hosted copy will run that way. The GitHub Pages copy stays a demo without accounts.

## Consequences

- Code in `src/jobs/` runs in the browser and in the server. It may not import from `node:` or touch the page.
  The server imports it straight from `../../src/jobs/`.
- There are three ways the app runs, and a change has to work in all of them
  ([architecture.md](../architecture.md#three-ways-it-runs)).
- Job sites can be reached from the laptop but usually not from a cloud build machine. Anything that needs the
  live sites is run on the laptop: `npm run smoke --prefix server`, `npm run fixtures:record`. The automated tests
  never need them ([0016](0016-how-the-code-is-tested.md)).
- The laptop is Windows, so everything has to run there as well as on Linux.

## In the code

- `scripts/local.mjs` starts both halves. `vite.config.ts` passes the account routes on to the server in
  development.
- `src/jobs/client.ts` decides which server the app talks to. `server/src/static.ts` serves the built app.
- `.github/workflows/ci.yml` builds and deploys the demo, and runs every check on Windows too.
