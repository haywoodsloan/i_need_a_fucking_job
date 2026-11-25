/**
 * The applications this computer keeps (docs/applications.md): the list of them, and one application with what is
 * left for the user before it can be sent.
 *
 * Whatever is saved on this page is saved as the user's. Every answer says who wrote it, and a draft by an assistant
 * stays marked as a draft until the user rewrites it or keeps it as it is
 * (docs/decisions/0021-an-answer-is-marked-with-who-wrote-it.md).
 */
import { Fragment, useCallback, useEffect, useId, useMemo, useState, type ChangeEvent, type FormEvent, type ReactNode } from 'react';
import type { Changes, FieldChange, ImportReply, UnreadableFile } from '../apply/api';
import { EXPORT_PATH, TrackerError, trackerApi, trackerErrorText } from '../apply/client';
import { LIMITS, STAGES, STAGE_LABEL, leftForUser, stageGroup, type Application, type ApplicationSummary, type FormField, type Setter, type Stage, type StageGroup, type TimelineEntry } from '../apply/model';
import { useTracker } from '../apply/TrackerProvider';
import { ErrorNotice } from './AccountForms';
import { Section, count } from './controls';
import { useRoute } from './hooks';
import { sanitizeHtml, textToHtml } from './sanitize';

/** How often the page asks again while it is in view. An assistant may be working on the same applications. */
const REFRESH_MS = 15_000;

const dateTime = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const dateOnly = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' });
/** A day given without a time is that day everywhere, so it is not moved into this computer's time zone. */
const dayAsWritten = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeZone: 'UTC' });
const when = (iso: string) => dateTime.format(new Date(iso));
const onDay = (iso: string) => (/^\d{4}-\d{2}-\d{2}$/.test(iso) ? dayAsWritten : dateOnly).format(new Date(iso));

const WHO: Record<Setter, string> = { user: 'you', assistant: 'your assistant', site: 'the employer’s site' };
const WORKPLACE = { remote: 'Remote', hybrid: 'Hybrid', onsite: 'On-site' };

/** Only a web address is ever put in a link, whatever a record holds. */
const webLink = (address: string | undefined) => (address && /^https?:\/\//i.test(address) ? address : undefined);

/**
 * Asks once, and again every quarter of a minute while the page is in view. With `onFocus`, also whenever the window
 * gets the focus back.
 */
function useLive(ask: () => unknown, onFocus: boolean) {
  useEffect(() => {
    ask();
    const again = () => {
      if (document.visibilityState === 'visible') ask();
    };
    if (onFocus) window.addEventListener('focus', again);
    const timer = window.setInterval(again, REFRESH_MS);
    return () => {
      window.removeEventListener('focus', again);
      window.clearInterval(timer);
    };
  }, [ask, onFocus]);
}

/** One thing the user does on the page that the server has to agree to: whether it is under way, and why it failed. */
function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  /** `action` answers with the sentence that says why it failed, or with nothing when it worked. */
  const run = useCallback(async (action: () => Promise<string>): Promise<boolean> => {
    setBusy(true);
    setError('');
    const problem = await action().catch(trackerErrorText);
    setBusy(false);
    setError(problem);
    return !problem;
  }, []);
  return { busy, error, run };
}

export function ApplicationsPage({ id }: { id: string }) {
  const { state, refresh } = useTracker();
  // The list itself is asked for again on focus by the provider, wherever in the app the user is.
  useLive(refresh, false);

  if (state.status === 'on') return id ? <ApplicationDetail key={id} id={id} /> : <ApplicationList applications={state.applications} unreadable={state.unreadable} />;
  return (
    <main className="tracker-page">
      <h1>Applications</h1>
      {state.status === 'checking' ? (
        <p className="muted" role="status">
          Looking for your applications…
        </p>
      ) : state.why === 'unreachable' ? (
        <div className="card">
          <p>The app could not reach its server.</p>
          <p className="small muted">Applications are kept by the server of this app, on the computer it runs on. Check that the server is running.</p>
          <div className="actions">
            <button type="button" className="btn" onClick={() => void refresh()}>
              Try again
            </button>
          </div>
        </div>
      ) : (
        <div className="card">
          <p>{state.why === 'build' ? 'This copy of the app keeps no applications.' : 'This server keeps no applications.'}</p>
          <p className="small muted">
            {state.why === 'build'
              ? 'Applications are kept by the app’s own server, on your own computer. This copy runs without one. Start the app on your computer with "npm run local" to track your applications.'
              : 'Applications have no sign-in, so a server only keeps them where nobody but the user of its own computer can reach it. The server’s log says why this one keeps none.'}
          </p>
        </div>
      )}
    </main>
  );
}

/* ------------------------------------------------------------------ the list */

const GROUPS: { group: StageGroup; title: string }[] = [
  { group: 'open', title: 'In progress' },
  { group: 'sent', title: 'Sent' },
  { group: 'over', title: 'Closed' },
];

type LeftCounts = { asks: number; drafts: number; yours: number };

/** What is left for the user, one part for each kind: "2 answers needed", "3 drafts to review", "1 only you can do". */
const leftParts = (left: LeftCounts): string[] =>
  [left.asks ? `${count(left.asks, 'answer')} needed` : '', left.drafts ? `${count(left.drafts, 'draft')} to review` : '', left.yours ? `${left.yours} only you can do` : ''].filter(Boolean);

/** "2 answers needed, 3 drafts to review, 1 only you can do". */
const leftText = (left: LeftCounts): string => leftParts(left).join(', ');

/** The same words in a column of the list, where a line may end between two parts and not inside one. */
function LeftInList({ left }: { left: LeftCounts }) {
  const parts = leftParts(left);
  if (!parts.length) return <>Nothing</>;
  return (
    <>
      {parts.map((part, i) => (
        <Fragment key={part}>
          {i > 0 && ' '}
          <span className="part">
            {part}
            {i < parts.length - 1 && ','}
          </span>
        </Fragment>
      ))}
    </>
  );
}

function ApplicationList({ applications, unreadable }: { applications: ApplicationSummary[]; unreadable: UnreadableFile[] }) {
  const [adding, setAdding] = useState(false);
  const imported = useImport();
  return (
    <main className="tracker-page">
      <div className="tracker-head">
        <div>
          <h1>Applications</h1>
          <p className="small muted">Kept on this computer by the app’s server, so they are still here after a restart.</p>
        </div>
        <div className="actions">
          <button type="button" className="btn" aria-expanded={adding} onClick={() => setAdding(!adding)}>
            Add an application
          </button>
          <label className="btn">
            {imported.busy ? 'Importing…' : 'Import a file'}
            <input type="file" className="sr-only" accept=".json,application/json" onChange={imported.chosen} disabled={imported.busy} />
          </label>
          {applications.length > 0 && (
            <a className="btn" href={EXPORT_PATH} download="job-applications.json">
              Export
            </a>
          )}
        </div>
      </div>
      <ErrorNotice>{imported.error}</ErrorNotice>
      {imported.result && <Imported result={imported.result} />}
      {adding && <AddByHand onClose={() => setAdding(false)} />}
      {unreadable.length > 0 && (
        <div className="notice" role="status">
          {count(unreadable.length, 'file')} in the server’s folder of applications could not be read, and {unreadable.length === 1 ? 'is' : 'are'} not shown below. Nothing in{' '}
          {unreadable.length === 1 ? 'it' : 'them'} was changed.
          <ul>
            {unreadable.map((u) => (
              <li key={u.file}>
                <code>{u.file}</code>: {u.why}
              </li>
            ))}
          </ul>
        </div>
      )}
      {applications.length === 0 && <div className="empty">No applications yet. Save a job from the search results, add one here, or import a file.</div>}
      {GROUPS.map(({ group, title }) => {
        const rows = applications.filter((a) => stageGroup(a.stage) === group);
        if (!rows.length) return null;
        const third = group === 'open' ? 'Left for you' : group === 'sent' ? 'Sent' : 'Ended';
        // The roles are the ones a table has anyway. They are written out because a narrow window shows each row as
        // a few lines under each other (styles.css), and some browsers stop reading a table as a table when its
        // parts are laid out as anything else.
        return (
          <section key={group} className="card" aria-labelledby={`applications-${group}`}>
            <h2 id={`applications-${group}`}>
              {title} <span className="muted">({rows.length})</span>
            </h2>
            <table className="tracker-table" role="table">
              <thead role="rowgroup">
                <tr role="row">
                  <th scope="col" role="columnheader">
                    Role
                  </th>
                  <th scope="col" role="columnheader">
                    Stage
                  </th>
                  <th scope="col" role="columnheader">
                    {third}
                  </th>
                  <th scope="col" role="columnheader" className="wide-only">
                    Last change
                  </th>
                </tr>
              </thead>
              <tbody role="rowgroup">
                {rows.map((a) => (
                  <tr key={a.id} role="row">
                    <th scope="row" role="rowheader">
                      <a href={`#/applications/${a.id}`}>{a.title}</a>
                      <div className="small muted">{[a.company, a.location].filter(Boolean).join(' · ')}</div>
                    </th>
                    <td role="cell" data-label="Stage">
                      {STAGE_LABEL[a.stage]}
                    </td>
                    <td role="cell" data-label={third}>
                      {group === 'open' ? a.fields === 0 ? <span className="muted">No form prepared yet</span> : <LeftInList left={a} /> : group === 'sent' && a.submittedAt ? onDay(a.submittedAt) : onDay(a.updatedAt)}
                    </td>
                    <td role="cell" className="wide-only muted">
                      {when(a.updatedAt)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        );
      })}
    </main>
  );
}

function AddByHand({ onClose }: { onClose: () => void }) {
  const { refresh } = useTracker();
  const [, go] = useRoute();
  const [title, setTitle] = useState('');
  const [company, setCompany] = useState('');
  const [link, setLink] = useState('');
  const { busy, error, run } = useAction();
  const id = useId();

  const submit = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      if (!title.trim() || !company.trim()) return 'Give the job title and the company.';
      if (!webLink(link.trim())) return 'The link to the posting must be a web address that starts with https:// or http://.';
      const reply = await trackerApi.add({ job: { title, company, postingUrl: link.trim(), listings: [] } });
      await refresh();
      go(`applications/${reply.application.id}`);
      return '';
    });
  };

  return (
    <section className="card" aria-labelledby={`${id}-title`}>
      <h2 id={`${id}-title`}>Add an application</h2>
      <p className="small muted">For a job you found somewhere else. A job from the search results has a “Save to applications” button of its own.</p>
      <form className="form" onSubmit={submit}>
        <div className="form-field">
          <label htmlFor={`${id}-job`}>Job title</label>
          <input id={`${id}-job`} type="text" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={LIMITS.line} required autoFocus />
        </div>
        <div className="form-field">
          <label htmlFor={`${id}-company`}>Company</label>
          <input id={`${id}-company`} type="text" value={company} onChange={(e) => setCompany(e.target.value)} maxLength={LIMITS.line} required />
        </div>
        <div className="form-field">
          <label htmlFor={`${id}-link`}>Link to the posting</label>
          <input id={`${id}-link`} type="text" inputMode="url" placeholder="https://" value={link} onChange={(e) => setLink(e.target.value)} maxLength={LIMITS.address} required />
        </div>
        <ErrorNotice>{error}</ErrorNotice>
        <div className="actions">
          <button type="submit" className="btn primary" disabled={busy}>
            {busy ? 'Adding…' : 'Add'}
          </button>
          <button type="button" className="btn ghost" onClick={onClose}>
            Cancel
          </button>
        </div>
      </form>
    </section>
  );
}

/** Puts back what "Export" gave. Applications that are here already are left as they are. */
function useImport() {
  const { refresh } = useTracker();
  const [result, setResult] = useState<ImportReply>();
  const { busy, error, run } = useAction();

  const chosen = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    // Emptied, so that choosing the same file again is noticed.
    e.target.value = '';
    if (!file) return;
    setResult(undefined);
    void run(async () => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(await file.text());
      } catch {
        return `${file.name} is not a file of applications: it is not JSON.`;
      }
      setResult(await trackerApi.importFile(parsed));
      await refresh();
      return '';
    });
  };
  return { busy, error, result, chosen };
}

function Imported({ result }: { result: ImportReply }) {
  return (
    <div className={`notice${result.skipped.length ? '' : ' ok'}`} role="status">
      {result.added.length ? `Added ${count(result.added.length, 'application')}.` : 'Nothing was added.'}
      {result.skipped.length > 0 && (
        <>
          {' '}
          Not added:
          <ul>
            {result.skipped.map((skipped, i) => (
              <li key={i}>
                {skipped.what}: {skipped.why}
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

/* ------------------------------------------------------------ one application */

/** Saves a change. Answers with the sentence that says why it was not saved, or with nothing when it was. */
type Save = (changes: Changes, o?: { guarded?: boolean }) => Promise<string>;

function ApplicationDetail({ id }: { id: string }) {
  const { refresh } = useTracker();
  const [, go] = useRoute();
  const [app, setApp] = useState<Application>();
  const [missing, setMissing] = useState(false);
  const [loadError, setLoadError] = useState('');

  /** Never back to an older version: the answer to an earlier question can arrive after a newer one. */
  const take = useCallback((next: Application) => setApp((old) => (old && old.revision > next.revision ? old : next)), []);

  const load = useCallback(async () => {
    try {
      take((await trackerApi.get(id)).application);
      setLoadError('');
    } catch (e) {
      if (e instanceof TrackerError && e.code === 'not_found') setMissing(true);
      else setLoadError(trackerErrorText(e));
    }
  }, [id, take]);
  useLive(load, true);

  const revision = app?.revision;
  const save: Save = useCallback(
    async (changes, o = {}) => {
      try {
        take((await trackerApi.change(id, changes, o.guarded ? revision : undefined)).application);
      } catch (e) {
        if (!(e instanceof TrackerError && e.code === 'changed' && e.application)) throw e;
        take(e.application);
        return 'This application changed while you had it open, so that was not saved. It is shown as it is now. Look at it again, then repeat what you did.';
      }
      void refresh();
      return '';
    },
    [id, revision, take, refresh],
  );

  if (missing) {
    return (
      <main className="tracker-page">
        <BackLink />
        <h1>No such application</h1>
        <p className="muted">There is no application at this address. It may have been removed.</p>
      </main>
    );
  }
  if (!app) {
    return (
      <main className="tracker-page">
        <BackLink />
        {loadError ? (
          <>
            <ErrorNotice>{loadError}</ErrorNotice>
            <div className="actions">
              <button type="button" className="btn" onClick={() => void load()}>
                Try again
              </button>
            </div>
          </>
        ) : (
          <p className="muted" role="status">
            Loading…
          </p>
        )}
      </main>
    );
  }

  const { job, form } = app;
  const open = stageGroup(app.stage) === 'open';
  const formLink = webLink(form?.url);
  const postingLink = webLink(job.postingUrl);
  return (
    <main className="tracker-page">
      <BackLink />
      <div>
        <h1>{job.title}</h1>
        <div className="facts">
          <strong>{job.company}</strong>
          {job.location && <span>{job.location}</span>}
          {job.workplace && <span>{WORKPLACE[job.workplace]}</span>}
          {job.pay && <span>{job.pay}</span>}
          {job.postedAt && <span>Posted {onDay(job.postedAt)}</span>}
        </div>
      </div>
      <div className="actions">
        {formLink && (
          <a className="btn primary" href={formLink} target="_blank" rel="noopener noreferrer">
            Open the form
          </a>
        )}
        {postingLink && postingLink !== formLink && (
          <a className="btn" href={postingLink} target="_blank" rel="noopener noreferrer">
            Open the posting
          </a>
        )}
      </div>
      <StageCard app={app} save={save} />
      {open && <LeftForYou app={app} save={save} />}
      <div className="panels">
        {form && form.fields.length > 0 && <Answers fields={form.fields} save={save} />}
        {form?.notes && <FormNotes notes={form.notes} />}
        <Posting app={app} />
      </div>
      <History app={app} save={save} />
      <Remove
        app={app}
        onRemoved={() => {
          void refresh();
          go('applications');
        }}
      />
    </main>
  );
}

const BackLink = () => (
  <p className="small">
    <a href="#/applications">All applications</a>
  </p>
);

function StageCard({ app, save }: { app: Application; save: Save }) {
  const { busy, error, run } = useAction();
  const id = useId();
  return (
    <div className="card">
      <div className="stage-row">
        <div className="filter">
          <label className="filter-label" htmlFor={id}>
            Stage
          </label>
          <span className="select">
            <select id={id} className="control" value={app.stage} disabled={busy} onChange={(e) => void run(() => save({ stage: e.target.value as Stage }))}>
              {STAGES.map((stage) => (
                <option key={stage} value={stage}>
                  {STAGE_LABEL[stage]}
                </option>
              ))}
            </select>
          </span>
        </div>
        <p className="small muted">
          Set by {WHO[app.stageSetBy]}.{app.submittedAt && ` Sent ${onDay(app.submittedAt)}.`} Last change {when(app.updatedAt)}.
        </p>
      </div>
      <ErrorNotice>{error}</ErrorNotice>
    </div>
  );
}

function LeftForYou({ app, save }: { app: Application; save: Save }) {
  const left = leftForUser(app);
  const said = leftText({ asks: left.asks.length, drafts: left.drafts.length, yours: left.yours.length });
  return (
    <section className="card" aria-labelledby="left-title">
      <h2 id="left-title">Left for you</h2>
      {!app.form?.fields.length ? (
        <p className="muted">No form has been prepared for this application yet.</p>
      ) : !said ? (
        <p className="muted">Nothing. Every question of the form has a settled answer.</p>
      ) : (
        <p className="small muted">{said}.</p>
      )}
      {left.asks.length > 0 && (
        <div className="left-group">
          <h3>Needs your answer</h3>
          <p className="small muted">Questions only you know the answer to.</p>
          {left.asks.map((f) => (
            <AnswerEditor key={f.id} field={f} mode="ask" save={save} />
          ))}
        </div>
      )}
      {left.drafts.length > 0 && (
        <div className="left-group">
          <h3>Drafts to review</h3>
          <p className="small muted">First drafts by your assistant. Rewrite each one in your own words, or keep it as it is.</p>
          {left.drafts.map((f) => (
            <AnswerEditor key={f.id} field={f} mode="draft" save={save} />
          ))}
        </div>
      )}
      {left.yours.length + left.optional.length > 0 && (
        <div className="left-group">
          <h3>Only you, on the form</h3>
          <p className="small muted">Nobody fills these in for you: pledges, consents, questions about yourself, files to attach.</p>
          <YoursList fields={left.yours} />
          {left.optional.length > 0 && (
            <>
              <p className="small muted">{left.yours.length > 0 ? 'The form does not require these:' : 'The form requires none of them:'}</p>
              <YoursList fields={left.optional} />
            </>
          )}
        </div>
      )}
    </section>
  );
}

function YoursList({ fields }: { fields: FormField[] }) {
  if (!fields.length) return null;
  return (
    <ul className="yours-list">
      {fields.map((f) => (
        <li key={f.id}>
          {f.label}
          {f.note && <div className="small muted">{f.note}</div>}
        </li>
      ))}
    </ul>
  );
}

/** Who wrote an answer, in a few words. */
function writtenBy(f: FormField): string {
  if (f.status === 'yours') return 'Only you, on the form';
  if (f.status === 'ask') return 'Waiting for your answer';
  if (f.value === '') return 'Left empty';
  if (f.origin === 'user') return 'Your words';
  const who = f.origin === 'form' ? 'Read from the form' : 'Written by your assistant';
  if (f.status === 'draft') return `${who}, as a draft`;
  return f.acceptedAt ? `${who}. You kept it as it is.` : who;
}

/**
 * One question with a box for its answer. What is typed stays as typed: nothing here rewrites, trims or corrects it.
 * `ask` is a question that waits for the user, `draft` an assistant's first draft, `change` any other answer.
 */
function AnswerEditor({ field, mode, save, onDone }: { field: FormField; mode: 'ask' | 'draft' | 'change'; save: Save; onDone?: () => void }) {
  const id = useId();
  const [text, setText] = useState(field.value);
  const [seen, setSeen] = useState(field.value);
  if (field.value !== seen) {
    // The answer changed in the tracker while this was open. What is being typed is kept.
    if (text === seen) setText(field.value);
    setSeen(field.value);
  }
  const { busy, error, run } = useAction();
  const changed = text !== field.value;
  const multiline = field.kind === 'longtext' || field.kind === 'choice' || field.value.includes('\n');

  const done = (ok: boolean) => {
    if (ok) onDone?.();
  };
  const saveText = (e: FormEvent) => {
    e.preventDefault();
    const change: FieldChange = { id: field.id, value: text };
    // An answer taken out again: a question the form requires waits for the user once more, any other is left empty.
    if (text === '') change.status = field.required ? 'ask' : 'filled';
    void run(() => save({ fields: [change] })).then(done);
  };
  /** Settles the question with what the tracker holds, which is what this box showed when it was last brought up to date. */
  const settle = () => void run(() => save({ fields: [{ id: field.id, status: 'filled' }] }, { guarded: true })).then(done);

  const about = [mode === 'draft' ? `${writtenBy(field)}.` : '', field.kind === 'choice' ? 'The option exactly as the form words it. Several options: one on each line.' : ''].filter(Boolean).join(' ');
  const box = {
    id: `${id}-box`,
    value: text,
    onChange: (e: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setText(e.target.value),
    maxLength: LIMITS.value,
    'aria-label': mode === 'change' ? field.label : undefined,
    'aria-describedby': about || field.note ? `${id}-about` : undefined,
    autoFocus: mode === 'change',
  };
  return (
    <form className="answer" aria-label={field.label} onSubmit={saveText}>
      {mode !== 'change' && (
        <div>
          <label htmlFor={`${id}-box`} className="answer-question">
            {field.label}
          </label>{' '}
          <span className="small muted">{field.required ? 'Required' : 'Optional'}</span>
        </div>
      )}
      {(about || field.note) && (
        <div className="small muted" id={`${id}-about`}>
          {about && <div>{about}</div>}
          {field.note && <div>{field.note}</div>}
        </div>
      )}
      {multiline ? <textarea {...box} rows={Math.min(18, Math.max(field.kind === 'longtext' ? 5 : 2, text.split('\n').length + Math.floor(text.length / 110)))} /> : <input type="text" {...box} />}
      <ErrorNotice>{error}</ErrorNotice>
      <div className="actions">
        <button type="submit" className="btn primary small" disabled={busy || !changed || (mode === 'ask' && text.trim() === '')}>
          {mode === 'draft' ? 'Save my version' : mode === 'ask' ? 'Save answer' : 'Save'}
        </button>
        {mode === 'draft' && (
          <button type="button" className="btn small" disabled={busy || changed} onClick={settle}>
            Keep as it is
          </button>
        )}
        {mode === 'ask' && !field.required && (
          <button type="button" className="btn small" disabled={busy || changed} onClick={settle}>
            Leave it empty
          </button>
        )}
        {mode === 'change' && (
          <button type="button" className="btn ghost small" onClick={onDone}>
            Cancel
          </button>
        )}
      </div>
    </form>
  );
}

function Answers({ fields, save }: { fields: FormField[]; save: Save }) {
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<string>();
  const settled = fields.filter((f) => f.status === 'filled').length;
  return (
    <Section title="Answers" summary={`${count(fields.length, 'question')}, ${settled} settled`} open={open} onToggle={() => setOpen(!open)} level={2}>
      <p>Every question of the form, in its order, with what goes in it and who wrote that.</p>
      <ol className="answers">
        {fields.map((f) => (
          <li key={f.id}>
            <div className="answer-question">
              {f.label} {f.required && <span className="small muted">Required</span>}
            </div>
            {editing === f.id ? (
              <AnswerEditor field={f} mode="change" save={save} onDone={() => setEditing(undefined)} />
            ) : (
              <>
                {f.value !== '' && <div className="answer-value">{f.value}</div>}
                <div className="answer-meta small muted">
                  <span>{writtenBy(f)}</span>
                  {f.status !== 'yours' && (
                    <button type="button" className="btn ghost small" aria-label={`Change the answer to: ${f.label}`} onClick={() => setEditing(f.id)}>
                      Change
                    </button>
                  )}
                </div>
                {f.note && <div className="small muted">{f.note}</div>}
              </>
            )}
          </li>
        ))}
      </ol>
    </Section>
  );
}

function FormNotes({ notes }: { notes: string }) {
  const [open, setOpen] = useState(false);
  return (
    <Section title="How this form is filled in" summary="Notes for filling it in again" open={open} onToggle={() => setOpen(!open)} level={2}>
      <div className="answer-value">{notes}</div>
    </Section>
  );
}

/** The posting as it was when it was saved. Its HTML came from a job site, so it goes through the sanitizer. */
function Posting({ app }: { app: Application }) {
  const [open, setOpen] = useState(false);
  const { job } = app;
  const body = useMemo(() => (job.descriptionHtml ? sanitizeHtml(job.descriptionHtml) : job.descriptionText ? textToHtml(job.descriptionText) : ''), [job.descriptionHtml, job.descriptionText]);
  return (
    <Section title="The posting" summary={`As it was when it was saved, ${onDay(app.createdAt)}`} open={open} onToggle={() => setOpen(!open)} level={2}>
      {body ? <div className="desc" dangerouslySetInnerHTML={{ __html: body }} /> : <p>The text of the posting was not saved.</p>}
      {job.listings.length > 0 && (
        <div className="listed">
          <div className="muted">Listed on</div>
          {job.listings.map((l, i) => (
            <div key={i}>
              {l.via}{' '}
              {webLink(l.url) && (
                <a href={webLink(l.url)} target="_blank" rel="noopener noreferrer nofollow" className="small">
                  original posting
                </a>
              )}
            </div>
          ))}
        </div>
      )}
    </Section>
  );
}

function historyLine(entry: TimelineEntry): ReactNode {
  if (entry.kind === 'created') return `Added by ${WHO[entry.by]}.`;
  if (entry.kind === 'stage') return `Stage set to “${STAGE_LABEL[entry.stage ?? 'unknown']}” by ${WHO[entry.by]}${entry.from ? `. It was “${STAGE_LABEL[entry.from]}”` : ''}.`;
  return entry.text;
}

function History({ app, save }: { app: Application; save: Save }) {
  const [note, setNote] = useState('');
  const { busy, error, run } = useAction();
  const id = useId();
  const submit = (e: FormEvent) => {
    e.preventDefault();
    void run(() => save({ note })).then((ok) => ok && setNote(''));
  };
  return (
    <section className="card" aria-labelledby={`${id}-title`}>
      <h2 id={`${id}-title`}>Notes and history</h2>
      <form className="form" onSubmit={submit}>
        <div className="form-field">
          <label htmlFor={`${id}-note`}>Add a note</label>
          <textarea id={`${id}-note`} value={note} onChange={(e) => setNote(e.target.value)} rows={2} maxLength={LIMITS.note} />
        </div>
        <ErrorNotice>{error}</ErrorNotice>
        <div className="actions">
          <button type="submit" className="btn small" disabled={busy || note.trim() === ''}>
            Add note
          </button>
        </div>
      </form>
      <ul className="history">
        {[...app.timeline].reverse().map((entry, i) => (
          <li key={app.timeline.length - i}>
            <div className={entry.kind === 'note' ? 'answer-value' : undefined}>{historyLine(entry)}</div>
            <div className="small muted">
              {entry.kind === 'note' && `Note by ${WHO[entry.by]}, `}
              <time dateTime={entry.at}>{when(entry.at)}</time>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Remove({ app, onRemoved }: { app: Application; onRemoved: () => void }) {
  const [asking, setAsking] = useState(false);
  const { busy, error, run } = useAction();
  const remove = () =>
    void run(async () => {
      await trackerApi.remove(app.id);
      onRemoved();
      return '';
    });
  return (
    <section className="card" aria-labelledby="remove-title">
      <h2 id="remove-title">Remove</h2>
      <p className="small muted">
        Removing takes this application off the list. The server moves its file into the “removed” folder next to the others, with its history, so it can be put back by hand.
      </p>
      <ErrorNotice>{error}</ErrorNotice>
      <div className="actions">
        {asking ? (
          <>
            <button type="button" className="btn danger" disabled={busy} onClick={remove}>
              {busy ? 'Removing…' : 'Remove it from the list'}
            </button>
            <button type="button" className="btn ghost" onClick={() => setAsking(false)}>
              Cancel
            </button>
          </>
        ) : (
          <button type="button" className="btn danger" onClick={() => setAsking(true)}>
            Remove this application…
          </button>
        )}
      </div>
    </section>
  );
}
