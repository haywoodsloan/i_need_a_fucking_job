/** The signed-in user's own page: where they are signed in, their password, their recovery code, deleting the account. */
import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { PASSWORD_PROBLEM_TEXT } from '../account/api';
import { otherSession, session } from '../testing/fakeAccounts';
import { refusal } from '../testing/fakeServer';
import { SAM, openApp } from '../testing/openApp';

const NEW_PASSWORD = 'another four unrelated words';

/** The account page of someone signed in. Each test gets its own copy of the account, since tests change it. */
async function open(options: Parameters<typeof openApp>[1] = {}, routes: Parameters<typeof openApp>[2] = {}) {
  const opened = openApp('/account', { account: { ...SAM }, signedIn: true, ...options }, routes);
  await screen.findByText(/Signed in as/);
  return opened;
}
const section = (name: string) => within(screen.getByRole('region', { name }));
const nav = () => within(screen.getByRole('navigation', { name: 'Main' }));

describe('opening the account page', () => {
  it('asks someone who is signed out to sign in first', async () => {
    openApp('/account', { account: SAM });
    expect(await screen.findByText('Sign in to see your account.')).toBeInTheDocument();
    expect(screen.getByLabelText('Email')).toBeInTheDocument();
    expect(screen.queryByText(/Signed in as/)).not.toBeInTheDocument();
  });

  it('says who is signed in, and marks an administrator', async () => {
    await open({ account: { ...SAM, role: 'admin' } });
    expect(screen.getByText(/Signed in as/)).toHaveTextContent(`Signed in as ${SAM.email} Admin`);
  });

  it('does not mark an ordinary user as an administrator', async () => {
    await open();
    expect(screen.queryByText('Admin')).not.toBeInTheDocument();
  });

  it('falls back to sign in when the session turns out to have ended since the page was opened', async () => {
    const { user, state } = await open({ sessions: [session(), otherSession()] });
    const rows = await section('Where you are signed in').findAllByRole('listitem');

    // Signed out from another browser, or timed out. This page only finds out when it next asks for something.
    state.signedIn = false;
    await user.click(within(rows[1]).getByRole('button', { name: 'Sign out' }));

    expect(await screen.findByText('Sign in to see your account.')).toBeInTheDocument();
    expect(screen.queryByText(/Signed in as/)).not.toBeInTheDocument();
  });
});

describe('where you are signed in', () => {
  const both = [session(), otherSession()];

  it('names each browser, marks this one, and offers to sign out everywhere only when there is more than one', async () => {
    await open({ sessions: both });
    const rows = await section('Where you are signed in').findAllByRole('listitem');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent('Chrome on Windows');
    expect(rows[0]).toHaveTextContent('This browser');
    expect(rows[1]).toHaveTextContent('Firefox on Mac');
    expect(rows[1]).not.toHaveTextContent('This browser');
    expect(rows[1]).toHaveTextContent(/Signed in .+\. Last used .+\./);
    expect(section('Where you are signed in').getByRole('button', { name: 'Sign out everywhere' })).toBeInTheDocument();
  });

  it('has no "sign out everywhere" with only this browser signed in', async () => {
    await open();
    await section('Where you are signed in').findAllByRole('listitem');
    expect(screen.queryByRole('button', { name: 'Sign out everywhere' })).not.toBeInTheDocument();
  });

  it('signs another browser out and stays signed in here', async () => {
    const { user, server } = await open({ sessions: both });
    const rows = await section('Where you are signed in').findAllByRole('listitem');
    await user.click(within(rows[1]).getByRole('button', { name: 'Sign out' }));

    await waitFor(() => expect(section('Where you are signed in').getAllByRole('listitem')).toHaveLength(1));
    expect(server.sent('POST /api/account/sessions/end')[0].body).toEqual({ id: 's-other' });
    expect(screen.getByText(/Signed in as/)).toBeInTheDocument();
  });

  it('signs this browser out when its own row is used', async () => {
    const { user } = await open({ sessions: both });
    const rows = await section('Where you are signed in').findAllByRole('listitem');
    await user.click(within(rows[0]).getByRole('button', { name: 'Sign out' }));
    expect(await screen.findByText('Sign in to see your account.')).toBeInTheDocument();
  });

  it('signs out everywhere, this browser included', async () => {
    const { user, state } = await open({ sessions: both });
    await user.click(await section('Where you are signed in').findByRole('button', { name: 'Sign out everywhere' }));
    expect(await screen.findByText('Sign in to see your account.')).toBeInTheDocument();
    expect(state.sessions).toEqual([]);
  });

  it('says so when the list cannot be loaded', async () => {
    await open({}, { 'GET /api/account/sessions': () => refusal(500, 'server_error', 'Something went wrong on the server.') });
    expect(await section('Where you are signed in').findByRole('alert')).toHaveTextContent('Something went wrong on the server.');
    expect(section('Where you are signed in').queryByRole('list')).not.toBeInTheDocument();
  });
});

describe('changing the password', () => {
  async function change(user: Awaited<ReturnType<typeof open>>['user'], current: string, next = NEW_PASSWORD, again = next) {
    const form = section('Password');
    await user.type(form.getByLabelText('Current password'), current);
    await user.type(form.getByLabelText('New password'), next);
    await user.type(form.getByLabelText('New password, once more'), again);
    await user.click(form.getByRole('button', { name: 'Change password' }));
  }

  it('changes it, says the other browsers were signed out, and empties the form', async () => {
    const { user, server, state } = await open({ sessions: [session(), otherSession()] });
    await change(user, SAM.password);

    expect(await section('Password').findByRole('status')).toHaveTextContent('Your password is changed. Other browsers that were signed in to your account have been signed out.');
    expect(server.sent('POST /api/account/password')[0].body).toEqual({ currentPassword: SAM.password, newPassword: NEW_PASSWORD });
    expect(state.account?.password).toBe(NEW_PASSWORD);
    for (const label of ['Current password', 'New password', 'New password, once more']) expect(section('Password').getByLabelText(label)).toHaveValue('');
  });

  it("shows the server's refusal when the current password is wrong", async () => {
    const { user, state } = await open();
    await change(user, 'not my password');
    expect(await section('Password').findByRole('alert')).toHaveTextContent('That password is not correct.');
    expect(state.account?.password).toBe(SAM.password);
    expect(section('Password').queryByRole('status')).not.toBeInTheDocument();
  });

  it('checks the new password here before asking the server', async () => {
    const { user, server } = await open();
    await change(user, SAM.password, NEW_PASSWORD, 'typed differently here');
    expect(section('Password').getByRole('alert')).toHaveTextContent('The two passwords are not the same.');

    await user.clear(section('Password').getByLabelText('New password'));
    await user.type(section('Password').getByLabelText('New password'), SAM.email);
    await user.click(section('Password').getByRole('button', { name: 'Change password' }));
    expect(section('Password').getByRole('alert')).toHaveTextContent(PASSWORD_PROBLEM_TEXT.is_email);
    expect(server.sent('POST /api/account/password')).toEqual([]);
  });

  it('names the account to password managers, out of sight', async () => {
    await open();
    const hidden = document.querySelector('input[type="email"][autocomplete="username"]')!;
    expect(hidden).toHaveValue(SAM.email);
    expect(hidden).toHaveAttribute('aria-hidden', 'true');
    expect(hidden).toHaveAttribute('tabindex', '-1');
  });
});

describe('getting a new recovery code', () => {
  it('asks for the password, then shows the new code once', async () => {
    const { user, state } = await open();
    await user.click(section('Recovery code').getByRole('button', { name: 'Get a new recovery code' }));
    await user.type(section('Recovery code').getByLabelText('Your password'), SAM.password);
    await user.click(section('Recovery code').getByRole('button', { name: 'Show a new recovery code' }));

    const panel = within(await screen.findByRole('region', { name: 'Save your recovery code' }));
    expect(panel.getByTestId('recovery-code')).toHaveTextContent(state.issued[0]);
    expect(panel.getByText('This is a new code. Your old recovery code no longer works.')).toBeInTheDocument();
    expect(panel.getByRole('button', { name: 'Done' })).toBeDisabled();

    await user.click(panel.getByRole('checkbox', { name: 'I have saved my recovery code' }));
    await user.click(panel.getByRole('button', { name: 'Done' }));

    expect(screen.queryByTestId('recovery-code')).not.toBeInTheDocument();
    expect(section('Recovery code').getByRole('button', { name: 'Get a new recovery code' })).toBeInTheDocument();
  });

  it('does not hand one over for a wrong password', async () => {
    const { user, state } = await open();
    await user.click(section('Recovery code').getByRole('button', { name: 'Get a new recovery code' }));
    await user.type(section('Recovery code').getByLabelText('Your password'), 'not my password{Enter}');

    expect(await section('Recovery code').findByRole('alert')).toHaveTextContent('That password is not correct.');
    expect(state.issued).toEqual([]);
    expect(screen.queryByTestId('recovery-code')).not.toBeInTheDocument();
  });

  it('can be backed out of', async () => {
    const { user, server } = await open();
    await user.click(section('Recovery code').getByRole('button', { name: 'Get a new recovery code' }));
    await user.click(section('Recovery code').getByRole('button', { name: 'Cancel' }));
    expect(section('Recovery code').queryByLabelText('Your password')).not.toBeInTheDocument();
    expect(server.sent('POST /api/account/recovery-code')).toEqual([]);
  });
});

describe('deleting the account', () => {
  it('says what is removed and what is not, before anything is asked', async () => {
    await open();
    expect(section('Delete account').getByText(/It cannot be undone\. Your resume and search settings in this browser are not touched\./)).toBeInTheDocument();
    expect(section('Delete account').queryByLabelText('Your password')).not.toBeInTheDocument();
  });

  it('needs the password, and keeps the account when it is wrong', async () => {
    const { user, state } = await open();
    await user.click(section('Delete account').getByRole('button', { name: 'Delete my account…' }));
    await user.type(section('Delete account').getByLabelText('Your password'), 'not my password');
    await user.click(section('Delete account').getByRole('button', { name: 'Delete my account for good' }));

    expect(await section('Delete account').findByRole('alert')).toHaveTextContent('That password is not correct.');
    expect(state.account).toBeDefined();
    expect(section('Delete account').getByRole('button', { name: 'Delete my account for good' })).toBeEnabled();
  });

  it('deletes it with the right password and goes back to the search page, signed out', async () => {
    localStorage.setItem('last-query:v1', JSON.stringify({ role: 'pilot', distanceMiles: 25, workplace: [] }));
    const { user, state } = await open();
    await user.click(section('Delete account').getByRole('button', { name: 'Delete my account…' }));
    await user.type(section('Delete account').getByLabelText('Your password'), SAM.password);
    await user.click(section('Delete account').getByRole('button', { name: 'Delete my account for good' }));

    expect(await screen.findByLabelText('Role')).toHaveValue('pilot');
    expect(state.account).toBeUndefined();
    expect(await nav().findByRole('link', { name: 'Sign in' })).toBeInTheDocument();
  });

  it('can be backed out of', async () => {
    const { user, state } = await open();
    await user.click(section('Delete account').getByRole('button', { name: 'Delete my account…' }));
    await user.click(section('Delete account').getByRole('button', { name: 'Cancel' }));
    expect(section('Delete account').getByRole('button', { name: 'Delete my account…' })).toBeInTheDocument();
    expect(state.account).toBeDefined();
  });
});

describe('signing out', () => {
  it('ends the session on the server and goes back to the search page', async () => {
    const { user, server, state } = await open();
    await user.click(screen.getAllByRole('button', { name: 'Sign out' })[0]);

    expect(await screen.findByLabelText('Role')).toBeInTheDocument();
    expect(server.sent('POST /api/auth/sign-out')).toHaveLength(1);
    expect(state.signedIn).toBe(false);
    expect(await nav().findByRole('link', { name: 'Sign in' })).toBeInTheDocument();
  });
});
