# 0013. No web framework on the server

- **Status:** Accepted
- **Date:** 2026-11-17
- **Decided by:** Claude. Sloan was not asked: it is an internal choice with no effect on how the app behaves.

## Context

The search server began on Node's built-in HTTP server. The plan for accounts named Fastify as its first choice.
While building accounts, the routes turned out small enough to write as plain functions from a request to a reply.

## Decision

The server stays on Node's built-in `http`, with no framework.

- What the server does with a request is one function made by `createApp(parts)`. Everything it needs is handed
  in: the settings, the fetch pipeline, accounts, the clock.
- The account routes are functions from a plain request object to a plain reply object. They know nothing about
  sockets.

## Consequences

- Every route can be tested without a running server, and with a fake clock and fake network where needed.
- No dependency to keep up to date, and nothing between the code and what goes over the wire.
- Things a framework would give for free are written by hand and tested here: reading and limiting request
  bodies, CORS, rate limits, security headers.
- It is looked at again when the live view of an application form needs WebSockets
  ([applications-plan.md](../applications-plan.md), section 6.3).

## In the code

- `server/src/app.ts` (`createApp`), `server/src/index.ts` (the process around it), `server/src/accounts/http.ts`.
- `test/integration/search-server.test.ts` runs `createApp` on a real socket. `test/integration/server-start.test.ts`
  starts the real process.
