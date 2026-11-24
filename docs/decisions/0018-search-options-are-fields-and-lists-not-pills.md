# 0018. Search options are fields and lists, not pills

- **Status:** Accepted
- **Date:** 2026-11-24
- **Decided by:** Sloan (no cluster of pills) and Claude (the controls that replace them, picked while Sloan was away)

## Context

The search page had grown three groups of small rounded labels, which the code called pills and chips:

- in the search box, three buttons to press in and out: Remote, Hybrid, On-site;
- in the settings behind the gear, a chip for each chosen company and a button to press in and out for each
  industry;
- under the search box after a search, one pill per source. With a few companies chosen, that row wrapped over
  three lines.

Sloan, on seeing it: "I don't like having a shit done of pills you can toggle on and off for the search options,
it should be a more clean and organized UI that doesn't just look like a big cluster of labels".

What could replace them:

1. **Keep the pills and group them under headings.** The least work, and still a cluster of labels.
2. **A column of filters beside the results,** as the large job boards have. It breaks
   [0002](0002-the-search-page-is-one-bar-with-sources-behind-a-gear.md), which keeps the filters inside the one
   search box, and it takes room from the postings.
3. **Ordinary form controls** in the places the options already are: fields with their names over them, lists to
   tick, and sections that fold away.

## Decision

Option 3. The page keeps the shape Sloan gave it in 0002, and what is inside that shape changes:

- **No search option is a button that is pressed in and out,** and no set of choices is a row of small labels that
  wraps.
- **In the search box, every filter is a field with its name over it,** all in one row: Location, Within,
  Workplace, Posted. One choice out of a few is a dropdown. Several choices out of a few (the workplaces) is a
  field that looks like the dropdowns beside it, says what is chosen, and opens a list to tick.
- **In the settings, each kind of source is a section that folds away under its heading.** The heading says in a
  few words what is chosen inside, so a folded section still tells its state, and a warning shows there too. Only
  the job boards are unfolded on a first visit. The panel remembers which sections were open.
- **Many choices are a list to tick, one to a row.** Things the user added, such as companies, are a list with one
  row each and a button that removes the row.
- **A report on many things is one line of totals that opens to a table.** For the sources of a search, the line
  counts what answered, failed, was blocked and is off. The table names every source, with what went wrong and why
  at the top.

This covers the search page and its settings. The resume review has two switches of its own (Page or Text, and
confirm or remove on a field). They are not search options and were not touched.

## Consequences

- A new filter is a new field in the row, and a new kind of source is a new section. Neither adds to a cluster.
- A folded section hides its controls, so a heading that says nothing useful hides a problem. Every section needs a
  summary, and one for a fault or a warning is coloured.
- Companies, direct site access and the server address are one press further away than before.
- Which source failed is one press away, where it used to be in view. The line still counts the failures, in
  colour, so a failure is seen without opening anything.
- The workplace list and the table of sources float over the page. Each closes on Escape, on a press outside it and
  when the focus leaves it, and Escape closes only what is on top: a list open inside the settings does not close
  the settings.
- A reason to look again: Sloan finds that folding hides too much, or the row of filters grows past what fits in
  one line of the box.

## In the code

- `src/ui/controls.tsx`: the field with a list to tick (`MultiSelect`), the section that folds (`Section`), and
  closing what floats (`useDismiss`).
- `src/ui/SearchPage.tsx` (`SearchBox`, `SourceReport`), `src/ui/SettingsPanel.tsx`, and their styles in
  `src/ui/styles.css`.
- `src/ui/controls.test.tsx` checks the controls. `src/ui/SearchPage.test.tsx` and `src/ui/SettingsPanel.test.tsx`
  each have a test that fails when an option is a switch to press in and out again.
- `test/e2e/app.e2e.ts` sets a filter and opens the table of sources in a real browser, under the real stylesheet.
