/**
 * The applications pages, used the way a person uses them. The server behind them is the real tracker over records
 * in memory (src/testing/fakeTracker.ts), so what a test finds in the tracker afterwards is what the real server
 * would have kept.
 */
import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { Changes } from '../apply/api';
import { FILE_FORMAT, type Application, type FormField } from '../apply/model';
import { DEFAULT_BOARDS } from '../jobs/boards';
import type { JobPosting } from '../jobs/types';
import { held, refusal, type Route } from '../testing/fakeServer';
import { fakeTracker } from '../testing/fakeTracker';
import { unsafeParts } from '../testing/html';
import { openApp } from '../testing/openApp';

const GLOBEX = {
  job: {
    title: 'Staff Technical Writer',
    company: 'Globex',
    location: 'Remote, US',
    workplace: 'remote',
    pay: '$120,000 to $150,000',
    postedAt: '2026-11-17',
    postingUrl: 'https://job-boards.greenhouse.io/globex/jobs/1',
    listings: [{ via: 'Globex', url: 'https://job-boards.greenhouse.io/globex/jobs/1' }, { via: 'A newsletter' }],
    descriptionHtml: '<h2>The role</h2><p onclick="steal()">Write the <b>docs</b>.</p><script>alert(1)</script><img src="x" onerror="alert(2)"><a href="javascript:alert(3)">apply</a>',
  },
  stage: 'drafting',
  form: {
    url: 'https://job-boards.greenhouse.io/globex/jobs/1#app',
    notes: 'The location box is a list that opens as you type.\nPick the entry from the list.',
    fields: [
      { id: 'first-name', label: 'First Name', kind: 'text', required: true, value: 'Jordan', status: 'filled', origin: 'form' },
      { id: 'why', label: 'Why Globex?', kind: 'longtext', required: true, value: 'A first draft about Globex.', status: 'draft', note: 'From the posting and the resume.' },
      { id: 'hear', label: 'How did you hear about us?', kind: 'choice', required: false, value: 'Company website', status: 'draft' },
      { id: 'start', label: 'When can you start?', kind: 'text', required: true, value: '', status: 'ask' },
      { id: 'website', label: 'Other website', kind: 'text', required: false, value: '', status: 'ask' },
      { id: 'pledge', label: 'I wrote these answers myself', kind: 'checkbox', required: true, value: '', status: 'yours', note: 'A pledge. Only you tick it.' },
      { id: 'gender', label: 'Gender', kind: 'choice', required: false, value: '', status: 'yours' },
    ],
  },
};
const ID = 'globex-staff-technical-writer';
const INITECH = { job: { title: 'Senior Technical Writer', company: 'Initech', postingUrl: 'https://jobs.ashbyhq.com/initech/1', listings: [] } };

type Start = Parameters<typeof fakeTracker>[0];

/** The app at an address, on a computer whose server keeps these applications. Accounts are off, as on Sloan's desktop. */
function open(address: string, start: Start = [GLOBEX]) {
  const tracker = fakeTracker(start);
  return { ...openApp(address, { available: false }, tracker.routes), tracker };
}

/** One application's page, once it is on screen. */
async function openOne(start: Start = [GLOBEX], id = ID) {
  const opened = open(`/applications/${id}`, start);
  // The last part of the page, so everything above it is there too.
  await screen.findByRole('heading', { name: 'Notes and history' });
  return opened;
}

const nav = () => within(screen.getByRole('navigation', { name: 'Main' }));
const region = (name: string | RegExp) => within(screen.getByRole('region', { name }));
/** The same, for a part that is only there once the server has answered. */
const loadedRegion = async (name: string | RegExp) => within(await screen.findByRole('region', { name }));
/** The box and buttons of one question. */
const question = (label: string) => within(screen.getByRole('form', { name: label }));
const kept = (tracker: ReturnType<typeof fakeTracker>, field: string, id = ID): FormField => tracker.get(id)!.form!.fields.find((f) => f.id === field)!;
const backInView = () => window.dispatchEvent(new Event('focus'));

describe('where the applications are', () => {
  it('has a link in the menu where the server keeps applications', async () => {
    const { user } = open('');
    await user.click(await nav().findByRole('link', { name: 'Applications' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Applications' })).toBeInTheDocument();
    expect(nav().getByRole('link', { name: 'Applications' })).toHaveAttribute('aria-current', 'page');
    expect(nav().getAllByRole('link').map((a) => a.textContent)).toEqual(['Find jobs', 'Applications', 'My resume']);
  });

  it('has no link, and says why at its address, where the server keeps none', async () => {
    const tracker = fakeTracker([], { available: false });
    const { server } = openApp('/applications', { available: false }, tracker.routes);
    expect(await screen.findByText('This server keeps no applications.')).toBeInTheDocument();
    expect(screen.getByText(/Applications have no sign-in/)).toBeInTheDocument();
    expect(nav().queryByRole('link', { name: 'Applications' })).not.toBeInTheDocument();
    expect(server.sent('GET /api/applications').length).toBeGreaterThan(0);
  });

  it('says the server could not be reached, and finds the applications when asked again', async () => {
    const tracker = fakeTracker([GLOBEX]);
    const notTheServer = () => new Response('<!doctype html><title>Job Hunt</title>', { status: 404, headers: { 'content-type': 'text/html' } });
    const { user, server } = openApp('/applications', { available: false }, { ...tracker.routes, 'GET /api/applications': notTheServer });
    expect(await screen.findByText('The app could not reach its server.')).toBeInTheDocument();

    server.routes['GET /api/applications'] = tracker.routes['GET /api/applications'];
    await user.click(screen.getByRole('button', { name: 'Try again' }));

    expect(await screen.findByRole('link', { name: 'Staff Technical Writer' })).toBeInTheDocument();
    expect(screen.queryByText('The app could not reach its server.')).not.toBeInTheDocument();
  });

  it('says it is looking while the server has not answered yet', async () => {
    let answer!: (reply: object) => void;
    openApp('/applications', { available: false }, { 'GET /api/applications': () => new Promise((resolve) => (answer = resolve)) });
    expect(screen.getByRole('status')).toHaveTextContent('Looking for your applications…');
    await waitFor(() => expect(answer).toBeDefined());
    answer({ available: true, applications: [] });
    expect(await screen.findByText(/No applications yet/)).toBeInTheDocument();
  });

  it('keeps the list on the page when one question to the server goes unanswered', async () => {
    const { server } = open('/applications');
    await screen.findByRole('link', { name: 'Staff Technical Writer' });

    server.routes['GET /api/applications'] = () => new Response('', { status: 502 });
    backInView();
    await waitFor(() => expect(server.sent('GET /api/applications').length).toBeGreaterThan(2));

    expect(screen.getByRole('link', { name: 'Staff Technical Writer' })).toBeInTheDocument();
    expect(screen.queryByText('The app could not reach its server.')).not.toBeInTheDocument();
  });
});

describe('the list of applications', () => {
  it('is empty at first, with ways to add one and nothing to export', async () => {
    open('/applications', []);
    expect(await screen.findByText('No applications yet. Save a job from the search results, add one here, or import a file.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add an application' })).toBeInTheDocument();
    expect(screen.getByLabelText('Import a file')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Export' })).not.toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('shows what is in progress, what was sent and what ended, each with what the user needs to know', async () => {
    open('/applications', [GLOBEX, INITECH, { job: { ...INITECH.job, title: 'Docs Lead', company: 'Northwind', postingUrl: 'https://northwind.example/careers/1' }, stage: 'submitted' }, { job: { ...INITECH.job, title: 'Writer', company: 'Zenith', postingUrl: 'https://zenith.example/careers/1' }, stage: 'rejected' }]);

    const progress = await loadedRegion(/^In progress/);
    expect(progress.getByRole('heading', { name: 'In progress (2)' })).toBeInTheDocument();
    expect(progress.getAllByRole('columnheader').map((h) => h.textContent)).toEqual(['Role', 'Stage', 'Left for you', 'Last change']);
    // The newest change comes first.
    const [initech, globex] = progress.getAllByRole('row').slice(1);
    expect(within(initech).getByRole('link', { name: 'Senior Technical Writer' })).toHaveAttribute('href', '#/applications/initech-senior-technical-writer');
    expect(within(initech).getByRole('rowheader')).toHaveTextContent('Initech');
    expect(within(initech).getAllByRole('cell').map((c) => c.textContent).slice(0, 2)).toEqual(['Saved', 'No form prepared yet']);
    expect(within(globex).getByRole('rowheader')).toHaveTextContent('Globex · Remote, US');
    // Two questions wait for an answer, two drafts for a look, and one required box only the user ticks.
    expect(within(globex).getAllByRole('cell').map((c) => c.textContent).slice(0, 2)).toEqual(['Being prepared', '2 answers needed, 2 drafts to review, 1 only you can do']);

    const sent = region(/^Sent/);
    expect(sent.getByRole('heading', { name: 'Sent (1)' })).toBeInTheDocument();
    expect(sent.getAllByRole('columnheader')[2]).toHaveTextContent('Sent');
    expect(sent.getByRole('link', { name: 'Docs Lead' })).toBeInTheDocument();
    expect(sent.getAllByRole('cell')[0]).toHaveTextContent('Sent');
    expect(sent.getAllByRole('cell')[1]).toHaveTextContent('2026');

    const closed = region(/^Closed/);
    expect(closed.getByRole('heading', { name: 'Closed (1)' })).toBeInTheDocument();
    expect(closed.getAllByRole('cell')[0]).toHaveTextContent('Not selected');
  });

  it('says "Nothing" when every question of a form is settled', async () => {
    open('/applications', [{ ...INITECH, form: { fields: [{ id: 'name', label: 'Name', value: 'Jordan', status: 'filled' }] } }]);
    expect((await loadedRegion(/^In progress/)).getAllByRole('cell')[1]).toHaveTextContent('Nothing');
  });

  it('names the files in the folder that it could not read', async () => {
    const tracker = fakeTracker([GLOBEX]);
    tracker.store.unreadable.push({ file: 'broken.json', why: 'It is not valid JSON.' });
    openApp('/applications', { available: false }, tracker.routes);
    const notice = await screen.findByText(/could not be read/);
    expect(notice).toHaveTextContent('1 file in the server’s folder of applications could not be read, and is not shown below. Nothing in it was changed.');
    expect(notice).toHaveTextContent('broken.json: It is not valid JSON.');

    tracker.store.unreadable.push({ file: 'half.json', why: 'job must be an object.' });
    backInView();
    expect(await screen.findByText(/2 files in the server’s folder/)).toHaveTextContent('are not shown below. Nothing in them was changed.');
  });

  it('gives every application as one file to keep', async () => {
    open('/applications');
    const link = await screen.findByRole('link', { name: 'Export' });
    expect(link).toHaveAttribute('href', '/api/applications/export');
    expect(link).toHaveAttribute('download', 'job-applications.json');
  });
});

describe('adding an application by hand', () => {
  it('takes a title, a company and a link, and opens the new application', async () => {
    const { user, tracker } = open('/applications', []);
    await user.click(await screen.findByRole('button', { name: 'Add an application' }));
    const form = region('Add an application');
    expect(form.getByLabelText('Job title')).toHaveFocus();
    await user.type(form.getByLabelText('Job title'), 'Documentation Engineer');
    await user.type(form.getByLabelText('Company'), 'Umbrella');
    await user.type(form.getByLabelText('Link to the posting'), 'https://umbrella.example/careers/1');
    await user.click(form.getByRole('button', { name: 'Add' }));

    expect(await screen.findByRole('heading', { level: 1, name: 'Documentation Engineer' })).toBeInTheDocument();
    expect(window.location.hash).toBe('#/applications/umbrella-documentation-engineer');
    // It is the user's: they added it, on the page.
    expect(tracker.get('umbrella-documentation-engineer')).toMatchObject({ stage: 'saved', stageSetBy: 'user', job: { title: 'Documentation Engineer', company: 'Umbrella', postingUrl: 'https://umbrella.example/careers/1' } });
    expect(tracker.get('umbrella-documentation-engineer')?.timeline).toEqual([expect.objectContaining({ by: 'user', kind: 'created' })]);
    expect(screen.getByText('No form has been prepared for this application yet.')).toBeInTheDocument();
  });

  it('says what is wrong with a link that is no web address, and sends nothing', async () => {
    const { user, server, tracker } = open('/applications', []);
    await user.click(await screen.findByRole('button', { name: 'Add an application' }));
    const form = region('Add an application');
    await user.type(form.getByLabelText('Job title'), 'Writer');
    await user.type(form.getByLabelText('Company'), 'Example');
    await user.type(form.getByLabelText('Link to the posting'), 'example.com/jobs/1');
    await user.click(form.getByRole('button', { name: 'Add' }));
    expect(await form.findByRole('alert')).toHaveTextContent('The link to the posting must be a web address that starts with https:// or http://.');

    await user.clear(form.getByLabelText('Job title'));
    await user.type(form.getByLabelText('Job title'), '   ');
    await user.click(form.getByRole('button', { name: 'Add' }));
    expect(await form.findByRole('alert')).toHaveTextContent('Give the job title and the company.');
    expect(server.sent('POST /api/applications')).toEqual([]);
    expect(tracker.ids()).toEqual([]);

    await user.click(form.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('region', { name: 'Add an application' })).not.toBeInTheDocument();
  });

  it('opens the application that is there already when the posting is tracked', async () => {
    const { user, tracker } = open('/applications');
    await user.click(await screen.findByRole('button', { name: 'Add an application' }));
    const form = region('Add an application');
    await user.type(form.getByLabelText('Job title'), 'Technical Writer, Staff');
    await user.type(form.getByLabelText('Company'), 'Globex Inc.');
    await user.type(form.getByLabelText('Link to the posting'), 'https://job-boards.greenhouse.io/globex/jobs/1/?utm_source=newsletter');
    await user.click(form.getByRole('button', { name: 'Add' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Staff Technical Writer' })).toBeInTheDocument();
    expect(tracker.ids()).toEqual([ID]);
  });
});

describe('importing a file of applications', () => {
  const file = (applications: unknown[]) => new File([JSON.stringify({ format: FILE_FORMAT, version: 1, applications })], 'job-applications.json', { type: 'application/json' });

  it('adds the ones that are not here yet, and says which were left out and why', async () => {
    const { user, tracker } = open('/applications');
    await screen.findByRole('link', { name: 'Staff Technical Writer' });
    // A file as an export gives it: one application that is here already, one that is not, with an answer in the user's words.
    const exported = [tracker.get(ID), { ...INITECH, form: { fields: [{ id: 'why', label: 'Why Initech?', value: 'Typed by me, long ago.', status: 'filled', origin: 'user' }] } }];
    await user.upload(screen.getByLabelText('Import a file'), file(exported));

    const result = await screen.findByText(/Added 1 application\./);
    expect(result).toHaveTextContent(`Not added:Globex, Staff Technical Writer: An application with the id "${ID}" is already here.`);
    expect(await screen.findByRole('link', { name: 'Senior Technical Writer' })).toBeInTheDocument();
    // The user chose the file on the page, so what it marks as the user's words stays theirs.
    expect(kept(tracker, 'why', 'initech-senior-technical-writer')).toMatchObject({ value: 'Typed by me, long ago.', origin: 'user' });
  });

  it('says so when everything was added, and when nothing was', async () => {
    const { user } = open('/applications', []);
    await screen.findByText(/No applications yet/);
    await user.upload(screen.getByLabelText('Import a file'), file([GLOBEX, INITECH]));
    expect(await screen.findByText('Added 2 applications.')).toBeInTheDocument();

    await user.upload(screen.getByLabelText('Import a file'), file([]));
    expect(await screen.findByText('Nothing was added.')).toBeInTheDocument();
  });

  it('turns down a file that is not one of applications', async () => {
    const { user, tracker } = open('/applications', []);
    await screen.findByText(/No applications yet/);
    await user.upload(screen.getByLabelText('Import a file'), new File(['not json at all'], 'notes.json', { type: 'application/json' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('notes.json is not a file of applications: it is not JSON.');

    await user.upload(screen.getByLabelText('Import a file'), new File([JSON.stringify({ applications: [GLOBEX] })], 'other.json', { type: 'application/json' }));
    expect(await screen.findByText(/This is not a file of applications from this app/)).toBeInTheDocument();
    expect(tracker.ids()).toEqual([]);
  });
});

describe('one application', () => {
  it('shows the job, where to go, and what is left for the user', async () => {
    await openOne();
    expect(screen.getByRole('heading', { level: 1, name: 'Staff Technical Writer' })).toBeInTheDocument();
    const facts = screen.getByText('Globex').parentElement!;
    expect(facts).toHaveTextContent(/Globex.*Remote, US.*Remote.*\$120,000 to \$150,000.*Posted .*17.*2026/);
    expect(screen.getByRole('link', { name: 'Open the form' })).toHaveAttribute('href', 'https://job-boards.greenhouse.io/globex/jobs/1#app');
    expect(screen.getByRole('link', { name: 'Open the posting' })).toHaveAttribute('href', 'https://job-boards.greenhouse.io/globex/jobs/1');
    for (const name of ['Open the form', 'Open the posting']) {
      expect(screen.getByRole('link', { name })).toHaveAttribute('target', '_blank');
      expect(screen.getByRole('link', { name })).toHaveAttribute('rel', 'noopener noreferrer');
    }
    expect(screen.getByRole('link', { name: 'All applications' })).toHaveAttribute('href', '#/applications');
    expect(screen.getByLabelText('Stage')).toHaveDisplayValue('Being prepared');
    expect(screen.getByText(/^Set by your assistant\./)).toBeInTheDocument();

    const left = region('Left for you');
    expect(left.getByText('2 answers needed, 2 drafts to review, 1 only you can do.')).toBeInTheDocument();
    expect(left.getAllByRole('heading', { level: 3 }).map((h) => h.textContent)).toEqual(['Needs your answer', 'Drafts to review', 'Only you, on the form']);
    expect(left.getAllByRole('form').map((f) => f.getAttribute('aria-label'))).toEqual(['When can you start?', 'Other website', 'Why Globex?', 'How did you hear about us?']);
  });

  it('has one link when the form is at the posting’s own address', async () => {
    await openOne([{ ...INITECH, form: { fields: [] } }], 'initech-senior-technical-writer');
    expect(screen.getByRole('link', { name: 'Open the form' })).toHaveAttribute('href', 'https://jobs.ashbyhq.com/initech/1');
    expect(screen.queryByRole('link', { name: 'Open the posting' })).not.toBeInTheDocument();
  });

  it('says so when there is no such application', async () => {
    open('/applications/never-saved');
    expect(await screen.findByRole('heading', { level: 1, name: 'No such application' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'All applications' })).toBeInTheDocument();
  });

  it('says when it could not be loaded, and loads it when asked again', async () => {
    const tracker = fakeTracker([GLOBEX]);
    const { user, server } = openApp(`/applications/${ID}`, { available: false }, { ...tracker.routes, [`GET /api/applications/${ID}`]: () => refusal(500, 'server_error', 'Something went wrong on the server.') });
    expect(await screen.findByRole('alert')).toHaveTextContent('Something went wrong on the server.');

    delete server.routes[`GET /api/applications/${ID}`];
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Staff Technical Writer' })).toBeInTheDocument();
  });
});

describe('a question that waits for the user', () => {
  it('is settled with the answer the user types, in their words', async () => {
    const { user, tracker } = await openOne();
    const start = question('When can you start?');
    expect(start.getByText('Required')).toBeInTheDocument();
    expect(start.getByRole('button', { name: 'Save answer' })).toBeDisabled();
    // A question the form requires cannot be left empty here.
    expect(start.queryByRole('button', { name: 'Leave it empty' })).not.toBeInTheDocument();

    await user.type(start.getByLabelText('When can you start?'), '  Two weeks after an offer. ');
    await user.click(start.getByRole('button', { name: 'Save answer' }));

    await waitFor(() => expect(screen.queryByRole('form', { name: 'When can you start?' })).not.toBeInTheDocument());
    // Exactly as typed, spaces and all.
    expect(kept(tracker, 'start')).toMatchObject({ value: '  Two weeks after an offer. ', origin: 'user', status: 'filled' });
    expect(region('Left for you').getByText('1 answer needed, 2 drafts to review, 1 only you can do.')).toBeInTheDocument();
  });

  it('is saved by the Enter key in a one-line box', async () => {
    const { user, tracker } = await openOne();
    await user.type(question('When can you start?').getByRole('textbox'), 'In January{Enter}');
    await waitFor(() => expect(kept(tracker, 'start')).toMatchObject({ value: 'In January', origin: 'user' }));
  });

  it('can be left empty when the form does not require it', async () => {
    const { user, tracker } = await openOne();
    const website = question('Other website');
    expect(website.getByText('Optional')).toBeInTheDocument();
    await user.click(website.getByRole('button', { name: 'Leave it empty' }));
    await waitFor(() => expect(screen.queryByRole('form', { name: 'Other website' })).not.toBeInTheDocument());
    expect(kept(tracker, 'website')).toMatchObject({ value: '', status: 'filled' });
    expect(kept(tracker, 'website').origin).toBeUndefined();
  });
});

describe('a first draft by an assistant', () => {
  it('says whose it is, and can be kept as it is without becoming the user’s words', async () => {
    const { user, tracker } = await openOne();
    const why = question('Why Globex?');
    expect(why.getByRole('textbox')).toHaveValue('A first draft about Globex.');
    expect(why.getByRole('textbox')).toHaveAccessibleDescription('Written by your assistant, as a draft. From the posting and the resume.');
    expect(why.getByRole('button', { name: 'Save my version' })).toBeDisabled();

    await user.click(why.getByRole('button', { name: 'Keep as it is' }));

    await waitFor(() => expect(screen.queryByRole('form', { name: 'Why Globex?' })).not.toBeInTheDocument());
    const field = kept(tracker, 'why');
    expect(field).toMatchObject({ value: 'A first draft about Globex.', origin: 'assistant', status: 'filled' });
    expect(field.acceptedAt).toBeDefined();

    await user.click(screen.getByRole('button', { name: /^Answers/ }));
    const row = screen.getByText('Why Globex?').closest('li')!;
    expect(row).toHaveTextContent('Written by your assistant. You kept it as it is.');
  });

  it('becomes the user’s words when they rewrite it', async () => {
    const { user, tracker } = await openOne();
    const why = question('Why Globex?');
    await user.clear(why.getByRole('textbox'));
    await user.type(why.getByRole('textbox'), 'I use Globex every day.\nI want to document it.');
    // A draft with other words in the box is no longer the draft that would be kept.
    expect(why.getByRole('button', { name: 'Keep as it is' })).toBeDisabled();
    await user.click(why.getByRole('button', { name: 'Save my version' }));

    await waitFor(() => expect(screen.queryByRole('form', { name: 'Why Globex?' })).not.toBeInTheDocument());
    const field = kept(tracker, 'why');
    expect(field).toMatchObject({ value: 'I use Globex every day.\nI want to document it.', origin: 'user', status: 'filled' });
    expect(field.acceptedAt).toBeUndefined();

    await user.click(screen.getByRole('button', { name: /^Answers/ }));
    expect(screen.getByText('Why Globex?').closest('li')).toHaveTextContent('Your words');
  });

  it('is not kept unseen: a draft that changed since the page showed it is shown again first', async () => {
    const { user, tracker } = await openOne();
    // The assistant rewrites the draft while the page still shows the first one.
    await tracker.change(ID, { fields: [{ id: 'why', value: 'A second draft, never seen.' }] });
    await user.click(question('Why Globex?').getByRole('button', { name: 'Keep as it is' }));

    expect(await question('Why Globex?').findByRole('alert')).toHaveTextContent(
      'This application changed while you had it open, so that was not saved. It is shown as it is now. Look at it again, then repeat what you did.',
    );
    expect(question('Why Globex?').getByRole('textbox')).toHaveValue('A second draft, never seen.');
    expect(kept(tracker, 'why')).toMatchObject({ status: 'draft', origin: 'assistant' });
    expect(kept(tracker, 'why').acceptedAt).toBeUndefined();

    // Now that it was seen, it can be kept.
    await user.click(question('Why Globex?').getByRole('button', { name: 'Keep as it is' }));
    await waitFor(() => expect(kept(tracker, 'why').acceptedAt).toBeDefined());
    expect(kept(tracker, 'why').value).toBe('A second draft, never seen.');
  });

  it('keeps what the user is typing when the draft changes underneath, and follows the change where nothing was typed', async () => {
    const { user, tracker } = await openOne();
    await user.clear(question('Why Globex?').getByRole('textbox'));
    await user.type(question('Why Globex?').getByRole('textbox'), 'Half a sentence of my own');

    await tracker.change(ID, { fields: [{ id: 'why', value: 'A second draft.' }, { id: 'hear', value: 'LinkedIn' }] });
    backInView();

    await waitFor(() => expect(question('How did you hear about us?').getByRole('textbox')).toHaveValue('LinkedIn'));
    expect(question('Why Globex?').getByRole('textbox')).toHaveValue('Half a sentence of my own');
    await user.click(question('Why Globex?').getByRole('button', { name: 'Save my version' }));
    await waitFor(() => expect(kept(tracker, 'why')).toMatchObject({ value: 'Half a sentence of my own', origin: 'user', status: 'filled' }));
  });

  it('says how a choice is written down', async () => {
    await openOne();
    expect(question('How did you hear about us?').getByRole('textbox')).toHaveAccessibleDescription(
      'Written by your assistant, as a draft. The option exactly as the form words it. Several options: one on each line.',
    );
  });

  it('waits for the user again when a required answer is taken out, and is left empty when an optional one is', async () => {
    const { user, tracker } = await openOne();
    await user.clear(question('Why Globex?').getByRole('textbox'));
    await user.click(question('Why Globex?').getByRole('button', { name: 'Save my version' }));
    await waitFor(() => expect(kept(tracker, 'why')).toMatchObject({ value: '', status: 'ask' }));
    expect(await region('Left for you').findByText('3 answers needed, 1 draft to review, 1 only you can do.')).toBeInTheDocument();

    await user.clear(question('How did you hear about us?').getByRole('textbox'));
    await user.click(question('How did you hear about us?').getByRole('button', { name: 'Save my version' }));
    await waitFor(() => expect(kept(tracker, 'hear')).toMatchObject({ value: '', status: 'filled' }));
  });

  it('shows why a save failed, next to the answer, and keeps what was typed', async () => {
    const { user, server, tracker } = await openOne();
    await user.clear(question('Why Globex?').getByRole('textbox'));
    await user.type(question('Why Globex?').getByRole('textbox'), 'My own words.');
    server.routes[`POST /api/applications/${ID}`] = () => new Response('', { status: 502 });
    await user.click(question('Why Globex?').getByRole('button', { name: 'Save my version' }));

    expect(await question('Why Globex?').findByRole('alert')).toHaveTextContent('The server could not be reached. Check that it is running, then try again.');
    expect(question('Why Globex?').getByRole('textbox')).toHaveValue('My own words.');
    expect(kept(tracker, 'why').value).toBe('A first draft about Globex.');

    delete server.routes[`POST /api/applications/${ID}`];
    await user.click(question('Why Globex?').getByRole('button', { name: 'Save my version' }));
    await waitFor(() => expect(kept(tracker, 'why').value).toBe('My own words.'));
  });
});

describe('what only the user does on the form', () => {
  it('is listed and never has a box: the required first, then what the form does not require', async () => {
    await openOne();
    const left = region('Left for you');
    const lists = left.getAllByRole('list');
    expect(lists).toHaveLength(2);
    expect(within(lists[0]).getByRole('listitem')).toHaveTextContent('I wrote these answers myselfA pledge. Only you tick it.');
    expect(left.getByText('The form does not require these:')).toBeInTheDocument();
    expect(within(lists[1]).getByRole('listitem')).toHaveTextContent('Gender');
    expect(screen.queryByRole('form', { name: 'I wrote these answers myself' })).not.toBeInTheDocument();

    // In the list of all answers it has no "Change" either.
    await userOpensAnswers();
    const row = screen.getAllByText('I wrote these answers myself').map((el) => el.closest('ol.answers > li')).find(Boolean)!;
    expect(row).toHaveTextContent('Only you, on the form');
    expect(within(row as HTMLElement).queryByRole('button')).not.toBeInTheDocument();
  });

  it('says when the form requires none of them', async () => {
    await openOne([{ ...INITECH, form: { fields: [{ id: 'gender', label: 'Gender', kind: 'choice', value: '', status: 'yours' }] } }], 'initech-senior-technical-writer');
    const left = region('Left for you');
    expect(left.getByText('Nothing. Every question of the form has a settled answer.')).toBeInTheDocument();
    expect(left.getByText('The form requires none of them:')).toBeInTheDocument();
    expect(left.getByRole('listitem')).toHaveTextContent('Gender');
  });
});

async function userOpensAnswers() {
  screen.getByRole('button', { name: /^Answers/ }).click();
  await screen.findByText('Every question of the form, in its order, with what goes in it and who wrote that.');
}

describe('every answer of the form', () => {
  it('folds away, and says how many questions there are and how many are settled', async () => {
    const { user } = await openOne();
    const head = screen.getByRole('button', { name: /^Answers/ });
    expect(head).toHaveAttribute('aria-expanded', 'false');
    expect(head).toHaveTextContent('7 questions, 1 settled');
    await user.click(head);
    expect(head).toHaveAttribute('aria-expanded', 'true');

    const rows = within(document.querySelector('ol.answers') as HTMLElement).getAllByRole('listitem');
    expect(rows).toHaveLength(7);
    expect(rows[0]).toHaveTextContent('First Name Required');
    expect(rows[0]).toHaveTextContent('Jordan');
    expect(rows[0]).toHaveTextContent('Read from the form');
    expect(rows[1]).toHaveTextContent('Written by your assistant, as a draft');
    expect(rows[1]).toHaveTextContent('From the posting and the resume.');
    expect(rows[3]).toHaveTextContent('Waiting for your answer');
    expect(rows[6]).toHaveTextContent('Only you, on the form');
  });

  it('lets the user correct any answer, which makes it theirs', async () => {
    const { user, tracker } = await openOne();
    await user.click(screen.getByRole('button', { name: /^Answers/ }));
    await user.click(screen.getByRole('button', { name: 'Change the answer to: First Name' }));

    const box = screen.getByRole('textbox', { name: 'First Name' });
    expect(box).toHaveFocus();
    expect(box).toHaveValue('Jordan');
    const editor = question('First Name');
    expect(editor.getByRole('button', { name: 'Save' })).toBeDisabled();
    await user.type(box, ' R.');
    await user.click(editor.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(kept(tracker, 'first-name')).toMatchObject({ value: 'Jordan R.', origin: 'user', status: 'filled' }));
    await waitFor(() => expect(screen.queryByRole('form', { name: 'First Name' })).not.toBeInTheDocument());
    expect(screen.getByText('Jordan R.').closest('li')).toHaveTextContent('Your words');
  });

  it('leaves an answer alone when the change is cancelled', async () => {
    const { user, tracker, server } = await openOne();
    await user.click(screen.getByRole('button', { name: /^Answers/ }));
    await user.click(screen.getByRole('button', { name: 'Change the answer to: First Name' }));
    await user.type(screen.getByRole('textbox', { name: 'First Name' }), ' and more');
    await user.click(question('First Name').getByRole('button', { name: 'Cancel' }));

    expect(screen.queryByRole('form', { name: 'First Name' })).not.toBeInTheDocument();
    expect(server.sent(`POST /api/applications/${ID}`)).toEqual([]);
    expect(kept(tracker, 'first-name')).toMatchObject({ value: 'Jordan', origin: 'form' });
  });

  it('says that an answer was left empty', async () => {
    const { user } = await openOne([{ ...INITECH, form: { fields: [{ id: 'website', label: 'Website', value: '', status: 'filled' }] } }], 'initech-senior-technical-writer');
    await user.click(screen.getByRole('button', { name: /^Answers/ }));
    expect(screen.getByText('Website').closest('li')).toHaveTextContent('Left empty');
  });
});

describe('the stage of an application', () => {
  it('is set by the user at once, and a sent application has nothing left to do', async () => {
    const { user, tracker } = await openOne();
    await user.selectOptions(screen.getByLabelText('Stage'), 'Sent');

    expect(await screen.findByText(/^Set by you\. Sent /)).toBeInTheDocument();
    expect(tracker.get(ID)).toMatchObject({ stage: 'submitted', stageSetBy: 'user' });
    expect(tracker.get(ID)?.submittedAt).toBeDefined();
    expect(screen.queryByRole('region', { name: 'Left for you' })).not.toBeInTheDocument();
    // The answers stay, as the record of what was sent.
    expect(screen.getByRole('button', { name: /^Answers/ })).toHaveTextContent('7 questions, 1 settled');
    expect(region('Notes and history').getByText('Stage set to “Sent” by you. It was “Being prepared”.')).toBeInTheDocument();
  });

  it('offers every stage by its name', async () => {
    await openOne();
    expect(within(screen.getByLabelText('Stage')).getAllByRole('option').map((o) => o.textContent)).toEqual([
      'Saved',
      'Being prepared',
      'Ready for you to send',
      'Being sent',
      'Sent',
      'In review',
      'Assessment',
      'Interview',
      'Offer',
      'Not selected',
      'Withdrawn',
      'Posting closed',
      'Unknown, check on the site',
    ]);
  });

  it('says why when it could not be set', async () => {
    const { user, server } = await openOne();
    server.routes[`POST /api/applications/${ID}`] = () => refusal(500, 'server_error', 'Something went wrong on the server.');
    await user.selectOptions(screen.getByLabelText('Stage'), 'Withdrawn');
    expect(await screen.findByRole('alert')).toHaveTextContent('Something went wrong on the server.');
    expect(screen.getByLabelText('Stage')).toHaveDisplayValue('Being prepared');
  });
});

describe('notes and history', () => {
  it('shows what happened, newest first, and who did it', async () => {
    const tracker = fakeTracker([GLOBEX]);
    await tracker.change(ID, { note: 'Read the form back.\nIt holds what is recorded here.' });
    await tracker.change(ID, { stage: 'ready' });
    openApp(`/applications/${ID}`, { available: false }, tracker.routes);

    const lines = (await loadedRegion('Notes and history')).getAllByRole('listitem');
    expect(lines.map((li) => li.firstElementChild?.textContent)).toEqual([
      'Stage set to “Ready for you to send” by your assistant. It was “Being prepared”.',
      'Read the form back.\nIt holds what is recorded here.',
      'Added by your assistant.',
    ]);
    expect(lines[1]).toHaveTextContent('Note by your assistant');
    expect(within(lines[0]).getByText(/2026/).tagName).toBe('TIME');
  });

  it('names the employer’s site where a stage was read there, and leaves out an earlier stage that nobody recorded', async () => {
    const tracker = fakeTracker([GLOBEX]);
    const app = tracker.get(ID)!;
    // As a file from somewhere else can have it: the stage was read on the employer's site, and what it was before is not known.
    tracker.store.applications.set(ID, {
      ...app,
      stage: 'in_review',
      stageSetBy: 'site',
      submittedAt: '2026-11-24T18:00:00.000Z',
      timeline: [...app.timeline, { at: '2026-11-25T10:00:00.000Z', by: 'site', kind: 'stage', stage: 'in_review' }],
    });
    openApp(`/applications/${ID}`, { available: false }, tracker.routes);

    const lines = (await loadedRegion('Notes and history')).getAllByRole('listitem');
    expect(lines.map((li) => li.firstElementChild?.textContent)).toEqual(['Stage set to “In review” by the employer’s site.', 'Added by your assistant.']);
    expect(screen.getByText(/^Set by the employer’s site\. Sent /)).toBeInTheDocument();
    expect(screen.getByLabelText('Stage')).toHaveDisplayValue('In review');
  });

  it('takes a note from the user', async () => {
    const { user, tracker } = await openOne();
    const history = region('Notes and history');
    expect(history.getByRole('button', { name: 'Add note' })).toBeDisabled();
    await user.type(history.getByLabelText('Add a note'), 'Called the recruiter.');
    await user.click(history.getByRole('button', { name: 'Add note' }));

    expect(await history.findByText('Called the recruiter.', { selector: 'li *' })).toBeInTheDocument();
    await waitFor(() => expect(history.getByLabelText('Add a note')).toHaveValue(''));
    expect(history.getAllByRole('listitem')[0]).toHaveTextContent('Note by you');
    expect(tracker.get(ID)?.timeline.at(-1)).toMatchObject({ by: 'user', kind: 'note', text: 'Called the recruiter.' });
  });
});

describe('the saved posting and the notes about the form', () => {
  it('shows the posting through the barrier for job site HTML', async () => {
    const { user } = await openOne();
    const head = screen.getByRole('button', { name: /^The posting/ });
    expect(head).toHaveTextContent('As it was when it was saved');
    await user.click(head);

    const body = document.querySelector('.desc') as HTMLElement;
    expect(body).toHaveTextContent('The roleWrite the docs.apply');
    expect(unsafeParts(body.innerHTML)).toEqual([]);
    expect(body.querySelector('script, img, [onclick], [href^="javascript"]')).toBeNull();
    // Where it was seen: a place with an address is a link, a place without one is only named.
    const listed = screen.getByText('Listed on').parentElement!;
    expect(listed).toHaveTextContent('Globex original posting');
    expect(listed).toHaveTextContent('A newsletter');
    expect(within(listed).getAllByRole('link')).toHaveLength(1);
    expect(within(listed).getByRole('link')).toHaveAttribute('href', 'https://job-boards.greenhouse.io/globex/jobs/1');
  });

  it('shows a posting that was saved as plain text, and says when none was saved', async () => {
    const { user } = await openOne([{ job: { ...INITECH.job, descriptionText: 'Write docs.\nFor <b>APIs</b>.' } }], 'initech-senior-technical-writer');
    await user.click(screen.getByRole('button', { name: /^The posting/ }));
    const body = document.querySelector('.desc') as HTMLElement;
    expect(body.innerHTML).toBe('<p>Write docs.<br>For &lt;b&gt;APIs&lt;/b&gt;.</p>');
    expect(screen.queryByText('Listed on')).not.toBeInTheDocument();
  });

  it('says when the text of the posting was not saved', async () => {
    const { user } = await openOne([INITECH], 'initech-senior-technical-writer');
    await user.click(screen.getByRole('button', { name: /^The posting/ }));
    expect(screen.getByText('The text of the posting was not saved.')).toBeInTheDocument();
    // No form, so no answers and no notes about one.
    expect(screen.queryByRole('button', { name: /^Answers/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^How this form is filled in/ })).not.toBeInTheDocument();
  });

  it('shows what an assistant wrote down about filling the form, line for line', async () => {
    const { user } = await openOne();
    await user.click(screen.getByRole('button', { name: /^How this form is filled in/ }));
    expect(screen.getByText(/The location box is a list that opens as you type\./).textContent).toBe('The location box is a list that opens as you type.\nPick the entry from the list.');
  });
});

describe('removing an application', () => {
  it('asks first, and then takes it off the list', async () => {
    const { user, tracker } = await openOne([GLOBEX, INITECH]);
    const remove = region('Remove');
    await user.click(remove.getByRole('button', { name: 'Remove this application…' }));
    // Not yet.
    expect(tracker.ids()).toContain(ID);
    await user.click(remove.getByRole('button', { name: 'Cancel' }));
    await user.click(remove.getByRole('button', { name: 'Remove this application…' }));
    await user.click(remove.getByRole('button', { name: 'Remove it from the list' }));

    expect(await screen.findByRole('heading', { level: 1, name: 'Applications' })).toBeInTheDocument();
    expect(window.location.hash).toBe('#/applications');
    expect(tracker.ids()).toEqual(['initech-senior-technical-writer']);
    await waitFor(() => expect(screen.queryByRole('link', { name: 'Staff Technical Writer' })).not.toBeInTheDocument());
    expect(screen.getByRole('link', { name: 'Senior Technical Writer' })).toBeInTheDocument();
  });

  it('says why when it could not be removed', async () => {
    const { user, server, tracker } = await openOne();
    server.routes[`POST /api/applications/${ID}/remove`] = () => refusal(500, 'server_error', 'Something went wrong on the server.');
    await user.click(region('Remove').getByRole('button', { name: 'Remove this application…' }));
    await user.click(region('Remove').getByRole('button', { name: 'Remove it from the list' }));
    expect(await region('Remove').findByRole('alert')).toHaveTextContent('Something went wrong on the server.');
    expect(tracker.ids()).toEqual([ID]);
  });
});

describe('an assistant working on the same application', () => {
  it('is seen on the page when the window comes back into view', async () => {
    const { tracker } = await openOne();
    const changes: Changes = { stage: 'ready', fields: [{ id: 'start', value: 'Two weeks after an offer.', status: 'draft' }], note: 'Asked in chat, answered there.' };
    const changed: Application = await tracker.change(ID, changes);
    expect(changed.revision).toBe(2);
    backInView();

    expect(await screen.findByDisplayValue('Ready for you to send')).toBeInTheDocument();
    // The question that waited is now a draft to review, with the assistant's words in it.
    await waitFor(() => expect(question('When can you start?').getByRole('textbox')).toHaveValue('Two weeks after an offer.'));
    expect(question('When can you start?').getByRole('button', { name: 'Keep as it is' })).toBeEnabled();
    expect(region('Notes and history').getByText('Asked in chat, answered there.')).toBeInTheDocument();
  });

  it('is never shown as it was before: an answer from the server that arrives late does not undo a newer one', async () => {
    const { user, server, tracker } = await openOne();
    const asItWas = tracker.get(ID)!;
    // The page asks again, and this time the server is slow to answer.
    const slow = held<Response>();
    const asked = server.sent(`GET /api/applications/${ID}`).length;
    server.routes[`GET /api/applications/${ID}`] = () => slow.answer;
    backInView();
    await waitFor(() => expect(server.sent(`GET /api/applications/${ID}`)).toHaveLength(asked + 1));
    delete server.routes[`GET /api/applications/${ID}`];

    // Meanwhile the user answers a question, and the page shows the application with that answer in it.
    await user.type(question('When can you start?').getByRole('textbox'), 'Two weeks after an offer.');
    await user.click(question('When can you start?').getByRole('button', { name: 'Save answer' }));
    await waitFor(() => expect(screen.queryByRole('form', { name: 'When can you start?' })).not.toBeInTheDocument());
    expect(region('Left for you').getByText('1 answer needed, 2 drafts to review, 1 only you can do.')).toBeInTheDocument();

    // Now the slow answer arrives, with the application as it was before the user answered. The page reads it,
    // and goes on showing what it has.
    const late = Response.json({ application: asItWas });
    slow.release(late);
    await waitFor(() => expect(late.bodyUsed).toBe(true));
    expect(screen.queryByRole('form', { name: 'When can you start?' })).not.toBeInTheDocument();
    expect(region('Left for you').getByText('1 answer needed, 2 drafts to review, 1 only you can do.')).toBeInTheDocument();
    expect(kept(tracker, 'start')).toMatchObject({ value: 'Two weeks after an offer.', origin: 'user', status: 'filled' });
  });
});

describe('saving a job from the search results', () => {
  const SERVER = 'https://search.example.test';
  const POSTING: JobPosting = {
    id: 'greenhouse:acme:1',
    title: 'Technical Writer',
    company: 'Acme',
    location: 'Austin, TX',
    workplace: 'hybrid',
    postedAt: '2026-11-20T09:00:00.000Z',
    salary: { min: 120_000, max: 150_000, currency: 'USD', period: 'year' },
    descriptionHtml: '<p>The first lines of the posting.</p>',
    descriptionPartial: true,
    listings: [
      { sourceId: 'greenhouse', via: 'Acme', url: 'https://boards.greenhouse.io/acme/jobs/1' },
      { sourceId: 'linkedin', via: 'LinkedIn', url: 'https://www.linkedin.com/jobs/view/42' },
    ],
  };
  const FULL = '<p>The whole posting.</p><script>alert(1)</script>';

  /** The search page with one result on it, on a computer whose server answers the tracker as `tracker` says. */
  async function searched(tracker: ReturnType<typeof fakeTracker>, routes: Record<string, Route> = {}) {
    localStorage.setItem('search-settings:v1', JSON.stringify({ boards: DEFAULT_BOARDS, companies: [], industries: [], allowScraping: false, apiUrl: SERVER }));
    const search: Record<string, Route> = {
      'POST /api/search': () => ({ jobs: [POSTING], sources: [{ sourceId: 'company:acme', label: 'Acme (greenhouse)', ok: true, count: 1, ms: 120 }] }),
      'GET /api/job': () => ({ descriptionHtml: FULL }),
    };
    const opened = openApp('', { available: false }, { ...tracker.routes, ...search, ...routes });
    await opened.user.type(screen.getByLabelText('Role'), 'technical writer');
    await opened.user.click(screen.getByRole('button', { name: 'Search' }));
    const detail = within(await screen.findByRole('article', { name: 'Technical Writer' }));
    // The rest of the posting has arrived.
    await detail.findByText('The whole posting.');
    return { ...opened, detail };
  }

  it('keeps the posting as the search gave it, as the user’s own application, and links to it', async () => {
    const tracker = fakeTracker([]);
    const { user, detail } = await searched(tracker);
    await user.click(await detail.findByRole('button', { name: 'Save to applications' }));

    const saved = await detail.findByRole('status');
    expect(saved).toHaveTextContent('Saved. Open it in your applications');
    expect(within(saved).getByRole('link')).toHaveAttribute('href', '#/applications/acme-technical-writer');
    expect(detail.queryByRole('button', { name: 'Save to applications' })).not.toBeInTheDocument();
    expect(tracker.get('acme-technical-writer')).toMatchObject({
      stage: 'saved',
      stageSetBy: 'user',
      job: {
        title: 'Technical Writer',
        company: 'Acme',
        location: 'Austin, TX',
        workplace: 'hybrid',
        pay: '$120,000 to $150,000 a year',
        postedAt: '2026-11-20T09:00:00.000Z',
        postingUrl: 'https://boards.greenhouse.io/acme/jobs/1',
        listings: [
          { via: 'Acme', url: 'https://boards.greenhouse.io/acme/jobs/1' },
          { via: 'LinkedIn', url: 'https://www.linkedin.com/jobs/view/42' },
        ],
        // The whole posting, as the site gave it. It is made safe where it is shown, not where it is kept.
        descriptionHtml: FULL,
      },
    });

    // The link goes to the application, with the posting shown through the barrier.
    await user.click(within(saved).getByRole('link'));
    expect(await screen.findByRole('heading', { level: 1, name: 'Technical Writer' })).toBeInTheDocument();
    await user.click(await screen.findByRole('button', { name: /^The posting/ }));
    expect(unsafeParts((document.querySelector('.desc') as HTMLElement).innerHTML)).toEqual([]);
    expect(document.querySelector('.desc')).toHaveTextContent('The whole posting.');
  });

  it('says where a job is that is tracked already, by whichever board it was found on', async () => {
    const tracker = fakeTracker([{ job: { title: 'Technical Writer', company: 'Acme', postingUrl: 'https://www.linkedin.com/jobs/view/42/?utm_source=share', listings: [] }, stage: 'drafting' }]);
    const { detail } = await searched(tracker);
    const there = await detail.findByRole('link', { name: 'In your applications: Being prepared' });
    expect(there).toHaveAttribute('href', '#/applications/acme-technical-writer');
    expect(detail.queryByRole('button', { name: 'Save to applications' })).not.toBeInTheDocument();
  });

  it('does not add a job twice that an assistant saved a moment ago, and says where it is', async () => {
    const tracker = fakeTracker([]);
    const { user, detail } = await searched(tracker);
    const save = await detail.findByRole('button', { name: 'Save to applications' });
    // Behind the page's back: the list the page has is from before this.
    await tracker.add({ job: { title: 'Technical Writer', company: 'Acme', postingUrl: 'https://boards.greenhouse.io/acme/jobs/1' }, stage: 'drafting' });
    await user.click(save);

    const there = await detail.findByRole('link', { name: 'In your applications: Being prepared' });
    expect(there).toHaveAttribute('href', '#/applications/acme-technical-writer');
    expect(detail.getByRole('status')).not.toHaveTextContent('Saved.');
    expect(detail.queryByRole('button', { name: 'Save to applications' })).not.toBeInTheDocument();
    // It is still the assistant's, as the assistant left it.
    expect(tracker.ids()).toEqual(['acme-technical-writer']);
    expect(tracker.get('acme-technical-writer')).toMatchObject({ revision: 1, stage: 'drafting', stageSetBy: 'assistant' });
  });

  it('has no button where the server keeps no applications', async () => {
    const { detail, server } = await searched(fakeTracker([], { available: false }));
    await waitFor(() => expect(server.sent('GET /api/applications').length).toBeGreaterThan(0));
    expect(detail.queryByRole('button', { name: 'Save to applications' })).not.toBeInTheDocument();
    expect(detail.queryByText(/In your applications/)).not.toBeInTheDocument();
  });

  it('says why when the job could not be saved, and can be tried again', async () => {
    const tracker = fakeTracker([]);
    const { user, detail, server } = await searched(tracker, { 'POST /api/applications': () => refusal(500, 'server_error', 'Something went wrong on the server.') });
    await user.click(await detail.findByRole('button', { name: 'Save to applications' }));
    expect(await detail.findByRole('alert')).toHaveTextContent('Something went wrong on the server.');
    expect(tracker.ids()).toEqual([]);

    server.routes['POST /api/applications'] = tracker.routes['POST /api/applications'];
    await user.click(detail.getByRole('button', { name: 'Save to applications' }));
    expect(await detail.findByRole('status')).toHaveTextContent('Saved.');
    expect(detail.queryByRole('alert')).not.toBeInTheDocument();
  });
});
