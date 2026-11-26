# Applications

The application tracker as it is built: what the app keeps about each job application, where it keeps it, who can
reach it, and how an assistant works on the same applications as the user. What is still intended, such as
applying from inside the app, is in [applications-plan.md](applications-plan.md). Why the tracker is built this way
is in the decision records [0020](decisions/0020-applications-are-kept-by-the-server-on-its-own-computer.md),
[0021](decisions/0021-an-answer-is-marked-with-who-wrote-it.md) and
[0022](decisions/0022-the-server-answers-its-own-computer-unless-told-otherwise.md).

Contents: [What it is for](#what-it-is-for) · [Where the tracker is on](#where-the-tracker-is-on) ·
[Where the applications are kept](#where-the-applications-are-kept) ·
[What an application holds](#what-an-application-holds) · [Who may change what](#who-may-change-what) ·
[The pages](#the-pages) · [The routes](#the-routes) · [A file of applications](#a-file-of-applications) ·
[Working on the applications as an assistant](#working-on-the-applications-as-an-assistant) ·
[After a restart](#after-a-restart) · [Known limits](#known-limits)

## What it is for

Sloan, on 2026-11-24: "I'd like to be able to have you find the jobs prepare the applications and even if I
restart my computer you should be able to resume the application where you left off."

Until then a prepared application lived in a browser tab: the employer's form, filled in up to Submit. A restart
emptied every tab. Now each application is a record on the computer's disk. It holds the job, the stage, the address
of the form, and every question of the form with what goes in it and who wrote that. Whoever opens the app after a
restart finds every application as it was left, and a form can be filled in again from its record.

Two kinds of people and programs work on the records:

- **The user**, on the app's Applications page.
- **An assistant**: an AI agent that works for the user outside the app, such as a Claude session with a browser
  on the same computer. It finds jobs, fills forms and writes first drafts, and it talks to the tracker's routes.

The app itself writes no answers and fills no forms. It keeps the record and shows it
([rule 1](../AGENTS.md#rules-that-do-not-bend)).

## Where the tracker is on

The tracker has no sign-in. Whoever can reach it can read and change every application. So a server keeps
applications only where nobody but the user of its own computer can reach it. All four of these must hold:

| What must hold | The setting that says so |
| --- | --- |
| The server answers this computer only | `HOST` is empty, or `localhost`, `127.0.0.1` or `::1` |
| No proxy passes other people's requests on to it | `TRUST_PROXY` is empty or 0 |
| It is not marked as a hosted copy | `NODE_ENV` is not `production` |
| Nobody switched the tracker off | `APPLICATIONS` is not `0` (or `off`, `false`, `no`) |

When it starts, the server prints which it is: `applications: kept on this computer, in <folder>`, or
`applications: off (<the reason>)`. `GET /api/health` answers with `"applications": true` or `false`.

| How the app runs | Applications |
| --- | --- |
| The public demo on GitHub Pages | None. That copy has no server of its own, and it does not ask for a tracker. |
| `npm run local` and `npm run local:built` on your own computer | Kept |
| A hosted copy (`server/Dockerfile` sets `HOST=0.0.0.0`) | None, until they can be kept behind a sign-in ([the plan](applications-plan.md#70-as-built-in-step-1)) |

The page finds out by asking `GET /api/applications`. A server that keeps none answers
`{ "available": false, "applications": [] }` there, and 404 for everything else under that address. The menu has
its "Applications" link only where the answer is yes.

### Every request is checked as well

The settings above decide whether the tracker exists. On top of that, each request is answered only when it comes
from the computer the server runs on (`server/src/applications/http.ts`):

- The connection comes from this computer, and no header says a proxy passed it on for someone else.
- It was sent to `localhost`, `127.0.0.1` or `[::1]` by name. A page somewhere else cannot reach the tracker
  through a name of its own that points at this computer.
- When a browser sent it, the page it came from is the app's own: the same address the request went to. A page of
  another site is turned down, also for reading.
- A request that changes something carries JSON, which a page of another site cannot send without asking first.
  The tracker never answers that question: none of its replies carries a CORS header, also for an address the
  search routes allow.

A request that fails a check gets 403 with a sentence that says why, and nothing about any application. It is
turned down by what it says about itself, before the server keeps or reads anything it carries. So a page of
another site, which can send any amount of text to an address on this computer, costs the server nothing.

### The server answers this computer only

Since the tracker was added, the whole server listens on this computer's own addresses only, unless `HOST` says
otherwise (`server/src/listen.ts`). `http://localhost:8787` works on the computer itself and nowhere else. This
also keeps other devices on the same network from running searches that spend the owner's search plan.
`HOST=0.0.0.0` makes the server answer other computers, which a hosted copy needs, and such a server keeps no
applications.

## Where the applications are kept

In `server/.data/applications/`, next to the account database. The folder is gitignored. `APPLICATIONS_DIR` names
another folder.

```
applications/
  globex-staff-technical-writer.json            one application, as it is now
  history/globex-staff-technical-writer/
    000001.json  000002.json  ...                 its earlier versions, the newest thirty
  removed/
    initech-senior-technical-writer.<time>.json      an application that was removed
    initech-senior-technical-writer.<time>.history/  with its earlier versions
```

- **The files are the record.** They are plain, readable JSON, and the server reads them again for every request.
  A file that is put back or corrected by hand counts at once, with no restart.
- **A file is replaced in one step.** A crash or a power cut in the middle of a change leaves the old version or
  the new one, never half of each.
- **A change does not lose what was there.** Every change keeps the version before it, up to the newest thirty.
  Removing an application moves its file into the `removed` folder. To put one back, move the file back and
  rename it to `<id>.json`.
- **A file that cannot be read is left alone.** The list names it and says what is wrong with it. The server never
  writes over it.
- **A backup** is a copy of the folder, or the file that "Export" gives.
- **Nothing in the folder is encrypted.** It holds what the forms ask for: a name, an email address, a phone
  number, an address, answers about work history. The folder is as private as the user's account on the computer.
- **One server for one folder.** Two servers that write to the same folder at the same time can undo each other's
  changes.

## What an application holds

`src/apply/model.ts` defines the record and checks every part of it. It is strict: a part it does not know is
turned down by name, and never dropped in silence.

| Part | What it is |
| --- | --- |
| `id` | Lower-case letters, digits and single dashes, such as `globex-staff-technical-writer`. Also the name of the file. Made from the company and the title when none is given. |
| `revision` | Goes up by one with every change. |
| `job` | The job as it was when it was saved: `title`, `company`, `postingUrl`, and when known `location`, `workplace`, `pay`, `postedAt`, `listings` (every place the posting was seen) and the posting's text (`descriptionHtml` or `descriptionText`). |
| `stage`, `stageSetBy` | Where the application stands, and who said so: `user`, `assistant` or `site`. |
| `submittedAt` | When the stage first said it was sent. |
| `form` | `url` (where the form is filled in), `notes` (what someone filling it again has to know) and `fields`: every question of the form, in the form's order. |
| `timeline` | What happened, oldest first: who added it, every change of stage, and notes. Each line says who wrote it. |

**Stages** are the plan's: `saved`, `drafting`, `ready`, `submitting`, `submitted`, `in_review`, `assessment`,
`interview`, `offer`, `rejected`, `withdrawn`, `closed` and `unknown`. The pages group them. In progress: `saved`,
`drafting`, `ready`, `submitting`, `unknown`. Sent: `submitted` to `offer`. Closed: `rejected`, `withdrawn`,
`closed`.

### A question of the form

| Part | What it is |
| --- | --- |
| `id` | Like an application's id, unique inside the application. The form's own field name is a good one. |
| `label` | The question as the form words it. |
| `kind` | `text`, `longtext`, `choice` (a dropdown, radio buttons, Yes and No buttons: the value is the option's text, and where several can be ticked, one option on each line), `checkbox` (the value is `checked` or empty) or `file`. |
| `required` | Whether the form marks it required. |
| `value` | Exactly what is typed or picked in the form. Empty when nothing is. |
| `status` | See below. |
| `origin` | Who wrote the value: `user`, `assistant` or `form`. Left out while the value is empty. |
| `acceptedAt` | When the user kept an assistant's draft as it is. |
| `note` | Where the value came from, or what to watch. |

The four statuses:

| Status | Meaning | On the page |
| --- | --- | --- |
| `filled` | Settled. This is what goes in the form. | Under "Answers" |
| `draft` | A first draft that the user still reviews or rewrites. | "Drafts to review" |
| `ask` | Waits for a fact only the user knows, such as a street address or a portfolio link. Always empty. | "Needs your answer" |
| `yours` | Only the user does this, on the form itself: a pledge, an acknowledgment, a consent, a demographic question, a file to attach. Nobody else fills it. | "Only you, on the form" |

"Left for you" on the pages is every `ask`, every `draft` and every `yours`. The count in the list leaves out the
`yours` questions that the form does not require.

### Who wrote an answer

Every answer says who wrote it ([0021](decisions/0021-an-answer-is-marked-with-who-wrote-it.md)):

| `origin` | Meaning |
| --- | --- |
| `user` | Typed by the user on the app's own page. Only this is the user's own words. |
| `assistant` | Written by an assistant: a first draft, or a fact it filled in from the resume. |
| `form` | Read back from the live form by an assistant. The user may have typed it there. |

Nothing turns an assistant's text into the user's. When the user keeps a draft as it is, the answer is settled and
gets the time in `acceptedAt`, and its origin stays `assistant`. The page then says "Written by your assistant.
You kept it as it is." When the user rewrites it, the new text is theirs.

## Who may change what

A change says who is making it, in `by`: `user` or `assistant`. Left out, it is `assistant`. Only a request from a
page can say `user`, and the app's page is the only page the tracker answers. `changeApplication` in
`src/apply/model.ts` holds the rules, and `src/apply/model.test.ts` has a test for each.

| | The user, on the page | An assistant |
| --- | --- | --- |
| Add an application, change the job's facts, the form's address and notes, add a note | Yes | Yes |
| Add a question, or change one that an assistant wrote | Yes | Yes, while the application is in progress |
| Change an answer the user wrote, or a draft the user kept | Yes | No |
| Change an answer that was read from the form | Yes | Only with a newer reading of the form (`"origin": "form"`) |
| Fill a `yours` question, or make it anything else | Yes | No. An `ask` can become `yours`, not the other way round. |
| Mark a value as the user's own words | It is, when saved on the page | Never |
| Change the answers of an application that was sent or closed | Yes | No. They are the record of what was sent. |
| Set the stage | Any | Any, except back to "in progress" from sent or closed |
| Remove an application | Yes | No. It sets the stage to `withdrawn` or `closed` instead. |

A change is all or nothing. One part of it that is wrong or not allowed, and nothing changes. The reply says which
part, in a sentence.

`by` keeps an honest caller from marking its own text as the user's by mistake. It is not a lock: see
[Known limits](#known-limits).

## The pages

`src/ui/ApplicationsPage.tsx`, at `#/applications` and `#/applications/<id>`.

- **The list** has a table each for what is in progress, what was sent and what is closed, with the stage and what
  is left for the user. "Add an application" takes a title, a company and a link, for a job found somewhere else.
  "Import a file" and "Export" read and write [a file of applications](#a-file-of-applications).
- **One application** shows the job, links to the form and the posting, the stage (a list to pick from), and "Left
  for you": the questions that need an answer with a box each, the drafts with "Save my version" and "Keep as it
  is", and what only the user does on the form. Below that, folded away: every answer with who wrote it and a
  "Change" button, the notes about filling the form, and the posting as it was saved. Then notes and history, and
  "Remove".
- **A search result** has "Save to applications" (`src/ui/SearchPage.tsx`). It keeps the posting as the search gave
  it. A posting that is tracked already shows where it is instead, whichever board it was found on.

What the user types is saved as typed: nothing trims, corrects or rewrites it. A posting's HTML came from a job
site, so it is kept as it came and goes through `sanitizeHtml` where it is shown
([rule 4](../AGENTS.md#rules-that-do-not-bend)).

An assistant may be changing the same application while the page is open. The page asks the server again when the
window gets the focus back, and every quarter of a minute while it is in view. It never shows an older version
after a newer one, and a box the user is typing in keeps what they typed. "Keep as it is" and "Leave it empty"
agree to what the page shows, so they are sent with the revision the page has: when the application changed in the
meantime, nothing is saved and the page shows it as it is now.

## The routes

All under `/api/applications`, answered as JSON and never cached. `src/apply/api.ts` has the shapes.

| Route | Body | Answers |
| --- | --- | --- |
| `GET /api/applications` | | `{ available, applications, unreadable }`: a summary of each, newest change first, and the files that could not be read |
| `POST /api/applications` | `{ by?, application }` | 201 and `{ application, existed: false }`. When the posting is tracked already: 200, `existed: true`, and the application that is there. Nothing is added twice. |
| `GET /api/applications/<id>` | | `{ application }`, whole |
| `POST /api/applications/<id>` | `{ by?, revision?, changes }` | `{ application }` as it is after the change. With `revision`, the change is turned down (409, `changed`) when the application has another revision by now, and the reply holds it as it is. |
| `POST /api/applications/<id>/remove` | `{ by: "user" }` | `{}`. Only from the page. |
| `GET /api/applications/export` | | [A file of applications](#a-file-of-applications), all of them, whole |
| `POST /api/applications/import` | The file itself, or `{ by?, file }` | `{ added, skipped }`: the ids that were added, and for each entry that was not, what it was and why |

`changes` may hold any of: `job` (the parts to replace), `stage`, `form` (`url`, `notes`), `fields` (questions to
add or change, by `id`: only the parts that are sent change, and a new one needs `label` and `status`),
`removeFields` (ids) and `note` (a line for the timeline).

A request that is turned down gets `{ error, code }`. `error` is a sentence for whoever sent it.

| Status | `code` | When |
| --- | --- | --- |
| 400 | `invalid` | What was sent is not an application, or not a change to one. The sentence names the part. |
| 400, 405, 413 | `bad_request` | Not JSON, not an object, a method the address does not take, or too large (4 MB, and 32 MB for an import) |
| 403 | `not_local`, `bad_origin` | The request did not come from this computer, or came from a page that is not the app's |
| 403 | `refused` | The one who sent it may not make this change ([who may change what](#who-may-change-what)) |
| 404 | `not_found` | No such application, or no such address |
| 409 | `changed`, `exists`, `full` | It changed since `revision`, the id is taken, or the tracker holds 2,000 applications |
| 500 | `server_error` | The tracker failed. The server's log says how. It never logs what was sent. |

## A file of applications

What "Export" gives and "Import a file" takes. It is also how applications that were prepared before the tracker
existed got into it.

```json
{
  "format": "job-hunt-applications",
  "version": 1,
  "applications": [
    {
      "id": "example-staff-technical-writer",
      "job": {
        "title": "Staff Technical Writer",
        "company": "Example",
        "location": "Remote, United States",
        "postingUrl": "https://jobs.example.com/postings/1",
        "listings": [{ "via": "Example", "url": "https://jobs.example.com/postings/1" }, { "via": "LinkedIn" }]
      },
      "stage": "drafting",
      "form": {
        "url": "https://jobs.example.com/postings/1/apply",
        "notes": "Pick the location from the list before typing the text fields.",
        "fields": [
          { "id": "first-name", "label": "First Name", "kind": "text", "required": true, "value": "Jordan", "status": "filled", "note": "From the resume" },
          { "id": "why", "label": "Why do you want to work here?", "kind": "longtext", "required": true, "value": "A first draft.", "status": "draft" },
          { "id": "start", "label": "When can you start?", "kind": "text", "required": true, "value": "", "status": "ask" },
          { "id": "resume", "label": "Resume/CV", "kind": "file", "required": true, "value": "", "status": "yours" }
        ]
      },
      "timeline": [{ "at": "2026-11-24T21:05:00Z", "text": "Form filled up to Submit." }]
    }
  ]
}
```

- An entry has the parts of [an application](#what-an-application-holds). Only `job.title`, `job.company` and
  `job.postingUrl` are required.
- Importing only adds. An entry whose id or posting is here already is left out and named in the reply, with the
  reason, and so is an entry with a part the app does not know. The other entries are still added.
- Who wrote what is believed from a file the user chose on the page, which is how an export is put back with
  "Your words" still marked. In a file an assistant sends, every answer is an assistant's unless it says `form`.
- An `ask` or a `yours` question with a value in it is turned down.

## Working on the applications as an assistant

For an AI agent with a shell on the computer that runs the app. The tracker answers at the server's own address,
`http://localhost:8787`. Use that name: the tracker does not answer at another name for the same computer.

```
curl http://localhost:8787/api/applications
curl http://localhost:8787/api/applications/example-staff-technical-writer
curl -X POST -H "Content-Type: application/json" --data-binary "@change.json" http://localhost:8787/api/applications/example-staff-technical-writer
```

In Windows PowerShell, write `curl.exe`. Put the JSON in a file and send the file: quoting JSON on a command line
goes wrong. The file for a form that was just filled in:

```json
{
  "changes": {
    "stage": "drafting",
    "form": { "url": "https://jobs.example.com/postings/1/apply", "notes": "Pick the location before the text fields." },
    "fields": [
      { "id": "first-name", "label": "First Name", "kind": "text", "required": true, "value": "Jordan", "status": "filled", "note": "From the resume" },
      { "id": "why", "label": "Why do you want to work here?", "kind": "longtext", "required": true, "value": "The whole draft, as typed into the form.", "status": "draft" },
      { "id": "pledge", "label": "I wrote these answers myself", "kind": "checkbox", "required": true, "value": "", "status": "yours", "note": "A pledge. Only the user ticks it." }
    ],
    "note": "Form filled in up to Submit."
  }
}
```

The rules that keep the record honest:

- **Leave `by` out.** What you send is an assistant's. You cannot mark anything as the user's words, and the tracker
  turns down a change to an answer that is theirs.
- **Record every question of the form,** in the form's order, also the ones left empty. The record is what the
  form is filled in from next time.
- **A first draft is `draft`,** never `filled`. A fact from the resume is `filled`, with a note that says where it
  came from.
- **A question that needs a fact only the user knows is `ask`,** and empty. When the user answers on the page, the
  answer is theirs. When they answer you in a message instead, send it as `filled` or `draft` with a note saying
  so. It is then marked as written by an assistant, which is true: you typed it.
- **A pledge, an acknowledgment, a consent, a demographic question and a file to attach are `yours`,** and empty.
  You do not fill these on the form either.
- **After filling a form, read it back** and compare it with the record. A value that differs from what you typed
  was changed on the form, perhaps by the user: save it with `"origin": "form"`.
- **Add a note** for anything the next session has to know, and keep `form.notes` true: the order that works, a
  control that misbehaves.
- **Set the stage** as the work goes: `drafting` while the form is being prepared, `ready` when only the user's part
  is left. The user presses Submit, and sets the stage to "Sent" on the page, or tells you to.

## After a restart

The app does not start by itself. Sloan was asked on 2026-11-24, "Start the job app by itself when you sign in to
Windows?", and chose: "No, start it when needed". So nothing is added to the computer's startup, and whoever needs
the app starts it. Do not add a startup entry, a scheduled task or a service without asking again.

Nothing is lost in between: the applications are files, not something a running server holds.

1. **Is the app running?** `curl http://localhost:8787/api/health` answers with `"applications": true` when it is.
2. **If not, start it** in the repository's folder with `npm run local`, in a window of its own, and leave it
   running. It serves the app at `http://localhost:5173` and the server at `http://localhost:8787`. An assistant
   has to start it in a way that outlives its own session. On Windows that takes three things. Start the window
   outside the job that holds the session's processes, or it ends with the session. Give it the environment
   Windows builds for the signed-in user, and not the session's own, which can hold keys. Set the window's title
   again once the app is up, because npm puts its own title on it. Closing the window stops the app, and loses
   nothing.
3. **Read the list:** `GET /api/applications`. Every application is there as it was left, with its stage and what
   is left for the user.
4. **Put a form back** when its browser tab is gone. Open `form.url`. Follow `form.notes`. Type every answer whose
   status is `filled` or `draft`, exactly as its `value`. Leave every `ask` and every `yours` question as the form
   has it. Then read the form back, compare, and add a note that says the form was filled in again.
5. **Go on from there.** The user reviews on the Applications page, at `http://localhost:5173/#/applications`.

## Known limits

- **The tracker is not behind a lock on the computer itself.** Any program that runs on the computer, under any
  of its users, can ask the server what a page or an assistant asks, and any program that runs as the user can
  read and change the files. That is the same trust the user's own documents have. What is kept out is everything
  that is not on the computer: other devices on the network, and pages of other sites in the user's browser.
- **`by` is not a lock either.** A program on the computer could send what the page sends. The marks say who wrote
  what among callers that follow the rules.
- **One computer.** The applications are not shared between devices. "Export" and "Import a file" move them.
- **No hosted copy keeps applications.** Keeping them in an account, encrypted, for friends on a hosted copy is
  still the plan and is not built ([applications-plan.md](applications-plan.md#70-as-built-in-step-1)).
- **Not built from step 1 of the plan:** filling in a job from a pasted link, importing a spreadsheet or another
  tracker's export, and checking whether a posting is still listed.
- **The folder only grows.** Earlier versions beyond the newest thirty are dropped, and nothing else ever is. A
  removed application stays in the `removed` folder until someone deletes it by hand.
- **The app does not check a form.** Whether the record matches what is in the employer's form is the work of
  whoever filled it in.
