# 0003. Everything happens inside the app

- **Status:** Accepted
- **Date:** 2026-11-16
- **Decided by:** Sloan

## Context

LinkedIn, Indeed, Glassdoor and ZipRecruiter do not let other sites read their listings. The first proposal was
that a search would open those sites in new tabs with the filters filled in, and show only the open sources inside
the app. Sloan turned that down in strong terms: the tool has to be one unified experience, and if a user has to
leave the site at any point to get a job, the project has failed. Sloan was willing to run a backend with an
automated browser to get there, as long as it was tested thoroughly.

## Decision

Every listing is shown and read inside the app, in one merged list. Listings from boards without open access come
in by these routes, in order of preference ([job-sources.md](../job-sources.md)):

1. A Google for Jobs data service (JSearch or SerpAPI, a paid key), which carries most of what LinkedIn, Indeed,
   Glassdoor and ZipRecruiter post.
2. The public feeds of hiring systems (Greenhouse, Lever, Ashby, SmartRecruiters, Workday, Amazon). Free.
3. The USAJOBS API. A free key.
4. Direct routes to a board's public pages. Off unless the server enables them and the user switches on "Direct
   site access".

A link to the original posting is always there. It is an option for the user, never a step they need.

## Consequences

- The app needs a server: keys must stay secret, and most of these sources refuse calls from a browser
  ([0005](0005-a-static-app-plus-one-server-run-on-the-laptop-first.md)).
- The big boards cost money to include: without a Google for Jobs key their listings are simply absent. Buying a
  key is Sloan's call and is still open ([status.md](../status.md)).
- What the app shows for those boards is what Google has indexed, which is most listings and not all.
- How far the direct routes may go is settled in [0007](0007-no-bot-check-bypass.md).
- Sloan later asked for the other direction too: a user must be able to see and update an application on the real
  site easily ([applications-plan.md](../applications-plan.md), section 7.4). In the app by default, with a way out.

## In the code

- `src/jobs/aggregate.ts`: `planSearch` picks the routes for a search, `mergeJobs` folds the same job from several
  boards into one posting that lists every board.
- `src/jobs/adapters/`: one file per kind of source.
- `src/jobs/aggregate.test.ts`, `src/jobs/jobs.property.test.ts` and `test/integration/search-server.test.ts`.
