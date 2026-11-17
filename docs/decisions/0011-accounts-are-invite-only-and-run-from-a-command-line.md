# 0011. Accounts are invite-only and managed from a command line

- **Status:** Accepted
- **Date:** 2026-11-17
- **Decided by:** Claude, in the plan Sloan read before saying "go ahead" with accounts.

## Context

The app is for Sloan and a few friends. Open sign-up would need an email service, abuse handling and an admin
screen, and an admin screen is one more thing a stolen session could misuse.

## Decision

- **Sign-up is by invitation.** `npm run admin -- invite <email>` prints a one-time link, which the admin sends to
  the person themselves. Password resets work the same way. The server never sends email.
- **There is no admin screen in the app.** Making an invite or a reset link takes access to the machine the
  server runs on, not just a signed-in browser.
- **The commands** are `setup`, `invite`, `reset`, `users` and `sign-out`. They work whether the server is running
  or stopped: only one process may open the database, so with the server running a command is handed to it over a
  channel that answers only on the machine itself.

## Consequences

- Whoever opens a link first gets the account, so links are single use, expire, and are stored only as a hash.
- A reset link can never open a vault. A tricked admin or a stolen link can lock a person out of their stored
  logins, but cannot read them.
- Adding a friend takes a person at the keyboard of the server. Fine for a handful of people, and something to
  look at again before hosting for more.

## In the code

- `server/src/admin.ts`, `server/src/accounts/cli.ts`, `admin-commands.ts`, and the admin channel in
  `server/src/accounts/index.ts`.
- `test/integration/admin-cli.test.ts` runs the real command as its own process, with the server stopped and
  running. `test/server/accounts.test.ts` covers what each command does.
