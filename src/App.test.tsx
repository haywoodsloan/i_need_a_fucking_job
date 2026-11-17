/** The app as a whole: getting from page to page, and what it shows depending on who is signed in. */
import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, onTestFinished } from 'vitest';
import basicResume from '../test/fixtures/resumes/basic.txt?raw';
import { buildTextSource } from './resume/extract';
import { parseResume } from './resume/parse';
import { SAM, openApp } from './testing/openApp';

const nav = () => within(screen.getByRole('navigation', { name: 'Main' }));
const current = () => nav().getAllByRole('link').find((a) => a.getAttribute('aria-current') === 'page')?.textContent;

describe('getting around', () => {
  it('opens on the search page, with the resume page one click away', async () => {
    const { user } = openApp('');
    expect(screen.getByRole('heading', { level: 1, name: 'Job Hunt' })).toBeInTheDocument();
    expect(current()).toBe('Find jobs');

    await user.click(nav().getByRole('link', { name: 'My resume' }));
    expect(await screen.findByRole('heading', { name: 'Add your resume' })).toBeInTheDocument();
    expect(current()).toBe('My resume');

    await user.click(screen.getByRole('link', { name: 'Job Hunt' }));
    expect(await screen.findByLabelText('Role')).toBeInTheDocument();
    expect(current()).toBe('Find jobs');
  });

  it('opens the page named in the address, and the search page for an address it does not know', async () => {
    openApp('/resume');
    expect(screen.getByRole('heading', { name: 'Add your resume' })).toBeInTheDocument();

    window.location.hash = '#/no-such-page';
    expect(await screen.findByLabelText('Role')).toBeInTheDocument();
  });

  it('still has the resume on the next visit, because it is kept in this browser', () => {
    const resume = parseResume(buildTextSource(basicResume, { fileName: 'jordan-rivera.txt', mimeType: 'text/plain', kind: 'text', sha256: 'x' }));
    localStorage.setItem('resume:v1', JSON.stringify(resume));
    openApp('/resume');
    expect(screen.getByText('jordan-rivera.txt')).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Extracted fields' })).toHaveTextContent('Jordan A. Rivera');
  });
});

describe('the link to the account', () => {
  it('is "Sign in" for someone signed out', async () => {
    openApp('', { account: SAM });
    expect(await nav().findByRole('link', { name: 'Sign in' })).toHaveAttribute('href', '#/sign-in');
    expect(nav().queryByRole('link', { name: 'Account' })).not.toBeInTheDocument();
  });

  it('is "Account" for someone signed in', async () => {
    openApp('', { account: SAM, signedIn: true });
    expect(await nav().findByRole('link', { name: 'Account' })).toHaveAttribute('href', '#/account');
    expect(nav().queryByRole('link', { name: 'Sign in' })).not.toBeInTheDocument();
  });

  it('is not there at all where the server has accounts switched off', async () => {
    const { server } = openApp('', { available: false });
    await waitFor(() => expect(server.sent('GET /api/auth/session')).toHaveLength(1));
    expect(nav().getAllByRole('link').map((a) => a.textContent)).toEqual(['Find jobs', 'My resume']);
  });

  it('is marked as the current page on every account page', async () => {
    openApp('/recover', { account: SAM });
    expect(await nav().findByRole('link', { name: 'Sign in' })).toHaveAttribute('aria-current', 'page');
  });
});

describe('when accounts cannot be used', () => {
  it('says the server has them switched off, and how they are turned on', async () => {
    openApp('/sign-in', { available: false });
    expect(await screen.findByText('Accounts are switched off on this server.')).toBeInTheDocument();
    expect(screen.getByText(/npm run admin -- setup/)).toBeInTheDocument();
    expect(screen.queryByLabelText('Email')).not.toBeInTheDocument();
  });

  it('says the server could not be reached, and asks again when told to', async () => {
    const notTheServer = () => new Response('<!doctype html><title>Job Hunt</title>', { status: 404, headers: { 'content-type': 'text/html' } });
    const { user, server } = openApp('/sign-in', { account: SAM }, { 'GET /api/auth/session': notTheServer });
    expect(await screen.findByText('The app could not reach its server.')).toBeInTheDocument();

    server.routes['GET /api/auth/session'] = () => ({ available: true, user: null });
    await user.click(screen.getByRole('button', { name: 'Try again' }));

    expect(await screen.findByLabelText('Email')).toBeInTheDocument();
    expect(screen.queryByText('The app could not reach its server.')).not.toBeInTheDocument();
  });

  it('says it is checking while the server has not answered yet', async () => {
    let answer!: (reply: object) => void;
    openApp('/account', { account: SAM }, { 'GET /api/auth/session': () => new Promise((resolve) => (answer = resolve)) });
    expect(screen.getByRole('status')).toHaveTextContent('Checking who is signed in…');
    await waitFor(() => expect(answer).toBeDefined());
    answer({ available: true, user: null });
    expect(await screen.findByText('Sign in to see your account.')).toBeInTheDocument();
  });
});

describe('with the app open in two tabs', () => {
  const otherTab = () => {
    const channel = new BroadcastChannel('job-hunt-account');
    onTestFinished(() => channel.close());
    return channel;
  };

  it('notices here a sign-out made in the other tab', async () => {
    const { state } = openApp('', { account: SAM, signedIn: true });
    await nav().findByRole('link', { name: 'Account' });

    state.signedIn = false;
    otherTab().postMessage('changed');

    expect(await nav().findByRole('link', { name: 'Sign in' })).toBeInTheDocument();
  });

  it('tells the other tab when this one signs out', async () => {
    const heard: unknown[] = [];
    otherTab().onmessage = (e) => heard.push(e.data);
    const { user } = openApp('/account', { account: SAM, signedIn: true });

    await screen.findByText(/Signed in as/);
    // The first "Sign out" is the one for this browser, at the top of the page. The others are in the list of sessions.
    await user.click(screen.getAllByRole('button', { name: 'Sign out' })[0]);

    await waitFor(() => expect(heard).toEqual(['changed']));
    expect(await nav().findByRole('link', { name: 'Sign in' })).toBeInTheDocument();
  });
});
