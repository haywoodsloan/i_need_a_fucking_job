# Documentation

Everything written down about this project, and which file is the home of which fact.

Starting a task? Read [AGENTS.md](../AGENTS.md), then [status.md](status.md), then the top of
[worklog.md](worklog.md). After that, only what the task touches.

## The files

| File | Kind | It is the home of | Change it when |
| --- | --- | --- | --- |
| [AGENTS.md](../AGENTS.md) | Entry point | The rules, the map of the code, the commands, what "done" means | A rule, a top-level folder or a command changes. Keep it short: it is read in full at the start of every session. |
| [README.md](../README.md) at the root | For a person arriving | What the app is, how to run it, how to deploy it | Running or deploying it changes |
| [status.md](status.md) | State | What is built, what is next, what waits on Sloan, known gaps | Any of those changes. It is rewritten, so it is always about today. |
| [worklog.md](worklog.md) | Log | What was done, when, and what was found on the way | Every change that lands. Add at the top, leave the rest. |
| [decisions/](decisions/README.md) | Records | Why: one decision per file, with who decided | A choice between real alternatives is made. A record is never rewritten. |
| [architecture.md](architecture.md) | Reference | How the parts fit: the folders, what happens during a search, a resume upload and a sign-in, what is stored where, what must stay true | A part is added, moved or connected differently |
| [testing.md](testing.md) | Reference | How to run, place and write tests, and what is not tested | The test setup or its rules change |
| [job-sources.md](job-sources.md) | Reference | Every job source: its route, cost and risk, what the live services taught us, what was verified and when | A source is added, changed or checked again |
| [fetch-tiers.md](fetch-tiers.md) | Reference | How the server reaches job sources, what it does at a bot check, how to write a tier | The pipeline or the contract of a tier changes |
| [resume-model.md](resume-model.md) | Reference | The resume fields and their guarantee, how a resume is parsed, its limits | The model or the parser changes |
| [accounts.md](accounts.md) | Reference | Sign-in as built: commands, what is stored, keys, sessions, routes, settings, limits | Anything about accounts changes |
| [applications-plan.md](applications-plan.md) | Plan | What is intended: the tracker, the login vault, applying, Claude, hosting, the threat model, the build order, the open decisions | A step is built (mark it there), or the plan changes |

The settings of the server are explained in `server/.env.example`, next to the settings themselves.

## Four kinds, kept apart

- **Reference** says how a part works now. It changes in the same commit as the code.
- **Plan** says what is intended. It says clearly what is built and what is not.
- **Record** says why something was chosen, on the day it was chosen. It does not change afterwards.
- **Log and state** say what was done (`worklog.md`, added to) and where things stand (`status.md`, rewritten).

Mixing them is how docs go stale: a plan that reads like a description, or a description that still argues for a
choice made long ago. If you are not sure where a sentence belongs, ask what would make it untrue. If the answer is
"a code change", it is reference. "A decision by Sloan": a record or the plan. "Time passing": the log or the
status.

## Rules for writing here

- **One home for each fact.** Everywhere else links to it. Before you write something down, look whether it
  already has a home in the table above.
- **Say what the code cannot.** Why, what for, what must not happen, what was tried. Do not describe line by line
  what a function does. That goes stale, and the code says it better.
- **Plain words and short sentences.** Sloan reads these too. Explain a term the first time it appears.
- **Paths from the repository root, in backticks:** `server/src/app.ts`. Links to other docs are relative:
  `[testing.md](testing.md)`. Both are checked, so a renamed file fails a test instead of leaving a dead pointer.
- **No counts that go stale** in reference docs ("92 tests", "33 companies"). Put a number in `status.md` or the
  log, where it has a date.
- **Sloan's own words** are quoted where they made a decision. They are the requirement. A summary of them is
  not.
- **If a doc and the code disagree,** find out which one is wrong before you build on either. For how something
  works, the code is right and the doc gets fixed. For a rule (the decisions, the rules in `AGENTS.md`), the doc is
  right and the code has a bug.

## What the test checks

`test/docs/docs.test.ts` runs with the other tests and reads `AGENTS.md`, the root `README.md` and everything in
`docs/`. It fails when:

- a link points at a file that is not there, or at a heading that is not in that file;
- a path in backticks does not exist, or a file named in backticks is nowhere in the repository;
- an `npm run` command names a script that neither `package.json` has;
- a decision record is misnumbered, lacks its status, date and "decided by" lines or one of its four headings, or
  is missing from the index;
- the work log is not dated and newest first, or `status.md` lacks its date or a section other docs link to;
- `AGENTS.md` grows past 120 lines.

It cannot tell whether a sentence is true. That part is yours.
