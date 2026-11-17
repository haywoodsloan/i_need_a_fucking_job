# 0009. LinkedIn and Indeed logins wait; employer systems come first

- **Status:** Accepted
- **Date:** 2026-11-17 (06:18 UTC, the evening of 2026-11-16 for Sloan, which is the date the plan gives)
- **Decided by:** Sloan

## Context

The plan for tracking and sending applications asked seven questions. The one that changes the scope most was
whether the first version should log in to LinkedIn and Indeed for its users. Both sites prohibit automated
access, so logging in from a server risks verification prompts and restricted accounts for the user. Sloan also
asked whether either site supports third-party apps. They do not for a tool like this: LinkedIn's job APIs are
open only to approved recruiting vendors, and Indeed's remaining APIs are for employers and their software.

## Decision

Not yet. The first version applies inside the app through the employer's own hiring system (Greenhouse, Lever,
Ashby, Workday) whenever a posting has one. Applications made on LinkedIn and Indeed are tracked by one click or by
import, each with a link to the site. Glassdoor, ZipRecruiter and Dice wait in any case.

## Consequences

- The build order starts with a tracker that needs no logins, then the employer systems
  ([applications-plan.md](../applications-plan.md), section 15).
- If this is reopened, the routes not taken are an opt-in experimental connector behind a risk warning, or a
  browser extension (plan, section 6.5). Partner API access from either site would also change the picture.
- The plan's other six questions are still open, with a recommended default each ([status.md](../status.md)).

## In the code

Nothing yet. The decision is recorded in [applications-plan.md](../applications-plan.md), section 2.
