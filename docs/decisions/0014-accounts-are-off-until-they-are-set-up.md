# 0014. Accounts are off until they are set up

- **Status:** Accepted
- **Date:** 2026-11-17
- **Decided by:** Claude. Sloan was not asked: it keeps what already worked working.

## Context

Search and the resume tools were in use before accounts existed, on the laptop and as the public demo. Accounts
add a database, a secret and two packages with native parts. None of that should be able to break a copy of the
app that does not use them.

## Decision

- Accounts are on only when the server has its secret, `AUTH_PEPPER`. `npm run admin -- setup <email>` creates it.
- With accounts off, none of the account code or its packages is loaded, and the server runs exactly as it did
  before accounts existed.
- The app shows "Sign in" or "Account" only where a server says it has accounts. The public demo has no server
  behind it and never calls the account routes.

## Consequences

- Turning accounts off again is one `#` in `server/.env`. Nothing is deleted.
- Every part has to work in both states, and the tests cover both.
- The secret must never be created by accident. A test that runs the admin command always hands it a secret, and
  checks afterwards that `server/.env` was left alone.

## In the code

- `server/src/index.ts` (loads accounts only when the secret is there), `server/src/accounts/index.ts`
  (`readAccountsConfig`), `src/account/client.ts` (`ACCOUNTS_ENABLED`), `server/src/static.ts` (tells the page).
- `src/App.test.tsx` (the app with accounts off, unreachable and on), `test/integration/search-server.test.ts`
  (the server without accounts), `test/integration/server-start.test.ts` (the real process with accounts on),
  `test/integration/admin-cli.test.ts` (the secret is never written by a test).
