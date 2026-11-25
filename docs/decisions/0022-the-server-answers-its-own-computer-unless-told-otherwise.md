# 0022. The server answers its own computer, unless told otherwise

- **Status:** Accepted
- **Date:** 2026-11-24
- **Decided by:** Claude. Sloan had been asked the day it came up and had not answered yet. The tracker could not be switched on without it, it is undone with one setting, and Sloan was told what it changes before it reached `main`.

## Context

The server used to listen on every network connection of the computer it runs on. That is what Node does when it
is given no address, and a hosted copy needs it.

On Sloan's own computer it meant more than anyone had chosen. On 2026-11-24, while the search key was being set
up there, it turned out that other devices on the same network could reach the server. Any of them could run
searches, and each search spends requests of a plan with a monthly limit. Sloan was asked that day whether the
server should answer the computer only, and has not answered.

The same day the tracker was built ([0020](0020-applications-are-kept-by-the-server-on-its-own-computer.md)). It
has no sign-in, and it holds a person's applications. It can only be switched on where nobody else reaches the
server. The options:

- **Leave the default, and make the tracker something to switch on.** The tracker would be off on the one
  computer it was built for until someone changed a setting there, and a server reachable from the network would
  stay the default for the search.
- **Listen on the computer's own addresses by default.** The tracker is on where it is safe with nothing to set,
  and a hosted copy says with one setting that it is hosted.

## Decision

Left alone, the server answers the computer it runs on and no other.

- **The default is this computer's own addresses,** `127.0.0.1` and `::1`. Both, because the name `localhost` can
  mean either one, and programs differ in which they try first.
- **`HOST` says otherwise.** `HOST=0.0.0.0` (or `::`, or `*`) listens on every network connection. Any other
  value is the one address to listen on. `server/Dockerfile` sets `HOST=0.0.0.0`, so a hosted copy behaves as
  before.
- **A server that other computers can reach keeps no applications,** whatever else is set.
- **The server says which it is** when it starts: `listening: for this computer only`, or what it listens on.

## Consequences

- Another device on the network can no longer reach the server on Sloan's computer: not the search, and not the
  applications. Nothing has to be set for that.
- Whoever ran the server on one computer and opened the app from another has to set `HOST=0.0.0.0` now. Nobody is
  known to do that. On such a server the tracker is off.
- `npm run local` is unchanged for the person at the computer: the app and the server talk to each other at
  `localhost`.
- A value of `HOST` that is no address of the computer stops the server at the start, with a sentence that says
  so.
- A reason to look at this again: Sloan answers the question differently, or wants to use the app from a second
  device at home. That would need the tracker behind a sign-in first.

## In the code

- `server/src/listen.ts`: `listenPlan` reads `HOST`, and `listen` opens the addresses.
- `server/src/index.ts`: starts listening, and prints what it listens on.
- `server/src/applications/index.ts`: `readApplicationsConfig` keeps the tracker off unless the server answers
  its own computer only.
- `server/Dockerfile` and `server/.env.example`: the setting, for a hosted copy and for a person.
- `test/server/listen.test.ts`, and `test/integration/applications-restart.test.ts`, which starts the real server
  and fails if it answers at the address other computers use for this one.
