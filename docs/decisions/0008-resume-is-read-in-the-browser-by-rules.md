# 0008. The resume is read in the browser, by rules

- **Status:** Accepted
- **Date:** 2026-11-16
- **Decided by:** Claude, in the first build. Sloan has not been asked to confirm it. The plan asks whether it
  should change ([applications-plan.md](../applications-plan.md), decision 5).

## Context

A resume is personal, and the app's promise is that its fields are the file's exact words
([0001](0001-applications-use-the-users-own-words.md)). The first build needed a way to turn a PDF, a Word file or
a text file into fields without a server, because the public copy of the app has none.

## Decision

- **The resume never leaves the browser.** The file is read there (pdf.js for PDF, mammoth for Word), parsed
  there, and kept there: the fields in `localStorage`, the original file in IndexedDB.
- **Parsing is fixed rules, with no AI and no network.** The same file always gives the same fields.
- **Nothing is dropped.** Text the rules do not understand is kept as a low-confidence field or shown as "not
  captured" on the review screen.

## Consequences

- The resume tools work on the static demo and offline.
- Rules cannot understand every layout. Two-column PDFs can come out interleaved, scanned PDFs have no text, old
  `.doc` files are not supported ([resume-model.md](../resume-model.md), "Known limits").
- Clearing the browser's storage loses the review. There is no copy anywhere else, and no second device.
- Two things in the plan would change this decision and need Sloan's yes first: storing application records in the
  account, and sending resume text to the Claude API for users who switch AI help on (decision 5). If either is
  built, write a new record that replaces this one, and reword the promise in the README.

## In the code

- `src/resume/load.ts` and `extract.ts` (file to text with positions), `parse.ts` (text to fields),
  `src/lib/storage.ts` (the browser's storage).
- `src/resume/*.test.ts`, `src/ui/ResumePage.test.tsx`, and real files through the real readers in
  `test/integration/pdf.test.ts`, `test/integration/docx.test.ts` and `test/e2e/app.e2e.ts`.
