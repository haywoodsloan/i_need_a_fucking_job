/** The panel behind the gear: which boards, companies and industries to search, and which search server to use. */
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { BOARDS, DEFAULT_BOARDS } from '../jobs/boards';
import type { ClientSettings } from '../jobs/client';
import { fakeServer, type Route } from '../testing/fakeServer';
import { SettingsPanel } from './SettingsPanel';

const START: ClientSettings = { boards: DEFAULT_BOARDS, companies: [], industries: [], allowScraping: false, apiUrl: '' };

/** The panel with the settings kept the way the search page keeps them. `current()` is what a search would use now. */
function open(initial: Partial<ClientSettings> = {}, routes: Record<string, Route> = {}) {
  let latest = { ...START, ...initial };
  const onClose = vi.fn();
  function Holder() {
    const [settings, setSettings] = useState(latest);
    latest = settings;
    return <SettingsPanel settings={settings} setSettings={setSettings} onClose={onClose} />;
  }
  const server = fakeServer(routes);
  const user = userEvent.setup();
  render(<Holder />);
  return { user, server, onClose, current: () => latest };
}

const chips = () => [...document.querySelectorAll('.chips')[0].querySelectorAll('.chip')].map((c) => c.textContent);

describe('choosing job boards', () => {
  it('lists every board, ticked if it is searched', () => {
    open({ boards: ['linkedin', 'dice'] });
    const boxes = screen.getAllByRole('checkbox').slice(0, BOARDS.length);
    expect(boxes).toHaveLength(BOARDS.length);
    expect(screen.getByRole('checkbox', { name: /^LinkedIn/ })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: /^Dice/ })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: /^Indeed/ })).not.toBeChecked();
  });

  it('adds a board when it is ticked and drops it when it is unticked', async () => {
    const { user, current } = open({ boards: ['linkedin'] });
    await user.click(screen.getByRole('checkbox', { name: /^Monster/ }));
    expect(current().boards).toEqual(['linkedin', 'monster']);
    await user.click(screen.getByRole('checkbox', { name: /^LinkedIn/ }));
    expect(current().boards).toEqual(['monster']);
  });
});

describe('choosing companies', () => {
  const box = () => screen.getByRole('combobox');

  it('offers the catalog companies that match what is typed, and adds the one picked with Enter', async () => {
    const { user, current } = open();
    await user.type(box(), 'boe');
    const options = within(screen.getByRole('listbox')).getAllByRole('option');
    expect(options[0]).toHaveTextContent('Boeing');
    expect(options[0]).toHaveTextContent('Workday');
    expect(options[0]).toHaveAttribute('aria-selected', 'true');

    await user.keyboard('{Enter}');

    expect(current().companies).toEqual(['boeing']);
    expect(chips()).toEqual(['BoeingWorkday✕']);
    expect(box()).toHaveValue('');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('moves through the offers with the arrow keys', async () => {
    const { user, current } = open();
    await user.type(box(), 'aviation');
    const names = within(screen.getByRole('listbox')).getAllByRole('option').map((o) => o.firstElementChild!.textContent);
    expect(names.length).toBeGreaterThan(2);

    await user.keyboard('{ArrowDown}{ArrowDown}{ArrowUp}');
    expect(within(screen.getByRole('listbox')).getAllByRole('option')[1]).toHaveAttribute('aria-selected', 'true');
    await user.keyboard('{Enter}');

    expect(chips()[0]).toContain(names[1]);
    expect(current().companies).toHaveLength(1);
  });

  it('offers to look up a company that is not in the catalog', async () => {
    const { user, current } = open();
    await user.type(box(), 'Acme Robotics');
    const offer = within(screen.getByRole('listbox')).getByRole('option', { name: /Add "Acme Robotics"/ });
    expect(offer).toHaveTextContent('look up automatically');

    await user.click(offer);

    expect(current().companies).toEqual(['custom:Acme Robotics']);
    expect(chips()).toEqual(['Acme Roboticsauto✕']);
  });

  it('does not offer a lookup for one letter, or for a name the catalog already has', async () => {
    const { user } = open();
    await user.type(box(), 'x');
    expect(screen.queryByRole('option', { name: /Add "/ })).not.toBeInTheDocument();

    await user.clear(box());
    await user.type(box(), 'boeing');
    expect(screen.getByRole('option', { name: /Boeing/ })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: /Add "/ })).not.toBeInTheDocument();
  });

  it('does not offer a company that is already chosen, and never adds one twice', async () => {
    const { user, current } = open({ companies: ['boeing', 'custom:Acme Robotics'] });
    await user.type(box(), 'boeing');
    expect(screen.queryByRole('option', { name: /^Boeing/ })).not.toBeInTheDocument();

    await user.clear(box());
    await user.type(box(), 'Acme Robotics{Enter}');
    expect(current().companies).toEqual(['boeing', 'custom:Acme Robotics']);
  });

  it('removes a company with the button on its chip', async () => {
    const { user, current } = open({ companies: ['boeing', 'custom:Acme Robotics'] });
    await user.click(screen.getByRole('button', { name: 'Remove Boeing' }));
    expect(current().companies).toEqual(['custom:Acme Robotics']);
    await user.click(screen.getByRole('button', { name: 'Remove Acme Robotics' }));
    expect(current().companies).toEqual([]);
  });

  it('closes the list of offers with Escape, and leaves the panel open', async () => {
    const { user, onClose } = open();
    await user.type(box(), 'boe');
    expect(screen.getByRole('listbox')).toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe('choosing industries and direct site access', () => {
  it('turns an industry on and off', async () => {
    const { user, current } = open();
    const chip = screen.getByRole('button', { name: 'Aerospace & Aviation' });
    expect(chip).toHaveAttribute('aria-pressed', 'false');

    await user.click(chip);
    expect(current().industries).toEqual(['Aerospace & Aviation']);
    expect(chip).toHaveAttribute('aria-pressed', 'true');

    await user.click(chip);
    expect(current().industries).toEqual([]);
  });

  it('leaves direct site access off until it is asked for', async () => {
    const { user, current } = open();
    const toggle = screen.getByRole('checkbox', { name: 'Use direct site access when the server supports it' });
    expect(toggle).not.toBeChecked();
    await user.click(toggle);
    expect(current().allowScraping).toBe(true);
  });
});

describe('the search server', () => {
  const health = (sources: object) => ({ ok: true, sources: { googleJobs: null, usajobs: false, linkedinGuest: false, playwright: false, ...sources } });

  it('warns that most boards are out of reach while none is set', () => {
    const { server } = open();
    expect(screen.getByText('No search server set. Most job boards are unavailable until one is connected.')).toBeInTheDocument();
    expect(server.calls).toEqual([]);
  });

  it('says what a connected server can reach', async () => {
    open({ apiUrl: 'https://search.example.test' }, { 'GET /api/health': () => health({ googleJobs: 'jsearch', linkedinGuest: true }) });
    const notice = await screen.findByText(/^Connected\./);
    expect(notice).toHaveTextContent('Connected. Google for Jobs: jsearch · USAJOBS: no key set · LinkedIn pages: on · Indeed browser: off');
    expect(screen.getByLabelText('Search server URL')).toHaveValue('https://search.example.test');
  });

  it('says so when the server does not answer as a search server', async () => {
    open({ apiUrl: 'https://search.example.test' }, { 'GET /api/health': () => new Response('Not found', { status: 404 }) });
    expect(await screen.findByText("Can't reach the server: Server answered 404")).toBeInTheDocument();
  });

  it('uses a new address only once it is saved, without the spaces around it, and checks it at once', async () => {
    const { user, server, current } = open({}, { 'GET /api/health': () => health({ usajobs: true }) });
    await user.type(screen.getByLabelText('Search server URL'), '  https://search.example.test  ');
    expect(current().apiUrl).toBe('');
    expect(server.calls).toEqual([]);

    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(current().apiUrl).toBe('https://search.example.test');
    expect(await screen.findByText(/^Connected\./)).toHaveTextContent('USAJOBS: on');
    expect(server.sent('GET /api/health')[0].origin).toBe('https://search.example.test');
    expect(screen.queryByText(/No search server set/)).not.toBeInTheDocument();
  });
});

describe('closing the panel', () => {
  it('happens with the close button, the Escape key, or a click outside it', async () => {
    const { user, onClose } = open();
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
