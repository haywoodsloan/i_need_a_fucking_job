# 0002. The search page is one bar, with the sources behind a gear

- **Status:** Accepted
- **Date:** 2026-11-16
- **Decided by:** Sloan

## Context

Sloan described the search page before it was built, down to the wording of the placeholder.

## Decision

- The page opens with the site title and one search bar, with a small gear at the right end of the bar.
- The bar's placeholder is "What type of role are you looking for?". Once the user starts typing, more fields
  appear inside the same box: location, distance, and remote or on-site.
- The gear is for how and what the search looks through, in two parts:
  1. **Job boards.** The big existing boards (LinkedIn, Indeed and so on), picked as the ones most used for jobs
     that pay about $50,000 a year or more. That is an estimate used to choose the list, not a filter on results.
  2. **Companies and industries, marked experimental.** The user types a name into a box that offers matches
     (Microsoft, Amazon, Google, Boeing, the FAA, government postings) and can pick whole industries. It builds
     on the fact that many employers rent the same few hiring systems, which behave the same for every customer.

## Consequences

- The first screen stays simple. Everything about sources lives in one settings panel.
- The experimental part covers only employers whose hiring system has an adapter. Sloan named Dayforce as one to
  use. It is not built yet, and neither is iCIMS ([job-sources.md](../job-sources.md)).
- A company that is not in the catalog can still be typed in. The server then looks for its board
  (`server/src/discover.ts`).

## In the code

- `src/ui/SearchPage.tsx`, `src/ui/SettingsPanel.tsx`.
- `src/jobs/boards.ts` (the boards and which are on by default), `src/jobs/catalog.ts` (companies, industries and
  the hiring system each one uses).
- `src/ui/SearchPage.test.tsx` and `src/ui/SettingsPanel.test.tsx` check the behaviour described here.
