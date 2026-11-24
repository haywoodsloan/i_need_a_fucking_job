# Job sources

Every source is an adapter (`src/jobs/adapters/*`) that turns one site's data into the shared `JobPosting` shape.
`src/jobs/aggregate.ts` fans a search out to the selected adapters in parallel, reports per-source status, and merges
duplicates (same company + title + city) into one posting that lists every board it was found on.

## Routes, in order of preference

| # | Route | Covers | Cost | Risk / upkeep |
| --- | --- | --- | --- | --- |
| 1 | **Google for Jobs API** (JSearch from OpenWeb Ninja or through RapidAPI, or SerpAPI) | LinkedIn, Indeed, Glassdoor, ZipRecruiter, Dice, Built In, Wellfound, Monster, employer sites | A small free allowance each month, then paid per request. [The key, and what a search costs](#google-for-jobs-the-key-and-what-a-search-costs) has the numbers. | Low. The vendor absorbs scraping risk. Coverage is whatever Google has indexed, which is most but not all listings. |
| 2 | **ATS public APIs** (Greenhouse, Lever, Ashby, SmartRecruiters, Workday, Amazon Jobs) | Any employer on those systems | Free | Low. These feeds exist so career pages can embed them. |
| 3 | **USAJOBS API** | All federal postings, filterable by agency (FAA, NASA, VA, …) | Free key | Low. Official API. |
| 4 | **LinkedIn public pages** (`ENABLE_LINKEDIN_GUEST=1`) | LinkedIn listings beyond what Google indexed | Free | Medium/high. Against LinkedIn's terms, rate-limited per IP, HTML changes without notice. The server says what it is (no browser disguise), sends one request at a time, and stops when LinkedIn refuses it. |
| 5 | **Headless browser** (`ENABLE_PLAYWRIGHT=1`) | Indeed | Free software, but realistically needs a paid residential proxy | High. Strong bot detection, frequent breakage, against the site's terms. |

Routes 4 and 5 are off unless the server enables them **and** the user turns on "Direct site access" in settings.
Neither ever logs in or uses anyone's account.

Route 5 is older code (`server/src/indeed.ts`) that hides that it is automated. That goes against the rule this
project has since settled on ([decisions/0007](decisions/0007-no-bot-check-bypass.md)), so it is not extended, and
whether to delete it is an open question for Sloan ([status.md](status.md#waiting-on-sloan)).

Glassdoor and ZipRecruiter are reachable only through route 1 today.

## Google for Jobs: the key, and what a search costs

Google has no public API for its job listings. Services sell access to them, and three are supported
(`src/jobs/adapters/googleJobs.ts`). The server uses the first one in this table whose setting is filled in, and
only that one. Why that order: [decisions/0019](decisions/0019-jsearch-is-read-from-its-maker-first.md).

| Setting in `server/.env` | Service | Free each month | Get a key at |
| --- | --- | --- | --- |
| `OPENWEBNINJA_API_KEY` | JSearch, bought from its maker, OpenWeb Ninja | 200 requests, then it refuses until the next month | [openwebninja.com/api/jsearch](https://www.openwebninja.com/api/jsearch) |
| `JSEARCH_API_KEY` | The same JSearch, bought through the RapidAPI marketplace | 200 requests, then it refuses | [rapidapi.com](https://rapidapi.com/letscrape-6bRBa3QguO5/api/jsearch) |
| `SERPAPI_KEY` | SerpAPI's Google Jobs search | 250 searches | [serpapi.com/google-jobs-api](https://serpapi.com/google-jobs-api) |

The allowances are what each service's own page said on 2026-11-24. They change, so read the page before relying
on one. Paying for a plan is Sloan's call.

JSearch is one service with two doors. A key belongs to the door it was bought at: a key from openwebninja.com is
turned down by RapidAPI, and the other way round.

### Getting an OpenWeb Ninja key

These are the service's own steps, read on 2026-11-24. Sloan got a key from it that day.

1. Open [openwebninja.com/api/jsearch](https://www.openwebninja.com/api/jsearch) and press **Try for Free**.
2. Create an account on the developer portal it leads to. The free plan asks for no card.
3. In the portal, subscribe to a plan for **JSearch**. The free one is enough to start.
4. Copy the API key the portal shows.
5. On the machine that runs the server, open `server/.env`. If it is not there yet, copy `server/.env.example` to
   that name first. Add the key on a line of its own, with nothing around it:

   ```
   OPENWEBNINJA_API_KEY=the-key-you-copied
   ```

6. Stop the server and start it again (`npm run local`). It reads `server/.env` only when it starts.
7. See that the server found the key, which costs nothing: open the settings (the gear) in the app, then the
   section "Search server". The line that starts with "Connected." should name "Google for Jobs (JSearch, OpenWeb
   Ninja)". If it says "no key set", the line in `server/.env` is not being read.
8. Check that the service accepts it: `npm run smoke --prefix server`. The row "Google for Jobs (JSearch, OpenWeb
   Ninja)" should say PASS. A search in the app shows the same thing.

The key is a secret. It goes into `server/.env` and nowhere else: not into a chat, a commit or a screenshot. The
server sends it to the service in a header (`x-api-key`), never in an address, and never to the app.

### What a search costs

JSearch counts pages, with up to ten postings on a page: every page it returns is one request of the plan. A
search here asks for two pages unless `GOOGLE_JOBS_PAGES` says otherwise.

| What is run | Requests it uses |
| --- | --- |
| A search with at least one board switched on that is reached through Google for Jobs (LinkedIn, Indeed, Glassdoor and most others) | Up to 2, however many of those boards are on |
| Each chosen company that has no feed of its own (Google, Microsoft, Apple, Meta, and a typed company found on no hiring system) | Up to 2 more for each. Picking an industry adds every such company in it. |
| The same search again within ten minutes (`CACHE_SECONDS`) | None. The server answers from memory. |
| `npm run smoke --prefix server` | About 4: one search, and one company of that kind |
| `npm run fixtures:record -- openwebninja` | 2 |

So the free allowance is about 100 plain searches a month. `GOOGLE_JOBS_PAGES=1` in `server/.env` halves what a
search uses and what it brings back (ten postings instead of twenty). It can be raised as far as 20.

SerpAPI counts searches, and every page is one search, so the same setting and the same sums apply to it.

### When Google for Jobs does not answer

The line above the results says how many sources answered and how many failed. Pressing it opens a table that
names each source that failed and repeats what the service said. A failed service is not swapped for the next of
the three: that would quietly spend another allowance.

| The message | What it means | What to do |
| --- | --- | --- |
| "needs OPENWEBNINJA_API_KEY, JSEARCH_API_KEY or SERPAPI_KEY on the server" | None of the three settings is filled in, or the server was not started again after `server/.env` changed | Add the key, then stop and start the server |
| "answered 401" or "answered 403", then "it did not accept the key in" and the setting's name | The service turned the key down | Look for a missing character or a space, check that the key is in the setting of the door it came from, and that its account has a plan for JSearch with requests left this month |
| "answered 429" | The plan's requests are used up, or too many came at once | Wait for the next month, lower `GOOGLE_JOBS_PAGES`, or move to a bigger plan |
| "The key in" the setting's name "cannot be sent as it is" | The key holds a space, a line break or an invisible character, usually picked up while copying. Nothing was sent. | Copy the key into `server/.env` again |

The first row and the 401 are known: a request without a key was answered 401 on 2026-11-24. What the service
answers when the free allowance runs out is not documented and has not been seen yet, which is why the last two
rows repeat the service's own words next to the status.

## The "one adapter, thousands of employers" idea (experimental section)

Most employers rent their hiring software. Each system exposes the same feed for every customer, so supporting a
company is just knowing its board id:

| System | Feed | Board id example |
| --- | --- | --- |
| Greenhouse | `boards-api.greenhouse.io/v1/boards/{id}/jobs` | `airbnb` |
| Lever | `api.lever.co/v0/postings/{id}` | `palantir` |
| Ashby | `api.ashbyhq.com/posting-api/job-board/{id}` | `openai` |
| SmartRecruiters | `api.smartrecruiters.com/v1/companies/{id}/postings` | `ServiceNow` |
| Workday | `{tenant}.wd{n}.myworkdayjobs.com/wday/cxs/{tenant}/{site}/jobs` | `boeing` / `EXTERNAL_CAREERS` |

Things the live systems taught us, which the adapters now handle:

- **Workday** has no location parameter. Each tenant publishes its own location filter values ("US - Austin, TX",
  "US, TX, Austin", "Texas - Austin", plain "Austin"), so the adapter searches the role, finds the filter values that
  name the city, and searches again with them applied. Pages are 20 results at most; it reads up to three.
- **SmartRecruiters** answers 200 with zero postings for a company id that does not exist, so an empty answer is
  double-checked before it is reported as "no matches".
- **Amazon Jobs** ignores `loc_query` on its own. The `normalized_city_name[]` and `normalized_state_name[]` filters
  work and are case-sensitive.
- **Ashby** boards may flag hybrid roles as `isRemote`. `workplaceType` is the field to trust.
- **Greenhouse** boards can be large (SpaceX and Anduril are 30 to 45 MB with descriptions). They are cached.
- Companies move. Visa left SmartRecruiters for Workday and Plaid left Lever for Ashby. `npm run check:catalog`
  (in `server/`) checks every catalog entry against its live system.

What reading JSearch's published description taught us (2026-11-24). None of it has been seen in a live answer
yet:

- Its search is `/search-v2` at both doors. The search the first build used (`/search`, with `page` and
  `remote_jobs_only`, answering with a bare list) is no longer listed by either. `/search-v2` takes
  `work_from_home`, and answers with the postings under `data.jobs` next to a `cursor` for the next page.
- A posting's `job_id` can be several hundred characters long. Newer answers carry Google's own short id next to
  it as `job_uid`, and that is the one used.
- `radius` is passed on to Google, which does not follow it strictly. Expect some postings from further away.
- The description lists no failure answers. What a refused or used-up key looks like was learned by asking
  without a key (401 with a one-line message), and the rest is still to be seen.

Three ways a typed company resolves:

1. **Catalog** (`src/jobs/catalog.ts`): curated companies tagged by industry and system.
2. **Auto-discovery** (`server/src/discover.ts`): the server tries slug guesses of the typed name against each
   system and caches the one that answers. This is how companies outside the catalog work with no setup.
3. **Fallback**: a Google for Jobs search filtered to that employer, for companies with fully custom sites (Google, Microsoft, Apple, Meta).

Picking an industry adds every catalog company tagged with it.

**Not built yet:** Dayforce and iCIMS. Their public job feeds vary per customer and need hands-on research against live sites.

## How the server makes requests

Every outbound request goes through one pipeline of tiers, cheapest first. A request only moves to the next tier
when the one before it could not answer. [fetch-tiers.md](fetch-tiers.md) has the full description.

1. **Cache.** A successful answer is reused for `CACHE_SECONDS` (10 minutes by default), so a second search that
   touches the same company board does not download it again.
2. **Plain HTTP.** Requests are spaced out per site (a handful at a time, LinkedIn one at a time), retried with
   backoff after a dropped connection or a 502/503/504, and retried after a 429 only when the site says when.
3. **Browser** (optional, `ENABLE_BROWSER_TIER=1`). A standard headless browser for pages that need JavaScript.
4. **Your own tiers** (optional, `FETCH_TIERS_MODULE`). A plug-in point for tiers you write.

The built-in tiers never get past a bot check. A site that refuses the request as automated traffic (a bot check, a
CAPTCHA page, LinkedIn's status 999) is not worked around: if no tier answers, the source is reported as **blocked**
in the search results, and the same board's listings still arrive through Google for Jobs when a key is set.
`/api/health` lists the tiers and shows request, cache and blocked counts.

## Verification status

No automated test calls a live site. Each source is tested two ways: against small samples for the fields it
reads (`src/jobs/jobs.test.ts` and the tests next to the adapters), and from request to posting against a recorded
answer (`test/sources/contract.test.ts`). The recorded answers are typed by hand until someone records real ones
on Sloan's computer. [testing.md](testing.md#recorded-answers-from-job-sources) has both, and the steps for
[adding a source](testing.md#adding-a-job-source).

So the live services are checked by hand. Since 2026-11-16 the samples follow what they return. Run from a home
connection on that date, searching "software engineer" near Austin, TX:

| Source | Result |
| --- | --- |
| Greenhouse, Lever, Ashby, SmartRecruiters, Workday, Amazon Jobs | Working. All 33 catalog companies on these systems resolve. |
| Workday, on 2026-11-24 | Blocked. In the first search from Sloan's desktop, all eight catalog companies on Workday were answered 429 with a bot check. Nobody has looked into why ([status.md](status.md#known-gaps)). |
| Company auto-discovery | Working (found Duolingo on Greenhouse from the typed name). |
| LinkedIn public pages | Working: 30 results per search, full descriptions on open. |
| Remote OK | Working. |
| Remotive | Working, but its public feed now carries only about 17 jobs in total. |
| Google for Jobs through JSearch from OpenWeb Ninja | Working with Sloan's key since 2026-11-24. The first search brought 20 postings in about 4 seconds. Asked without a key, the service answers 401, as the adapter expects. |
| Google for Jobs through JSearch on RapidAPI, or through SerpAPI | Not yet run: needs a key. The RapidAPI route was moved to `/search-v2` on 2026-11-24 without a live check. |
| USAJOBS | Not yet run: needs a key. The endpoint is reachable and asks for one. |
| Indeed headless browser | Not run. |

To re-check, run `cd server && npm run smoke`. It prints one row per source: PASS, EMPTY (the source answered but had
nothing for that search, with the count for the same search in any city alongside), FAIL, BLOCKED or SKIPPED.
