# 0012. The local database is PGlite, behind a small interface

- **Status:** Accepted
- **Date:** 2026-11-17
- **Decided by:** Claude. Sloan was not asked: it follows from "run it on the laptop" and can be changed without
  touching the rest of the code.

## Context

Accounts need a database. The app runs on Sloan's Windows laptop first, and installing and looking after a
database server there is a chore. A hosted copy will later want a normal Postgres server.

## Decision

- The database is **PGlite**: Postgres built to run inside the Node process, with its files in `server/.data/pg/`.
  Nothing to install.
- The server talks to it through a **small interface** (`Db` in `server/src/db/db.ts`) in plain Postgres SQL.
  PGlite is the only driver today. A hosted copy gets a driver for a real Postgres server behind the same
  interface.
- Schema changes are **numbered migrations**, applied once each at startup.

## Consequences

- Only one process can have the database open. A lock file names the holder, and admin commands go through the
  running server ([0011](0011-accounts-are-invite-only-and-run-from-a-command-line.md)).
- Tests use a real database, in memory, and not a fake of one. The SQL that runs in tests is the SQL that runs
  for real.
- The data lives in a folder. A container that throws its disk away on redeploy would lose every account, so
  accounts stay off on such a host until the real Postgres driver exists.

## In the code

- `server/src/db/db.ts` (the interface, the PGlite driver, the lock), `server/src/db/migrations.ts`.
- `test/server/accounts.test.ts`: "is held by one process at a time", "applies each schema change once".
