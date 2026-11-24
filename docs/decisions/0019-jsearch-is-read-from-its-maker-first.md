# 0019. JSearch is read from its maker first

- **Status:** Accepted
- **Date:** 2026-11-24
- **Decided by:** Sloan chose the service. Claude chose the order and the details, which are defaults.

## Context

The listings of LinkedIn, Indeed, Glassdoor and ZipRecruiter come in through a service that reads Google for Jobs
([0003](0003-everything-happens-inside-the-app.md)). The first build supported two: JSearch, with a key from the
RapidAPI marketplace, and SerpAPI. Neither had ever been run with a key.

When Sloan went to get the JSearch key, RapidAPI would not let them in: "RapidAPI isn't working right, it gives me
an error when I try to setup and account. We need another options".

What was on the table:

- **SerpAPI.** Already supported here. Its own index of Google for Jobs, 250 free searches a month.
- **Adzuna.** A free API, but it is Adzuna's own listings and not Google's, it gives a summary of each posting and
  not the text, and it asks to be credited on the page.
- **JSearch from its maker.** OpenWeb Ninja, who make JSearch, also sell it on their own site: the same service
  with a different address, and a key that goes in a different header.

Sloan found the third themselves and settled it: "I found OpenWeb Ninja has JSearch. I've got an API key now".

## Decision

Google for Jobs is read through JSearch with a key from OpenWeb Ninja. The two older ways in stay.

- **Three settings, one in use.** The server uses the first of these that is filled in: `OPENWEBNINJA_API_KEY`,
  then `JSEARCH_API_KEY` (the RapidAPI key), then `SERPAPI_KEY`. The maker's own door comes first because it is
  the one Sloan has, and it has one company less in the middle.
- **JSearch is one source with two doors.** One piece of code reads both. A door is an address, a header for the
  key, and a setting. Anything else that differs between them would be a bug.
- **A failed service is reported, not replaced.** When the service in use turns a search down, the results say so
  in its own words and name the setting to look at. The search does not go on to the next service: that would
  spend a second allowance without anyone having asked for it.
- **What a search costs is a setting.** `GOOGLE_JOBS_PAGES` says how many pages of ten a search asks for. It stays
  at two, as before. Every page is one request of the plan.

## Consequences

- Nobody needs a RapidAPI account. A person who has one can still use it.
- A key only works at the door it was bought at. A key in the wrong setting is turned down by the service, and the
  message says which setting it was read from.
- The free plan stops at 200 requests a month. When it is used up, the big boards' listings stop arriving until
  the next month and every other source carries on. Whether to pay, or to lower `GOOGLE_JOBS_PAGES`, is Sloan's
  call.
- The RapidAPI door was moved to the search that JSearch lists today, to keep the two doors the same. That was
  done from the service's description, with no key to try it.
- A reason to look at this again: the allowance turns out too small in daily use. The choices then are a paid
  plan, fewer pages, or letting a search fall over to SerpAPI's free allowance. The last one changes the third
  point above, so it needs Sloan.

## In the code

- `src/jobs/adapters/googleJobs.ts`: the two doors and what they share (`jsearchThrough`), the pages setting, and
  SerpAPI.
- `src/jobs/aggregate.ts`: `googleJobsAdapter` holds the order.
- `src/jobs/adapters/googleJobs.test.ts` and `src/jobs/aggregate.test.ts` fail if a key travels in an address,
  if the order changes, or if a search moves on to a second service.
- `test/fixtures/sources/openwebninja.json` and `test/fixtures/sources/jsearch.json`: one stored answer for each
  door.
- `server/.env.example` names the settings. [job-sources.md](../job-sources.md#google-for-jobs-the-key-and-what-a-search-costs)
  has how to get a key and what a search costs.
