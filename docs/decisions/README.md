# Decisions

Why things are the way they are. One record per decision, in the order they were made.

Read the record before you change something it covers. **Decided by** tells you how firm it is: a choice Sloan
made stays until Sloan changes it, so ask. A default that Claude picked can be changed when there is a reason, by
writing a new record.

Questions that are still open are not here. They are in [status.md](../status.md#waiting-on-sloan).

| # | Decision | Date | Decided by |
| --- | --- | --- | --- |
| [0001](0001-applications-use-the-users-own-words.md) | Applications use the user's own words | 2026-11-16 | Sloan |
| [0002](0002-the-search-page-is-one-bar-with-sources-behind-a-gear.md) | The search page is one bar, with the sources behind a gear | 2026-11-16 | Sloan |
| [0003](0003-everything-happens-inside-the-app.md) | Everything happens inside the app | 2026-11-16 | Sloan |
| [0004](0004-work-lands-on-main-without-pull-requests.md) | Work lands on main without pull requests | 2026-11-16 | Sloan |
| [0005](0005-a-static-app-plus-one-server-run-on-the-laptop-first.md) | A static app plus one server, run on the laptop first | 2026-11-16 | Sloan and Claude |
| [0006](0006-job-sources-are-reached-through-a-pipeline-of-tiers.md) | Job sources are reached through a pipeline of tiers | 2026-11-16 | Sloan and Claude |
| [0007](0007-no-bot-check-bypass.md) | No bot-check bypass | 2026-11-16 | Claude |
| [0008](0008-resume-is-read-in-the-browser-by-rules.md) | The resume is read in the browser, by rules | 2026-11-16 | Claude |
| [0009](0009-linkedin-and-indeed-logins-wait.md) | LinkedIn and Indeed logins wait; employer systems come first | 2026-11-17 | Sloan |
| [0010](0010-sign-in-is-built-here-not-bought.md) | Sign-in is built here, not bought | 2026-11-17 | Claude |
| [0011](0011-accounts-are-invite-only-and-run-from-a-command-line.md) | Accounts are invite-only and managed from a command line | 2026-11-17 | Claude |
| [0012](0012-the-local-database-is-pglite-behind-a-small-interface.md) | The local database is PGlite, behind a small interface | 2026-11-17 | Claude |
| [0013](0013-no-web-framework-on-the-server.md) | No web framework on the server | 2026-11-17 | Claude |
| [0014](0014-accounts-are-off-until-they-are-set-up.md) | Accounts are off until they are set up | 2026-11-17 | Claude |
| [0015](0015-job-html-is-sanitized-and-the-app-runs-under-a-strict-policy.md) | Job site HTML is sanitized, and the app runs under a strict policy | 2026-11-17 | Claude |
| [0016](0016-how-the-code-is-tested.md) | How the code is tested | 2026-11-17 | Claude |
| [0017](0017-how-the-documentation-is-organized.md) | How the documentation is organized | 2026-11-17 | Claude |

Dates are UTC. Every record so far has the status Accepted.

## Adding a record

Write one when you choose between real alternatives, or when Sloan does: a rule for the product, a technology, a
way of working, something deliberately left out. A bug fix or a refactoring needs no record.

1. Copy [0000-template.md](0000-template.md) to the next free number, with a short name in lower case with
   dashes: `<number>-short-name.md`.
2. Fill it in. One decision, about one screen. Use Sloan's own words where they made the decision.
3. Add a row to the table above, with the record's title and date as they are in the file.
4. If it replaces an older record, change that record's Status line to
   `Replaced by [<number>](<number>-short-name.md)`. Leave the rest of the old record as it was.

## What may change in a record later

A record says what was known and chosen on its day. Its Context, Decision and Consequences are not edited
afterwards, also when they name a file that has since moved or gone. Three things are kept alive, because a dead
pointer helps nobody:

- the **Status** line, when a newer record replaces it;
- a **link** whose target was renamed;
- the paths under **In the code**, so the record still leads to where the decision lives now.

`test/docs/docs.test.ts` checks the numbering, the headings, the table, the links, and the paths under
"In the code".
