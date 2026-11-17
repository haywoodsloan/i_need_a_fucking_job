# 0010. Sign-in is built here, not bought

- **Status:** Accepted
- **Date:** 2026-11-17
- **Decided by:** Claude, in the plan Sloan read before saying "go ahead" with accounts. Sloan set the requirement
  that leads to it.

## Context

Sloan asked that each user's logins for job sites be stored so that the backend can read them only while that
user is signed in and making the request. The plan answers this with a vault key that the user's own password
unlocks. So the password does two jobs: it proves who the user is, and it opens their vault.

Hosted login services (Auth0, Clerk, Supabase Auth and the like) take the password on their own page and never
show it to our server, so they cannot do the second job. "Sign in with Google" has no password at all.

## Decision

Sign-in is written in `server/`, from standard and well-reviewed parts, with nothing invented:

- Argon2id for passwords (64 MiB, 3 passes), with a per-user salt and a server secret mixed in (`AUTH_PEPPER`).
- AES-256-GCM and HKDF-SHA256 from Node's own `crypto` for keys. No custom ciphers.
- One session cookie that scripts cannot read (`HttpOnly`, `SameSite=Strict`). The server keeps only a one-way
  value made from it.
- Passwords of at least 14 characters, checked against a list of breached passwords, with no forced symbols.

The details are in [accounts.md](../accounts.md), and the reasoning in
[applications-plan.md](../applications-plan.md), sections 4 and 5.

## Consequences

- This code guards people's passwords, so it is held to the strictest testing in the repository: known answers
  and tampering for every crypto path, every route, and a test that dumps the database and looks for secrets
  ([0016](0016-how-the-code-is-tested.md)).
- No email service is needed, and none is used ([0011](0011-accounts-are-invite-only-and-run-from-a-command-line.md)).
- A forgotten password without the recovery code loses the stored site logins, because nobody else can open the
  vault. That is the price of the guarantee, and it still needs Sloan's yes (plan, decision 4).
- Passkeys, a second factor, and deriving the key in the browser are left for later (plan, section 4.5).

## In the code

- `server/src/accounts/crypto.ts`, `keys.ts`, `service.ts`, `http.ts`, `policy.ts`, `limits.ts`.
- `test/server/accounts.test.ts` and `test/server/accounts-crypto.test.ts`. `vitest.config.ts` requires every line
  of the crypto, key, service, route and limit files to be run by a test.
