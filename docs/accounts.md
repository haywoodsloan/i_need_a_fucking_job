# Accounts and sign-in

How people get an account on a copy of this app, how sign-in works, and what the server keeps. This describes what
is built. The reasoning behind the design is in [applications-plan.md](applications-plan.md), sections 4, 5 and 13.

Accounts are **off** until you turn them on. With them off the app and the search server run exactly as before.

Signing in does not change search or the resume tools yet. Accounts are the base for what comes next: the
application tracker, and the vault that will hold each person's logins for hiring sites.

Contents: [Turn accounts on](#turn-accounts-on) · [Admin commands](#admin-commands) · [In the app](#in-the-app) ·
[Forgotten passwords](#forgotten-passwords) · [What is stored where](#what-is-stored-where) ·
[Passwords and keys](#passwords-and-keys) · [Sessions](#sessions) ·
[Which requests are accepted](#which-requests-are-accepted) · [Limits on guessing](#limits-on-guessing) ·
[Settings](#settings) · [Routes](#routes) · [The app served by the server](#the-app-served-by-the-server) ·
[Looking after it](#looking-after-it) · [Known limits](#known-limits) · [Code and tests](#code-and-tests)

## Turn accounts on

On your own machine, from the repo root:

```bash
npm install --prefix server              # accounts use two packages the search server did not need
npm run admin -- setup you@example.com   # creates the server secret and prints your invite link
npm run local                            # stop it first (Ctrl+C) if it was already running
```

Open the link that `setup` printed. It looks like `http://localhost:5173/#/invite/…`. Choose a password of at
least 14 characters, then save the **recovery code** the next page shows. It is shown once.

What `setup` did:

- It added `AUTH_PEPPER` to `server/.env`. This is the server's secret. Keep a copy of it somewhere safe: if it is
  lost, nobody can sign in. The file is gitignored.
- It created the account database in `server/.data/`. Also gitignored.
- It made a one-time invite for an admin account with your email.

Running `setup` again is safe. It keeps the secret that is there and prints a fresh invite, or says so when that
email already has an account.

To turn accounts off again, put a `#` in front of the `AUTH_PEPPER` line in `server/.env` and restart. Nothing is
deleted, and taking the `#` away brings every account back. Do not delete the line itself: the accounts cannot be
opened without that secret.

## Admin commands

Accounts are by invitation. Invites and resets are made on the machine the server runs on, from the repo root or
from `server/`. They work whether the server is running or stopped.

| Command | What it does |
| --- | --- |
| `npm run admin -- setup <email>` | Turns accounts on for this server and prints an admin invite for that email. |
| `npm run admin -- invite <email>` | Prints a one-time invite link, good for 7 days. Add `--admin` to make the person an admin. |
| `npm run admin -- reset <email>` | Prints a one-time password reset link, good for 24 hours. See [Forgotten passwords](#forgotten-passwords) for what it costs. |
| `npm run admin -- users` | Lists accounts: email, role, when each was made, and how many browsers it is signed in on. |
| `npm run admin -- sign-out <email>` | Signs that account out everywhere, for a lost device. |

A link works once. Send it to the person yourself: whoever opens it first gets the account. Asking for a new
link cancels an unused earlier one for the same person. No email is ever sent by the server.

There is no admin screen in the app, on purpose. Making an invite or a reset link takes access to the machine,
not just a signed-in browser. The admin role is recorded and shown on the account page, and does not unlock
anything in the app yet.

## In the app

| Page | Address | What it is for |
| --- | --- | --- |
| Sign in | `#/sign-in` | Email and password. |
| Invite | `#/invite/<code>` | Create the account an invite is for, then save the recovery code. |
| Reset | `#/reset/<code>` | Set a new password from a reset link. |
| Forgot your password? | `#/recover` | Set a new password with the recovery code. |
| Account | `#/account` | Where you are signed in, change password, new recovery code, delete account. |

The top bar shows **Sign in** or **Account** when the server has accounts on, and neither when it does not. The
public demo on GitHub Pages has no server behind it, shows neither, and never calls the account routes.

## Forgotten passwords

| You still have | What to do | What is kept |
| --- | --- | --- |
| The recovery code | **Forgot your password?** on the sign-in page: email, code, new password. | Everything. You get a new code, and the one you used stops working. |
| The password, but not the code | Account page, **Recovery code**, enter your password. | Everything. The old code stops working. |
| Neither | Ask whoever runs the server for a reset link (`npm run admin -- reset <email>`). | The account itself. The vault key is replaced, so logins for hiring sites stored in the account are erased. Nothing is stored there yet. |

Using the recovery code or a reset link signs the account out everywhere.

A reset link cannot open a vault. That is deliberate: a tricked admin or a stolen link can lock a person out of
their stored logins, but can never read them.

## What is stored where

| Where | What |
| --- | --- |
| `server/.env` | `AUTH_PEPPER`, the server secret: 32 random bytes. It is mixed into every password hash, so the database alone is not enough to guess passwords. |
| `server/.data/pg/` | The database: Postgres files, run inside the server process by PGlite. Nothing to install. |
| `server/.data/pg.lock` | Names the process that has the database open. Removed when that process stops cleanly. |
| The browser | One cookie holding a random session token. Nothing about the account is put in `localStorage`. |

The tables:

| Table | Holds |
| --- | --- |
| `users` | Email, role, when the account was made, the password check value (`verifier`) with its salt and hashing settings, and two locked copies of the vault key: one opened by the password, one by the recovery code. |
| `invites` | Unused and used invite and reset links: who for, which kind, when they expire. Only a hash of the link's code is kept. |
| `sessions` | One row per signed-in browser: a one-way id made from its token, the browser's name as it reported it, when it was made and last seen, and while the vault is unlocked a third locked copy of the vault key. |
| `audit_log` | What happened and when: account made, sign-in, failed sign-in, sign-out, password changed, recovery used, reset link used, account deleted, and so on. |

What is never stored, in the database or in the server's log: passwords, recovery codes, the codes inside links,
session tokens, vault keys in the clear, and network addresses. A test dumps every table and looks for each of
those secrets (`test/accounts.test.ts`, "what the database holds").

Deleting an account removes its row, its sessions and its links, and takes the email out of the log. The log
keeps the fact that an account was deleted.

## Passwords and keys

Nothing here is invented. Argon2id stretches the password, HKDF-SHA256 turns one secret into several independent
keys, and AES-256-GCM locks things.

```
password ── Argon2id(salt, server secret) ──► master ── HKDF ──► auth key ── SHA-256 ──► verifier   (database)
                                                      └─ HKDF ──► password key ── locks ──► vault key (copy 1)

recovery code ── HKDF(recovery salt) ──► recovery key ── locks ──► vault key                         (copy 2)

session token (cookie only) ── HKDF ──► session id                                    (database, lookup only)
                            └─ HKDF ──► session key ── locks ──► vault key        (copy 3, deleted on lock)
```

- **Password hashing.** Argon2id with 64 MiB of memory, 3 passes, 1 lane, a random salt per user, and the server
  secret as Argon2's key. The settings are stored per user. When they or the server secret change, each person is
  moved over the next time they sign in.
- **The verifier** is what the database keeps to check a password. Knowing it does not help with the password
  key next to it.
- **The vault key** is 32 random bytes per user. It will encrypt that person's stored site logins. It is never
  stored in the clear, and it exists in the server's memory only inside one request. Nothing is encrypted with it
  yet.
- **The recovery code** is 24 characters (120 random bits), shown as six groups of four. Case, spaces and dashes
  do not matter when it is typed back, and `O`, `I` and `L` are read as `0`, `1` and `1`.
- **Locked copies** are tied to their owner and their kind. A copy moved to another user, or a session's copy
  moved to another session, does not open.

So the database alone opens nothing, and neither does the cookie alone.

**Password rules.** 14 to 256 characters. It cannot be the email address. No symbol rules, and pasting from a
password manager works. A new password is also looked up among passwords known from data breaches, using the
[Pwned Passwords](https://haveibeenpwned.com/Passwords) range service: only the first five characters of the
password's SHA-1 hash leave the server, so the service learns neither the password nor whether it was found. If
the service cannot be reached within 3 seconds the password is accepted and the server's log says so.
`PASSWORD_BREACH_CHECK=0` turns the lookup off.

## Sessions

- Signing in sets one cookie: `session` on `http://localhost`, and `__Host-session` with `Secure` when every
  address in `APP_ORIGIN` is HTTPS. It is always `HttpOnly` (scripts cannot read it), `SameSite=Strict` (other
  sites cannot send it) and `Path=/`.
- A session ends after 7 days without use, and after 30 days whatever happens.
- The account page lists where the account is signed in, by browser and system, and can end any of them.
- Changing the password signs out every other browser and keeps the one that did it.
- Signing in again in the same browser replaces that browser's session.
- The vault key has its own clock, per session: unlocked by signing in, locked again after 60 minutes without
  vault use, and unlocked again with the password. The routes for this exist and are tested. The app has no
  buttons for it yet, because the vault has nothing in it.
- Changing the password, getting a new recovery code, deleting the account and unlocking the vault all ask for
  the password again.

## Which requests are accepted

The account routes are for the app's own pages and nobody else.

- They send no CORS headers, so a page on another site cannot read their answers.
- A request that names the page it came from (the `Origin` header) must name an address in `APP_ORIGIN`.
- Anything that changes state is a `POST`, must name its origin, must not be marked cross-site by the browser
  (`Sec-Fetch-Site`), and must carry JSON. A form on another site can produce none of that.
- Every answer is JSON, is never cached, and cannot be framed.

Locally the page at `http://localhost:5173` calls `/api/auth/…` on its own address, and Vite's dev server passes
those calls to the backend. That keeps the cookie first-party without any CORS setup. `npm run local` sets this up.
Plain `npm run dev` has no backend to pass to, so the app behaves as if accounts were off.

Open the app as `http://localhost:5173`, not `http://127.0.0.1:5173`. To the browser those are two different
sites, and the server only accepts the first unless you add the second to `APP_ORIGIN`.

## Limits on guessing

Counted over 15 minutes, in the server's memory:

| What | Limit |
| --- | --- |
| Sign-in tries for one account | 10. A successful sign-in clears the count. |
| Recovery code tries for one account | 10 |
| Password re-entry while signed in | 10 |
| Sign-in tries, recovery tries, and link codes from one network address | 50 each |

Past a limit the answer is "Too many attempts. Try again in N minutes", for the right password too.

A wrong password and an unknown email get the same answer and take the same time, so sign-in does not reveal
who has an account. Two password hashes run at a time and sixteen more may wait. Past that the server answers
"busy" instead of using more memory.

## Settings

All in `server/.env`. Only `AUTH_PEPPER` is needed, and `setup` writes it.

| Setting | Default | What it does |
| --- | --- | --- |
| `AUTH_PEPPER` | none | The server secret, as `1:<base64 of 32 bytes>`. Accounts are off without it. Created by `npm run admin -- setup`. |
| `AUTH_PEPPER_OLD` | none | Earlier secrets, while people move over to a new one. See [Changing the server secret](#changing-the-server-secret). |
| `APP_ORIGIN` | `http://localhost:5173,http://localhost:<PORT>` | The addresses the signed-in app is served from, comma separated. The first one is used in invite and reset links. Anything but localhost must be `https`. |
| `ACCOUNTS_DATA_DIR` | `server/.data` | Folder for the database. |
| `PASSWORD_BREACH_CHECK` | on | `0` turns off the breached-password lookup. |
| `TRUST_PROXY` | `0` | How many proxies stand between the internet and this server. It decides which entry of `X-Forwarded-For` is counted as the client's address. Leave it out on your own machine. |
| `SERVE_APP` | off | `1` makes the server serve the built app as well. The same as starting it with `--serve-app`. |

One setting belongs to the app's build: `VITE_ACCOUNTS=1` makes a build look for an account server at its own
address. It is only needed when something other than this server serves the app next to the account routes.

## Routes

| Route | Body | What it does |
| --- | --- | --- |
| `GET /api/auth/session` | | Who is signed in. Answers `{ "available": false }` when accounts are off. |
| `POST /api/auth/sign-in` | `email`, `password` | Signs in and sets the cookie. |
| `POST /api/auth/sign-out` | | Ends this session. |
| `POST /api/auth/invite` | `code` | Says what a link is for (invite or reset) and whose it is. Does not use it up. |
| `POST /api/auth/accept-invite` | `code`, `password` | Creates the account, signs in, returns the recovery code. |
| `POST /api/auth/reset` | `code`, `password` | Sets a new password from a reset link, returns a new recovery code. |
| `POST /api/auth/recover` | `email`, `recoveryCode`, `password` | Sets a new password with the recovery code, returns a new one. |
| `GET /api/account/sessions` | | Where this account is signed in. |
| `POST /api/account/sessions/end` | `id` | Ends one of them. |
| `POST /api/account/sign-out-everywhere` | | Ends all of them. |
| `POST /api/account/password` | `currentPassword`, `newPassword` | Changes the password. |
| `POST /api/account/recovery-code` | `currentPassword` | Returns a new recovery code. |
| `POST /api/account/delete` | `currentPassword` | Deletes the account. |
| `POST /api/vault/unlock` | `password` | Unlocks the vault key for this session. |
| `POST /api/vault/lock` | | Locks it. |

A failed request answers `{ "error": "<a sentence the app can show>", "code": "<a short name>" }`. The shapes are
in `src/account/api.ts`, which the app and the server share.

`npm run admin` commands reach a running server through `POST /api/admin/run`. That route answers only requests
that come from the same machine, carry a key made from `AUTH_PEPPER`, and do not come from a browser. To
everything else it is a 404, and the dev server does not pass it on.

## The app served by the server

`npm run local` serves the app from Vite, which is right for working on it. The server can also serve the built
app itself, so the app and its API share one address. A hosted copy will run this way.

```bash
npm run local:built      # builds the app, then starts the server with --serve-app
```

Then open `http://localhost:8787`. In this mode the server sends the security headers that a static host such as
GitHub Pages cannot:

| Header | Value | Why |
| --- | --- | --- |
| `Content-Security-Policy` | `default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data: blob: https:; font-src 'self'; connect-src 'self' https:; worker-src 'self' blob:; manifest-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'` | Scripts and styles come only from the app's own files. Nothing inline and nothing evaluated from text, so hostile markup from a job description could not run even if it got past the sanitizer. |
| `X-Frame-Options` | `DENY` | The app cannot be framed by another site. |
| `X-Content-Type-Options` | `nosniff` | Files are only ever what the server says they are. |
| `Referrer-Policy` | `no-referrer` | Links to job sites do not carry the app's address. |
| `Cross-Origin-Opener-Policy`, `Cross-Origin-Resource-Policy` | `same-origin` | Other sites get no handle on the app's window or files. |
| `Permissions-Policy` | camera, microphone, location, payment and USB off | The app uses none of them. |
| `Strict-Transport-Security` | `max-age=31536000` | Sent only when the app is on HTTPS. |

The server reads the files in `dist/` once at startup and answers only those exact paths, so no request can
reach outside that folder. The app served this way searches through the same server without any setup.

`npm run local` does not send these headers, because Vite's dev server needs inline scripts to work. They apply in
this mode and on a hosted copy.

Invite and reset links use the first address in `APP_ORIGIN`. To have them point at this mode, put
`APP_ORIGIN=http://localhost:8787` in `server/.env`.

## Looking after it

### Backups

Stop the server, then copy the `server/.data` folder. Keep a copy of `AUTH_PEPPER` separately from it: the
database is useless without the secret, and that is the point of having both.

### Changing the server secret

Do this if the secret may have been seen by someone else.

1. Make a new one: `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`.
2. In `server/.env`, move the current value to `AUTH_PEPPER_OLD` and set `AUTH_PEPPER` to the new one with the
   next number in front:

   ```ini
   AUTH_PEPPER=2:<the new secret>
   AUTH_PEPPER_OLD=1:<the old secret>
   ```

3. Restart the server.

Everyone can still sign in. Each account moves to the new secret the next time its owner signs in. Remove the old
secret once everyone has signed in again. An account still on a removed secret cannot sign in until it is put back.

### "The database is in use"

Only one process may have the database open. The server holds it while it runs, and `npm run admin` commands go
through the server.

If the server will not start and says the database is in use, another copy of it is still running. Stop that
one. If nothing of this app is running, the lock file was left behind by a crash: delete `server/.data/pg.lock`
and start again. A lock whose process is gone is normally cleared without help.

### Moving to a real Postgres server

The server talks to the database through a small interface (`server/src/db/db.ts`) in plain Postgres SQL. PGlite
is the only driver today. A hosted copy will get a driver for a normal Postgres server behind the same interface.

## Known limits

- **For your own machine only, for now.** Do not turn accounts on in a container whose disk is thrown away on
  redeploy (the Fly.io setup in the README is one): the database would go with it. Hosting with accounts is a
  later step of the plan and brings a real Postgres server.
- **Not yet checked on Windows.** The tests and a full browser run pass on Linux. The two new packages ship
  prebuilt for Windows, but nobody has run them there yet.
- **The breached-password lookup has only been tested against a stand-in.** The machine this was built on could
  not reach the real service. To check it, try to create an account with `password1234567`: it should be refused.
- **Someone who knows your email can lock you out for 15 minutes** by guessing wrong ten times. That is the price
  of the per-account limit. The limits live in memory, so a restart clears them.
- **On `http://localhost` the cookie is not tied to a port.** Any program serving pages on another localhost port
  could have the browser send it. This applies to your own machine only. A hosted copy is HTTPS, where the
  `__Host-` cookie does not have this problem.
- **`connect-src` still allows any HTTPS address**, because the app can search job sources straight from the
  browser when it has no server. A hosted copy should tighten it to `'self'`.
- **Scanned PDFs that use JPEG 2000 images** may not render in the resume viewer under the strict policy, which
  does not allow WebAssembly.
- **Behind a proxy, set `TRUST_PROXY`** to the number of proxies, or every visitor shares one address for the
  limits above. The right number for Fly.io has not been checked yet.
- **A reset link must also delete stored logins** once the vault holds any. The place is marked in
  `server/src/accounts/service.ts`.
- **No second factor, no passkeys, no email.** See the plan, section 4.5.

## Code and tests

| Where | What |
| --- | --- |
| `server/src/accounts/crypto.ts`, `keys.ts` | The building blocks, and which key locks what. |
| `server/src/accounts/service.ts` | Everything an account can do. Knows nothing about HTTP. |
| `server/src/accounts/http.ts` | The routes, the cookie, and the origin rules. |
| `server/src/accounts/policy.ts`, `limits.ts` | Password rules, and the limits on guessing. |
| `server/src/accounts/index.ts` | Settings, startup, and the admin channel. |
| `server/src/accounts/cli.ts`, `admin-commands.ts` | `npm run admin`. |
| `server/src/db/` | The database interface, the lock file, and the tables. |
| `server/src/static.ts` | Serving the built app and its security headers. |
| `src/account/` | The app's side: calls to the routes, and who is signed in. |
| `src/ui/SignInPages.tsx`, `AccountPage.tsx`, `AccountForms.tsx` | The pages. |

`npm test` runs all of it: the account flows against a real in-memory database (`test/accounts.test.ts`), known
answers and tampering for the cryptography (`test/accounts-crypto.test.ts`), the built-app server
(`test/static.test.ts`), the app's account client (`src/account/client.test.ts`), and 92 hostile job descriptions
against the sanitizer (`src/ui/sanitize.test.ts`).
