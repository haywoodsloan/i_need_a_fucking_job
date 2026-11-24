# Testing

How the tests are organized, how to run them, where a new test goes, and what is not tested. The reasons behind
the approach are in [decisions/0016](decisions/0016-how-the-code-is-tested.md).

Contents: [Commands](#commands) · [The layers](#the-layers) · [Where a test goes](#where-a-test-goes) ·
[Writing a test](#writing-a-test) · [The network guard](#the-network-guard) ·
[Recorded answers from job sources](#recorded-answers-from-job-sources) · [Adding a job source](#adding-a-job-source) ·
[Pages](#pages) · [The server](#the-server) · [Real resume files](#real-resume-files) ·
[Property tests](#property-tests) · [In a real browser](#in-a-real-browser) · [Coverage](#coverage) · [CI](#ci) ·
[What is not tested](#what-is-not-tested) · [When a test fails](#when-a-test-fails)

## Commands

Run from the repository root. Node 22.12 or newer.

| Command | What it runs | Takes about |
| --- | --- | --- |
| `npm run check` | Type check, every test below except the browser tests, with coverage, then a build. **Run it before every push.** | 35 s |
| `npm test` | Unit, component and integration tests. | 20 s |
| `npm run test:unit` | Unit and component tests only. | 15 s |
| `npm run test:integration` | Integration tests only. | 10 s |
| `npm run test:coverage` | `npm test`, plus a coverage report in `coverage/index.html`. Fails under the minimum. | 20 s |
| `npm run test:e2e` | The built app in a real browser. Needs one: see [In a real browser](#in-a-real-browser). | 10 s |
| `npm run test:watch` | Re-runs the tests of the files you change. | |
| `npx vitest run src/jobs/aggregate.test.ts` | One file. | |
| `npx vitest run src/jobs -t "gives each job once"` | The tests under a folder whose names contain the words. | |
| `npm run typecheck` | Type check only. The tests are type-checked too. | 5 s |

The times are from the machine the suite was built on. Expect the same order on a laptop, not the same numbers.

While you fix a failure, run only what failed. Run everything once at the end.

## The layers

One runner, [Vitest](https://vitest.dev), runs four layers. `vitest.config.ts` defines the first three as projects.

| Layer | Files | Runs in | What it is for | What is fake |
| --- | --- | --- | --- | --- |
| **Unit** | `src/**/*.test.ts`, `test/server/`, `test/sources/` | Node | Logic: parsers, adapters, merging, the fetch pipeline, accounts, the sanitizer | The network and the clock |
| **Component** | `src/**/*.test.tsx` | A simulated browser (jsdom) | A page as a person uses it: what it shows, what a click or a key does | The server, at `fetch` |
| **Integration** | `test/integration/` | Node, with real sockets, files and processes on this machine | The parts put together: the server over HTTP, the admin command and the server as real processes, real PDF and Word files | The job sites only |
| **Browser** | `test/e2e/*.e2e.ts` | Chromium | The built app under its real security headers. A handful of journeys. | The job sites only |

Most tests are unit tests, because they are fast and say exactly what broke. Each layer above exists for what
the layer below cannot show.

## Where a test goes

| The code under test | The test |
| --- | --- |
| A file in `src/` | Next to it: `aggregate.ts` → `aggregate.test.ts` |
| A component or page in `src/` | Next to it, as `.test.tsx`: `SearchPage.tsx` → `SearchPage.test.tsx` |
| A rule that must hold for any input | Next to the code, as `.property.test.ts` |
| A file in `server/src/` | `test/server/<name>.test.ts` |
| A job source, from request to posting | A cassette in `test/fixtures/sources/` and a row in `test/helpers/sources.ts`. `test/sources/contract.test.ts` picks it up. |
| Anything that needs a real socket, a file on disk or another process | `test/integration/` |
| Only a real browser can show it | `test/e2e/`. Keep these few. |
| The docs | `test/docs/docs.test.ts` |

Tests under `src/` are checked as browser code, like the app. They cannot import from `node:`. Load a fixture as
text with `import text from '../../test/fixtures/resumes/basic.txt?raw'`.

Helpers live in `test/helpers/` (for tests under `test/`) and `src/testing/` (for component tests). Fixtures live
in `test/fixtures/`.

## Writing a test

- **Name the behaviour, in plain words.** `it('keeps the longest description of each job')`. Someone who reads
  only the names of a file's tests should learn what the code promises.
- **Test what the code offers to the outside**, not how it does it inside. A test that breaks when the code is
  tidied up without changing what it does was testing the wrong thing.
- **Fake only the edges:** the network, the clock and chance. Use the real thing for everything inside: the real
  database (in memory), real cryptography, the real parser, the real sanitizer. Do not replace the app's own
  modules with `vi.mock`. The one exception is the PDF drawing library in component tests, which needs a real
  browser.
- **Control time.** Pass a clock in (`now`) or use `vi.useFakeTimers()`. A test never sleeps.
- **No test depends on another.** Each makes what it needs. Spies, replaced globals and changed settings are put
  back after every test by the config.
- **A bug fix starts with a test that fails without the fix.** Say in a comment how the bug was found if that
  helps the next reader.
- **Made-up people only.** Sam Okafor, Jordan Rivera, `someone@example.com`. Never real personal data, in a test
  or a fixture.
- **It has to pass on Windows.** Build paths with `node:path` and `fileURLToPath`. Even out `\r\n` when reading
  what a process printed. Delete temporary folders with retries (`rmSync(dir, { recursive: true, force: true,
  maxRetries: 5, retryDelay: 200 })`).

## The network guard

`test/setup/network.ts` replaces the global `fetch` for every test with one that only lets through calls to this
machine. Anything else fails with `NetworkInTestError` and says what to do instead:

- Code that is handed a `fetch` (sources, the fetch pipeline, the account service): hand it a fake, or replay a
  recorded answer.
- Code that calls the global `fetch` (the app's own clients): `vi.stubGlobal('fetch', fake)`, or use the fake
  server described under [Pages](#pages). The guard is back after the test.

`test/integration/network-guard.test.ts` tests the guard itself.

## Recorded answers from job sources

A **cassette** is one JSON file in `test/fixtures/sources/`. It holds the requests a source makes for one search
("software engineer" near Austin, TX) and what the service answered. `replay(cassette)` from
`test/helpers/cassette.ts` is a `fetch` that answers from it, so a test runs the source's real code end to end
with no network. A request the cassette does not hold fails the test and spells the request out.

`test/sources/contract.test.ts` runs every source against its cassette and checks what holds for any honest
answer: every posting is fit to show (`postingProblems` in `test/helpers/sources.ts`), ids are unique, titles
match the search, every recorded request was made, and a failing service comes through as an error. What a source
does with one odd field belongs in a unit test with a small sample written into the test
(`src/jobs/jobs.test.ts`).

A cassette says where it came from in its `origin`:

- `recorded`: taken from the live service by the recorder, then cut down to a few postings.
- `handwritten`: typed up from what the service documents and the adapter reads. It tests the code paths, but it
  cannot notice the service changing.

Whether the cassettes are recordings yet is in [status.md](status.md#waiting-on-sloan). They started out
handwritten, because the machine they were made on could not reach the job sites.

### Recording

On a machine that can reach the job sites:

```bash
npm run fixtures:record                  # every source this machine has what it needs for
npm run fixtures:record -- lever ashby   # only these
npm test                                 # the new cassettes must pass
git diff test/fixtures/sources/          # read it before you commit: it is other people's text
```

The recorder (`server/src/record-fixtures.ts`) runs each search through the server's own fetch pipeline, so
requests are paced and a bot check is reported, not worked around. It cuts the answer down, replays it once to
prove it works offline, and only then writes it. Sources that need a key or a switch in `server/.env` are skipped
without one. Request headers are never stored and API keys in addresses are blanked, so a cassette is safe to
commit. The contract test checks that too.

## Adding a job source

1. Write the adapter in `src/jobs/adapters/`. It gets its `fetch` from the context it is handed and never calls
   the global one. It runs in the browser and in the server, so no `node:` imports.
2. Add unit tests with small samples for the fields it reads and the odd cases.
3. Add a row for it to `SOURCES` in `test/helpers/sources.ts`.
4. Record its cassette (`npm run fixtures:record -- <name>`), or write one by hand with `"origin": "handwritten"`
   if the service cannot be reached from where you are.
5. Wire it into `planSearch` in `src/jobs/aggregate.ts`, and test the wiring in `src/jobs/aggregate.test.ts`.
6. Add it to [job-sources.md](job-sources.md). Ask Sloan to run `npm run smoke --prefix server` on the laptop.

## Pages

A page is tested with the page and all of the app's own code running for real, and the server replaced at the
one place the app reaches it: `fetch`.

| Helper (in `src/testing/`) | What it gives |
| --- | --- |
| `fakeServer(routes)` | Replaces `fetch` with a table of routes. `server.calls` and `server.sent(route)` say what the page asked for. A request with no route fails the test. |
| `refusal(status, code, error)` | A reply that turns a request down, shaped like the real server's. |
| `held()` | A reply that waits until the test lets it go, for testing what a page shows while it waits. |
| `fakeAccounts(options)` | The account routes with state behind them: sign in, sessions, invites, password change. Same paths, reply shapes and sentences as the real server. |
| `openApp(address, options, routes)` | Renders the whole app at an address like `'#/account'`, with `fakeAccounts` behind it. Returns the `user` to click and type with. |

Find things the way a person does, by role and name:
`screen.getByRole('button', { name: 'Sign in' })`. Use `await screen.findBy…` for what appears after a reply.
Reach for a CSS class only when there is nothing a person could name.

`src/testing/setup.ts` runs before every component test. It adds the matchers that read like the page
(`toBeInTheDocument`, `toBeDisabled`), empties the page and the browser storage after each test, and stands in for
the few things jsdom lacks: `scrollIntoView`, the size of a text range, and reading a file's bytes. Where a test
needs more, it adds it itself: IndexedDB with `vi.stubGlobal('indexedDB', new IDBFactory())` from
`fake-indexeddb`, and `vi.spyOn` for `window.confirm` and for downloads.

jsdom does not lay a page out or draw. What depends on that is tested [in a real browser](#in-a-real-browser).

## The server

- **Request handling** (`server/src/app.ts`): `startTestServer` in `test/helpers/server.ts` runs it on a real
  socket on this machine, with a replayed network, a clock the test moves (`server.advance(ms)`), and no waiting.
  `test/integration/search-server.test.ts` uses it.
- **Accounts** (`test/server/accounts.test.ts`): every route against a real database in memory, with a fake clock
  and password hashing at a low cost setting. One test dumps every table and looks for secrets.
- **Processes** (`test/integration/admin-cli.test.ts`, `server-start.test.ts`): the real commands, started as a
  person starts them. They read `server/.env` like any run, so the test passes every setting that matters and
  leaves none to the file. **`AUTH_PEPPER` is always passed**: without one, `setup` would write a new secret into
  `server/.env`. The admin test ends by checking that the file was left alone. Helpers are in
  `test/helpers/process.ts`.

## Real resume files

`test/helpers/resume-files.ts` makes a real PDF and a real Word file in code, saying the same thing
(`RESUME`). They are built in the test so that what is in the file can be read in the test, and no binary file has
to be kept in the repository.

- `test/integration/pdf.test.ts` and `docx.test.ts` put them through the real readers (pdf.js, mammoth) and the
  app's parser. They check the assumption under the unit tests, which use hand-typed input: what the libraries
  really produce.
- `test/e2e/app.e2e.ts` uploads both in a real browser.

## Property tests

A property test states a rule and lets [fast-check](https://fast-check.dev) make up hundreds of inputs to break
it. They are in `*.property.test.ts`:

| File | Rules |
| --- | --- |
| `src/resume/parse.property.test.ts` | Whatever text or PDF is given: the parser does not fail, every field is the file's exact words, none is empty, ids are unique, and the same file reads the same way twice. |
| `src/ui/sanitize.property.test.ts` | Whatever markup is given: only allowed tags come out, with no attribute but a web link's address. |
| `src/jobs/jobs.property.test.ts` | Merging loses no job and shows none twice, keeps every board, and changes nothing it was given. The helpers that read a job site's text never fail. |

Each run uses new random inputs. When one fails, fast-check prints the smallest input that still fails, and a
seed. **A failure is a real bug, in the code or in the rule as written. Do not run it again and hope.**

1. Reproduce it: put the printed values into the failing call, `fc.assert(…, { seed: 123, path: '4:1' })`.
2. Fix the bug.
3. Add the smallest failing input as an ordinary test next to the others, so it stays fixed. Take the seed out.

## In a real browser

`test/e2e/app.e2e.ts` runs the built app in Chromium, served by the server's own code with its real security
headers, a real database on disk and the real sign-in cookie. Only the job sites are stand-ins, and the browser is
cut off from every address but the app's. It covers what nothing else can:

1. The security policy is sent, is enforced, and the app runs under it with nothing refused.
2. A search goes through the server and shows a posting.
3. An invite link becomes a signed-in account that survives a reload, signs out, and signs in again.
4. A PDF resume is read by the real PDF reader, its page is drawn, and the review survives a reload.
5. A Word resume is read by the real Word reader.

Every test ends by checking `problems`: anything the page logged as an error or the policy refused. So a library
that starts to need something the policy forbids fails here.

It needs a browser. Any one of these works:

```bash
npx playwright install chromium          # once: downloads Playwright's own Chromium (a few hundred MB)
npm run test:e2e

BROWSER_CHANNEL=msedge npm run test:e2e  # or use a browser that is already installed (msedge or chrome)
BROWSER_PATH=/path/to/chromium npm run test:e2e
```

On Windows, Edge is already there. In PowerShell: `$env:BROWSER_CHANNEL='msedge'; npm run test:e2e`.

The run builds its own copy of the app into a temporary folder (`test/e2e/build.ts`), so it does not use or change
`dist/`. Keep this layer small: a journey belongs here only if no other layer can show it.

## Coverage

`npm run test:coverage` measures which lines the unit, component and integration tests run, and writes a report to
`coverage/index.html`.

- **It is a floor, not a goal.** `vitest.config.ts` holds a minimum a little under what the suite reaches. A
  change that leaves clearly more code untested than before fails the build. Raise the minimum when coverage goes
  up. Do not lower it to get a change through: write the test.
- **Three places must have every line run by a test:** the account files that handle passwords, sessions and
  keys, the sanitizer, and the resume model.
- **A covered line is not a tested line.** Coverage shows what no test runs. It cannot show that a test checks the
  right thing. The property tests and the checks in [Writing a test](#writing-a-test) are for that.
- **Left out of the count**, each with its reason in `vitest.config.ts`: files that are only wiring or types;
  files that are tested as separate processes, where the report cannot see them; the tools run by hand against
  live sites; and the old Indeed route.

## CI

`.github/workflows/ci.yml` runs on every push, on Linux and on Windows: type check, `npm test` (with the coverage
minimum on Linux), the browser tests, and a build. The demo is deployed from `main` only when all of it passed on
both systems. The coverage report of each run is kept for 14 days as a download on the run's page.

The Linux job is pinned to Ubuntu 24.04, the system the server's Docker image is built on. The pinned Playwright
has no browser for a newer Ubuntu, and "the latest" Ubuntu moves without notice. When Playwright is upgraded, the
version in both `package.json` files, the image in `server/Dockerfile` and the system in the workflow move
together.

## What is not tested

A green run does not cover these. Each one is a known gap, not an oversight:

- **The live job sites.** No automated test calls them. A source can pass every test and be broken because the
  site changed. `npm run smoke --prefix server` on the laptop is the check, and so is recording the cassettes
  again.
- **Hand-written cassettes.** They match what the adapter expects, which is not proof of what the service sends.
- **The browser tier driving a real browser** (`playwrightLoader` in `server/src/browser.ts`). Its logic is tested
  with a stand-in page loader.
- **The old Indeed route** (`server/src/indeed.ts`). Only its page parser is tested.
- **The tools run by hand:** `server/src/smoke.ts`, `server/src/check-catalog.ts`, and the command-line part of
  the recorder.
- **The Google for Jobs and USAJOBS sources against the real services.** They need keys, and a key lives only in
  `server/.env` on the machine that runs the server. [status.md](status.md#not-yet-tried-on-a-real-machine) says
  whether each has been tried there.
- **The breached-password lookup against the real service.** It is tested against a stand-in.
- **Browsers other than Chromium,** and phones.
- **How the pages look.** There are no picture comparisons. The tests check what is on the page, not where.
- **Large loads and long runs.** There are no speed or load tests.

## When a test fails

- **Read the message first.** The guards explain themselves: a network call names the address, a missing recording
  prints the request, a page test prints what the page shows.
- **"No recorded answer for this request".** The source now asks for something else. If that was meant, change the
  cassette or record again. If not, the change broke the source.
- **A property test.** It found a real case. See [Property tests](#property-tests).
- **"requests the test gave the fake server no answer for".** The page called the server in a way the test did not
  expect. Add the route if the call is right.
- **Only on Windows.** Usually a path, a line ending, or a file that is still open when it is deleted.
- **Only sometimes.** Treat it as a bug, in the test or in the code. Find what differs between runs: time, order,
  chance. Do not add a retry, and never skip or delete a test to get a green run.
- **The coverage minimum.** New code came without tests. Write them.
