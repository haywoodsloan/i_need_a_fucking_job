# 0021. An answer is marked with who wrote it

- **Status:** Accepted
- **Date:** 2026-11-24
- **Decided by:** Sloan asked for first drafts and was told the tracker marks them as drafts. Claude chose the marks and the rules around them, which are defaults.

## Context

The first rule of this project is that an application is the user's own words
([0001](0001-applications-use-the-users-own-words.md)): nothing the app writes may enter one. The plan's open
decision 6 asked whether AI may suggest wording. Its recommended answer was no, with a note on what a yes would
need: "a third, visible origin label".

Then the way Sloan works changed. An assistant outside the app prepares each application, and on 2026-11-24 Sloan
told it: "You should pre-answer all questions for me, I'll review the open prompt answers before I submit." The
answers to open questions are first drafts that Sloan rewrites "in my own words before submitting".

The tracker ([0020](0020-applications-are-kept-by-the-server-on-its-own-computer.md)) has to hold those drafts, or
a restart loses them. That puts text written by an assistant into the app's records, next to text the user typed.
Kept without a mark, the two cannot be told apart later, and the first rule means nothing. The options:

- **Keep no drafts in the app.** Then the app cannot do what it was asked to do: bring an application back after a
  restart.
- **Keep them unmarked.** The user could send an assistant's words believing they were their own.
- **Mark every answer with who wrote it,** and make the marks hard to get wrong.

The card that asked Sloan about saving applications said "Drafts are marked as drafts", and Sloan chose it.

## Decision

Every answer in a tracked application says who wrote it, and the app never turns someone else's text into the
user's.

- **Three origins.** `user`: typed by the user on the app's own page. `assistant`: written by an assistant.
  `form`: read back from the live form by an assistant, where the user may have typed it. Only `user` is the
  user's own words.
- **A draft stays a draft until the user settles it.** They rewrite it, and the new text is theirs. Or they keep it
  as it is: the answer is then settled, the time is kept, and it still says an assistant wrote it.
- **The page speaks for the user, and nothing else does.** What is saved on the Applications page is the user's.
  Every other change is an assistant's, also when it says otherwise.
- **An assistant cannot undo the user.** It cannot change an answer the user wrote or kept, cannot replace what
  was read from the form except with a newer reading, cannot touch the answers of an application that was sent,
  and cannot remove an application.
- **Some questions are nobody's but the user's.** A pledge, an acknowledgment, a consent, a demographic question
  and a file to attach have the status `yours`. An assistant cannot put a value in one, and cannot take the status
  away.
- **The app still writes nothing.** It keeps and shows what people and assistants give it. It fills no form.

## Consequences

- The user can always see which answers are their own words, which are an assistant's draft, and which draft they
  kept without rewriting.
- The first rule holds for the app's own code, and decision 6 of the plan stays open for the day the app itself
  fills forms or calls a model: whether an assistant's text may be sent then, and how it is labelled, is still
  Sloan's to decide. Step 2 of the plan has to carry these marks into its review screen.
- An assistant that follows the rules cannot mark its text as the user's, even by mistake. A program that sets out
  to lie can: the tracker has no sign-in, and whatever runs on the computer can send what the page sends
  ([applications.md](../applications.md#known-limits)). The marks are a record among honest callers, not a lock.
- An answer the user gave an assistant in a message, and the assistant typed in, is marked as an assistant's. That
  is true to who typed it. The user makes it theirs by saving it on the page.
- A reason to look at this again: the app starts filling forms itself, or Sloan wants a kept draft to count as
  their own words.

## In the code

- `src/apply/model.ts`: the origins, the statuses, and `changeApplication`, which holds every rule above.
- `src/apply/model.test.ts`: a test for each rule. This file and `server/src/applications/http.ts` must stay at
  every line covered (`vitest.config.ts`).
- `server/src/applications/http.ts`: `actor` decides who a change is from. Only a request from a page can be the
  user's.
- `src/apply/client.ts`: everything the page sends is sent as the user's.
- `src/ui/ApplicationsPage.tsx`: `writtenBy` puts the mark into words, and "Keep as it is" is sent with the
  revision the page shows, so a draft that changed unseen is never kept.
- `src/ui/ApplicationsPage.test.tsx`: "a first draft by an assistant" and the tests around it.
