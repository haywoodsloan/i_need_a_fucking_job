# 0015. Job site HTML is sanitized, and the app runs under a strict policy

- **Status:** Accepted
- **Date:** 2026-11-17
- **Decided by:** Claude. Sloan was not asked: it is a safety measure with no choice in it for the user.

## Context

Job descriptions arrive as HTML written by strangers, and the app shows them inside its own page. Once people
sign in, a script smuggled into a description could act as the signed-in user.

## Decision

Two barriers, so that one can fail without harm:

1. **An allowlist sanitizer.** Job HTML reaches the page only through `sanitizeHtml`. It keeps a short list of
   harmless tags and one attribute (the address of a web link), and drops everything else. It is a list of what
   is allowed, never a list of what is known to be bad.
2. **A strict content security policy** on the app when the server serves it: scripts and styles only from the
   app's own files, nothing inline, nothing evaluated from text. Even if hostile markup got past the sanitizer,
   the browser would refuse to run it.

## Consequences

- No inline `<script>` or `<style>` in `index.html`, and no library that needs `eval`. The browser test would
  catch one.
- GitHub Pages cannot send these headers. Only a copy served by the server gets the second barrier, which is one
  reason a hosted copy with accounts will be served that way.
- `connect-src` still allows any HTTPS address, because the app can search some sources straight from the
  browser. A hosted copy should tighten it ([accounts.md](../accounts.md), "Known limits").

## In the code

- `src/ui/sanitize.ts`, used by `src/ui/SearchPage.tsx`. `server/src/static.ts` (`APP_CSP`, `appHeaders`).
- `src/ui/sanitize.test.ts` (a list of hostile descriptions), `src/ui/sanitize.property.test.ts` (thousands of made-up
  ones), `test/server/static.test.ts`, and `test/e2e/app.e2e.ts`, which checks in a real browser that the policy
  is enforced and that the app runs under it with nothing refused.
- `vitest.config.ts` requires every line of `src/ui/sanitize.ts` to be run by a test.
