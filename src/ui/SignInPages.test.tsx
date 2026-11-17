/**
 * Getting into an account: signing in, accepting an invite, using a reset link, and recovering with the recovery
 * code. Each test opens the whole app at the page's address and uses it as a person would.
 */
import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { InviteInfo } from '../account/api';
import { PASSWORD_PROBLEM_TEXT } from '../account/api';
import { held, refusal } from '../testing/fakeServer';
import { SAM, openApp } from '../testing/openApp';

const GOOD_PASSWORD = 'four unrelated words here';
const invite: InviteInfo = { kind: 'invite', email: 'new.person@example.com', expiresAt: '2026-11-20T00:00:00.000Z' };
const reset: InviteInfo = { kind: 'reset', email: SAM.email, expiresAt: '2026-11-18T00:00:00.000Z' };

const alertText = () => screen.getByRole('alert').textContent;

describe('signing in', () => {
  it('takes the email and password to the server and opens the account page', async () => {
    const { user, server } = openApp('/sign-in', { account: SAM });
    await user.type(await screen.findByLabelText('Email'), SAM.email);
    await user.type(screen.getByLabelText('Password'), SAM.password);
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByText(/Signed in as/)).toHaveTextContent(`Signed in as ${SAM.email}`);
    expect(window.location.hash).toBe('#/account');
    expect(server.sent('POST /api/auth/sign-in')[0].body).toEqual({ email: SAM.email, password: SAM.password });
  });

  it("shows the server's refusal and stays on the page, ready for another try", async () => {
    const { user } = openApp('/sign-in', { account: SAM });
    await user.type(await screen.findByLabelText('Email'), SAM.email);
    await user.type(screen.getByLabelText('Password'), 'not the password{Enter}');

    await waitFor(() => expect(alertText()).toBe('Email or password is incorrect.'));
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeEnabled();

    await user.clear(screen.getByLabelText('Password'));
    await user.type(screen.getByLabelText('Password'), `${SAM.password}{Enter}`);
    expect(await screen.findByText(/Signed in as/)).toBeInTheDocument();
  });

  it('says how long to wait after too many tries', async () => {
    const { user } = openApp('/sign-in', { account: SAM }, { 'POST /api/auth/sign-in': () => refusal(429, 'rate_limited', 'Too many attempts. Try again in 5 minutes.', { retryAfter: 300 }) });
    await user.type(await screen.findByLabelText('Email'), SAM.email);
    await user.type(screen.getByLabelText('Password'), `${SAM.password}{Enter}`);
    await waitFor(() => expect(alertText()).toBe('Too many attempts. Try again in 5 minutes.'));
  });

  it('cannot be sent twice while the server is still answering', async () => {
    const reply = held<Response>();
    const { user, server } = openApp('/sign-in', { account: SAM }, { 'POST /api/auth/sign-in': () => reply.answer });
    await user.type(await screen.findByLabelText('Email'), SAM.email);
    await user.type(screen.getByLabelText('Password'), SAM.password);
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByRole('button', { name: 'Signing in…' })).toBeDisabled();
    reply.release(refusal(401, 'invalid_credentials', 'Email or password is incorrect.'));
    expect(await screen.findByRole('button', { name: 'Sign in' })).toBeEnabled();
    expect(server.sent('POST /api/auth/sign-in')).toHaveLength(1);
  });

  it('keeps the password hidden unless the person asks to see it', async () => {
    const { user } = openApp('/sign-in', { account: SAM });
    const password = await screen.findByLabelText('Password');
    await user.type(password, 'secret words');
    expect(password).toHaveAttribute('type', 'password');

    await user.click(screen.getByRole('button', { name: 'Show password' }));
    expect(password).toHaveAttribute('type', 'text');
    await user.click(screen.getByRole('button', { name: 'Hide password' }));
    expect(password).toHaveAttribute('type', 'password');
  });

  it('tells password managers which field is which', async () => {
    openApp('/sign-in', { account: SAM });
    expect(await screen.findByLabelText('Email')).toHaveAttribute('autocomplete', 'username');
    expect(screen.getByLabelText('Password')).toHaveAttribute('autocomplete', 'current-password');
  });

  it('leads to the recovery page for someone who forgot the password', async () => {
    const { user } = openApp('/sign-in', { account: SAM });
    await user.click(await screen.findByRole('link', { name: 'Forgot your password?' }));
    expect(await screen.findByRole('heading', { name: 'Forgot your password?' })).toBeInTheDocument();
  });

  it('goes straight to the account page for someone who is already signed in', async () => {
    openApp('/sign-in', { account: SAM, signedIn: true });
    expect(await screen.findByText(/Signed in as/)).toBeInTheDocument();
    expect(window.location.hash).toBe('#/account');
  });
});

describe('accepting an invite', () => {
  const open = () => openApp('/invite/GOOD-CODE', { links: { 'GOOD-CODE': invite } });

  it('shows whose account it is and counts the password up to the length it needs', async () => {
    const { user, server } = open();
    expect(await screen.findByRole('heading', { name: 'Create your account' })).toBeInTheDocument();
    expect(server.sent('POST /api/auth/invite')[0].body).toEqual({ code: 'GOOD-CODE' });
    const email = screen.getByLabelText('Email');
    expect(email).toHaveValue('new.person@example.com');
    expect(email).toHaveAttribute('readonly');

    const password = screen.getByLabelText('Password');
    expect(password).toHaveAccessibleDescription(/^At least 14 characters\. A few unrelated words work well/);
    await user.type(password, 'short');
    expect(password).toHaveAccessibleDescription(/^At least 14 characters, 5 so far\./);
    await user.type(password, ' but longer now');
    expect(password).toHaveAccessibleDescription('Long enough.');
    expect(password).toHaveAttribute('autocomplete', 'new-password');
  });

  it.each([
    ['is too short', 'too short', 'too short', PASSWORD_PROBLEM_TEXT.too_short],
    ['is the email address', invite.email, invite.email, PASSWORD_PROBLEM_TEXT.is_email],
    ['was typed differently the second time', GOOD_PASSWORD, 'four unrelated words there', 'The two passwords are not the same.'],
  ])('does not ask the server for a password that %s', async (_why, first, second, message) => {
    const { user, server } = open();
    await user.type(await screen.findByLabelText('Password'), first);
    await user.type(screen.getByLabelText('Password, once more'), second);
    await user.click(screen.getByRole('button', { name: 'Create account' }));

    expect(alertText()).toBe(message);
    expect(server.sent('POST /api/auth/accept-invite')).toEqual([]);
  });

  it('creates the account, shows the recovery code once, and only lets go once it is saved', async () => {
    const { user, server, state } = open();
    await user.type(await screen.findByLabelText('Password'), GOOD_PASSWORD);
    await user.type(screen.getByLabelText('Password, once more'), GOOD_PASSWORD);
    await user.click(screen.getByRole('button', { name: 'Create account' }));

    expect(await screen.findByRole('heading', { name: 'Your account is ready' })).toBeInTheDocument();
    expect(server.sent('POST /api/auth/accept-invite')[0].body).toEqual({ code: 'GOOD-CODE', password: GOOD_PASSWORD });
    expect(screen.getByTestId('recovery-code')).toHaveTextContent(state.issued[0]);
    expect(screen.getByText(/This is the only time the code is shown/)).toBeInTheDocument();

    const onward = screen.getByRole('button', { name: 'Continue to your account' });
    expect(onward).toBeDisabled();
    await user.click(screen.getByRole('checkbox', { name: 'I have saved my recovery code' }));
    expect(onward).toBeEnabled();
    await user.click(onward);

    expect(await screen.findByText(/Signed in as/)).toHaveTextContent('Signed in as new.person@example.com');
    // The address with the one-time code is not left behind.
    expect(window.location.hash).toBe('#/account');
    expect(screen.queryByTestId('recovery-code')).not.toBeInTheDocument();
  });

  it("shows the server's reason when it turns the password down", async () => {
    const stolen = 'password123456';
    const { user } = openApp('/invite/GOOD-CODE', { links: { 'GOOD-CODE': invite }, breached: [stolen] });
    await user.type(await screen.findByLabelText('Password'), stolen);
    await user.type(screen.getByLabelText('Password, once more'), stolen);
    await user.click(screen.getByRole('button', { name: 'Create account' }));

    await waitFor(() => expect(alertText()).toBe(PASSWORD_PROBLEM_TEXT.breached));
    expect(screen.getByRole('heading', { name: 'Create your account' })).toBeInTheDocument();
  });

  it('says a link that was used or has run out cannot be used, and points to sign in', async () => {
    openApp('/invite/OLD-CODE', { links: {} });
    expect(await screen.findByRole('heading', { name: 'This link cannot be used' })).toBeInTheDocument();
    expect(screen.getByText('This link is no longer valid. Ask for a new one.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Go to sign in' })).toHaveAttribute('href', '#/sign-in');
    expect(screen.queryByLabelText('Password')).not.toBeInTheDocument();
  });
});

describe('using a password reset link', () => {
  it('warns what a reset erases, and offers the recovery code as the way that erases nothing', async () => {
    openApp('/reset/RESET-CODE', { account: SAM, links: { 'RESET-CODE': reset } });
    expect(await screen.findByRole('heading', { name: 'Set a new password' })).toBeInTheDocument();
    expect(screen.getByText(/Logins for job sites that are stored in your account are erased when you use it/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'use it instead' })).toHaveAttribute('href', '#/recover');
  });

  it('sets the password, hands over a new recovery code, and sends the person to sign in', async () => {
    const { user, server, state } = openApp('/reset/RESET-CODE', { account: SAM, links: { 'RESET-CODE': reset } });
    await user.type(await screen.findByLabelText('New password'), GOOD_PASSWORD);
    await user.type(screen.getByLabelText('New password, once more'), GOOD_PASSWORD);
    await user.click(screen.getByRole('button', { name: 'Set password' }));

    expect(await screen.findByRole('heading', { name: 'Your password is changed' })).toBeInTheDocument();
    expect(server.sent('POST /api/auth/reset')[0].body).toEqual({ code: 'RESET-CODE', password: GOOD_PASSWORD });
    expect(screen.getByTestId('recovery-code')).toHaveTextContent(state.issued[0]);
    expect(screen.getByText('This is a new code. Your old recovery code no longer works.')).toBeInTheDocument();

    await user.click(screen.getByRole('checkbox', { name: 'I have saved my recovery code' }));
    await user.click(screen.getByRole('button', { name: 'Go to sign in' }));

    expect(await screen.findByRole('button', { name: 'Sign in' })).toBeInTheDocument();
    expect(window.location.hash).toBe('#/sign-in');
    expect(state.account?.password).toBe(GOOD_PASSWORD);
  });
});

describe('recovering with the recovery code', () => {
  async function fill(user: ReturnType<typeof openApp>['user'], code: string, password = GOOD_PASSWORD, again = password) {
    await user.type(await screen.findByLabelText('Email'), SAM.email);
    await user.type(screen.getByLabelText('Recovery code'), code);
    await user.type(screen.getByLabelText('New password'), password);
    await user.type(screen.getByLabelText('New password, once more'), again);
    await user.click(screen.getByRole('button', { name: 'Set new password' }));
  }

  it('sets a new password and hands over a new code, since the old one is used up', async () => {
    const { user, server, state } = openApp('/recover', { account: { ...SAM } });
    await fill(user, SAM.recoveryCode);

    expect(await screen.findByRole('heading', { name: 'Your password is changed' })).toBeInTheDocument();
    expect(server.sent('POST /api/auth/recover')[0].body).toEqual({ email: SAM.email, recoveryCode: SAM.recoveryCode, password: GOOD_PASSWORD });
    expect(screen.getByTestId('recovery-code')).toHaveTextContent(state.issued[0]);
    expect(screen.getByText(/The one you just used no longer works\. Every browser that was signed in to your account has been signed out\./)).toBeInTheDocument();

    await user.click(screen.getByRole('checkbox', { name: 'I have saved my recovery code' }));
    await user.click(screen.getByRole('button', { name: 'Go to sign in' }));
    expect(await screen.findByRole('button', { name: 'Sign in' })).toBeInTheDocument();
  });

  it("shows the server's refusal for a wrong code, without saying which of the two was wrong", async () => {
    const { user } = openApp('/recover', { account: { ...SAM } });
    await fill(user, 'WRONG-CODE');
    await waitFor(() => expect(alertText()).toBe('Email or recovery code is incorrect.'));
    expect(screen.getByRole('heading', { name: 'Forgot your password?' })).toBeInTheDocument();
  });

  it('checks the new password here before asking the server', async () => {
    const { user, server } = openApp('/recover', { account: { ...SAM } });
    await fill(user, SAM.recoveryCode, 'too short');
    expect(alertText()).toBe(PASSWORD_PROBLEM_TEXT.too_short);
    expect(server.sent('POST /api/auth/recover')).toEqual([]);
  });

  it('explains what to do without a recovery code, and leads back to sign in', async () => {
    openApp('/recover', { account: { ...SAM } });
    expect(await screen.findByText(/No recovery code\? Whoever runs this server can make you a password reset link\./)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to sign in' })).toHaveAttribute('href', '#/sign-in');
    expect(screen.getByLabelText('Recovery code')).toHaveAttribute('autocomplete', 'off');
  });
});

describe('the recovery code, once it is shown', () => {
  async function shown() {
    const opened = openApp('/invite/GOOD-CODE', { links: { 'GOOD-CODE': invite } });
    await opened.user.type(await screen.findByLabelText('Password'), GOOD_PASSWORD);
    await opened.user.type(screen.getByLabelText('Password, once more'), GOOD_PASSWORD);
    await opened.user.click(screen.getByRole('button', { name: 'Create account' }));
    const panel = await screen.findByRole('region', { name: 'Save your recovery code' });
    return { ...opened, panel, code: opened.state.issued[0] };
  }

  it('can be copied', async () => {
    const { user, panel, code } = await shown();
    await user.click(within(panel).getByRole('button', { name: 'Copy' }));
    expect(await within(panel).findByRole('button', { name: 'Copied' })).toBeInTheDocument();
    expect(await navigator.clipboard.readText()).toBe(code);
  });

  it('can be downloaded as a text file that says which account and site it is for', async () => {
    const { user, panel, code } = await shown();
    const files: Blob[] = [];
    const names: string[] = [];
    vi.spyOn(URL, 'createObjectURL').mockImplementation((blob) => (files.push(blob as Blob), 'blob:recovery-code'));
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      names.push(this.download);
    });

    await user.click(within(panel).getByRole('button', { name: 'Download as a file' }));

    expect(names).toEqual(['job-hunt-recovery-code.txt']);
    const text = await files[0].text();
    expect(text).toContain(`Code: ${code}`);
    expect(text).toContain('Account: new.person@example.com');
    expect(text).toContain(`Site: ${window.location.origin}`);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:recovery-code');
  });
});
