# Resume data model

Source: `src/resume/model.ts`. Parser: `src/resume/parse.ts`. Extraction: `src/resume/extract.ts`, `load.ts`.

## The guarantee

Every `Field` has:

| Property | Meaning |
| --- | --- |
| `value` | The text |
| `spans` | Character ranges in `source.text` the value was taken from |
| `origin` | `source` (verbatim from the file) or `user` (typed by the user) |
| `status` | `pending`, `verified`, or `rejected` |
| `confidence` | How sure the parser is that the text is in the right slot (drives review order hints) |

`checkIntegrity(resume)` re-reads the text at every span and compares it to the value. Any mismatch is a hard
failure. `toApplicationProfile(resume)` (what automated applying will consume) throws if integrity fails and returns
only `verified` fields. There is no code path that generates or rewrites wording.

The only normalisation applied to a value is whitespace: a bullet that wraps across three lines in a PDF becomes one
string with single spaces, and keeps one span per visual line.

Dates keep their verbatim text as `value` and add a parsed `start` / `end` / `current` so application forms with
month and year pickers can be filled. The parsed part is derived data, never presented as the user's words.

## Shape

```
ParsedResume
├─ source: SourceDocument      text, lines, PDF positions, sha256 of the file
├─ contact                     name, headline, email, phone, location, links[]
├─ summary[]                   paragraphs
├─ experience[]                title, company, location, dates, bullets[]
├─ education[]                 institution, degree, fieldOfStudy, location, dates, gpa, details[]
├─ skills[]                    category?, items[]
└─ sections[]                  every detected section; unstructured ones (projects, certifications,
                               awards, …) keep their lines as items[] so nothing is dropped
```

## From a file to text

The parser works on plain text. `src/resume/load.ts` opens the file, and `src/resume/extract.ts` turns what it
gets into lines:

| File | How it becomes lines |
| --- | --- |
| PDF | pdf.js gives runs of text with their place on the page. Runs on one baseline become one line. A wide gap inside a line becomes three spaces, which the parser reads as a column break ("Name      email"). Each run keeps its box, so the review screen can highlight it on the page. |
| Word (`.docx`) | mammoth turns the file into HTML. A paragraph or a heading becomes a line. A list item becomes a line that starts with "• ", so the parser can tell a bullet from a header. The marker is never part of a field. A table row whose cells hold one line each becomes one line, with three spaces between the cells. A table that lays out the page (a cell with several paragraphs, a list or another table) is read cell after cell, one line per paragraph. |
| Text (`.txt`, `.md`) | Used as it is. |

## How parsing works

No AI and no network. `parseResume` is deterministic rules:

1. Split the text into sections by heading vocabulary ("Experience", "Work History", "EDUCATION", …).
2. Lines above the first heading are the contact block: email, phone, links and location by pattern; name and headline by position.
3. Experience: a run of non-bullet lines is an entry header; the date range, location, title and company are pulled
   out of it; following bullets (and their wrapped continuation lines) attach to it. Stacked roles under one employer
   reuse the employer's span.
4. Education and skills use their own small grammars.
5. Anything not understood is still kept, as a low-confidence field or as visibly "not captured" text in the review screen.

## Review screen

Left: the original (rendered PDF page with highlights, or the extracted text). Right: the fields. Selecting either
side highlights the other. Text not captured by any field gets a wavy underline. To fix a wrong field without
retyping, select the right text in the Text view and choose "Use" for the active field, which keeps it verbatim.
Typing a correction is allowed and is marked `typed`.

## Tests

| Test | What it checks |
| --- | --- |
| `src/resume/model.test.ts` | The guarantee: a field that differs from its source is caught, and only confirmed fields get out |
| `src/resume/parse.test.ts`, `src/resume/dates.test.ts`, `src/resume/extract.test.ts` | The rules, on sample resumes and small pieces of text |
| `src/resume/parse.property.test.ts` | Made-up text and PDFs by the hundred: the parser never fails, and every field is the file's exact words |
| `test/integration/pdf.test.ts`, `test/integration/docx.test.ts` | A real PDF and a real Word file through the real readers |
| `src/ui/ResumePage.test.tsx`, `test/e2e/app.e2e.ts` | The review screen, in a simulated and in a real browser |

## Known limits

- Two-column PDF layouts can interleave columns in reading order. The review screen makes this visible; column detection is future work.
- Scanned (image-only) PDFs have no text; the app says so and asks for a text PDF or DOCX. OCR is future work.
- Old `.doc` files are not supported.
