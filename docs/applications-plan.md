# Accounts, site logins and application tracking: design plan

**Status:** Two steps of the build order ([15](#15-build-order)) are built. Step 0, accounts and sign-in, is
described in [accounts.md](accounts.md), and where it differs from this plan is listed in
[4.6](#46-as-built-in-step-0). Step 1, the tracker, is built for a person's own computer and described in
[applications.md](applications.md), and where it differs is listed in [7.0](#70-as-built-in-step-1). Nothing else in
this document is built yet. Written 2026-11-16. Decision 1 was made the same day. Decision 5 was made in part on
2026-11-24. Decisions 2 to 7 are otherwise still open ([2](#2-decisions-for-sloan)). Step 0 follows the recommended
answer to decision 4.

This is the plan for the phase after job search and the resume analyzer: user accounts, safe storage of each user's
logins for job boards and hiring systems, tracking applications, submitting them from inside the app, where Claude
fits, hosting, and the threat model.

It keeps the two rules the project already has:

- **Your words, verbatim.** Applications are filled only from verified resume fields and answers the user typed.
- **No bot-check bypass.** When a site wants a login, a code or a CAPTCHA, the user does it. The app never solves or
  dodges one. This is the same rule the fetch tiers in this repository already follow for search
  ([fetch-tiers.md](fetch-tiers.md)).

Contents: [1 What was asked](#1-what-was-asked-and-where-the-plan-answers-it) ·
[2 Decisions](#2-decisions-for-sloan) · [3 Starting point](#3-starting-point) · [4 Accounts](#4-accounts-and-sign-in) ·
[5 Login vault](#5-the-login-vault) · [6 Connectors](#6-acting-on-other-sites-connectors) ·
[7 Tracking](#7-tracking-applications) · [8 Submitting](#8-submitting-applications) · [9 Claude](#9-using-claude) ·
[10 Lighter models](#10-a-cheap-home-for-lighter-models) · [11 Hosting](#11-hosting) · [12 Data model](#12-data-model) ·
[13 Threat model](#13-threat-model) · [14 Repo changes](#14-changes-to-the-repo) · [15 Build order](#15-build-order) ·
[16 To confirm](#16-to-confirm-on-live-sites) · [17 Sources](#17-sources)

## 1. What was asked and where the plan answers it

| Asked for | The plan's answer | Section |
| --- | --- | --- |
| Store site logins securely, readable by the backend only while the user is signed in and making the request | Each user's logins are encrypted with a key that is locked twice: by their password for storage, and by their session cookie for use. The server never stores anything that opens either lock by itself. | [5](#5-the-login-vault) |
| Updates and checks only while the user is signed in, no background task | Checks run when the user opens the tracker or presses Refresh. Nothing is scheduled, so the server can sleep when nobody is signed in. | [7.3](#73-checks-happen-only-while-signed-in) |
| Easy to see and update an application on the real site | Every application has an "Open on *site*" control that goes to the most specific page that site offers, says which account it is under, and can show the login. | [7.4](#74-open-on-the-real-site) |
| Claude (Fable 5.2 preferred) for resume breakdown and for figuring out new job boards and applications | Fable 5.2 does resume breakdown, resume review and board discovery. Code checks everything it returns. Paid from the plan's monthly API credits, roughly $2.50 to $5 per active user per month. | [9](#9-using-claude) |
| A cheaply hosted lighter model on Azure or Hugging Face for simpler automation | Not worth hosting at this size. Haiku 5.5 on the same API key costs cents a month. The Azure credit is for dev and test only and cannot pay for Claude. | [10](#10-a-cheap-home-for-lighter-models) |

## 2. Decisions for Sloan

Decision 1 is made, and decision 5 in part. The others are open: each has a recommended default, and the rest of
this plan assumes those defaults.

| # | Decision | Recommended | If you choose otherwise |
| --- | --- | --- | --- |
| 1 | Should the first version log in to LinkedIn and Indeed from our server? (Glassdoor, ZipRecruiter and Dice wait in any case.) | **Decided 2026-11-16: not yet.** Apply in-app through the employer's own system (Greenhouse, Lever, Ashby, Workday) whenever a posting has one. Track LinkedIn and Indeed applications by one click or import, each with a link to the site. | The routes not taken, if this is reopened: an opt-in experimental connector behind a risk warning, or a browser extension ([6.5](#65-why-the-big-boards-wait)). Both sites prohibit automated access, so either route risks verification prompts and restricted accounts. |
| 2 | Who presses the final Submit? | **The user**, on the real form, after reviewing it in the app. | Automatic submit can be allowed per site later, once that site's connector has a clean record. |
| 3 | Where does it run, and do we buy a domain? | **Yes to a domain** (about $10 to $15 a year), because sign-in cookies need the app and the API on one site. Laptop first, Azure credits for a staging copy, then choose the friends-facing host. | Staying on `github.io` plus a separate API host means weaker sign-in security and breaks in Safari ([11](#11-hosting)). |
| 4 | Is it acceptable that a forgotten password loses the stored site logins? | **Yes.** It is the price of logins that we cannot read. A recovery code given at sign-up avoids the loss, and tracker data survives either way. | Making logins recoverable by us means the server can open the vault without the user, which removes the guarantee asked for. |
| 5 | May data leave the browser? Today the resume never does. | **Yes, in two ways.** Application records and what was submitted are stored encrypted in the account. Resume text goes to the Claude API only for users who switch AI help on. **Decided in part 2026-11-24:** on a person's own computer the app's server keeps the applications in a folder there ([0020](decisions/0020-applications-are-kept-by-the-server-on-its-own-computer.md)). Still open: records in an account on a hosted copy, and resume text to the API. | Without storage there is no cross-device tracker. Without the API the built-in rules parser still works. |
| 6 | May AI suggest wording? | **No.** AI gives feedback and points at text. Nothing it writes can enter an application. | Suggestions the user accepts would need a third, visible origin label ("AI-assisted") next to `source` and `user`. |
| 7 | Host a small model ourselves? | **No, not now.** Use Haiku 5.5 for light tasks and revisit if light calls pass about $10 a month. | See the options and prices in [10](#10-a-cheap-home-for-lighter-models). |

On decision 6: the app still writes nothing. Since 2026-11-24 the tracker holds first drafts that an assistant
outside the app wrote for Sloan, and every answer is marked with who wrote it
([0021](decisions/0021-an-answer-is-marked-with-who-wrote-it.md)). That is the "visible origin label" of the last
column, built for the records. It does not answer decision 6. Whether the app's own AI may suggest wording, and
whether the app may send an assistant's text when it fills forms itself in Step 2, is still Sloan's to decide.

## 3. Starting point

What existed when this plan was written, from the code:

- A static React app on GitHub Pages. The resume is parsed and stored only in the browser (`src/lib/storage.ts`).
- `server/` is a stateless search proxy: no users, no database, no cookies. All outbound requests go through the
  tier pipeline in `server/src/fetcher.ts` (cache, plain HTTP, an optional headless browser). Its built-in tiers
  report a bot check as `blocked` and never work around one.
- `toApplicationProfile(resume)` in `src/resume/model.ts` returns only verified fields and throws if any value
  differs from its source. It is already the single gate for anything that fills an application.
- Each posting carries the board link and an apply link (`JobListing.url`, `applyUrl` in `src/jobs/types.ts`), and
  duplicate postings are merged so one job lists every place it was found.
- `npm run local` runs the frontend and backend together on one machine.

What this phase adds: accounts, a database, the login vault, the tracker, connectors that act on sites, and a model
layer. What it changes: two written promises need rewording when the relevant parts ship ("The resume never touches
the backend" in the README and "No AI and no network" in `docs/resume-model.md`), and GitHub Pages alone can no
longer host the signed-in app.

## 4. Accounts and sign-in

### 4.1 Who can sign up

The app is for Sloan and friends, so sign-up is **invite-only**. The admin creates a one-time invite link from a
command (`npm run admin -- invite name@example.com`) and sends it personally. Password resets work the same way. That
means no email service is needed for the first version.

The username is the person's email address. Every user has their own password.

### 4.2 Why sign-in is built here and not bought

The password does two jobs: it proves who the user is, and it unlocks their vault. Hosted login services (Auth0,
Clerk, Supabase Auth and similar) take the password on their own page and never show it to our server, so they cannot
do the second job. "Sign in with Google" has no password at all. Both could be added later with a separate vault
passphrase, but that is two secrets for the user instead of one.

So sign-in is written in `server/` from standard, well-reviewed parts, with nothing invented:

| Piece | Choice |
| --- | --- |
| Password hashing and key derivation | Argon2id, 64 MiB memory, 3 passes, 1 lane, per-user random salt. The OWASP floor is 19 MiB and 2 passes. Parameters are stored per user so they can be raised later. |
| Pepper | A 32-byte server secret mixed into Argon2id, kept in the host's secret store and never in the database. A stolen database alone then cannot be used to guess passwords. |
| Encryption | AES-256-GCM and HKDF-SHA256 from Node's built-in `crypto`. No custom ciphers. |
| Password rules | At least 14 characters, because this one password also guards the vault. Checked against known-breached passwords at sign-up. No forced symbols, paste and password managers allowed. |
| Web framework | Node's built-in HTTP server, as before. Fastify was the first choice here. In Step 0 the account routes turned out small enough to write as plain functions from a request to a reply, which keeps them testable without a running server and adds no dependency. A framework is looked at again when the live view needs WebSockets ([6.3](#63-the-live-view)). |

### 4.3 Sessions

- One cookie, `__Host-session`: `HttpOnly`, `Secure`, `SameSite=Strict`, `Path=/`. It holds a random 256-bit token.
  The server stores only a one-way derivative of it, so a database leak yields no usable sessions.
- A session lasts 7 days idle and 30 days at most. The account page lists sessions and has "sign out everywhere".
- The **vault** has its own, shorter clock: it locks after 60 minutes without vault use, and there is a "Lock now"
  button. Browsing the tracker does not need it. Unlocking again means typing the password.
- Typing the password again is also required to reveal a stored login, export the vault, connect a new site, change
  the password or delete the account.
- Every state-changing request must come from our own origin (`Origin` and `Sec-Fetch-Site` checks) and carry JSON.
- Sign-in and unlock attempts are limited per account and per address, and Argon2id runs a few at a time so a burst
  of attempts cannot exhaust memory. Unknown emails get the same answer and timing as wrong passwords.

### 4.4 Recovery

- At sign-up the user is shown a **recovery code** once (24 characters) and asked to save it. It can unlock the
  vault key by itself.
- Forgot the password, has the code: set a new password, nothing is lost.
- Forgot both: the admin issues a reset link. The account, tracker and resume data survive. The stored site logins
  are erased, and the user reconnects those sites. A reset link can never open a vault, so a hijacked email or a
  tricked admin cannot leak anyone's logins.

### 4.5 Later, not now

Passkeys (which can also unlock the vault on devices that support the PRF extension), a second factor for our own
sign-in, and deriving the key in the browser so the password never reaches the server at all.

### 4.6 As built in Step 0

Step 0 built 4.1 to 4.4 and the keys of [5.2](#52-keys). [accounts.md](accounts.md) is the reference for what
exists. What differs from the text above:

- **No web framework.** See the last row of the table in 4.2.
- **The cookie on a laptop.** `__Host-session` needs HTTPS. On `http://localhost` the cookie is named `session` and
  has no `Secure` flag. Everything else about it is the same.
- **The vault key exists, the vault does not.** Every account has its vault key, locked by the password, by the
  recovery code, and by the session while unlocked. Locking, unlocking and the 60-minute clock work on the server
  and are tested. There is no "Lock now" button yet, because nothing is stored under the key until Step 2.
- **Recovery codes and reset links are built,** ahead of Step 4, where the build order first listed them.
- **Typing the password again** is asked for changing the password, a new recovery code, deleting the account and
  unlocking the vault. Revealing a login, exporting and connecting a site arrive with the vault.
- **The per-user data key** for class D data ([12](#12-data-model)) is not there yet. It arrives with the first
  class D table, in Step 1. Row-level security waits for the same step: the Step 0 tables are reached only through
  one service that always filters by account.
- **The local database is PGlite,** as hoped in [11.2](#112-options). Only one process can open it, so admin
  commands go through the running server.
- **The admin commands** are `setup`, `invite`, `reset`, `users` and `sign-out`.
- **Two ways to get one origin.** For development, Vite passes the account routes on to the backend. The server
  can also serve the built app itself, with the strict Content Security Policy (`npm run local:built`). A hosted
  copy will have that second shape.

## 5. The login vault

### 5.1 The idea in plain words

Each user has one random **vault key**. Every stored login is encrypted with it. The vault key itself is never
stored in the clear. It is stored locked, in up to three copies:

1. Locked by a key made from the **password**. This is how it rests in the database.
2. Locked by a key made from the **recovery code**.
3. While signed in and unlocked: locked by a key made from the **session token**, which exists only in the user's
   cookie.

Copy 3 is what makes "only while the user is signed in and making the request" true. To use a login, the server
needs the locked copy from its database **and** the token that arrives with the user's request. No request, no key.
Signing out, locking or expiry deletes the server's half. Clearing the cookie removes the other half.

### 5.2 Keys

```
password ── Argon2id(salt, pepper) ──► master ── HKDF "auth" ──► auth key ── SHA-256 ──► verifier   (database)
                                              └─ HKDF "vault" ─► password key ── locks ──► vault key (copy 1)

recovery code ── HKDF ──► recovery key ── locks ──► vault key (copy 2)

session token (cookie only) ── HKDF "sid" ──► session id            (database, lookup only)
                            └─ HKDF "wrap" ─► session key ── locks ──► vault key (copy 3, deleted on lock)

vault key ── AES-256-GCM ──► each stored login, bound to its owner and item id
```

Knowing the verifier or the session id does not help with the keys next to them: HKDF outputs are independent.
Each encrypted login is bound to its user id and item id, so a row copied to another user or another slot fails to
decrypt instead of opening.

### 5.3 What is stored where

| State | Database | Server memory | User's browser |
| --- | --- | --- | --- |
| Signed out | Encrypted logins. Vault key locked by password and by recovery code. | Nothing | Nothing |
| Signed in, vault locked | The same, plus a session row | Nothing | Session cookie |
| Signed in, vault unlocked | The same, plus the vault key locked by the session key | The vault key and one login, only while a request or job that needs them runs | Session cookie |

The database alone, the server's disk alone, or the cookie alone never opens the vault.

### 5.4 A request that uses a login

```
Browser                                Server                                         Database
  │ POST /api/applications/42/check      │                                               │
  │ Cookie: session token ──────────────►│ derive session id and session key from token  │
  │                                      │ load the session ────────────────────────────►│ user, locked vault key, expiry
  │                                      │ unlock the vault key (memory only)            │
  │                                      │ decrypt the one login this job needs ◄────────│ encrypted login
  │                                      │ run the check in an isolated browser          │
  │                                      │ wipe the vault key and the login from memory  │
  │◄──────────────── result ─────────────│ save status, re-encrypt the site's cookies ──►│
```

Only a short list of requests ever unlocks the vault key: connect a site, check status, fill an application, reveal
a login, export. Everything else (search, browsing the tracker, the resume pages) never touches it.

### 5.5 What goes in the vault

| Kind | What | Used for |
| --- | --- | --- |
| `session` | The site's cookies and local storage, captured after the user signs in to that site themselves | Preferred. Works with codes, two-factor and Google sign-in, and we never hold the password. |
| `password` | Username and password for sites with plain password logins, mainly per-employer Workday accounts | Signing in again when a session expires, and letting the user look the login up later. Essential for accounts the app helps create. |
| `token` | An official API or OAuth token, where a site offers one | Rare today. |
| Sensitive answers | Demographic, disability, veteran status and salary answers saved for reuse | Treated like logins, so the operator cannot read them. |

Never stored: two-factor codes or authenticator seeds, security-question answers, payment details, Social Security
numbers.

### 5.6 Jobs end with the session

Work that uses a login (a status check, filling a form) runs as a job in server memory.

- A job starts only from a signed-in request with the vault unlocked.
- It ends when the session ends: sign-out, lock and expiry cancel it and wipe its secrets.
- It may run unattended for five minutes at most. Time the user spends driving the live view does not count.
- Jobs are never written to disk or queued. A server restart drops them.
- An application interrupted at the very last step is marked **Unknown, check on site**, with the link.

### 5.7 What the user controls

A "Connected sites" page lists every stored login with when it was added and last used, and offers Disconnect
(deletes it), Show login (password required), Export all, and an activity log such as "Workday · Boeing: used at
14:02 for a status check".

### 5.8 The honest limit

This design makes a stolen database, a stolen backup or a curious operator unable to read anyone's logins. It
cannot make a **running** server blind: while a user is active, their password, vault key and the login in use pass
through server memory. Someone who takes over the live server can capture those for users who are active during
that time. Friends who use the app are trusting whoever deploys it. The plan limits that window and makes use
visible, and [13](#13-threat-model) says what is left.

## 6. Acting on other sites: connectors

### 6.1 One connector per site

A connector is the logged-in counterpart of a search adapter in `src/jobs/adapters`. Each one declares what it can
do and which hosts it may touch.

```ts
interface SiteConnector {
  id: string;                                   // 'greenhouse', 'workday', ...
  label: string;
  risk: 'low' | 'medium' | 'high';              // shown to the user before they connect
  auth: 'none' | 'password' | 'interactive';    // interactive = the user signs in themselves in the live view
  hosts: string[];                              // the only hosts its browser may visit
  can: { apply: boolean; listApplications: boolean; status: boolean };
  links(app: Application): { application?: string; portal?: string; posting: string };
  describeForm?(posting: JobPosting): Promise<FormSpec>;       // the questions, before touching the site
  fill?(run: ConnectorRun, plan: FillPlan): Promise<FillResult>; // fills and stops before Submit
  listApplications?(run: ConnectorRun): Promise<RemoteApplication[]>;
  checkStatus?(run: ConnectorRun, app: Application): Promise<RemoteStatus>;
}
```

### 6.2 How a connector reaches a site, cheapest first

This follows the tiered idea already used for search ([fetch-tiers.md](fetch-tiers.md)).

1. **Public API, no login.** For example Greenhouse's public Job Board API returns a posting's application
   questions with no key, and tells us whether a posting is still open.
2. **Server browser, unattended.** For steps that need no person: filling fields, reading a status page with a
   stored session.
3. **Server browser with the user driving** through the embedded live view: sign-ins, codes, CAPTCHAs, the final
   review and Submit.
4. **Hand-off link.** If a site will not work with an automated browser at all, the app says so and opens the real
   site in a new tab.

No tier tries to solve or avoid a bot check. A challenge pauses the job and moves it to tier 3, then tier 4. The
logged-in connectors use a normal browser with no detection-hiding flags, no fingerprint spoofing and no proxy
rotation. (The Indeed search route in `server/src/indeed.ts` sets a flag that hides automation. Connectors must not
inherit it.)

Anything sent with a user's login stays out of the search fetch pipeline in `server/src/fetcher.ts`. That pipeline's
cache is shared by all users (its key is the request, not who asked), and its plug-in tiers (`FETCH_TIERS_MODULE`)
are handed every request's headers. Public, signed-out reads such as Greenhouse's question list can keep using it.

### 6.3 The live view

This is how the user stays inside the app while a real site needs them.

- A Chromium page on the server is streamed into the app, and the user's clicks and keys are sent back to it. A
  banner always shows which site is on screen.
- During sign-in the app does not record what is typed. Afterwards it captures the session state and encrypts it.
- Keystrokes pass through our server to reach the remote browser, so the live view has the same trust level as the
  vault.
- On the laptop ("local mode") the live view is simply a visible browser window. That is the first version to
  build, because that is where connectors can be tested against real sites. It can open the Edge or Chrome already
  installed, through the `BROWSER_CHANNEL` setting the search browser tier uses, so nothing new is installed.
- The stream is built on Chromium's own screencast feature and stays on our server. Hosted browser services exist,
  but they would put another company in the middle of users' logins.
- A video stream is not usable with a screen reader. The hand-off link is the accessible path.
- One job per user at a time, and a small global limit (two or three browsers on a 2 GB machine) with a visible
  queue.

### 6.4 Rollout by risk

| Site | How logins work there | In-app apply | Status | Risk | When |
| --- | --- | --- | --- | --- | --- |
| Greenhouse | None to apply. Its candidate portal, MyGreenhouse, signs in by emailed code. | Assisted fill. Questions come from the public API. | Only what the employer shares in MyGreenhouse. Otherwise the user sets it. | Low | Phase 2 |
| Lever | None * | Assisted fill | No applicant portal *. The user sets it. | Low | Phase 2 |
| Ashby | None * | Assisted fill | No applicant portal *. The user sets it. | Low | Phase 2 |
| Workday | One account per employer, email and password * | Assisted fill of the multi-step form | The employer's candidate home lists each application * | Medium | Phase 3 |
| SmartRecruiters, iCIMS, Taleo, SuccessFactors, Dayforce | Mostly one account per employer * | Later, by demand | Later | Medium | Later |
| LinkedIn | Password plus frequent verification * | Not in the first version | Import or one click | High | Later (decision 1) |
| Indeed | Emailed code or Google sign-in * | Not in the first version | One click | High | Later (decision 1) |
| Glassdoor, ZipRecruiter, Dice | Varies * | No | One click | High | Later |
| USAJOBS | login.gov with two-factor * | Never automated | One click and link | Not applicable | Phase 1 |

\* From general knowledge, not yet checked against the live site. Each is confirmed when its connector is built, the
same way the search adapters were corrected against live services ([16](#16-to-confirm-on-live-sites)).

Checked for this plan: Greenhouse's public API needs no key for reading and returns a posting's questions,
including compliance and demographic ones, while submitting through that API needs the employer's secret key, so the
app fills the hosted form instead. MyGreenhouse is password-free, shows status only when the employer shares it, and
does not let a candidate edit or withdraw a submitted application.

### 6.5 Why the big boards wait

Decision 1 settled this for the first version: no LinkedIn or Indeed logins from our server. The reasons:

- LinkedIn's User Agreement prohibits bots and automated access, and it publishes a list of prohibited software and
  extensions. Indeed and the others have similar terms. Storing a user's password for them is itself against those
  terms.
- These sites challenge sign-ins from servers constantly, and they restrict accounts they believe are automated.
  For a job seeker, a restricted LinkedIn account costs far more than the convenience gained.
- Many postings found on those boards point at an employer system anyway. Search already merges those listings, so
  the in-app path is "apply through the employer's system". The gap is postings that can only be applied to on the
  board itself, such as LinkedIn Easy Apply.

If decision 1 is reopened later, there are two routes: an opt-in experimental connector with an explicit risk screen, or
a companion browser extension that works inside the user's own signed-in browser. The extension needs no stored
login and sees far fewer challenges, but it means an install, desktop only, and LinkedIn also acts against
extensions it detects.

## 7. Tracking applications

### 7.0 As built in Step 1

Step 1 is built for one case: a person who runs the app on their own computer, which is how Sloan uses it.
[applications.md](applications.md) is the reference for what exists. 7.1 to 7.5 are still the plan for a hosted
copy, and for the parts that are not built. What differs from them:

- **Where the records are.** The plan keeps them in the user's account, encrypted (class D in
  [12](#12-data-model)). The built tracker keeps them as readable files in a folder on the computer the server
  runs on, with no account and no encryption, and only where nobody else can reach that server
  ([0020](decisions/0020-applications-are-kept-by-the-server-on-its-own-computer.md)). A hosted copy keeps no
  applications. The routes reach the records through two small interfaces, so the account database can go behind
  them later without a change to the pages.
- **An assistant works on the records.** In the plan the app fills the forms (Step 2). Today an assistant outside
  the app prepares each application in a browser, up to Submit, and writes it into the tracker. So the tracker's
  routes are made for a program as much as for the page, and every change says who made it.
- **The record holds the form before it is sent.** [7.5](#75-what-was-submitted) keeps what was submitted. The
  built record holds every question of the form from the day it is prepared: what goes in it, whether that is
  settled, a first draft, a question for the user, or something only the user does, and who wrote it
  ([0021](decisions/0021-an-answer-is-marked-with-who-wrote-it.md)). Once the application is marked as sent, an
  assistant can no longer change its answers, so they stand as the record of what was sent. The resume file's hash
  and the site's confirmation are not kept yet.
- **Who set a stage** is `user`, `assistant` or `site`, one more than [7.1](#71-what-a-tracked-application-holds)
  has. Nothing reads a stage from a site yet. The mark `site` is kept for that day, and for now it only arrives in
  a file the user imports.
- **How applications get in ([7.2](#72-how-applications-get-into-the-tracker)).** Built: one click on a search
  result ("Save to applications"), adding a job by hand with its title, company and link, importing a file in the
  app's own format, which is what "Export" writes, and an assistant adding them through the routes. Not built:
  filling in a job from a pasted link, importing a spreadsheet, another tracker's export or LinkedIn's data
  export, and syncing from a site's own list.
- **No checks ([7.3](#73-checks-happen-only-while-signed-in)).** Nothing asks a site about an application, and the
  "posting closed" check of the build order is not built. The user or an assistant sets the stage.
- **Open on the real site ([7.4](#74-open-on-the-real-site))** is two plain links, to the form and to the posting.
  No login is stored, so there is no account line and no "Show login".
- **Nothing starts by itself.** After a restart of the computer someone starts the app, and the applications are
  there as they were left ([applications.md](applications.md#after-a-restart)).
- **The server answers its own computer only,** unless a setting says otherwise
  ([0022](decisions/0022-the-server-answers-its-own-computer-unless-told-otherwise.md)). That came with the
  tracker, because it has no sign-in.

### 7.1 What a tracked application holds

- The job as it was when applied to: title, company, location, posting link, description text, every board it was
  found on.
- Stage, and who set it (`site` or `user`). The site's own wording is kept next to it, for example "Workday says:
  Under Consideration".
- Links: the application, the site's "my applications" page, and the posting.
- Which connected login it belongs to.
- A snapshot of what was submitted ([7.5](#75-what-was-submitted)).
- A timeline: every stage change, check, note and submission.
- When it was last checked and what that check found.

Stages: `saved`, `drafting`, `ready`, `submitting`, `submitted`, `in_review`, `assessment`, `interview`, `offer`,
`rejected`, `withdrawn`, `closed` (posting taken down) and `unknown` (interrupted, check on site).

### 7.2 How applications get into the tracker

1. Applied through the app: recorded automatically.
2. One click on any search result: "Save" or "I applied".
3. Paste a link: the app recognises the hiring system from the address and fills in the job from its public feed.
4. Import a file: a spreadsheet, another tracker's export, or LinkedIn's account data export, which includes job
   application activity (file layout to confirm with a real export).
5. Sync from a connected site's own list: Workday candidate homes and MyGreenhouse.

Routes 2 to 4 need no stored login at all, so the tracker is useful from Phase 1.

### 7.3 Checks happen only while signed in

- A check runs when the user opens the tracker and the last check is older than a few hours, or when they press
  Refresh. Each site has a minimum gap between checks.
- Progress shows per site, like the table of sources on the search page. Every application shows "Checked 3 h ago".
- If the vault is locked the tracker shows what it last knew, with "Unlock to refresh".
- If a site wants the user to sign in again, the row says "Needs sign-in" with a Reconnect button.
- There is no scheduler, no queue and no push. Nothing runs for a user who is not there.
- One signal needs no login: whether the posting is still listed, read from the public feed.

The cost of this choice is staleness: a status can be as old as the user's last visit, and the app says so. If that
becomes a problem later, the cheaper next step is reading confirmation and rejection emails, not background logins.
Background checks would need a key the server can use alone, which is exactly what this design rules out.

### 7.4 Open on the real site

The user can always see and change their application on the actual site.

- Every row in the tracker has an external-link control. The application page has it as the main button in the
  header, for example **Open on Workday (Boeing)**.
- It goes to the most specific page the site offers, in this order: the application itself, the site's "my
  applications" page, then the posting. The label says which one it is.
- Under it the app shows which account the application is under ("Signed in there as jordan@example.com") and a
  **Show login** control, password required, when the vault holds a password for it. Accounts the app helped create
  are never a black box.
- Where a site gives applicants no way to view or change a submitted application (Greenhouse, Lever and Ashby
  mostly do not), the app says so plainly, links the posting, and shows its own record of what was sent.
- It is a plain link in a new tab. It never carries a login, token or session, and the app never signs the user in
  on the real site.
- When the user comes back, the app offers "Check this application now".
- The site is the source of truth. If the user changes something there, our record is labelled "as submitted through
  this app on *date*" and is not presented as current.

### 7.5 What was submitted

For every application sent through the app the tracker keeps the exact list of question and value pairs, where each
value came from (which verified resume field, or which saved answer), the resume file's name and hash, the time, and
the site's confirmation text or number. This is what lets the user trust the consistency of what went out, and it is
the raw material for interview prep later.

## 8. Submitting applications

### 8.1 The flow

1. **Preflight.** `toApplicationProfile(resume)` must pass. Unverified fields are not available to fill with.
2. **Read the form.** Questions come from the public API where there is one, otherwise from the page.
3. **Match.** Each question gets a source: a verified resume field, a saved answer, or "needs you". Rules do this
   first. A small model may classify what a question is asking, but only by choosing from a fixed list. It never
   produces an answer.
4. **Review in the app.** Every question, the value that will go in, and where it came from. Required questions with
   no source are answered here by the user, and can be saved for next time.
5. **Fill.** The server browser fills the real form and stops before Submit.
6. **Final check.** The user sees the real, filled form in the live view, completes any CAPTCHA, and presses Submit.
7. **Record.** The snapshot, the confirmation and the links are saved, and the stage becomes `submitted`.

### 8.2 Rules

- Never guess and never generate wording. An unknown optional question is left blank.
- Never submit twice. Each posting has one in-flight application, and "already applied" pages are detected.
- Never submit without the user's own click in the first version (decision 2).
- Demographic, disability, veteran and salary questions are filled only from an answer the user saved for exactly
  that question, and are highlighted in review.
- A "dry run" mode fills and stops, for testing connectors without sending anything.

### 8.3 Saved answers

Forms ask things a resume does not contain: work authorization, sponsorship, relocation, notice period, how the
person heard about the job. The user types each answer once. It is stored as their own words (`origin: 'user'`) under
a key such as `work_authorization_us`, and reused verbatim when the same question comes up. This is the existing
`Field` idea applied to application questions.

### 8.4 Accounts on employer systems

Workday needs an account per employer. The app can create one during an application only with the user present in
the live view. The login goes into the vault and stays visible to the user through Show login, so they can always
sign in directly without the app.

## 9. Using Claude

### 9.1 How it is paid for

- The app calls the Claude API with an **API key from a Claude Console organization**. A claude.ai plan's chat and
  Claude Code limits cannot be used by an app.
- Max, Ultra and Team plans do include **monthly API credits**: $100 on Max, $200 on Ultra, and $20 or $100 per
  Team seat (pooled, capped at $500). They are claimed once at claude.ai under Settings, Billing, API credits, by
  linking a Console organization. They cover the Claude API. They do not cover interactive Claude Code, or Claude
  bought through Amazon Bedrock, Google Cloud or Microsoft Foundry.
- Unused credits expire each billing cycle. When they run out, API requests stop until the next cycle unless credits
  were bought or auto-reload is on. That is a natural hard budget: leave auto-reload off.
- Every key in the linked organization draws on the same balance. Give this app its own workspace with a spend limit
  so it cannot use credits meant for other things.
- Development work (researching a new hiring system and writing its connector) is Claude Code under the plan itself
  and uses no API credits.

### 9.2 Which model does what

Rules first, then a small model, then Fable. This is the same "cheap tier first" idea as the fetch layer.

| Job | Model | Why | How its output is checked |
| --- | --- | --- | --- |
| Resume breakdown: which text belongs in which field | Fable 5.2 (`claude-fable-5-2`) | Hard layouts, two columns, stacked roles. Low volume, high value. | It returns pointers into the text, not text. Code slices the source and `checkIntegrity` rejects anything that is not an exact slice. Fields arrive as `pending` for the user to verify. |
| Resume review: feedback | Fable 5.2 | Quality of judgment matters | Shown as feedback only. Never written into a field (decision 6). |
| Finding which hiring system a company uses, and its board id | Fable 5.2 with web search | Open-ended lookup. Each answer is shared by every user and cached. | Accepted only after the public feed answers for that board id, as `discover.ts` does today. |
| Reading an unfamiliar public application form into a list of questions | Fable 5.2, experimental | The long tail of custom career sites | The user reviews every field before anything is filled. |
| Deciding what a form question is asking | Haiku 5.5 (`claude-haiku-5-5`) | High volume, simple | It may only pick from a fixed list of keys. Values come from the user's data. |
| Tidying a site's status wording into a stage | Rules, then Haiku 5.5 | Trivial | Fixed list, and the site's own words are kept. |
| Writing a connector for a new board | Claude Code on the plan | Development work | Code review and live smoke tests. |

### 9.3 Rules for AI use

- **It never sees vault contents.** No passwords, cookies or tokens go to a model, ever.
- **It never acts with a user's login.** The model that reads web pages has no tools that can touch a signed-in
  session. Postings and career pages are untrusted text and may contain instructions aimed at a model. Its output is
  data that code verifies against a fixed schema, never commands.
- **Its words never enter an application.**
- **Per-user opt-in.** A user who does not switch AI help on keeps the built-in rules parser, and their resume stays
  off the API.
- **Retention is disclosed.** Fable 5.2 requires the API organization to keep Anthropic's standard 30-day data
  retention, so resume text sent for analysis is kept by Anthropic for up to 30 days. Confirm the current API data
  terms before inviting friends.
- **Minimum data.** Breakdown sends the extracted text the browser already has, not the file. Page images are added
  only when the layout defeats the text.
- **Refusals are handled.** Fable can decline a request. The server uses the API's fallback option, and the last
  fallback is always the rules parser.
- **Usage is metered.** Every call records its token counts per user, with a per-user monthly cap and a meter Sloan
  can see.

### 9.4 What it costs

Prices as of early November 2026, per million tokens: Fable 5.2 $8 in and $40 out (repeated context read from cache
$0.20), Haiku 5.5 $0.10 in and $0.50 out, Sonnet 5.5 $2 and $10, Opus 5.5 $4 and $20. Web search is $10 per 1,000
searches. Fable always reasons before answering, and that reasoning is billed as output.

| Job | Assumed size per run | Model | Per run | Typical runs a month | Per month |
| --- | --- | --- | --- | --- | --- |
| Resume breakdown | 6,000 tokens in, 6,000 out | Fable 5.2 | $0.29 | 4 | $1.15 |
| Resume review | 4,000 in, 5,000 out | Fable 5.2 | $0.23 | 5 | $1.16 |
| Form question matching | 5,000 in, 2,500 out | Haiku 5.5 | $0.002 | 60 | $0.10 |
| **Core, per active user** | | | | | **about $2.40** |
| Optional: "how does my resume fit this posting", on request | 2,000 new and 3,500 cached in, 3,000 out | Fable 5.2 | $0.14 | 20 | $2.75 |
| **With fit checks, per active user** | | | | | **about $5.15** |
| Board discovery, shared by everyone | 25,000 in, 3,000 out, 3 searches | Fable 5.2 | $0.35 | 20 in total | $7 in total |

- A heavy user (15 breakdowns, 20 reviews, 60 fit checks, 150 forms) comes to about $17 a month.
- **$100 of credits** covers the shared discovery cost plus roughly 18 typical users with fit checks, or about 5
  heavy ones. $200 doubles that.
- Using Fable for everything, including every form and an automatic fit check on every posting opened, is about $24
  per user a month, so $100 would cover four people. That is the wasteful setup. Fable on the three jobs where depth
  matters is not.
- If the meter runs hot, Opus 5.5 does the same jobs at half Fable's price, and lowering the `effort` setting cuts
  Fable's output cost directly.

These are estimates from assumed token counts, not measurements. The API reports exact usage on every call, so the
first week of real use replaces this table.

### 9.5 Notes for the implementation

- The key lives in `server/.env` and the host's secret store, never in the browser. AI-assisted breakdown therefore
  runs through the server, while the built-in parser stays in the browser.
- Official SDK: `@anthropic-ai/sdk`.
- Fable 5.2 specifics: leave `thinking` unset (it is always on), control depth with `output_config.effort`, use
  structured outputs (`output_config.format`) because forced tool choice is rejected, check `stop_reason` for
  `refusal`, and send `fallbacks: "default"` with the `server-side-fallback-2026-07-01` beta header.
- Cache the stable start of each prompt (instructions, then the resume). The minimum cacheable size on these models
  is 512 tokens.
- Board discovery is one Messages API call with the built-in web search tool. It does not need an agent framework.

## 10. A cheap home for lighter models

**Short answer: do not host one yet.**

The light jobs here are small classification calls: what is this form question asking, which stage does this status
text mean, which saved answer matches. A group of friends produces a few thousand of them a month. On Haiku 5.5 that
is between a few cents and a couple of dollars, with no server to run and nothing to pay while idle.

What self-hosting would cost instead:

| Option | Price | Catch |
| --- | --- | --- |
| Hugging Face Inference Endpoint, smallest CPU (1 vCPU, 2 GB) | $0.033 to $0.06 an hour, about $24 to $44 a month always on | Too small for a useful language model |
| Hugging Face Inference Endpoint, T4 GPU | $0.50 an hour, about $365 a month always on. Billed by the minute, and it can scale to zero. | Waking from zero takes minutes, each time someone comes back |
| Azure Container Apps with a serverless GPU | Per second, scales to zero, payable with credits | The same cold start |
| An always-on Azure VM | Eats the shared credit | The credit's terms allow suspending anything that runs more than 120 hours straight |
| Hugging Face Inference Providers (pay per token) | Per token. The $9 PRO plan includes $2 of credit. | Another vendor, and open models are weaker at strict structured answers |
| A small Microsoft model (Phi family) on Azure, pay per token | Per token, no idle cost. Probably payable with credits (to confirm). | Another integration to maintain and test |
| In the user's browser, or on our own server's CPU | Free | Only for very small models, such as text matching |

Facts about the Azure credit that shape this:

- The $150 monthly Visual Studio Enterprise credit is "specifically for individual dev/test usage only". Production
  use needs a paid subscription, and Microsoft may suspend an instance that runs more than 120 hours continuously or
  that it judges to be production.
- It does not apply to third-party branded products. Claude on Microsoft Foundry is billed through Azure Marketplace,
  so assume the credit cannot pay for Claude. The Claude plan's API credits also exclude Foundry.

Recommendation:

1. Use Haiku 5.5 through the same API key for light jobs.
2. Put model calls behind one small interface (`classify(task, input)` returning a checked answer), so a different
   provider can be swapped in without touching the callers.
3. Spend Azure credits where they clearly apply: a staging copy of the backend ([11](#11-hosting)).
4. If a free light model is wanted later, try text matching on the app server's own CPU first, then a per-token Phi
   deployment on Azure.

A small model cannot reliably drive a browser. Free-roaming "agent" browsing needs a frontier model and is where
planted-instruction attacks concentrate, so this plan keeps models out of signed-in sessions altogether.

## 11. Hosting

### 11.1 What the next phase needs

- **One site for the app and the API.** Sign-in cookies have to be first-party. `haywoodsloan.github.io` and any API
  host are different sites, so the cookie would be third-party: Safari blocks those, private windows block them, and
  allowing them means giving up the `SameSite` protection. GitHub Pages also cannot send security headers. A custom
  domain, with the backend serving the built frontend, fixes all of it. GitHub Pages can stay as the signed-out demo
  (search and the resume tools) or redirect to the domain.
- **One container** with the Node server and Chromium (2 GB of memory or more), **Postgres**, and a **secret
  store**. A single instance, because the live view and running jobs live in its memory.
- **It can sleep.** Nothing runs when nobody is signed in, so a host that scales to zero costs almost nothing.

### 11.2 Options

| Option | Cost | Good for | Watch out for |
| --- | --- | --- | --- |
| The laptop (`npm run local`) | Free | Building and testing now. Site sign-ins come from a home connection with a visible browser, which is the gentlest setup for the user's accounts. | Friends cannot reach it |
| Azure Container Apps, scaled to zero | The free monthly grant (180,000 vCPU-seconds, 360,000 GiB-seconds) is about 25 hours of a 2 vCPU, 4 GB container. Past that, roughly ten to twenty cents an hour from the credit (list rate to confirm). | A staging copy, paid by credits | The credit is dev and test only, so the friends-facing copy there risks suspension. The outgoing address is not fixed. |
| Fly.io (already set up in `server/fly.toml`) | About $5 to $15 a month, real money | The friends-facing copy. Stops when idle. | Check current pricing |
| A rented VPS | About $5 to $10 a month | Cheapest memory | Patching and hardening become our job, which is a poor trade for a server that holds logins |

Database: Postgres, so the server stays stateless and can move between these hosts. A serverless Postgres with a free
tier that sleeps when idle suits the usage pattern (Neon is the usual choice, limits to confirm). Azure Database for
PostgreSQL is the credit-paid alternative at very roughly $15 to $20 a month, always on. Locally, Postgres runs
embedded in the Node process (PGlite), so `npm run local` keeps working with nothing new to install. Step 0
confirmed that on Linux. Windows is still to be checked on the laptop, and the fallback is Postgres in Docker.

Recommendation: laptop through Phase 3, an Azure staging copy when hosting work starts, and choose the
friends-facing host then. Fly.io is the pick if staying inside the Azure credit's terms matters.

### 11.3 Running it

- **Secrets** (pepper, data key, API keys) live in the host's secret store, never in the repo or the database. The
  pepper is also backed up offline: losing it locks every user out.
- **Backups** are the database provider's. Vault rows in a backup are still ciphertext. Deleting an account deletes
  its locked keys, which makes its vault unreadable everywhere, backups included.
- **Headers** come from our own server: a strict Content Security Policy, HSTS, and no framing by other sites.
- **Logs** never contain request bodies, cookies or secrets. A separate audit table records sign-ins, unlocks, every
  use of a stored login, reveals, submissions and exports.
- **One region.** Sites see sign-ins coming from the server's address. A fixed outgoing address is an add-on to
  consider if sites keep asking users to verify again.
- **Before friends join:** a one-page plain notice of what is stored, what the operator can and cannot see, and the
  per-site risks, accepted once per user and once per connected site.

## 12. Data model

Protection classes: **P** plain. **D** encrypted by the app with a per-user data key that the server can unlock (it
survives a password reset and protects against database theft). **V** encrypted with the user's vault key (needs the
user).

| Table | Holds | Class |
| --- | --- | --- |
| `users` | Email, verifier, salt and Argon2id settings, pepper version, vault key locked by password, vault key locked by recovery code, locked data key, role, AI opt-in | P (the locked keys are useless alone) |
| `invites` | Hashed one-time codes for invites and resets, expiry | P |
| `sessions` | Session id, user, created, last seen, expiry, vault key locked by the session key, vault expiry | P (same) |
| `vault_items` | Connector, scope (for example the Workday host), kind, label, ciphertext, last used | V |
| `applications` | Connector, linked vault item, stage, stage source, times | P for stage and times, D for job details, links and the site's status wording |
| `application_events` | Timeline entries | D |
| `submissions` | What was sent: questions, values, where each came from, resume hash, confirmation | D, with sensitive answers in V |
| `profile_answers` | Saved answers by key | D, sensitive ones in V |
| `resumes` | The parsed resume and the original file, once decision 5 is taken | D |
| `connector_catalog` | Company to hiring system and board id, how it was found, when last verified. Shared by all users. | P |
| `audit_log` | Who did what and when, with no secrets | P |
| `ai_usage` | Per call: user, job, model, token counts, estimated cost | P |

Every user-owned row carries `user_id`, every query filters on it, and Postgres row-level security enforces it a
second time.

Plainly stated: the operator can technically read class D data by using the server's key. Only class V is out of
the operator's reach.

## 13. Threat model

What is being protected, most valuable first: stored site logins and sessions, sensitive answers, account passwords,
resumes and application history (job hunting while employed is sensitive), the accuracy of what gets submitted, the
standing of users' accounts on other sites, and the server's own keys.

| # | Threat | What the design does | What remains |
| --- | --- | --- | --- |
| 1 | The database or a backup is stolen | Vault contents need the user's password, and guessing needs the pepper, which is not in the database. Session copies of the vault key need each user's cookie. Tracker details need the data key, also outside the database. | Database plus secret store together allow offline guessing of weak passwords. |
| 2 | The running server is taken over (a bug, a bad dependency, stolen deploy access) | Vaults of users who do not sign in during the takeover stay closed. Short unlock window. Few dependencies, locked versions. The browser worker has no database or key access. The audit log shows every use of a login. | Passwords, vault keys and logins of users active during the takeover are exposed. Treat as a full breach: rotate the pepper, force resets, tell users to change site passwords. |
| 3 | The operator or the host's staff look at the data | Same as 1 for the vault. No admin screen can show a login. | Whoever deploys code is trusted, and class D data is readable by the operator. |
| 4 | A session cookie is stolen | `HttpOnly`, `Secure`, `SameSite`. The cookie decrypts nothing by itself: it works only through our server, where revealing or exporting a login still needs the password. Vault locks on its own clock. Sign out everywhere. | Until the session ends, whoever holds the cookie can use the app as that user. Until the vault locks, that includes checks and applications on connected sites. |
| 5 | Script injection through job description HTML | The sanitizer rebuilds descriptions from a short tag list and copies no attributes except web links. Step 0 added tests with 92 attack payloads, run in a real browser as well, and a strict Content Security Policy for the app when our server serves it. The tests found one flaw, now fixed: the text of scripts inside SVG and MathML was shown as plain text instead of being dropped. A sandboxed frame is a further option. | Residual risk in any app that shows third-party HTML. |
| 6 | Forged requests or the app framed by another site | `SameSite=Strict`, origin checks, framing disallowed. | Low. |
| 7 | Password guessing on our sign-in | Rate limits, slow hashing, breached-password check, invite-only. | Reused passwords. A second factor is the later answer. |
| 8 | The service used to test stolen logins or spam employers | Invite-only, users sign in to sites themselves in the live view, per-user limits, user-pressed Submit. | Low at this size. |
| 9 | Requests steered at internal addresses through pasted links or browser navigation | Each connector may only reach its listed hosts. Private address ranges are refused. | Low. |
| 10 | A hostile page attacks the server's browser | Chromium's sandbox stays on, non-root, one browser process per user job, kept patched, no downloads. | A browser zero-day. |
| 11 | One user's data reaches another through a bug | A separate browser context per job, user-scoped queries plus row-level security, encrypted items bound to their owner so the wrong key fails, and nothing sent with a login passes through the shared search cache. | Low. |
| 12 | Secrets leak into logs, traces or screenshots | No bodies in logs, no browser traces or video in production, no screenshots on sign-in pages, confirmations stored encrypted. | Human error in new code. Reviewed per connector. |
| 13 | A wrong, duplicate or unapproved application is sent | Verified fields only, review screen, the user's own Submit, one in-flight application per posting, the `unknown` state after an interruption. | A user approving something they did not read. |
| 14 | A site flags or restricts the user's account | Risk shown per site, user-started actions only, slow pace, no disguise, sessions reused, a switch to turn any connector off at once, big boards deferred. | Cannot be removed for any automation. This is why decision 1 exists. |
| 15 | A site objects to the operator | Public and official routes first, friends only, no bulk collection with user accounts, blocks respected, quick disable. | Terms-of-service risk stays with automation of any signed-in site. |
| 16 | Instructions planted in a posting or page steer the model | The model has no tools that touch signed-in sessions, answers in a fixed schema, and code verifies the result. | Wrong suggestions that the user must catch in review. |
| 17 | Personal data sent to the model provider | Opt-in, minimum data, never vault contents, retention disclosed. | Anthropic holds resume text for up to 30 days. |
| 18 | A forgotten password, or a reset obtained by trickery | A reset cannot open the vault. Recovery code. Admin-issued links. | Tracker data is reachable after a hostile reset. |
| 19 | The pepper or data key is lost | Offline backup and a written restore procedure. | Without the backup, every user must reset and all vaults are lost. |
| 20 | The user's own device is compromised | Out of scope. | Everything that user can see. |

What this design does not promise: that a compromised live server is harmless, that no site will ever flag an
account, or that the operator cannot see tracker data.

## 14. Changes to the repo

- `server/` grows from a search proxy into the app server: `accounts/` and `db/` (built in Step 0), then `vault/`,
  `connectors/`, `live/` and `ai/`. `server/src/index.ts` stays on Node's built-in HTTP server for now
  ([4.2](#42-why-sign-in-is-built-here-and-not-bought)). Search keeps working unchanged for signed-out users.
- `src/apply/` holds the shared types (form questions, fill plans, saved answers), used by both the browser and the
  server, the way `src/jobs` is today. (Step 1 put the application record and its rules there.)
- New pages: Sign in, Applications, Application detail, Apply review, Connected sites, Account. (Sign in and
  Account came with Step 0, Applications and Application detail with Step 1.)
- `src/resume/model.ts` keeps its contract. AI-located fields are still `origin: 'source'`, since the text is an
  exact slice.
- Local development moves to one origin: Vite proxies `/api` to the backend, replacing the cross-origin
  `VITE_API_URL` setup for anything signed-in. `npm run local` keeps working. (Built in Step 0 for the account
  routes and in Step 1 for the tracker's. Search still calls the backend directly.)
- README and docs: reword the two promises named in [3](#3-starting-point) when the parts that change them ship.
- Tests: known-answer and tamper tests for every crypto path, sign-in and session tests, connector tests against
  recorded pages, and live smoke tests run from the laptop like `npm run smoke`.

## 15. Build order

Each step ends with something usable.

| Step | What | Done when |
| --- | --- | --- |
| 0 | **Built.** Foundations: one-origin dev setup, database, accounts, sessions, invites, security headers, sanitizer tests | Sloan can sign in and out locally, and the auth tests pass |
| 1 | **Built for a person's own computer** ([7.0](#70-as-built-in-step-1)). Tracker without logins: records, one-click add, paste a link, file import, stages and timeline, Open on site, "posting closed" check. Still to build: paste a link, other files than the app's own, the "posting closed" check, and the records in the account for a hosted copy | Sloan tracks real applications in the app |
| 2 | Vault and assisted apply for sites that need no login: Greenhouse first, then Lever and Ashby. Key handling, lock and unlock, live view as a local window, form reading, matching, review, fill, user Submit, snapshots, saved answers | A real Greenhouse application is sent end to end from the laptop |
| 3 | Workday: connect or create an account with the user present, stored passwords, status sync on open | A real Workday application's status shows in the tracker |
| 4 | Hosted for friends: domain, deployment, streamed live view, invites, recovery codes, backups, the notice | A friend signs up from an invite and connects a site |
| A | In parallel after step 0: Claude resume breakdown and review, board discovery, the usage meter | A two-column resume that the rules parser scrambles comes out right, and the meter shows what it cost |
| Later | Revisiting decision 1 (LinkedIn and Indeed logins), email signals, passkeys, more hiring systems | |

Step 0 also built two things listed under later steps: key handling with lock and unlock on the server (Step 2),
and recovery codes (Step 4). See [4.6](#46-as-built-in-step-0).

Live sites can only be reached from the laptop, not from the cloud build environment, so every connector is finished
and smoke-tested there.

## 16. To confirm on live sites

- Everything marked * in [6.4](#64-rollout-by-risk): exact sign-in behaviour, where each site shows application
  status, and the address of each "my applications" page.
- Which bot check each hosted form runs at Submit, and whether a person passes it in the live view from a server
  address. If not, that site stays on the laptop or the hand-off link.
- The file layout of LinkedIn's account data export.
- Whether Lever and Ashby truly offer applicants no status page.
- Real token counts for resume breakdown, to replace the estimates in [9.4](#94-what-it-costs).
- Whether the Azure credit can pay for a per-token Phi deployment.
- Whether PGlite and the Argon2 package behave on Windows as they do on Linux, where Step 0 was built and tested.
- The real breached-password lookup, which the build environment could not reach.
- Current limits and prices for Azure Container Apps, the Postgres free tier and Fly.io.

## 17. Sources

Checked on 2026-11-16:

- [Monthly API credits for Max, Ultra, and Team plans](https://support.claude.com/en/articles/17154008-monthly-api-credits-for-max-ultra-and-team-plans) and
  [API credits for subscribers](https://platform.claude.com/docs/en/about-claude/api-credits-for-subscribers)
- [Why a paid Claude plan and the API are billed separately](https://support.claude.com/en/articles/9876003-i-have-a-paid-claude-subscription-pro-max-team-or-enterprise-plans-why-do-i-have-to-pay-separately-to-use-the-claude-api-and-console)
- [Claude API pricing](https://platform.claude.com/docs/en/about-claude/pricing). The figures in 9.4 come from
  Anthropic's API reference dated 2026-11-03.
- [Monthly Azure credits for Visual Studio subscribers](https://azure.microsoft.com/en-us/pricing/member-offers/credit-for-visual-studio-subscribers/)
- [Claude models billing in Microsoft Foundry](https://learn.microsoft.com/en-my/Azure/foundry/foundry-models/concepts/claude-models-billing)
- [Azure Container Apps pricing](https://azure.microsoft.com/en-us/pricing/details/container-apps/)
- [Hugging Face Inference Endpoints pricing](https://huggingface.co/docs/inference-endpoints/en/pricing) and
  [Hugging Face pricing](https://huggingface.co/pricing)
- [Greenhouse Job Board API](https://docs.greenhouse.io/job-board.html)
- [MyGreenhouse FAQ for candidates](https://support.greenhouse.io/hc/en-us/articles/43418495049499-MyGreenhouse-FAQ-for-Candidates)
- [OWASP Password Storage Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html)
