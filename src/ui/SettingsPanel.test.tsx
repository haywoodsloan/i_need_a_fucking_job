/** The panel behind the gear: which boards, companies and industries to search, and which search server to use. */
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { BOARDS, DEFAULT_BOARDS } from '../jobs/boards';
import { INDUSTRIES } from '../jobs/catalog';
import type { ClientSettings } from '../jobs/client';
import { fakeServer, held, type Route } from '../testing/fakeServer';
import { SettingsPanel } from './SettingsPanel';

const START: ClientSettings = { boards: DEFAULT_BOARDS, companies: [], industries: [], allowScraping: false, apiUrl: '' };
const SERVER = 'https://search.example.test';

/** The four parts of the panel. Each folds away under a heading, and only the job boards start unfolded. */
type Part = 'Job boards' | 'Companies and industries' | 'Direct site access' | 'Search server';

/** The heading of a part. Its name ends with what is chosen inside, and pressing it unfolds or folds the part. */
const heading = (part: Part) => screen.getByRole('button', { name: new RegExp(`^${part}`) });

/**
 * The panel with the settings kept the way the search page keeps them. `current()` is what a search would use now.
 * Pass a part to have it unfolded before the test goes on.
 */
async function open(initial: Partial<ClientSettings> = {}, routes: Record<string, Route> = {}, unfold?: Part) {
  let latest = { ...START, ...initial };
  const onClose = vi.fn();
  function Holder() {
    const [settings, setSettings] = useState(latest);
    latest = settings;
    return <SettingsPanel settings={settings} setSettings={setSettings} onClose={onClose} />;
  }
  const server = fakeServer(routes);
  const user = userEvent.setup();
  const page = render(<Holder />);
  if (unfold) await user.click(heading(unfold));
  return { user, server, onClose, page, current: () => latest };
}

describe('the parts of the panel', () => {
  it('shows the job boards, and keeps the rest folded under headings that say what is chosen inside', async () => {
    await open({ boards: ['linkedin', 'dice'], companies: ['boeing', 'custom:Acme Robotics'], industries: ['Aerospace & Aviation'], allowScraping: true });

    const headings = screen.getAllByRole('heading', { level: 3 }).map((h) => within(h).getByRole('button'));
    expect(headings.map((h) => h.getAttribute('aria-expanded'))).toEqual(['true', 'false', 'false', 'false']);
    expect(heading('Job boards')).toHaveAccessibleName(`Job boards 2 of ${BOARDS.length} selected`);
    expect(heading('Companies and industries')).toHaveAccessibleName('Companies and industries Experimental 2 companies, 1 industry');
    expect(heading('Direct site access')).toHaveAccessibleName('Direct site access Experimental On');
    expect(heading('Search server')).toHaveAccessibleName('Search server Not set. Most job boards are unavailable.');

    // What is folded is not on the page at all, so the panel is as short as what is open.
    expect(screen.getAllByRole('checkbox')).toHaveLength(BOARDS.length);
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Search server URL')).not.toBeInTheDocument();
  });

  it('says so when nothing is chosen in a part', async () => {
    await open({ boards: [] });
    expect(heading('Job boards')).toHaveAccessibleName(`Job boards 0 of ${BOARDS.length} selected`);
    expect(heading('Companies and industries')).toHaveAccessibleName('Companies and industries Experimental None chosen');
    expect(heading('Direct site access')).toHaveAccessibleName('Direct site access Experimental Off');
  });

  it('counts one of a thing as one, and leaves out the kind that has none', async () => {
    const { page } = await open({ companies: ['boeing'] });
    expect(heading('Companies and industries')).toHaveAccessibleName('Companies and industries Experimental 1 company');
    page.unmount();

    await open({ industries: ['Defense', 'Government'] });
    expect(heading('Companies and industries')).toHaveAccessibleName('Companies and industries Experimental 2 industries');
  });

  it('keeps a heading true while choices are made under it', async () => {
    const { user } = await open({}, {}, 'Companies and industries');
    await user.click(screen.getByRole('checkbox', { name: /^Monster/ }));
    expect(heading('Job boards')).toHaveAccessibleName(`Job boards ${DEFAULT_BOARDS.length + 1} of ${BOARDS.length} selected`);

    await user.click(screen.getByRole('checkbox', { name: 'Defense' }));
    await user.type(screen.getByRole('combobox'), 'boe{Enter}');
    expect(heading('Companies and industries')).toHaveAccessibleName('Companies and industries Experimental 1 company, 1 industry');
  });

  it('unfolds a part from its heading, and folds it again', async () => {
    const { user } = await open();
    const access = () => screen.queryByRole('checkbox', { name: 'Use direct site access when the server supports it' });
    expect(access()).not.toBeInTheDocument();

    await user.click(heading('Direct site access'));
    expect(heading('Direct site access')).toHaveAttribute('aria-expanded', 'true');
    expect(access()).toBeInTheDocument();

    await user.click(heading('Direct site access'));
    expect(access()).not.toBeInTheDocument();

    await user.click(heading('Job boards'));
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
  });

  it('opens the way it was left', async () => {
    const { user, page } = await open();
    await user.click(heading('Job boards'));
    await user.click(heading('Search server'));
    page.unmount();

    await open();
    expect(heading('Job boards')).toHaveAttribute('aria-expanded', 'false');
    expect(heading('Search server')).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByLabelText('Search server URL')).toBeInTheDocument();
  });

  it('has nothing to choose that is a switch to press in and out, with every part unfolded', async () => {
    // Sloan asked for this (docs/decisions/0018-search-options-are-fields-and-lists-not-pills.md).
    const { user } = await open({ companies: ['boeing', 'custom:Acme Robotics'], industries: ['Defense'] });
    for (const part of ['Companies and industries', 'Direct site access', 'Search server'] as const) await user.click(heading(part));

    expect(document.querySelector('[aria-pressed]')).toBeNull();
    // Every choice is a tick in a list. The only buttons are the headings, and the ones that remove, save and close.
    expect(screen.getAllByRole('checkbox')).toHaveLength(BOARDS.length + INDUSTRIES.length + 1);
    const buttons = screen.getAllByRole('button').filter((b) => !b.hasAttribute('aria-expanded'));
    expect(buttons.map((b) => b.getAttribute('aria-label') ?? b.textContent)).toEqual(['Close settings', 'Remove Boeing', 'Remove Acme Robotics', 'Save']);
  });
});

describe('choosing job boards', () => {
  it('lists every board with what it is for, ticked if it is searched', async () => {
    await open({ boards: ['linkedin', 'dice'] });
    expect(screen.getAllByRole('checkbox')).toHaveLength(BOARDS.length);
    expect(screen.getByRole('checkbox', { name: 'LinkedIn Largest professional network and job board' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: /^Dice/ })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: /^Indeed/ })).not.toBeChecked();
  });

  it('adds a board when it is ticked and drops it when it is unticked', async () => {
    const { user, current } = await open({ boards: ['linkedin'] });
    await user.click(screen.getByRole('checkbox', { name: /^Monster/ }));
    expect(current().boards).toEqual(['linkedin', 'monster']);
    await user.click(screen.getByRole('checkbox', { name: /^LinkedIn/ }));
    expect(current().boards).toEqual(['monster']);
  });
});

describe('choosing companies', () => {
  const companies = (initial: Partial<ClientSettings> = {}) => open(initial, {}, 'Companies and industries');
  const box = () => screen.getByRole('combobox', { name: 'Add a company' });
  /** The companies chosen so far, as the panel lists them: the name, then how the company is searched. */
  const picked = () =>
    within(screen.getByRole('list', { name: 'Companies to search' }))
      .getAllByRole('listitem')
      .map((item) => item.textContent!.replace('✕', '').trim());

  it('offers the catalog companies that match what is typed, and adds the one picked with Enter', async () => {
    const { user, current } = await companies();
    expect(screen.queryByRole('list', { name: 'Companies to search' })).not.toBeInTheDocument();

    await user.type(box(), 'boe');
    const options = within(screen.getByRole('listbox')).getAllByRole('option');
    expect(options[0]).toHaveTextContent('Boeing');
    expect(options[0]).toHaveTextContent('Workday');
    expect(options[0]).toHaveAttribute('aria-selected', 'true');

    await user.keyboard('{Enter}');

    expect(current().companies).toEqual(['boeing']);
    expect(picked()).toEqual(['Boeing Workday']);
    expect(box()).toHaveValue('');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('moves through the offers with the arrow keys', async () => {
    const { user, current } = await companies();
    await user.type(box(), 'aviation');
    const names = within(screen.getByRole('listbox')).getAllByRole('option').map((o) => o.firstElementChild!.textContent);
    expect(names.length).toBeGreaterThan(2);

    await user.keyboard('{ArrowDown}{ArrowDown}{ArrowUp}');
    expect(within(screen.getByRole('listbox')).getAllByRole('option')[1]).toHaveAttribute('aria-selected', 'true');
    await user.keyboard('{Enter}');

    expect(picked()[0]).toContain(names[1]);
    expect(current().companies).toHaveLength(1);
  });

  it('offers to look up a company that is not in the catalog', async () => {
    const { user, current } = await companies();
    await user.type(box(), 'Acme Robotics');
    const offer = within(screen.getByRole('listbox')).getByRole('option', { name: /Add "Acme Robotics"/ });
    expect(offer).toHaveTextContent('look up automatically');

    await user.click(offer);

    expect(current().companies).toEqual(['custom:Acme Robotics']);
    expect(picked()).toEqual(['Acme Robotics Looked up automatically']);
  });

  it('does not offer a lookup for one letter, or for a name the catalog already has', async () => {
    const { user } = await companies();
    await user.type(box(), 'x');
    expect(screen.queryByRole('option', { name: /Add "/ })).not.toBeInTheDocument();

    await user.clear(box());
    await user.type(box(), 'boeing');
    expect(screen.getByRole('option', { name: /Boeing/ })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: /Add "/ })).not.toBeInTheDocument();
  });

  it('does not offer a company that is already chosen, and never adds one twice', async () => {
    const { user, current } = await companies({ companies: ['boeing', 'custom:Acme Robotics'] });
    await user.type(box(), 'boeing');
    expect(screen.queryByRole('option', { name: /^Boeing/ })).not.toBeInTheDocument();

    await user.clear(box());
    await user.type(box(), 'Acme Robotics{Enter}');
    expect(current().companies).toEqual(['boeing', 'custom:Acme Robotics']);
  });

  it('lists the chosen companies one to a row, each with a button that removes it', async () => {
    const { user, current } = await companies({ companies: ['boeing', 'custom:Acme Robotics'] });
    expect(picked()).toEqual(['Boeing Workday', 'Acme Robotics Looked up automatically']);

    await user.click(screen.getByRole('button', { name: 'Remove Boeing' }));
    expect(current().companies).toEqual(['custom:Acme Robotics']);
    expect(picked()).toEqual(['Acme Robotics Looked up automatically']);

    await user.click(screen.getByRole('button', { name: 'Remove Acme Robotics' }));
    expect(current().companies).toEqual([]);
    expect(screen.queryByRole('list', { name: 'Companies to search' })).not.toBeInTheDocument();
  });

  it('closes the list of offers with Escape, and leaves the panel open', async () => {
    const { user, onClose } = await companies();
    await user.type(box(), 'boe');
    expect(screen.getByRole('listbox')).toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe('choosing industries and direct site access', () => {
  it('lists every industry, and includes one when it is ticked', async () => {
    const { user, current } = await open({}, {}, 'Companies and industries');
    const industries = within(screen.getByRole('group', { name: 'Industries' }));
    expect(industries.getAllByRole('checkbox')).toHaveLength(INDUSTRIES.length);
    const aviation = industries.getByRole('checkbox', { name: 'Aerospace & Aviation' });
    expect(aviation).not.toBeChecked();

    await user.click(aviation);
    expect(current().industries).toEqual(['Aerospace & Aviation']);
    expect(aviation).toBeChecked();

    await user.click(aviation);
    expect(current().industries).toEqual([]);
  });

  it('leaves direct site access off until it is asked for', async () => {
    const { user, current } = await open({}, {}, 'Direct site access');
    const toggle = screen.getByRole('checkbox', { name: 'Use direct site access when the server supports it' });
    expect(toggle).not.toBeChecked();

    await user.click(toggle);
    expect(current().allowScraping).toBe(true);
    expect(heading('Direct site access')).toHaveAccessibleName('Direct site access Experimental On');
  });
});

describe('the search server', () => {
  const health = (sources: object) => ({ ok: true, sources: { googleJobs: null, usajobs: false, linkedinGuest: false, playwright: false, ...sources } });

  it('warns that most boards are out of reach while none is set, even while its part is folded', async () => {
    const { user, server } = await open();
    expect(heading('Search server')).toHaveAccessibleName('Search server Not set. Most job boards are unavailable.');

    await user.click(heading('Search server'));
    expect(screen.getByText('No search server set. Most job boards are unavailable until one is connected.')).toBeInTheDocument();
    expect(server.calls).toEqual([]);
  });

  it('says that it is asking, then that the server is connected, without being unfolded', async () => {
    const answer = held<object>();
    await open({ apiUrl: SERVER }, { 'GET /api/health': () => answer.answer });
    expect(heading('Search server')).toHaveAccessibleName('Search server Checking…');

    answer.release(health({}));
    await waitFor(() => expect(heading('Search server')).toHaveAccessibleName('Search server Connected'));
  });

  it('says what a connected server can reach', async () => {
    await open({ apiUrl: SERVER }, { 'GET /api/health': () => health({ googleJobs: 'jsearch', linkedinGuest: true }) }, 'Search server');
    const notice = await screen.findByText(/^Connected\./);
    expect(notice).toHaveTextContent('Connected. Google for Jobs: jsearch · USAJOBS: no key set · LinkedIn pages: on · Indeed browser: off');
    expect(screen.getByLabelText('Search server URL')).toHaveValue(SERVER);
  });

  it('says so when the server does not answer as a search server', async () => {
    const { user } = await open({ apiUrl: SERVER }, { 'GET /api/health': () => new Response('Not found', { status: 404 }) });
    await waitFor(() => expect(heading('Search server')).toHaveAccessibleName("Search server Can't reach the server"));

    await user.click(heading('Search server'));
    expect(screen.getByText("Can't reach the server: Server answered 404")).toBeInTheDocument();
  });

  it('uses a new address only once it is saved, without the spaces around it, and checks it at once', async () => {
    const { user, server, current } = await open({}, { 'GET /api/health': () => health({ usajobs: true }) }, 'Search server');
    await user.type(screen.getByLabelText('Search server URL'), `  ${SERVER}  `);
    expect(current().apiUrl).toBe('');
    expect(server.calls).toEqual([]);

    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(current().apiUrl).toBe(SERVER);
    expect(await screen.findByText(/^Connected\./)).toHaveTextContent('USAJOBS: on');
    expect(server.sent('GET /api/health')[0].origin).toBe(SERVER);
    expect(screen.queryByText(/No search server set/)).not.toBeInTheDocument();
  });
});

describe('closing the panel', () => {
  it('happens with the close button, the Escape key, or a click outside it', async () => {
    const { user, onClose } = await open();
    await user.click(screen.getByRole('button', { name: 'Close settings' }));
    expect(onClose).toHaveBeenCalledTimes(1);

    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(2);

    await user.click(document.querySelector('.drawer-backdrop')!);
    expect(onClose).toHaveBeenCalledTimes(3);
  });

  it('stops listening for Escape once it is closed', async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    fakeServer({});
    const { unmount } = render(<SettingsPanel settings={START} setSettings={() => {}} onClose={onClose} />);
    unmount();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(onClose).not.toHaveBeenCalled());
  });
});
