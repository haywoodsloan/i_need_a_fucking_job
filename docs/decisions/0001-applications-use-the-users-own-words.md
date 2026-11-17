# 0001. Applications use the user's own words

- **Status:** Accepted
- **Date:** 2026-11-16
- **Decided by:** Sloan

## Context

The goal of the app is to fill in and send job applications for its user. When Sloan asked for the first build
(job search and the resume analyzer), they gave the reason for building the analyzer first: to check that the tool
breaks a resume down correctly, so that when it applies it can guarantee accuracy and consistency, "because you
don't want to be offering our own words for the user in their application". The app automates getting the
application from the resume the user decided on, and the user has to feel confident that what is sent is theirs.

## Decision

Nothing the app writes may enter an application.

- Every resume field is either an exact slice of the uploaded file, with a pointer to where in the file it came
  from (`origin: 'source'`), or text the user typed (`origin: 'user'`). There is no third kind.
- The only change ever made to a value is whitespace: a bullet that wraps over three lines becomes one line.
- `checkIntegrity` reads the file again at every pointer and compares. Any difference is a hard failure.
- `toApplicationProfile` is the only way resume data leaves for an application. It returns only fields the user
  confirmed, and refuses to run if any field differs from the file.

## Consequences

- A parsing mistake shows up as a wrong slice that the user can see and fix. It never shows up as invented text.
- The user has to review: every field starts as `pending` and is confirmed or removed on the review screen.
- A parsed date keeps its original text as the value. The month and year worked out from it are extra data for
  form pickers, never shown as the user's words.
- The app cannot "repair" a badly parsed resume by rewording it. The fix is always to select the right text.
- Everything built later has to go through the same gate: the resume builder, an AI breakdown of a resume, the
  application filler. Whether AI may ever suggest wording is an open question for Sloan, and the recommended
  answer is no ([applications-plan.md](../applications-plan.md), decision 6).

## In the code

- `src/resume/model.ts`: `Field`, `checkIntegrity`, `toApplicationProfile`. Described in
  [resume-model.md](../resume-model.md).
- `src/resume/model.test.ts` checks the gate. `src/resume/parse.property.test.ts` makes up hundreds of resumes,
  tidy and broken, and holds every field of every one to the rule.
- `vitest.config.ts` requires every line of `src/resume/model.ts` to be run by a test.
