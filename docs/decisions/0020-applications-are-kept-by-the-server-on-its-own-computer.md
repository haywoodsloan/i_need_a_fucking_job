# 0020. Applications are kept by the server, on its own computer

- **Status:** Accepted
- **Date:** 2026-11-24
- **Decided by:** Sloan decided that the applications are saved on their computer, and that the app does not start by itself. Claude chose how they are kept, which is a default.

## Context

Sloan has an assistant find jobs and prepare applications: it fills each employer's form in a browser, up to
Submit. A filled form lived only in its browser tab, and a restart of the computer emptied every tab. Sloan, on
2026-11-24: "I'd like to be able to have you find the jobs prepare the applications and even if I restart my
computer you should be able to resume the application where you left off."

That needs a record of each application outside any tab. The [plan](../applications-plan.md#7-tracking-applications)
has one, the tracker of its step 1, and puts it in the user's account, encrypted. Whether application records may
be stored at all was its open decision 5. Three places were on the table:

- **In the account, as planned.** Accounts are off on Sloan's computer, and an assistant has no way to sign in.
  It is the right place for friends on a hosted copy, which does not exist yet.
- **In the browser,** where the resume is. The user's browser and the assistant's browser are two browsers, so
  neither would see what the other saved, and the record would go when a browser's data is cleared.
- **In a folder on the computer, kept by the app's server.** Both browsers reach the same server.

Sloan was asked on a card: "Save your applications and their drafted answers in the app, on your PC?" The option
said what it meant: "The app's server keeps each application, its status and its answers in a folder on your PC.
Drafts are marked as drafts. Your browser and the Claude browser see the same list." Sloan chose it: "Yes, save
them on my PC".

A second card asked about the hours after a restart: "Start the job app by itself when you sign in to Windows?"
Sloan chose: "No, start it when needed". That option said: "Nothing is added to your PC. After a restart, a Claude
session starts the app before it can search or reopen your applications, which takes a few minutes."

## Decision

The app's server keeps the applications, as files in a folder on the computer it runs on.

- **One readable file for each application,** in `server/.data/applications/`. The files are the record: the server
  reads them again for every request, replaces a file in one step, keeps the versions before a change, and never
  deletes or writes over what it cannot read.
- **No sign-in, so only on its own computer.** Whoever can reach the tracker can read and change every
  application. A server keeps applications only where it answers its own computer and nothing passes other
  people's requests on to it, and every single request is checked again. A server that other computers can reach
  keeps none. [applications.md](../applications.md#where-the-tracker-is-on) has the conditions.
- **The resume itself still stays in the browser** ([0008](0008-resume-is-read-in-the-browser-by-rules.md)). The
  app sends no resume file and no parsed resume to the server. What the tracker holds is what goes into a form,
  put there by whoever filled the form in: the user on the page, or an assistant.
- **Nothing starts by itself.** No startup entry, no scheduled task, no service. Whoever needs the app after a
  restart starts it. The applications are files, so nothing is lost while it is not running.
- **The place is replaceable.** The routes reach the records through two small interfaces
  (`server/src/applications/records.ts`). A hosted copy can put the account database behind them later.

## Consequences

- An application survives a restart of the browser, the app and the computer, and a form can be filled in again
  from its record. The user and an assistant see the same applications.
- A backup is a copy of the folder. A file can be read, corrected or put back by hand.
- The folder is not encrypted. It holds names, contact details and answers about a person's work. It is as
  private as the user's account on the computer, and any program running there could read it.
- A hosted copy has no tracker. For friends, the plan's version is still to be built: records in the account,
  encrypted, behind the sign-in. This record answers decision 5 of the plan only for a person's own computer.
- The applications live on one computer. Moving them is an export and an import.
- After a restart the app is down until someone starts it, which is what Sloan chose over a startup entry. Asking
  again is the way to change that.
- A reason to look at this again: hosting for friends, or Sloan wanting the applications on a second device.

## In the code

- `server/src/applications/store.ts`: the folder, the one-step replace, the earlier versions, what is done with a
  file that cannot be read.
- `server/src/applications/index.ts`: `readApplicationsConfig` decides whether a server keeps applications.
- `server/src/applications/http.ts`: the check of every request.
- `server/src/applications/records.ts`: the two interfaces a later store has to offer.
- `test/server/applications-store.test.ts`, `test/server/applications.test.ts`: the files and the checks.
- `test/integration/applications-restart.test.ts`: a server process is ended on the spot and started again, and
  every application is as it was left. It also fails if a server that other computers can reach keeps any.
