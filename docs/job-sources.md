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
| 4 | **LinkedIn public pages** (`ENABLE_LINKEDIN_GUEST=1`) | LinkedIn listings beyond what Google indexed | Free | Medium/high. Against LinkedIn's terms, rate-limited per IP, HTML changes without notice. |
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
| SmartRecruiters | `api.smartrecruiters.com/v1/companies/{id}/postings` | `Visa` |
| Workday | `{tenant}.wd{n}.myworkdayjobs.com/wday/cxs/{tenant}/{site}/jobs` | `boeing` / `EXTERNAL_CAREERS` |

Three ways a typed company resolves:

1. **Catalog** (`src/jobs/catalog.ts`): curated companies tagged by industry and system.
2. **Auto-discovery** (`server/src/discover.ts`): the server tries slug guesses of the typed name against each
   system and caches the one that answers. This is how companies outside the catalog work with no setup.
3. **Fallback**: a Google for Jobs search filtered to that employer, for companies with fully custom sites (Google, Microsoft, Apple, Meta).

Picking an industry adds every catalog company tagged with it.

**Not built yet:** Dayforce and iCIMS. Their public job feeds vary per customer and need hands-on research against live sites.

## Verification status

Adapters are tested against sample payloads shaped like each API's documented response (`src/jobs/jobs.test.ts`).
They have **not yet been run against the live services**, because the environment this was built in blocks those
hosts. Before relying on a source, run `cd server && npm run smoke` from a machine with normal internet access; it
prints a per-source pass/fail table. Catalog board ids are best-known values and are confirmed by the same run.
