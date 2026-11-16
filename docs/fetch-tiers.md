# Fetch tiers

How the search server reaches job sources, and how to add a tier of your own.

Every request a job source makes goes through one pipeline (`server/src/fetcher.ts`). The pipeline is an ordered list
of tiers, cheapest first, and a request only moves to the next tier when the one before it could not answer. Most
requests never get past the first two.

## The pipeline

| # | Tier | On | What it does |
| --- | --- | --- | --- |
| 1 | `cache` | always | Reuses a successful answer to the same request for `CACHE_SECONDS` (10 minutes). No network. |
| 2 | `http` | always | A plain request. Spaced out per site, retried with backoff after a dropped connection or a 502/503/504, and retried after a 429 only when the site says when. |
| 3 | `browser` | `ENABLE_BROWSER_TIER=1` | Loads the page in a standard headless browser and returns the rendered HTML. Page requests only. |
| 4+ | your own | `FETCH_TIERS_MODULE=…` | Whatever you write. See [Your own tiers](#your-own-tiers). |

The rules:

- A tier **answers** by returning a response. The pipeline stops there. Successful answers are cached, whichever tier
  gave them.
- An error status from the site (404, 500 and so on) **is an answer**. Nothing heavier is tried for it.
- A tier **fails** by throwing: the connection failed after its retries, it timed out, or the site turned it away as
  automated traffic. The failure is recorded and the next tier gets the request, along with the list of failures so far.
- A tier can **pass** on a request that is not its kind (the browser tier passes on API calls). Passing is not a failure.
- A search that was cancelled stops the pipeline.
- When no tier answers, the source fails with the "turned away" error if any tier was turned away, and the search
  shows that source as **blocked**. Otherwise it fails with the last tier's error.

`/api/health` lists the active tiers and how many answers each has given. `npm run smoke` prints the same.

## Bot checks

The tiers in this repository never get past a bot check. They recognise one and stop:

- **Recognise.** LinkedIn's status 999, Cloudflare's `cf-mitigated: challenge` header, a 403/429/503 page carrying
  challenge markers, and pages whose whole title is a known interstitial ("Just a moment...", "Security Check - …",
  "Access Denied").
- **Stop.** No disguise, no waiting a challenge out, no solving, no proxies. The `http` tier sends only the headers
  the job source set. The `browser` tier leaves the automation flag on, adds this tool's name to its user agent, and
  hands a challenge page back the moment it sees one instead of letting its script run.

A site that serves an openly automated client has allowed it. A site that refuses one has given its answer, and the
source is reported as blocked. The same board's listings still arrive through Google for Jobs when a key is set.

## The browser tier

For pages that only render with JavaScript, and for sites that answer a browser but not a plain HTTP client.

- It takes **page requests only**: a `GET` whose `Accept` header includes `text/html`. API calls pass straight by.
- It loads the page, gives scripts up to 4 seconds of quiet network to finish rendering, and returns the HTML with
  the page's status.
- It needs a Chromium. The Docker image already has Playwright's. Locally, either run `npx playwright install chromium`
  or set `BROWSER_CHANNEL=msedge` (or `chrome`) to use a browser that is already installed.

```ini
# server/.env
ENABLE_BROWSER_TIER=1
BROWSER_CHANNEL=msedge
```

Checked live on 2026-11-16 with Edge 157 on Windows: a script-rendered page came back rendered in under 3 seconds,
and a challenge page was reported as blocked in 0.2 seconds without waiting for it.

Note that the Indeed route (`server/src/indeed.ts`, `ENABLE_PLAYWRIGHT`) is older, separate code and does not go
through this tier.

## Your own tiers

A tier is an object with a name and one function:

```ts
interface FetchTier {
  name: string;
  fetch(req: TierRequest): Promise<Response | undefined>;
}

interface TierRequest {
  url: string;
  init?: RequestInit;                 // the request exactly as the job source made it
  failures: readonly TierFailure[];   // what the tiers before this one reported, in order
}

interface TierFailure {
  tier: string;      // "http", "browser", or another tier's name
  error: Error;
  blocked: boolean;  // the site turned that tier away as automated traffic
}
```

What `fetch` may do:

| It… | Meaning |
| --- | --- |
| returns a `Response` | This is the answer. The pipeline stops. A successful one is cached. |
| returns `undefined` | Not this tier's kind of request. The next tier gets it. |
| throws | Recorded in `failures`. The next tier gets it. Throw `BlockedError` (from `src/jobs/adapters/common.ts`) to report being turned away. |

To add tiers:

1. Copy `server/tiers.example.mjs` to `server/tiers.local.mjs`. That name is gitignored, so it stays on your machine.
2. Fill in `fetch`. Export either `tiers` (an array) or a default function that receives the environment and returns
   the array, which is the place to read your own settings from `server/.env`.
3. Switch it on in `server/.env`. The path is relative to `server/`.

```ini
FETCH_TIERS_MODULE=./tiers.local.mjs
```

Your tiers run after the built-in ones, in the order you list them, and only for requests the earlier tiers could not
answer. They see every kind of request, API calls included, so pass (`return undefined`) on what you do not handle.
Names must be unique, and `cache`, `http` and `browser` are taken. A module that cannot be loaded stops the server at
startup with a message naming the file, so a typo never silently runs without your tier.

To try a tier without the network, hand it to the pipeline with a fake first tier, the way `test/fetcher.test.ts`
does:

```ts
const fetcher = createFetcher({
  fetch: async () => { throw new TypeError('fetch failed'); },  // make the http tier fail
  retries: 0,
  tiers: [myTier],
});
const res = await fetcher('https://careers.example.com/jobs', { headers: { Accept: 'text/html' } });
```

A custom tier is code you write and switch on. What it does, and whether that fits the terms of the sites it
touches, is yours to decide. Nothing in this repository ships or configures one.
