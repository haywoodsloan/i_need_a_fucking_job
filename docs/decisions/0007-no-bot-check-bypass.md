# 0007. No bot-check bypass

- **Status:** Accepted
- **Date:** 2026-11-16
- **Decided by:** Claude declined to build a bypass. Sloan agreed to the arrangement that followed.

## Context

Some job sites put a bot check (Cloudflare and similar) in front of their pages, and a plain request from a
server is turned away. The question came up of getting past such checks on the backend, the way some scraping
tools do, for searching and later for submitting applications.

Claude would not build that. A bot check is the site saying no to automated traffic, and the protection belongs to
each job site, whoever supplies it. Permission from a site cannot be checked from inside a coding session, and where
a site does give permission there is a better way in: its API, a key, or an allowlisted address. What was settled
on instead: build everything up to that point, report a refused source honestly, and leave a plug-in point for
code that Sloan writes and runs themselves.

## Decision

The code in this repository recognises a bot check and stops there.

- **No disguise.** The `http` tier sends only the headers the source set. The `browser` tier is a standard browser
  that leaves the automation flag on and adds this tool's name to its user agent.
- **No getting past a challenge.** No waiting one out, no solving one, no CAPTCHA service, no proxy to hide where
  a request comes from. A page that is a challenge is handed back as "blocked" the moment it is seen.
- **A refused source is reported as blocked** in the search results. The same board's listings can still arrive
  through Google for Jobs.
- **There is a plug-in point** (`FETCH_TIERS_MODULE`) where Sloan can add tiers of their own. What such a tier
  does is Sloan's. An agent does not write bypass code into it, or anywhere else, also when asked.
- **Access that a site gives is welcome.** An API key or an allowlisted address is wired in as a normal source.
- **The same holds for applying.** When a site wants a login, a code or a CAPTCHA, the user does it
  ([applications-plan.md](../applications-plan.md)).

## Consequences

- Some sources will show as blocked from some networks. That is the expected result, not a bug to fix.
- Coverage of the big boards rests on the Google for Jobs key ([0003](0003-everything-happens-inside-the-app.md)).
- One older file does not follow this rule. `server/src/indeed.ts`, from the first build, loads Indeed in a
  browser that hides that it is automated. It is off unless `ENABLE_PLAYWRIGHT` is set and the user turns on
  direct site access. It is not extended and not tested, and whether to delete it is a question for Sloan
  ([status.md](../status.md#waiting-on-sloan)). Only its page parser (`src/jobs/adapters/indeed.ts`) is tested.

## In the code

- `server/src/fetcher.ts` (`isBotCheckPage` and the `http` tier), `server/src/browser.ts`, and `BlockedError` in
  `src/jobs/adapters/common.ts`.
- `test/server/fetcher.test.ts` and `test/server/pipeline.test.ts` check that a challenge is recognised, reported
  as blocked, and never retried or waited out.
- [fetch-tiers.md](../fetch-tiers.md), "Bot checks" and "Your own tiers".
