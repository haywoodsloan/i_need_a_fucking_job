/** The search page, used the way a person uses it: type a role, search, read the results. */
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import basicResume from '../../test/fixtures/resumes/basic.txt?raw';
import { DEFAULT_BOARDS } from '../jobs/boards';
import type { JobPosting, JobQuery, SearchResponse, SourceStatus } from '../jobs/types';
import { buildTextSource } from '../resume/extract';
import { listFields, updateField } from '../resume/model';
import { parseResume } from '../resume/parse';
import { fakeServer, held, refusal, type Route } from '../testing/fakeServer';
import { SearchPage } from './SearchPage';

const SERVER = 'https://search.example.test';
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000 - 60_000).toISOString();

const job = (over: Partial<JobPosting> = {}): JobPosting => ({
  id: 'greenhouse:acme:1',
  title: 'Software Engineer',
  company: 'Acme',
  location: 'Austin, TX',
  workplace: 'hybrid',
  postedAt: daysAgo(3),
  salary: { min: 120_000, max: 150_000, currency: 'USD', period: 'year' },
  descriptionHtml: '<p>Build services in <b>Go</b> on Kubernetes.</p>',
  descriptionText: 'Build services in Go on Kubernetes.',
  listings: [{ sourceId: 'greenhouse', via: 'Acme', url: 'https://boards.greenhouse.io/acme/jobs/1' }],
  ...over,
});
const source = (over: Partial<SourceStatus> = {}): SourceStatus => ({ sourceId: 'company:acme', label: 'Acme (greenhouse)', ok: true, count: 1, ms: 120, ...over });
const found = (jobs: JobPosting[], sources: SourceStatus[] = [source({ count: jobs.length })]): SearchResponse => ({ jobs, sources });

/** The page as someone sees it who has a search server set, which is how the app runs locally. */
function open(routes: Record<string, Route>, resume: Parameters<typeof SearchPage>[0]['resume'] = null) {
  localStorage.setItem('search-settings:v1', JSON.stringify({ boards: DEFAULT_BOARDS, companies: [], industries: [], allowScraping: false, apiUrl: SERVER }));
  const server = fakeServer(routes);
  const user = userEvent.setup();
  const page = render(<SearchPage resume={resume} />);
  return { server, user, page };
}

type User = ReturnType<typeof userEvent.setup>;

async function search(user: User, role = 'software engineer') {
  await user.type(screen.getByLabelText('Role'), role);
  await user.click(screen.getByRole('button', { name: 'Search' }));
}

/** The workplace field. Its name ends with what is chosen: "Workplace Any", "Workplace Remote, Hybrid". */
const workplace = () => screen.getByRole('button', { name: /^Workplace/ });

/** Opens the list behind the workplace field, ticks or unticks each of `names`, and closes the list again. */
async function tickWorkplace(user: User, ...names: string[]) {
  await user.click(workplace());
  for (const name of names) await user.click(screen.getByRole('checkbox', { name }));
  await user.keyboard('{Escape}');
}

describe('before a search', () => {
  it('is one box, with the filters appearing once a role is typed', async () => {
    const { user } = open({});
    expect(screen.getByRole('heading', { name: 'Job Hunt' })).toBeInTheDocument();
    expect(screen.getByLabelText('Role')).toHaveFocus();
    expect(screen.queryByLabelText('Location')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Search' })).not.toBeInTheDocument();

    await user.type(screen.getByLabelText('Role'), 'p');

    expect(screen.getByLabelText('Location')).toHaveValue('');
    expect(screen.getByLabelText('Within')).toHaveDisplayValue('25 mi');
    expect(workplace()).toHaveAccessibleName('Workplace Any');
    expect(screen.getByLabelText('Posted')).toHaveDisplayValue('Any time');
    expect(screen.getByRole('button', { name: 'Search' })).toBeEnabled();
  });

  it('has each filter as a field with its name over it, and none as a switch to press in and out', async () => {
    // Sloan asked for this (docs/decisions/0018-search-options-are-fields-and-lists-not-pills.md).
    const { user } = open({});
    await user.type(screen.getByLabelText('Role'), 'pilot');
    const box = within(screen.getByRole('search'));
    for (const name of ['Location', 'Within', 'Workplace', 'Posted']) expect(box.getByText(name)).toBeInTheDocument();

    // The workplaces are a list of ticks behind their field, where they were three buttons side by side.
    await user.click(workplace());
    const list = within(box.getByRole('group', { name: 'Workplace' }));
    expect(list.getAllByRole('checkbox')).toHaveLength(3);
    for (const name of ['Remote', 'Hybrid', 'On-site']) expect(list.getByRole('checkbox', { name })).not.toBeChecked();
    expect(document.querySelector('[aria-pressed]')).toBeNull();
  });

  it('does not search for a role that is only spaces', async () => {
    const { user, server } = open({});
    await search(user, '   ');
    expect(server.calls).toEqual([]);
    expect(screen.getByRole('heading', { name: 'Job Hunt' })).toBeInTheDocument();
  });

  it('has no place to type in a remote-only search, because the place does not matter', async () => {
    const { user } = open({});
    await user.type(screen.getByLabelText('Role'), 'pilot');
    await user.type(screen.getByLabelText('Location'), 'Austin, TX');
    expect(screen.getByLabelText('Within')).toBeEnabled();

    await tickWorkplace(user, 'Remote');
    expect(workplace()).toHaveAccessibleName('Workplace Remote');
    expect(screen.getByLabelText('Location')).toBeDisabled();
    expect(screen.getByLabelText('Location')).toHaveAttribute('placeholder', 'Anywhere');
    expect(screen.getByLabelText('Within')).toBeDisabled();

    await tickWorkplace(user, 'Hybrid');
    expect(workplace()).toHaveAccessibleName('Workplace Remote, Hybrid');
    expect(screen.getByLabelText('Location')).toBeEnabled();
  });

  it('remembers the last search for the next visit', async () => {
    const { user, page } = open({});
    await user.type(screen.getByLabelText('Role'), 'air traffic controller');
    await tickWorkplace(user, 'On-site');
    page.unmount();

    render(<SearchPage resume={null} />);
    expect(screen.getByLabelText('Role')).toHaveValue('air traffic controller');
    expect(workplace()).toHaveAccessibleName('Workplace On-site');
  });
});

describe('searching', () => {
  it('sends the role without stray spaces, the filters that were set, and where to search', async () => {
    const { user, server } = open({ 'POST /api/search': () => found([]) });
    await user.type(screen.getByLabelText('Role'), ' software engineer ');
    await user.type(screen.getByLabelText('Location'), 'Austin, TX');
    await user.selectOptions(screen.getByLabelText('Within'), '50 mi');
    await tickWorkplace(user, 'Hybrid');
    await user.selectOptions(screen.getByLabelText('Posted'), 'Past week');
    await user.click(screen.getByRole('button', { name: 'Search' }));

    await screen.findByText(/No jobs found/);
    expect(server.sent('POST /api/search')).toHaveLength(1);
    expect(server.calls[0].origin).toBe(SERVER);
    expect(server.calls[0].body).toEqual({
      query: { role: 'software engineer', location: 'Austin, TX', distanceMiles: 50, workplace: ['hybrid'], postedWithinDays: 7 },
      settings: { boards: DEFAULT_BOARDS, companies: [], industries: [], allowScraping: false },
    });
  });

  it('asks for any workplace until some are ticked, then for each one that is', async () => {
    const { user, server } = open({ 'POST /api/search': () => found([]) });
    await search(user, 'pilot');
    await screen.findByText(/No jobs found/);

    await tickWorkplace(user, 'On-site', 'Remote');
    await user.click(screen.getByRole('button', { name: 'Search' }));

    await waitFor(() => expect(server.sent('POST /api/search')).toHaveLength(2));
    const asked = server.sent('POST /api/search').map((call) => (call.body as { query: JobQuery }).query.workplace);
    expect(asked).toEqual([[], ['remote', 'onsite']]);
  });

  it('can be started with the Enter key', async () => {
    const { user, server } = open({ 'POST /api/search': () => found([]) });
    await user.type(screen.getByLabelText('Role'), 'pilot{Enter}');
    await screen.findByText(/No jobs found/);
    expect(server.sent('POST /api/search')).toHaveLength(1);
  });

  it('says it is searching, and does not start a second search on top of the first', async () => {
    const reply = held<SearchResponse>();
    const { user, server } = open({ 'POST /api/search': () => reply.answer });
    await search(user);

    expect(await screen.findByText('Searching…', { selector: '.empty' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Searching…' })).toBeDisabled();
    await user.type(screen.getByLabelText('Role'), '{Enter}');
    expect(server.sent('POST /api/search')).toHaveLength(1);

    reply.release(found([job()]));
    expect(await screen.findByRole('listbox', { name: '1 job' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Search' })).toBeEnabled();
  });

  it("shows why a search failed in the server's words, and lets it be tried again", async () => {
    const { user, server } = open({ 'POST /api/search': () => refusal(429, 'rate_limited', 'Too many searches. Try again in a few minutes.') });
    await search(user);
    expect(await screen.findByText('Search failed: Too many searches. Try again in a few minutes.')).toBeInTheDocument();

    server.routes['POST /api/search'] = () => found([job()]);
    await user.click(screen.getByRole('button', { name: 'Search' }));
    expect(await screen.findByRole('listbox', { name: '1 job' })).toBeInTheDocument();
    expect(screen.queryByText(/Search failed/)).not.toBeInTheDocument();
  });
});

describe('the results', () => {
  const second = job({ id: 'lever:globex:9', title: 'Staff Engineer', company: 'Globex', location: undefined, workplace: 'remote', postedAt: daysAgo(45), salary: { min: 95, period: 'hour' }, listings: [{ sourceId: 'google-jobs', via: 'LinkedIn', url: 'https://www.linkedin.com/jobs/view/9' }, { sourceId: 'lever', via: 'Globex', url: 'https://jobs.lever.co/globex/9' }] });

  it('lists every posting with what a person needs to tell them apart', async () => {
    const { user } = open({ 'POST /api/search': () => found([job(), second]) });
    await search(user);

    const list = await screen.findByRole('listbox', { name: '2 jobs' });
    expect(within(list).getByText('2 jobs')).toBeInTheDocument();
    const cards = within(list).getAllByRole('option');
    expect(cards).toHaveLength(2);
    expect(cards[0]).toHaveTextContent('Software Engineer');
    expect(cards[0]).toHaveTextContent('Acme · Austin, TX');
    expect(cards[0]).toHaveTextContent('Hybrid · $120k–$150k · 3 days ago');
    expect(cards[0]).toHaveTextContent('on Acme');
    expect(cards[1]).toHaveTextContent('Staff Engineer');
    expect(cards[1]).toHaveTextContent('Remote · $95/hour · 1 mo ago');
    expect(cards[1]).toHaveTextContent('on LinkedIn, Globex');
  });

  it('opens the first posting, and any other when it is picked', async () => {
    const { user } = open({ 'POST /api/search': () => found([job(), second]) });
    await search(user);

    const first = await screen.findByRole('article', { name: 'Software Engineer' });
    expect(within(first).getByText('Build services in', { exact: false })).toBeInTheDocument();
    expect(within(first).getByText('Posted 3 days ago')).toBeInTheDocument();
    const cards = within(screen.getByRole('listbox', { name: '2 jobs' })).getAllByRole('option');
    expect(cards.map((c) => c.getAttribute('aria-selected'))).toEqual(['true', 'false']);

    await user.click(cards[1]);
    const other = screen.getByRole('article', { name: 'Staff Engineer' });
    expect(screen.queryByRole('article', { name: 'Software Engineer' })).not.toBeInTheDocument();
    expect(cards.map((c) => c.getAttribute('aria-selected'))).toEqual(['false', 'true']);

    // Every board the posting is on, each with a way to see it on that board.
    const links = within(other).getAllByRole('link', { name: 'original posting' });
    expect(links.map((a) => a.getAttribute('href'))).toEqual(['https://www.linkedin.com/jobs/view/9', 'https://jobs.lever.co/globex/9']);
    for (const a of links) {
      expect(a).toHaveAttribute('target', '_blank');
      expect(a).toHaveAttribute('rel', 'noopener noreferrer nofollow');
    }

    await user.click(within(other).getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('article')).not.toBeInTheDocument();
  });

  it('counts a single job as one job', async () => {
    const { user } = open({ 'POST /api/search': () => found([job()]) });
    await search(user);
    expect(within(await screen.findByRole('listbox', { name: '1 job' })).getByText('1 job')).toBeInTheDocument();
  });

  it('says so when nothing was found, and which sources were not searched at all', async () => {
    const sources = [
      source({ sourceId: 'google-jobs', label: 'Google for Jobs', ok: false, count: 0, skipped: 'needs JSEARCH_API_KEY or SERPAPI_KEY on the server' }),
      source({ sourceId: 'usajobs', label: 'USAJOBS', ok: false, count: 0, skipped: 'needs USAJOBS_API_KEY on the server' }),
    ];
    const { user } = open({ 'POST /api/search': () => found([], sources) });
    await search(user);

    expect(await screen.findByText(/No jobs found\./)).toBeInTheDocument();
    expect(screen.getByText('2 sources were skipped: Google for Jobs (needs JSEARCH_API_KEY or SERPAPI_KEY on the server); USAJOBS (needs USAJOBS_API_KEY on the server).')).toBeInTheDocument();
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('shows a posting with no description, salary or date without making any up', async () => {
    const bare = job({ descriptionHtml: undefined, descriptionText: undefined, salary: undefined, postedAt: undefined, workplace: undefined, location: undefined });
    const { user } = open({ 'POST /api/search': () => found([bare]) });
    await search(user);

    const detail = await screen.findByRole('article', { name: 'Software Engineer' });
    expect(within(detail).getByText('No description provided by this source.')).toBeInTheDocument();
    expect(within(detail).queryByText(/Posted/)).not.toBeInTheDocument();
    expect(detail.querySelector('.facts')).toHaveTextContent(/^Acme$/);
  });
});

describe('how the sources did', () => {
  const sources = [
    source({ count: 1 }),
    source({ sourceId: 'linkedin-guest', label: 'LinkedIn', ok: false, count: 0, blocked: true, error: 'www.linkedin.com turned this server away as automated traffic (999)' }),
    source({ sourceId: 'remoteok', label: 'Remote OK', ok: false, count: 0, error: 'remoteok.com answered 500' }),
    source({ sourceId: 'usajobs', label: 'USAJOBS', ok: false, count: 0, skipped: 'needs USAJOBS_API_KEY on the server' }),
    source({ sourceId: 'company:globex', label: 'Globex (lever)', count: 12, ms: 300 }),
  ];

  /** Searches, and gives the line under the search box that says how the sources did. */
  async function searched(answered: SourceStatus[], jobs = [job()]) {
    const { user } = open({ 'POST /api/search': () => found(jobs, answered) });
    await search(user);
    const report = await screen.findByRole('region', { name: 'Sources searched' });
    return { user, report, line: () => within(report).getByRole('button') };
  }
  /** The table behind the line, as [source, result] for each row. */
  const rows = (report: HTMLElement) =>
    within(within(report).getByRole('table'))
      .getAllByRole('row')
      .slice(1)
      .map((row) => [...row.children].map((cell) => cell.textContent));

  it('is one line: how many answered, and how many failed, were blocked or are off', async () => {
    const { report, line } = await searched(sources);
    expect(line()).toHaveTextContent('2 of 5 sources answered · 1 failed · 1 blocked · 1 off');
    expect(line()).toHaveAccessibleName('2 of 5 sources answered, 1 failed, 1 blocked, 1 off');
    expect(line()).toHaveAttribute('aria-expanded', 'false');
    expect(within(report).queryByRole('table')).not.toBeInTheDocument();
  });

  it('says so in fewer words when every source answered', async () => {
    const { line } = await searched([source(), source({ sourceId: 'usajobs', label: 'USAJOBS', count: 4 })]);
    expect(line()).toHaveAccessibleName('All 2 sources answered');
  });

  it('counts a single source as one source', async () => {
    const { line } = await searched([source({ ok: false, count: 0, error: 'boards.greenhouse.io answered 500' })]);
    expect(line()).toHaveAccessibleName('0 of 1 source answered, 1 failed');
  });

  it('opens to a table with a row for each source: what went wrong and why first, then how many jobs each found', async () => {
    const { user, report, line } = await searched(sources);
    await user.click(line());

    expect(line()).toHaveAttribute('aria-expanded', 'true');
    expect(within(report).getAllByRole('columnheader').map((h) => h.textContent)).toEqual(['Source', 'Result']);
    expect(rows(report)).toEqual([
      ['Remote OK', 'Failed remoteok.com answered 500'],
      ['LinkedIn', 'Blocked www.linkedin.com turned this server away as automated traffic (999)'],
      ['USAJOBS', 'Off needs USAJOBS_API_KEY on the server'],
      ['Acme (greenhouse)', '1 job'],
      ['Globex (lever)', '12 jobs'],
    ]);
    expect(within(report).getByRole('cell', { name: '12 jobs' })).toHaveAttribute('title', 'Answered in 300 ms');
  });

  it('closes the table with a second press, with Escape, and with a press anywhere else', async () => {
    const { user, report, line } = await searched(sources);
    const table = () => within(report).queryByRole('table');

    await user.click(line());
    await user.click(line());
    expect(table()).not.toBeInTheDocument();

    await user.click(line());
    await user.keyboard('{Escape}');
    expect(table()).not.toBeInTheDocument();
    expect(line()).toHaveFocus();

    await user.click(line());
    await user.click(screen.getByRole('option', { name: /Software Engineer/ }));
    expect(table()).not.toBeInTheDocument();
  });

  it('says so when there was nothing to search', async () => {
    const { report } = await searched([], []);
    expect(report).toHaveTextContent('No sources were searched. Choose where to search with the gear.');
    expect(within(report).queryByRole('button')).not.toBeInTheDocument();
  });
});

describe('the description of a posting', () => {
  const partial = job({ id: 'linkedin:4100000001', descriptionHtml: undefined, descriptionText: 'A short summary…', descriptionPartial: true });

  it('is loaded in full from the server when the search only brought a summary', async () => {
    const full = held<Partial<JobPosting>>();
    const { user, server } = open({ 'POST /api/search': () => found([partial]), 'GET /api/job': () => full.answer });
    await search(user);

    const detail = await screen.findByRole('article', { name: 'Software Engineer' });
    expect(within(detail).getByText('A short summary…')).toBeInTheDocument();
    expect(within(detail).getByText('Loading full description…')).toBeInTheDocument();
    expect(server.sent('GET /api/job')[0].query).toEqual({ id: 'linkedin:4100000001' });

    full.release({ descriptionHtml: '<p>The whole description, <em>all</em> of it.</p>', descriptionText: 'The whole description, all of it.', employmentType: 'Full-time' });
    expect(await within(detail).findByText('The whole description,', { exact: false })).toBeInTheDocument();
    expect(within(detail).getByText('Full-time')).toBeInTheDocument();
    expect(within(detail).queryByText('A short summary…')).not.toBeInTheDocument();
    expect(within(detail).queryByText('Loading full description…')).not.toBeInTheDocument();
  });

  it('keeps the summary and says why when the full text cannot be loaded', async () => {
    const { user } = open({ 'POST /api/search': () => found([partial]), 'GET /api/job': () => Response.json({ error: 'LinkedIn route is disabled on this server' }, { status: 500 }) });
    await search(user);

    const detail = await screen.findByRole('article', { name: 'Software Engineer' });
    expect(await within(detail).findByText("Couldn't load the full description: LinkedIn route is disabled on this server")).toBeInTheDocument();
    expect(within(detail).getByText('A short summary…')).toBeInTheDocument();
  });

  it('is not asked for again when the search already brought all of it', async () => {
    const { user, server } = open({ 'POST /api/search': () => found([job()]) });
    await search(user);
    await screen.findByRole('article', { name: 'Software Engineer' });
    expect(server.sent('GET /api/job')).toEqual([]);
  });

  it('is shown as text and simple formatting only, whatever the job site sent', async () => {
    const hostile = job({
      descriptionHtml:
        '<h3>About</h3><p onclick="window.pwned = 1">Fly <b>planes</b>.</p><img src="x" onerror="window.pwned = 1"><script>window.pwned = 1</script>' +
        '<a href="javascript:window.pwned = 1">apply</a> <a href="https://acme.example/apply">site</a><iframe src="https://evil.example"></iframe>',
    });
    const { user } = open({ 'POST /api/search': () => found([hostile]) });
    await search(user);

    const description = (await screen.findByRole('article', { name: 'Software Engineer' })).querySelector('.desc')!;
    expect(description).toHaveTextContent('AboutFly planes.apply site');
    expect(description.querySelector('script, img, iframe, [onclick], [onerror]')).toBeNull();
    expect(within(description as HTMLElement).getByText('apply')).not.toHaveAttribute('href');
    expect(within(description as HTMLElement).getByText('site')).toHaveAttribute('href', 'https://acme.example/apply');
    expect((window as unknown as { pwned?: number }).pwned).toBeUndefined();
  });
});

describe('with a resume', () => {
  const resume = parseResume(buildTextSource(basicResume, { fileName: 'r.txt', mimeType: 'text/plain', kind: 'text', sha256: 'x' }));

  it('marks the skills from the resume that the posting names', async () => {
    const { user } = open({ 'POST /api/search': () => found([job()]) }, resume);
    await search(user);

    const detail = await screen.findByRole('article', { name: 'Software Engineer' });
    expect(within(detail).getByText(/of your resume skills appear in this posting/)).toHaveTextContent('2 of your resume skills appear in this posting (highlighted).');
    expect([...detail.querySelectorAll('mark')].map((m) => m.textContent)).toEqual(['Go', 'Kubernetes']);
  });

  it('leaves out a skill the user removed from the resume', async () => {
    const go = listFields(resume).find((f) => f.field.value === 'Go')!;
    const { user } = open({ 'POST /api/search': () => found([job()]) }, updateField(resume, go.path, { status: 'rejected' }));
    await search(user);

    const detail = await screen.findByRole('article', { name: 'Software Engineer' });
    expect([...detail.querySelectorAll('mark')].map((m) => m.textContent)).toEqual(['Kubernetes']);
  });

  it('says so when the posting names none of them', async () => {
    const { user } = open({ 'POST /api/search': () => found([job({ descriptionHtml: '<p>Fly planes.</p>', descriptionText: 'Fly planes.' })]) }, resume);
    await search(user);
    expect(await screen.findByText('None of your resume skills appear in this posting by name.')).toBeInTheDocument();
  });

  it('says nothing about skills when there is no resume', async () => {
    const { user } = open({ 'POST /api/search': () => found([job()]) });
    await search(user);
    await screen.findByRole('article', { name: 'Software Engineer' });
    expect(screen.queryByText(/resume skills/)).not.toBeInTheDocument();
  });
});

describe('the settings', () => {
  const health = { ok: true, sources: { googleJobs: null, usajobs: false, linkedinGuest: false, playwright: false } };

  it('open from the gear, close with Escape, and are used by the next search', async () => {
    const { user, server } = open({ 'GET /api/health': () => health, 'POST /api/search': () => found([]) });
    await user.click(screen.getByRole('button', { name: 'Search settings' }));
    const panel = screen.getByRole('dialog', { name: 'Search settings' });

    await user.click(within(panel).getByRole('checkbox', { name: /^Glassdoor/ }));
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

    await search(user);
    await screen.findByText(/No jobs found/);
    const sent = server.sent('POST /api/search')[0].body as { settings: { boards: string[] } };
    expect(sent.settings.boards).toEqual(DEFAULT_BOARDS.filter((b) => b !== 'glassdoor'));
  });
});
