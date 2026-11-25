/**
 * The rules of a tracked application: what a record must look like, who may change what in it, and that an
 * assistant's text never becomes the user's.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  ApplicationError,
  FILE_FORMAT,
  LIMITS,
  STAGES,
  STAGE_LABEL,
  changeApplication,
  fileEntries,
  isId,
  leftForUser,
  newApplication,
  newId,
  postingKey,
  slug,
  stageGroup,
  storedApplication,
  summarize,
  toFile,
  type Actor,
  type Application,
  type FormField,
} from './model';

const NOW = new Date('2026-11-24T22:00:00.000Z');
const LATER = new Date('2026-11-25T09:30:00.000Z');
const free = () => false;

const JOB = { title: 'Staff Technical Writer', company: 'Globex', postingUrl: 'https://job-boards.greenhouse.io/globex/jobs/1234567' };

/** A form the way an assistant hands it in: facts, a draft, and two things only the user does. */
const FIELDS = [
  { id: 'first-name', label: 'First Name', kind: 'text', required: true, value: 'Jordan', status: 'filled', note: 'From the resume' },
  { id: 'docs-as-code', label: 'Tell us about your experience with Git and docs as code.', kind: 'longtext', required: true, value: 'I write docs in Markdown.', status: 'draft' },
  { id: 'zip', label: 'ZIP code', kind: 'text', required: true, value: '', status: 'ask', note: 'Not on the resume.' },
  { id: 'pledge', label: 'Do you confirm the answers are your own?', kind: 'choice', required: true, value: '', status: 'yours', note: 'A pledge. Only the user answers it.' },
  { id: 'gender', label: 'Gender', kind: 'choice', required: false, value: '', status: 'yours' },
];

function make(extra: Record<string, unknown> = {}, by: Actor = 'assistant'): Application {
  return newApplication({ job: JOB, stage: 'drafting', form: { fields: FIELDS }, ...extra }, { by, now: NOW, taken: free });
}

const field = (app: Application, id: string): FormField => {
  const found = app.form?.fields.find((f) => f.id === id);
  if (!found) throw new Error(`no field ${id}`);
  return found;
};

const change = (app: Application, changes: unknown, by: Actor, now = LATER) => changeApplication(app, changes, { by, now });

/** The error a change is turned down with. */
function problem(run: () => unknown): ApplicationError {
  try {
    run();
  } catch (e) {
    if (e instanceof ApplicationError) return e;
    throw e;
  }
  throw new Error('It was accepted.');
}

describe('ids', () => {
  it('are made from the company and the title', () => {
    expect(slug('Globex Staff Technical Writer, Docs & APIs')).toBe('globex-staff-technical-writer-docs-apis');
    expect(slug('  Señor Développeur — Zürich  ')).toBe('senor-developpeur-zurich');
    expect(slug('!!!')).toBe('application');
    expect(slug('x'.repeat(200))).toHaveLength(60);
    // Names Windows will not take for a file, and names the routes use.
    expect(slug('CON')).toBe('application-con');
    expect(slug('export')).toBe('application-export');
  });

  it('get a number when the plain one is taken', () => {
    const used = new Set(['globex-staff-technical-writer', 'globex-staff-technical-writer-2']);
    expect(newId(JOB, (id) => used.has(id))).toBe('globex-staff-technical-writer-3');
    expect(newId(JOB, free)).toBe('globex-staff-technical-writer');
  });

  it('are lower-case letters, digits and single dashes', () => {
    for (const good of ['a', 'globex-staff-technical-writer', 'x9-2', 'a'.repeat(80)]) expect(isId(good), good).toBe(true);
    for (const bad of ['', 'A', 'a--b', '-a', 'a-', 'a_b', 'a/b', '../a', 'a.json', 'a'.repeat(81), 'export', 'import', 'con', 'nul', 'com1', 'lpt9', 7, null, undefined]) {
      expect(isId(bad), String(bad)).toBe(false);
    }
  });
});

describe('telling whether two addresses are one posting', () => {
  it('ignores what does not make it a different posting', () => {
    const key = postingKey('https://job-boards.greenhouse.io/globex/jobs/1234567');
    for (const same of [
      'https://JOB-BOARDS.greenhouse.io/globex/jobs/1234567/',
      'http://www.job-boards.greenhouse.io/globex/jobs/1234567#app',
      'https://job-boards.greenhouse.io/globex/jobs/1234567?gh_src=abc&utm_source=linkedin',
    ]) {
      expect(postingKey(same), same).toBe(key);
    }
  });

  it('keeps what does', () => {
    expect(postingKey('https://example.com/careers?gh_jid=1')).not.toBe(postingKey('https://example.com/careers?gh_jid=2'));
    expect(postingKey('https://example.com/careers?b=2&a=1')).toBe(postingKey('https://example.com/careers?a=1&b=2'));
    expect(postingKey('https://example.com/jobs/1')).not.toBe(postingKey('https://example.com/jobs/2'));
    expect(postingKey(' not an address ')).toBe('not an address');
  });
});

describe('the stages', () => {
  it('each have a name for the page and a group', () => {
    for (const stage of STAGES) {
      expect(STAGE_LABEL[stage]).toBeTruthy();
      expect(['open', 'sent', 'over']).toContain(stageGroup(stage));
    }
    expect(STAGES.filter((s) => stageGroup(s) === 'open')).toEqual(['saved', 'drafting', 'ready', 'submitting', 'unknown']);
    expect(STAGES.filter((s) => stageGroup(s) === 'over')).toEqual(['rejected', 'withdrawn', 'closed']);
  });
});

describe('a new application', () => {
  it('needs only a title, a company and a link', () => {
    const app = newApplication({ job: JOB }, { by: 'user', now: NOW, taken: free });
    expect(app).toEqual({
      id: 'globex-staff-technical-writer',
      revision: 1,
      createdAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
      job: { ...JOB, listings: [] },
      stage: 'saved',
      stageSetBy: 'user',
      timeline: [{ at: NOW.toISOString(), by: 'user', kind: 'created' }],
    });
  });

  it('keeps everything about the job and the form that was given', () => {
    const app = make({
      id: 'globex-staff',
      job: {
        ...JOB,
        location: ' Remote, United States ',
        workplace: 'remote',
        pay: '$139,200 to $235,200',
        postedAt: '2026-11-17',
        listings: [{ via: 'Greenhouse', url: JOB.postingUrl }, { via: 'LinkedIn' }],
        descriptionText: 'Line one\r\nLine two',
        descriptionHtml: '<p>Hello</p>',
      },
      form: { url: 'https://job-boards.greenhouse.io/embed/job_app?for=globex&token=1234567', notes: 'Pick the city first.', fields: FIELDS },
      timeline: [
        { at: '2026-11-24T21:05:00Z', text: 'Found on the Greenhouse board.' },
        { at: '2026-11-24T20:00:00Z', text: 'Searched.' },
      ],
    });
    expect(app.id).toBe('globex-staff');
    expect(app.job).toMatchObject({ location: 'Remote, United States', workplace: 'remote', pay: '$139,200 to $235,200', postedAt: '2026-11-17', descriptionText: 'Line one\nLine two', descriptionHtml: '<p>Hello</p>' });
    expect(app.job.listings).toEqual([{ via: 'Greenhouse', url: JOB.postingUrl }, { via: 'LinkedIn' }]);
    expect(app.form?.url).toBe('https://job-boards.greenhouse.io/embed/job_app?for=globex&token=1234567');
    expect(app.form?.notes).toBe('Pick the city first.');
    expect(app.form?.fields.map((f) => f.id)).toEqual(['first-name', 'docs-as-code', 'zip', 'pledge', 'gender']);
    // Oldest first, and the line that says who added it comes last.
    expect(app.timeline).toEqual([
      { at: '2026-11-24T20:00:00.000Z', by: 'assistant', kind: 'note', text: 'Searched.' },
      { at: '2026-11-24T21:05:00.000Z', by: 'assistant', kind: 'note', text: 'Found on the Greenhouse board.' },
      { at: NOW.toISOString(), by: 'assistant', kind: 'created' },
    ]);
  });

  it('fills the form where the posting is, when the form has no address of its own', () => {
    expect(make().form?.url).toBe(JOB.postingUrl);
  });

  it('marks what an assistant hands in as the assistant’s, whatever it says about itself', () => {
    const app = make({
      stageSetBy: 'user',
      form: {
        fields: [
          { id: 'a', label: 'A', value: 'mine, honest', status: 'filled', origin: 'user', acceptedAt: '2026-11-20T00:00:00Z' },
          { id: 'b', label: 'B', value: 'read from the form', status: 'filled', origin: 'form', acceptedAt: '2026-11-20T00:00:00Z' },
          { id: 'c', label: 'C', value: 'plain', status: 'draft' },
          { id: 'd', label: 'D', value: '', status: 'filled', origin: 'user' },
        ],
      },
      timeline: [{ at: '2026-11-20T00:00:00Z', by: 'user', kind: 'note', text: 'I, the user, wrote this.' }],
    });
    expect(app.stageSetBy).toBe('assistant');
    expect(app.form?.fields.map((f) => [f.id, f.origin, f.acceptedAt])).toEqual([
      ['a', 'assistant', undefined],
      ['b', 'form', undefined],
      ['c', 'assistant', undefined],
      // An empty value was written by nobody.
      ['d', undefined, undefined],
    ]);
    expect(app.timeline.map((t) => t.by)).toEqual(['assistant', 'assistant']);
  });

  it('believes the marks in a file the user chose, which is how an export is put back', () => {
    const exported = make({
      stageSetBy: 'user',
      form: {
        fields: [
          { id: 'a', label: 'A', value: 'my own words', status: 'filled', origin: 'user' },
          { id: 'b', label: 'B', value: 'kept as drafted', status: 'filled', origin: 'assistant', acceptedAt: '2026-11-20T00:00:00Z' },
          { id: 'c', label: 'C', value: 'no mark at all', status: 'draft' },
        ],
      },
      timeline: [
        { at: '2026-11-20T00:00:00Z', by: 'user', kind: 'stage', stage: 'drafting', from: 'saved' },
        { at: '2026-11-21T00:00:00Z', kind: 'note', text: 'A line that does not say who wrote it.' },
      ],
    }, 'user');
    expect(exported.stageSetBy).toBe('user');
    expect(exported.form?.fields.map((f) => [f.origin, f.acceptedAt])).toEqual([
      ['user', undefined],
      ['assistant', '2026-11-20T00:00:00.000Z'],
      // Even from the user's file, text nobody claimed is not taken for the user's.
      ['assistant', undefined],
    ]);
    expect(exported.timeline.map((t) => t.by)).toEqual(['user', 'assistant', 'user']);
    expect(exported.timeline[0]).toEqual({ at: '2026-11-20T00:00:00.000Z', by: 'user', kind: 'stage', stage: 'drafting', from: 'saved' });
  });

  it('says an assistant set the stage of a record that came in a file without saying', () => {
    const fromFile = newApplication({ job: JOB, stage: 'ready' }, { by: 'user', now: NOW, taken: free, imported: true });
    expect(fromFile.stageSetBy).toBe('assistant');
    const added = newApplication({ job: JOB, stage: 'ready' }, { by: 'user', now: NOW, taken: free });
    expect(added.stageSetBy).toBe('user');
  });

  it('refuses an assistant’s answer to a question that is left to the user', () => {
    const e = problem(() => make({ form: { fields: [{ id: 'pledge', label: 'I wrote this myself', kind: 'checkbox', value: 'checked', status: 'yours' }] } }));
    expect(e.code).toBe('refused');
    expect(e.message).toContain('left to the user');
    // The user may record their own answer to it.
    const mine = make({ form: { fields: [{ id: 'pledge', label: 'I wrote this myself', kind: 'checkbox', value: 'checked', status: 'yours', origin: 'user' }] } }, 'user');
    expect(field(mine, 'pledge')).toMatchObject({ value: 'checked', status: 'yours', origin: 'user' });
  });

  it('notes when it was sent, if it arrives as sent', () => {
    expect(make({ stage: 'submitted' }).submittedAt).toBe(NOW.toISOString());
    expect(make({ stage: 'interview', submittedAt: '2026-11-01T10:00:00Z' }).submittedAt).toBe('2026-11-01T10:00:00.000Z');
    expect(make({ stage: 'drafting', submittedAt: '2026-11-01T10:00:00Z' }).submittedAt).toBeUndefined();
  });

  it('takes the id it was given, and turns down one that cannot be a file name', () => {
    expect(make({ id: 'my-own-id' }).id).toBe('my-own-id');
    for (const bad of ['Has Capitals', '../escape', 'con', 'export', 'a'.repeat(81), 12]) {
      expect(problem(() => make({ id: bad })).code, String(bad)).toBe('invalid');
    }
  });

  it.each([
    ['no job', { job: undefined }, 'job must be an object'],
    ['no title', { job: { ...JOB, title: undefined } }, 'job.title must be text'],
    ['an empty company', { job: { ...JOB, company: '   ' } }, 'job.company is empty'],
    ['a link that is not a web address', { job: { ...JOB, postingUrl: 'globex jobs' } }, 'job.postingUrl is not a web address'],
    ['a link that runs a script', { job: { ...JOB, postingUrl: 'javascript:alert(1)' } }, 'must start with http:// or https://'],
    ['a link that holds data', { job: { ...JOB, postingUrl: 'data:text/html,<script>1</script>' } }, 'must start with http:// or https://'],
    ['a link with a password in it', { job: { ...JOB, postingUrl: 'https://jordan:secret@example.com/job' } }, 'must not hold a name or a password'],
    ['a listing with a script link', { job: { ...JOB, listings: [{ via: 'X', url: 'JaVaScRiPt:alert(1)' }] } }, 'must start with http:// or https://'],
    ['a form address with a script link', { form: { url: 'vbscript:x', fields: [] } }, 'must start with http:// or https://'],
    ['a workplace it does not know', { job: { ...JOB, workplace: 'moon' } }, 'job.workplace must be one of: remote, hybrid, onsite'],
    ['a date that is not one', { job: { ...JOB, postedAt: 'last week' } }, 'job.postedAt is not a date'],
    ['a stage it does not know', { stage: 'hired' }, 'stage must be one of'],
    ['a part it does not know', { fit: 'strong' }, 'a part this app does not know: "fit"'],
    ['a job part it does not know', { job: { ...JOB, salary: 5 } }, 'job has a part this app does not know: "salary"'],
    ['fields that are not a list', { form: { fields: {} } }, 'form.fields must be a list'],
    ['a field without a status', { form: { fields: [{ id: 'a', label: 'A' }] } }, 'form.fields[0].status must be one of: filled, draft, ask, yours'],
    ['an answer in a question that still waits for one', { form: { fields: [{ id: 'a', label: 'A', status: 'ask', value: '12345' }] } }, 'a question that waits for the user\'s answer is empty'],
    ['a field without a label', { form: { fields: [{ id: 'a', status: 'draft' }] } }, 'form.fields[0].label must be text'],
    ['a field id with capitals', { form: { fields: [{ id: 'First Name', label: 'A', status: 'draft' }] } }, 'form.fields[0].id must be lower-case letters'],
    ['two fields with one id', { form: { fields: [{ id: 'a', label: 'A', status: 'draft' }, { id: 'a', label: 'B', status: 'draft' }] } }, 'two fields with the id "a"'],
    ['a field kind it does not know', { form: { fields: [{ id: 'a', label: 'A', status: 'draft', kind: 'slider' }] } }, 'kind must be one of'],
    ['a required that is not yes or no', { form: { fields: [{ id: 'a', label: 'A', status: 'draft', required: 'yes' }] } }, 'required must be true or false'],
    ['a value that is not text', { form: { fields: [{ id: 'a', label: 'A', status: 'draft', value: 5 }] } }, 'value must be text'],
    ['an origin it does not know', { form: { fields: [{ id: 'a', label: 'A', status: 'draft', value: 'x', origin: 'robot' }] } }, 'origin must be one of: user, assistant, form'],
    ['a timeline line without a time', { timeline: [{ text: 'x' }] }, 'timeline[0].at is not a time'],
    ['a timeline note without text', { timeline: [{ at: '2026-11-24T00:00:00Z' }] }, 'timeline[0].text must be text'],
    ['a stage line without a stage', { timeline: [{ at: '2026-11-24T00:00:00Z', kind: 'stage' }] }, 'timeline[0].stage must be one of'],
    ['a time that is not one', { createdAt: 'yesterday' }, 'createdAt is not a time'],
  ])('turns down %s', (_what, extra, message) => {
    const e = problem(() => make(extra));
    expect(e.code).toBe('invalid');
    expect(e.message).toContain(message);
  });

  it('turns down something that is not an application at all', () => {
    for (const bad of [null, 'text', 5, [], undefined]) expect(problem(() => newApplication(bad, { by: 'user', now: NOW, taken: free })).message).toBe('The application must be an object.');
  });

  it('holds text only up to a size', () => {
    const big = (n: number) => 'x'.repeat(n);
    expect(make({ form: { fields: [{ id: 'a', label: 'A', status: 'draft', value: big(LIMITS.value) }] } }).form?.fields[0].value).toHaveLength(LIMITS.value);
    expect(problem(() => make({ form: { fields: [{ id: 'a', label: 'A', status: 'draft', value: big(LIMITS.value + 1) }] } })).message).toContain(`longer than ${LIMITS.value} characters`);
    expect(problem(() => make({ job: { ...JOB, title: big(LIMITS.line + 1) } })).message).toContain('job.title is longer than');
    expect(problem(() => make({ form: { fields: Array.from({ length: LIMITS.fields + 1 }, (_, i) => ({ id: `f${i}`, label: 'x', status: 'draft' })) } })).message).toContain(`more than ${LIMITS.fields} entries`);
    // Room is left for the line that says who added it.
    const lines = (n: number) => Array.from({ length: n }, () => ({ at: '2026-11-24T00:00:00Z', text: 'x' }));
    expect(make({ timeline: lines(LIMITS.timeline - 1) }).timeline).toHaveLength(LIMITS.timeline);
    expect(problem(() => make({ timeline: lines(LIMITS.timeline) })).message).toContain('timeline has more than');
  });
});

describe('a record the server kept', () => {
  it('reads back exactly as it was written', () => {
    let app = make({ job: { ...JOB, location: 'Remote', listings: [{ via: 'Greenhouse', url: JOB.postingUrl }] }, form: { notes: 'Notes', fields: FIELDS } });
    app = change(app, { fields: [{ id: 'docs-as-code', value: 'My own words.' }], stage: 'ready', note: 'Reviewed.' }, 'user');
    app = change(app, { stage: 'submitted' }, 'user');
    expect(storedApplication(JSON.parse(JSON.stringify(app)))).toEqual(app);
    expect(field(app, 'docs-as-code').origin).toBe('user');
  });

  it.each([
    ['is not an object', [], 'The record must be an object'],
    ['has no id', { id: undefined }, 'no usable id'],
    ['has an id that cannot be a file name', { id: '../x' }, 'no usable id'],
    ['has no revision', { revision: undefined }, 'no revision number'],
    ['has a revision that is not a count', { revision: 1.5 }, 'no revision number'],
    ['does not say who set the stage', { stageSetBy: undefined }, 'stageSetBy must be one of'],
    ['has a part this app does not know', { colour: 'blue' }, 'a part this app does not know: "colour"'],
    ['has no time', { createdAt: 5 }, 'createdAt is not a time'],
  ])('is not read when it %s', (_what, broken, message) => {
    const raw = Array.isArray(broken) ? broken : { ...JSON.parse(JSON.stringify(make())), ...broken };
    expect(problem(() => storedApplication(raw)).message).toContain(message);
  });
});

describe('the user changing an application, on the app’s page', () => {
  it('makes a rewritten draft their own words, and settles it', () => {
    const before = make();
    const after = change(before, { fields: [{ id: 'docs-as-code', value: 'I have kept docs next to code since 2016.\r\nSecond line.' }] }, 'user');
    expect(field(after, 'docs-as-code')).toEqual({
      ...field(before, 'docs-as-code'),
      value: 'I have kept docs next to code since 2016.\nSecond line.',
      origin: 'user',
      status: 'filled',
      updatedAt: LATER.toISOString(),
    });
    expect(after.revision).toBe(2);
    expect(after.updatedAt).toBe(LATER.toISOString());
    // The record that was passed in is never changed itself.
    expect(field(before, 'docs-as-code')).toMatchObject({ value: 'I write docs in Markdown.', origin: 'assistant', status: 'draft' });
    expect(before.revision).toBe(1);
  });

  it('can rewrite a draft and keep it a draft', () => {
    const after = change(make(), { fields: [{ id: 'docs-as-code', value: 'Half done', status: 'draft' }] }, 'user');
    expect(field(after, 'docs-as-code')).toMatchObject({ value: 'Half done', origin: 'user', status: 'draft' });
  });

  it('can keep a draft as it is: the words stay marked as the assistant’s, and the acceptance is marked', () => {
    const after = change(make(), { fields: [{ id: 'docs-as-code', status: 'filled' }] }, 'user');
    expect(field(after, 'docs-as-code')).toMatchObject({ value: 'I write docs in Markdown.', origin: 'assistant', status: 'filled', acceptedAt: LATER.toISOString() });
    // Back to a draft, the acceptance is gone.
    const again = change(after, { fields: [{ id: 'docs-as-code', status: 'draft' }] }, 'user');
    expect(field(again, 'docs-as-code').acceptedAt).toBeUndefined();
    // Rewritten after accepting, it is simply theirs.
    const rewritten = change(after, { fields: [{ id: 'docs-as-code', value: 'Mine now.' }] }, 'user');
    expect(field(rewritten, 'docs-as-code')).toMatchObject({ origin: 'user', status: 'filled' });
    expect(field(rewritten, 'docs-as-code').acceptedAt).toBeUndefined();
  });

  it('can answer a question that was left to them, and it stays theirs to do on the form', () => {
    const after = change(make(), { fields: [{ id: 'pledge', value: 'Yes' }] }, 'user');
    expect(field(after, 'pledge')).toMatchObject({ value: 'Yes', origin: 'user', status: 'yours' });
  });

  it('can answer a question that waited for them, which settles it, or settle it as left empty', () => {
    const answered = change(make(), { fields: [{ id: 'zip', value: '12345' }] }, 'user');
    expect(field(answered, 'zip')).toMatchObject({ value: '12345', origin: 'user', status: 'filled' });
    const blank = change(make(), { fields: [{ id: 'zip', status: 'filled' }] }, 'user');
    expect(field(blank, 'zip')).toMatchObject({ value: '', status: 'filled' });
    expect(field(blank, 'zip').acceptedAt).toBeUndefined();
    expect(problem(() => change(make(), { fields: [{ id: 'zip', value: '12345', status: 'ask' }] }, 'user')).message).toContain('waits for the user\'s answer, so it is empty');
  });

  it('keeps a draft a draft when its text is cleared', () => {
    const after = change(make(), { fields: [{ id: 'docs-as-code', value: '' }] }, 'user');
    expect(field(after, 'docs-as-code')).toMatchObject({ value: '', status: 'draft' });
  });

  it('clears who wrote a value when the value is cleared', () => {
    const after = change(make(), { fields: [{ id: 'first-name', value: '' }] }, 'user');
    expect(field(after, 'first-name').value).toBe('');
    expect(field(after, 'first-name').origin).toBeUndefined();
  });

  it('can add a field, which goes to the end, and take one away', () => {
    const added = change(make(), { fields: [{ id: 'website', label: ' Website ', value: 'https://example.com', status: 'filled', kind: 'text', required: false, note: ' typed on the page ' }] }, 'user');
    expect(added.form?.fields.at(-1)).toEqual({ id: 'website', label: 'Website', kind: 'text', required: false, value: 'https://example.com', origin: 'user', status: 'filled', note: 'typed on the page', updatedAt: LATER.toISOString() });
    const removed = change(added, { removeFields: ['pledge', 'no-such-field'] }, 'user');
    expect(removed.form?.fields.map((f) => f.id)).toEqual(['first-name', 'docs-as-code', 'zip', 'gender', 'website']);
  });

  it('can change the facts of the job, and take an optional one away', () => {
    const app = make({ job: { ...JOB, location: 'Remote', pay: '$1' } });
    const after = change(app, { job: { title: 'Principal Technical Writer', pay: '', workplace: 'remote', postedAt: '2026-11-20', listings: [{ via: 'LinkedIn' }], descriptionText: 'About the job' } }, 'user');
    expect(after.job).toEqual({ title: 'Principal Technical Writer', company: 'Globex', postingUrl: JOB.postingUrl, listings: [{ via: 'LinkedIn' }], location: 'Remote', workplace: 'remote', postedAt: '2026-11-20', descriptionText: 'About the job' });
    expect(problem(() => change(app, { job: { postingUrl: 'javascript:alert(1)' } }, 'user')).message).toContain('must start with http:// or https://');
    expect(problem(() => change(app, { job: { title: '' } }, 'user')).message).toContain('job.title is empty');
  });

  it('can say where the form is and what to know about it, before any field exists', () => {
    const app = newApplication({ job: JOB }, { by: 'user', now: NOW, taken: free });
    const after = change(app, { form: { url: 'https://example.com/apply', notes: 'Two pages.' } }, 'user');
    expect(after.form).toEqual({ url: 'https://example.com/apply', notes: 'Two pages.', fields: [] });
    expect(change(after, { form: { notes: '' } }, 'user').form).toEqual({ url: 'https://example.com/apply', fields: [] });
  });

  it('moves it through the stages, and the timeline says so', () => {
    const drafting = make();
    const ready = change(drafting, { stage: 'ready' }, 'user');
    expect(ready).toMatchObject({ stage: 'ready', stageSetBy: 'user' });
    expect(ready.submittedAt).toBeUndefined();
    expect(ready.timeline.at(-1)).toEqual({ at: LATER.toISOString(), by: 'user', kind: 'stage', stage: 'ready', from: 'drafting' });

    const sent = change(ready, { stage: 'submitted' }, 'user', new Date('2026-11-26T10:00:00Z'));
    expect(sent.submittedAt).toBe('2026-11-26T10:00:00.000Z');
    const interview = change(sent, { stage: 'interview' }, 'user', new Date('2026-12-01T10:00:00Z'));
    // When it was sent does not move when the stage moves on.
    expect(interview.submittedAt).toBe('2026-11-26T10:00:00.000Z');
    expect(change(interview, { stage: 'rejected' }, 'user').submittedAt).toBe('2026-11-26T10:00:00.000Z');
  });

  it('can open a sent application again, which takes back that it was sent', () => {
    const sent = change(make(), { stage: 'submitted' }, 'user');
    const reopened = change(sent, { stage: 'drafting' }, 'user');
    expect(reopened.stage).toBe('drafting');
    expect(reopened.submittedAt).toBeUndefined();
  });

  it('adds a note to the timeline', () => {
    const after = change(make(), { note: '  Recruiter emailed, call on Friday.  ' }, 'user');
    expect(after.timeline.at(-1)).toEqual({ at: LATER.toISOString(), by: 'user', kind: 'note', text: 'Recruiter emailed, call on Friday.' });
    expect(problem(() => change(make(), { note: '   ' }, 'user')).message).toContain('note is empty');
  });

  it('does not say where a value came from: what they save is theirs', () => {
    expect(problem(() => change(make(), { fields: [{ id: 'first-name', value: 'S', origin: 'form' }] }, 'user')).code).toBe('invalid');
  });
});

describe('an assistant changing an application', () => {
  it('can add answers, correct its own, and mark a first draft as one', () => {
    const before = make();
    const after = change(before, {
      fields: [
        { id: 'first-name', value: 'Jordan R.' },
        { id: 'why-us', label: 'Why Globex?', kind: 'longtext', required: true, value: 'Because of the handbook.', status: 'draft' },
      ],
      note: 'Form filled up to Submit.',
    }, 'assistant');
    expect(field(after, 'first-name')).toMatchObject({ value: 'Jordan R.', origin: 'assistant', status: 'filled' });
    expect(field(after, 'why-us')).toMatchObject({ value: 'Because of the handbook.', origin: 'assistant', status: 'draft' });
    expect(after.timeline.at(-1)).toMatchObject({ by: 'assistant', kind: 'note' });
    expect(after.revision).toBe(2);
  });

  it('cannot replace the user’s own words', () => {
    const mine = change(make(), { fields: [{ id: 'docs-as-code', value: 'My own words.' }] }, 'user');
    for (const attempt of [{ value: 'A better version.' }, { value: '' }, { status: 'draft' }, { value: 'From the form.', origin: 'form' }]) {
      const e = problem(() => change(mine, { fields: [{ id: 'docs-as-code', ...attempt }] }, 'assistant'));
      expect(e.code, JSON.stringify(attempt)).toBe('refused');
      expect(e.message).toContain('holds the user’s own words'.replace('’', "'"));
    }
    expect(problem(() => change(mine, { removeFields: ['docs-as-code'] }, 'assistant')).code).toBe('refused');
    // It may still correct how the question is described.
    const relabelled = change(mine, { fields: [{ id: 'docs-as-code', label: 'Git and docs as code', note: 'The form reworded this.', required: false, kind: 'text' }] }, 'assistant');
    expect(field(relabelled, 'docs-as-code')).toMatchObject({ label: 'Git and docs as code', note: 'The form reworded this.', required: false, kind: 'text', value: 'My own words.', origin: 'user' });
  });

  it('cannot replace an answer the user accepted', () => {
    const accepted = change(make(), { fields: [{ id: 'docs-as-code', status: 'filled' }] }, 'user');
    expect(problem(() => change(accepted, { fields: [{ id: 'docs-as-code', value: 'Reworded.' }] }, 'assistant')).code).toBe('refused');
    expect(problem(() => change(accepted, { fields: [{ id: 'docs-as-code', status: 'draft' }] }, 'assistant')).code).toBe('refused');
    expect(problem(() => change(accepted, { removeFields: ['docs-as-code'] }, 'assistant')).code).toBe('refused');
  });

  it('can send again what is already there, and nothing changes', () => {
    const mine = change(make(), { fields: [{ id: 'docs-as-code', value: 'My own words.' }, { id: 'pledge', value: 'Yes' }] }, 'user');
    const again = change(mine, { fields: mine.form!.fields.map(({ id, label, kind, required, value, status }) => ({ id, label, kind, required, value, status })) }, 'assistant');
    expect(again).toBe(mine);
  });

  it('can replace a value read from the live form only with a newer reading of the form', () => {
    const read = change(make(), { fields: [{ id: 'first-name', value: 'Jordan E.', origin: 'form' }] }, 'assistant');
    expect(field(read, 'first-name')).toMatchObject({ value: 'Jordan E.', origin: 'form' });
    const e = problem(() => change(read, { fields: [{ id: 'first-name', value: 'Jordan' }] }, 'assistant'));
    expect(e.code).toBe('refused');
    expect(e.message).toContain('read from the live form');
    expect(problem(() => change(read, { fields: [{ id: 'first-name', status: 'draft' }] }, 'assistant')).code).toBe('refused');
    expect(problem(() => change(read, { removeFields: ['first-name'] }, 'assistant')).code).toBe('refused');
    const reread = change(read, { fields: [{ id: 'first-name', value: 'Jordan Elizabeth', origin: 'form' }] }, 'assistant');
    expect(field(reread, 'first-name')).toMatchObject({ value: 'Jordan Elizabeth', origin: 'form' });
    expect(problem(() => change(read, { fields: [{ id: 'first-name', value: 'x', origin: 'user' }] }, 'assistant')).message).toContain('origin must be one of: form');
  });

  it('cannot answer a question that is left to the user, or say it no longer is', () => {
    const app = make();
    expect(problem(() => change(app, { fields: [{ id: 'pledge', value: 'Yes' }] }, 'assistant')).message).toContain('left to the user, so it stays empty');
    expect(problem(() => change(app, { fields: [{ id: 'pledge', status: 'filled' }] }, 'assistant')).message).toContain('left to the user. Only they can change that');
    expect(problem(() => change(app, { fields: [{ id: 'pledge', value: 'Yes', status: 'filled' }] }, 'assistant')).code).toBe('refused');
    expect(problem(() => change(app, { removeFields: ['gender'] }, 'assistant')).code).toBe('refused');
    expect(problem(() => change(app, { fields: [{ id: 'consent', label: 'I agree', kind: 'checkbox', value: 'checked', status: 'yours' }] }, 'assistant')).code).toBe('refused');
  });

  it('can leave one of its own answers to the user, by emptying it', () => {
    const app = make();
    expect(problem(() => change(app, { fields: [{ id: 'docs-as-code', status: 'yours' }] }, 'assistant')).message).toContain('stays empty');
    const after = change(app, { fields: [{ id: 'docs-as-code', value: '', status: 'yours', note: 'The form asks for your own words only.' }] }, 'assistant');
    expect(field(after, 'docs-as-code')).toMatchObject({ value: '', status: 'yours' });
    expect(field(after, 'docs-as-code').origin).toBeUndefined();
    const consent = change(app, { fields: [{ id: 'consent', label: 'I agree', kind: 'checkbox', required: true, status: 'yours' }] }, 'assistant');
    expect(field(consent, 'consent')).toEqual({ id: 'consent', label: 'I agree', kind: 'checkbox', required: true, value: '', status: 'yours', updatedAt: LATER.toISOString() });
  });

  it('can fill in what the user told it, once a question no longer waits for them', () => {
    const app = make();
    const filled = change(app, { fields: [{ id: 'zip', value: '12345', status: 'filled', note: 'The user\'s message of 2026-11-25' }] }, 'assistant');
    expect(field(filled, 'zip')).toMatchObject({ value: '12345', origin: 'assistant', status: 'filled', note: 'The user\'s message of 2026-11-25' });
    // It says what the answer is now: settled, or a draft. A question that waits is empty.
    const e = problem(() => change(app, { fields: [{ id: 'zip', value: '12345' }] }, 'assistant'));
    expect(e.code).toBe('invalid');
    expect(e.message).toContain('Send the answer with the status "filled" or "draft"');
  });

  it('can turn an answer of its own into a question for the user, by emptying it', () => {
    const after = change(make(), { fields: [{ id: 'first-name', value: '', status: 'ask', note: 'Legal name or preferred name?' }] }, 'assistant');
    expect(field(after, 'first-name')).toMatchObject({ value: '', status: 'ask' });
    expect(problem(() => change(make(), { fields: [{ id: 'first-name', status: 'ask' }] }, 'assistant')).code).toBe('invalid');
    // A question for the user can become one only they answer on the form, and not the other way round.
    expect(field(change(make(), { fields: [{ id: 'zip', status: 'yours' }] }, 'assistant'), 'zip').status).toBe('yours');
    expect(problem(() => change(make(), { fields: [{ id: 'pledge', status: 'ask' }] }, 'assistant')).code).toBe('refused');
  });

  it('can take away an answer of its own', () => {
    expect(change(make(), { removeFields: ['first-name'] }, 'assistant').form?.fields.map((f) => f.id)).toEqual(['docs-as-code', 'zip', 'pledge', 'gender']);
  });

  it('cannot change the answers of an application that was sent, or that ended', () => {
    for (const stage of ['submitted', 'interview', 'rejected', 'closed'] as const) {
      const sent = change(make(), { stage }, 'user');
      const e = problem(() => change(sent, { fields: [{ id: 'first-name', value: 'S' }] }, 'assistant'));
      expect(e.code, stage).toBe('refused');
      expect(e.message).toContain(STAGE_LABEL[stage]);
      expect(problem(() => change(sent, { removeFields: ['first-name'] }, 'assistant')).code).toBe('refused');
      // What it learns later still goes on the record.
      expect(change(sent, { note: 'The posting was taken down.', form: { notes: 'Closed.' } }, 'assistant').timeline.at(-1)).toMatchObject({ kind: 'note', by: 'assistant' });
    }
  });

  it('can record a last reading of the form and that it was sent, in one change', () => {
    const after = change(make(), { fields: [{ id: 'first-name', value: 'Jordan E.', origin: 'form' }], stage: 'submitted', note: 'The user pressed Submit.' }, 'assistant');
    expect(after).toMatchObject({ stage: 'submitted', stageSetBy: 'assistant', submittedAt: LATER.toISOString() });
    expect(field(after, 'first-name').origin).toBe('form');
    expect(after.timeline.slice(-2).map((t) => t.kind)).toEqual(['stage', 'note']);
  });

  it('can move a stage on, and cannot open again what was sent or ended', () => {
    const sent = change(make(), { stage: 'submitted' }, 'assistant');
    expect(change(sent, { stage: 'in_review' }, 'assistant').stage).toBe('in_review');
    expect(change(sent, { stage: 'rejected' }, 'assistant').stage).toBe('rejected');
    const e = problem(() => change(sent, { stage: 'drafting' }, 'assistant'));
    expect(e.code).toBe('refused');
    expect(e.message).toContain('Only the user opens it again');
    const over = change(make(), { stage: 'withdrawn' }, 'user');
    expect(problem(() => change(over, { stage: 'ready' }, 'assistant')).code).toBe('refused');
    // Between the stages before sending it moves freely.
    expect(change(change(make(), { stage: 'ready' }, 'assistant'), { stage: 'drafting' }, 'assistant').stage).toBe('drafting');
  });
});

describe('any change', () => {
  it('is all or nothing', () => {
    const app = change(make(), { fields: [{ id: 'docs-as-code', value: 'My own words.' }] }, 'user');
    const copy = JSON.parse(JSON.stringify(app));
    expect(problem(() => change(app, { stage: 'ready', note: 'Done.', fields: [{ id: 'first-name', value: 'S' }, { id: 'docs-as-code', value: 'Overwritten' }] }, 'assistant')).code).toBe('refused');
    expect(app).toEqual(copy);
  });

  it('that changes nothing leaves the revision alone', () => {
    const app = make();
    expect(change(app, {}, 'user')).toBe(app);
    expect(change(app, { stage: 'drafting', job: { title: JOB.title }, form: { url: JOB.postingUrl }, fields: [{ id: 'first-name', value: 'Jordan' }], removeFields: ['nothing'] }, 'assistant')).toBe(app);
  });

  it.each([
    ['is not an object', 'stage: ready', 'The change must be an object'],
    ['has a part this app does not know', { field: [] }, 'a part this app does not know: "field"'],
    ['names a stage it does not know', { stage: 'won' }, 'stage must be one of'],
    ['has fields that are not a list', { fields: 'all' }, 'fields must be a list'],
    ['has a field that is not an object', { fields: ['first-name'] }, 'fields[0] must be an object'],
    ['has a field with a part it does not know', { fields: [{ id: 'first-name', text: 'x' }] }, 'fields[0] has a part this app does not know: "text"'],
    ['adds a field without a status', { fields: [{ id: 'new-one', label: 'New', value: 'x' }] }, 'fields[0].status is needed for a new field: filled, draft, ask, yours'],
    ['adds a field without a label', { fields: [{ id: 'new-one', status: 'draft' }] }, 'fields[0].label must be text'],
    ['has a field with a status it does not know', { fields: [{ id: 'first-name', status: 'done' }] }, 'status must be one of'],
    ['names a field to remove that cannot be an id', { removeFields: ['First Name'] }, 'removeFields[0] must be lower-case'],
    ['has a form part it does not know', { form: { fields: [] } }, 'form has a part this app does not know: "fields"'],
    ['has a form address that is not one', { form: { url: 'nowhere' } }, 'form.url is not a web address'],
  ])('is turned down when it %s', (_what, changes, message) => {
    for (const by of ['user', 'assistant'] as const) {
      const e = problem(() => change(make(), changes, by));
      expect(e.code).toBe('invalid');
      expect(e.message).toContain(message);
    }
  });

  it('cannot grow an application past what it may hold', () => {
    const full = make({ form: { fields: Array.from({ length: LIMITS.fields }, (_, i) => ({ id: `f${i}`, label: 'x', status: 'draft' })) } });
    expect(problem(() => change(full, { fields: [{ id: 'one-more', label: 'x', status: 'draft' }] }, 'user')).message).toContain(`at most ${LIMITS.fields} fields`);
    const long = make({ timeline: Array.from({ length: LIMITS.timeline - 1 }, () => ({ at: '2026-11-24T00:00:00Z', text: 'x' })) });
    expect(problem(() => change(long, { note: 'One more.' }, 'user')).message).toContain(`at most ${LIMITS.timeline} lines`);
    // A full timeline does not stop other changes.
    expect(change(long, { fields: [{ id: 'first-name', value: 'S' }] }, 'user').revision).toBe(2);
  });
});

describe('what is left for the user', () => {
  it('is every question that waits for them, every draft, and every required question only they answer', () => {
    const left = leftForUser(make());
    expect(left.asks.map((f) => f.id)).toEqual(['zip']);
    expect(left.drafts.map((f) => f.id)).toEqual(['docs-as-code']);
    expect(left.yours.map((f) => f.id)).toEqual(['pledge']);
    expect(left.optional.map((f) => f.id)).toEqual(['gender']);
  });

  it('is nothing once the application was sent or ended, and nothing without a form', () => {
    const empty = { asks: [], drafts: [], yours: [], optional: [] };
    expect(leftForUser(change(make(), { stage: 'submitted' }, 'user'))).toEqual(empty);
    expect(leftForUser(change(make(), { stage: 'withdrawn' }, 'user'))).toEqual(empty);
    expect(leftForUser(newApplication({ job: JOB }, { by: 'user', now: NOW, taken: free }))).toEqual(empty);
  });

  it('is counted in the summary a list shows', () => {
    const app = make({ job: { ...JOB, location: 'Remote' } });
    expect(summarize(app)).toEqual({
      id: app.id,
      revision: 1,
      title: JOB.title,
      company: JOB.company,
      location: 'Remote',
      postingUrl: JOB.postingUrl,
      stage: 'drafting',
      stageSetBy: 'assistant',
      createdAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
      fields: 5,
      asks: 1,
      drafts: 1,
      yours: 1,
    });
    const sent = change(app, { stage: 'submitted' }, 'user');
    expect(summarize(sent)).toMatchObject({ stage: 'submitted', submittedAt: LATER.toISOString(), asks: 0, drafts: 0, yours: 0, fields: 5 });
    expect(summarize(newApplication({ job: JOB }, { by: 'user', now: NOW, taken: free }))).toMatchObject({ fields: 0, asks: 0, drafts: 0, yours: 0 });
  });
});

describe('a file of applications', () => {
  it('is the records with a marker and a version, and reads back', () => {
    const apps = [make(), make({ id: 'second' })];
    const file = toFile(apps, LATER);
    expect(file).toEqual({ format: FILE_FORMAT, version: 1, exportedAt: LATER.toISOString(), applications: apps });
    expect(fileEntries(JSON.parse(JSON.stringify(file)))).toEqual(apps);
    // A file written by hand needs no time of export.
    expect(fileEntries({ format: FILE_FORMAT, version: 1, applications: [] })).toEqual([]);
  });

  it.each([
    ['is not an object', [], 'The file must be an object'],
    ['is some other JSON', { jobs: [] }, 'not a file of applications from this app'],
    ['is a newer version', { format: FILE_FORMAT, version: 2, applications: [] }, 'this app reads version 1'],
    ['has no version', { format: FILE_FORMAT, applications: [] }, 'this app reads version 1'],
    ['has no list', { format: FILE_FORMAT, version: 1 }, 'no list of applications'],
    ['has a part this app does not know', { format: FILE_FORMAT, version: 1, applications: [], searches: [] }, 'a part this app does not know: "searches"'],
  ])('is turned down when it %s', (_what, file, message) => {
    expect(problem(() => fileEntries(file)).message).toContain(message);
  });
});

/**
 * The promise in one test: whatever an assistant sends, and however often, the user's words and their acceptances
 * stay exactly as they were, the questions left to the user stay unanswered, and nothing new is ever marked as the
 * user's.
 */
describe('whatever an assistant sends', () => {
  const ids = ['first-name', 'docs-as-code', 'zip', 'pledge', 'gender', 'own-words', 'accepted', 'from-form', 'brand-new'];
  const fieldChange = fc.record(
    {
      id: fc.constantFrom(...ids),
      label: fc.constant('A question'),
      value: fc.oneof(fc.constant(''), fc.string({ maxLength: 12 })),
      status: fc.constantFrom('filled', 'draft', 'ask', 'yours'),
      origin: fc.constantFrom('form'),
      required: fc.boolean(),
      note: fc.string({ maxLength: 8 }),
    },
    { requiredKeys: ['id'] },
  );
  const changes = fc.record(
    {
      fields: fc.array(fieldChange, { maxLength: 4 }),
      removeFields: fc.array(fc.constantFrom(...ids), { maxLength: 2 }),
      stage: fc.constantFrom(...STAGES),
      note: fc.string({ minLength: 1, maxLength: 10 }),
    },
    { requiredKeys: [] },
  );

  function start(): Application {
    let app = make({
      form: {
        fields: [
          ...FIELDS,
          { id: 'own-words', label: 'Why us?', kind: 'longtext', required: true, value: 'draft', status: 'draft' },
          { id: 'accepted', label: 'Notice period', kind: 'text', required: true, value: 'Two weeks', status: 'draft' },
          { id: 'from-form', label: 'City', kind: 'text', required: true, value: 'Plainfield', status: 'filled', origin: 'form' },
        ],
      },
    });
    app = change(app, { fields: [{ id: 'own-words', value: 'These are my own words.' }, { id: 'accepted', status: 'filled' }] }, 'user');
    return app;
  }

  const protectedPart = (app: Application) =>
    (app.form?.fields ?? []).filter((f) => f.origin === 'user' || f.acceptedAt !== undefined).map(({ id, value, status, origin, acceptedAt }) => ({ id, value, status, origin, acceptedAt }));

  it('the user’s words stay as they are, and nothing new becomes the user’s', () => {
    fc.assert(
      fc.property(fc.array(changes, { minLength: 1, maxLength: 8 }), (sequence) => {
        let app = start();
        const mine = protectedPart(app);
        for (const next of sequence) {
          try {
            app = change(app, next, 'assistant');
          } catch (e) {
            if (!(e instanceof ApplicationError)) throw e;
          }
          expect(protectedPart(app)).toEqual(mine);
          for (const f of app.form?.fields ?? []) {
            // A question left to the user is never answered by anyone else.
            if (f.status === 'yours' || f.status === 'ask') expect(f.value).toBe('');
            if (f.value === '') expect(f.origin).toBeUndefined();
          }
          // What it stores can always be read back.
          expect(storedApplication(JSON.parse(JSON.stringify(app)))).toEqual(app);
        }
      }),
      { numRuns: 300 },
    );
  });
});
