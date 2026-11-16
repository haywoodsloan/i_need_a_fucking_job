# Job sources

Every source is an adapter (`src/jobs/adapters/*`) that turns one site's data into the shared `JobPosting` shape.
`src/jobs/aggregate.ts` fans a search out to the selected adapters in parallel, reports per-source status, and merges
duplicates (same company + title + city) into one posting that lists every board it was found on.

## Routes, in order of preference

| # | Route | Covers | Cost | Risk / upkeep |
| --- | --- | --- | --- | --- |
| 1 | **Google for Jobs API** (JSearch on RapidAPI, or SerpAPI) | LinkedIn, Indeed, Glassdoor, ZipRecruiter, Dice, Built In, Wellfound, Monster, employer sites | Paid per search, small free tier. Check current pricing before subscribing. | Low. The vendor absorbs scraping risk. Coverage is whatever Google has indexed, which is most but not all listings. |
| 2 | **ATS public APIs** (Greenhouse, Lever, Ashby, SmartRecruiters, Workday, Amazon Jobs) | Any employer on those systems | Free | Low. These feeds exist so career pages can embed them. |
| 3 | **USAJOBS API** | All federal postings, filterable by agency (FAA, NASA, VA, …) | Free key | Low. Official API. |
| 4 | **LinkedIn public pages** (`ENABLE_LINKEDIN_GUEST=1`) | LinkedIn listings beyond what Google indexed | Free | Medium/high. Against LinkedIn's terms, rate-limited per IP, HTML changes without notice. The server says what it is (no browser disguise), sends one request at a time, and stops when LinkedIn refuses it. |
| 5 | **Headless browser** (`ENABLE_PLAYWRIGHT=1`) | Indeed | Free software, but realistically needs a paid residential proxy | High. Strong bot detection, frequent breakage, against the site's terms. |

Routes 4 and 5 are off unless the server enables them **and** the user turns on "Direct site access" in settings.
Neither ever logs in or uses anyone's account.

Glassdoor and ZipRecruiter are reachable only through route 1 today.

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

Adapters are tested against sample payloads (`src/jobs/jobs.test.ts`), and since 2026-11-16 those samples follow what
the live services return. Run from a home connection on that date, searching "software engineer" near Austin, TX:

| Source | Result |
| --- | --- |
| Greenhouse, Lever, Ashby, SmartRecruiters, Workday, Amazon Jobs | Working. All 33 catalog companies on these systems resolve. |
| Company auto-discovery | Working (found Duolingo on Greenhouse from the typed name). |
| LinkedIn public pages | Working: 30 results per search, full descriptions on open. |
| Remote OK | Working. |
| Remotive | Working, but its public feed now carries only about 17 jobs in total. |
| Google for Jobs (JSearch or SerpAPI) | Not yet run: needs a key. |
| USAJOBS | Not yet run: needs a key. The endpoint is reachable and asks for one. |
| Indeed headless browser | Not run. |

To re-check, run `cd server && npm run smoke`. It prints one row per source: PASS, EMPTY (the source answered but had
nothing for that search, with the count for the same search in any city alongside), FAIL, BLOCKED or SKIPPED.
