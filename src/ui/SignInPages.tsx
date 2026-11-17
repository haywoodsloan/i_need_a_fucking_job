/**
 * The pages for getting into an account: sign in, accept an invite, use a reset link, and recover with the
 * recovery code. What each one does on the server is described in docs/accounts.md.
 */
import { useEffect, useId, useState, type FormEvent } from 'react';
import type { InviteInfo } from '../account/api';
import { useAccount } from '../account/AccountProvider';
import { accountApi } from '../account/client';
import { AccountsUnavailable, ErrorNotice, NewPasswordFields, PasswordField, RecoveryCodePanel, errorText, newPasswordProblem } from './AccountForms';
import { useRoute } from './hooks';

/** Leaves a page whose address holds a one-time code, without keeping that address in the back button's history. */
const replaceRoute = (route: string) => window.location.replace(`${window.location.pathname}${window.location.search}#/${route}`);

export function SignInPage({ note }: { note?: string }) {
  const { state, refresh } = useAccount();
  const [, go] = useRoute();
  const emailId = useId();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const signedIn = state.status === 'signed-in';
  useEffect(() => {
    if (signedIn) go('account');
  }, [signedIn, go]);

  if (signedIn) return null; // on the way to the account page
  if (state.status === 'off' || state.status === 'checking') {
    return (
      <main className="account-page">
        <h1>Sign in</h1>
        <AccountsUnavailable state={state} retry={() => void refresh()} />
      </main>
    );
  }

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await accountApi.signIn(email, password);
      setPassword('');
      await refresh();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="account-page">
      <h1>Sign in</h1>
      {note && <p className="muted">{note}</p>}
      <form className="card form" onSubmit={submit}>
        <div className="form-field">
          <label htmlFor={emailId}>Email</label>
          <input id={emailId} type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" autoFocus required />
        </div>
        <PasswordField label="Password" value={password} onChange={setPassword} autoComplete="current-password" />
        <ErrorNotice>{error}</ErrorNotice>
        <div className="actions">
          <button type="submit" className="btn primary" disabled={busy}>
            {busy ? 'Signing in…' : 'Sign in'}
          </button>
          <a href="#/recover">Forgot your password?</a>
        </div>
      </form>
      <p className="small muted">Accounts are by invitation. To get one, ask whoever runs this server for an invite link.</p>
    </main>
  );
}

/** The page behind an invite link (#/invite/<code>) or a password reset link (#/reset/<code>). */
export function LinkPage({ code }: { code: string }) {
  const { state, refresh } = useAccount();
  const emailId = useId();
  const [info, setInfo] = useState<InviteInfo | 'loading' | { failed: string }>('loading');
  const [password, setPassword] = useState('');
  const [again, setAgain] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [recoveryCode, setRecoveryCode] = useState('');

  const usable = state.status === 'signed-in' || state.status === 'signed-out';
  useEffect(() => {
    if (!usable) return;
    let current = true;
    setInfo('loading');
    accountApi.invite(code).then(
      (found) => current && setInfo(found),
      (e) => current && setInfo({ failed: errorText(e) }),
    );
    return () => {
      current = false;
    };
  }, [code, usable]);

  if (!usable) {
    return (
      <main className="account-page">
        <h1>Your link</h1>
        <AccountsUnavailable state={state} retry={() => void refresh()} />
      </main>
    );
  }
  if (info === 'loading') {
    return (
      <main className="account-page">
        <p className="muted" role="status">
          Checking your link…
        </p>
      </main>
    );
  }
  if ('failed' in info) {
    return (
      <main className="account-page">
        <h1>This link cannot be used</h1>
        <section className="card">
          <p>{info.failed}</p>
          <p className="small muted">
            A link works once and for a limited time. Whoever runs this server can make a new one. <a href="#/sign-in">Go to sign in</a>
          </p>
        </section>
      </main>
    );
  }

  const isInvite = info.kind === 'invite';

  if (recoveryCode) {
    return (
      <main className="account-page">
        <h1>{isInvite ? 'Your account is ready' : 'Your password is changed'}</h1>
        <RecoveryCodePanel
          code={recoveryCode}
          email={info.email}
          done={isInvite ? 'Continue to your account' : 'Go to sign in'}
          onDone={() => replaceRoute(isInvite ? 'account' : 'sign-in')}
        >
          {!isInvite && <p>This is a new code. Your old recovery code no longer works.</p>}
        </RecoveryCodePanel>
      </main>
    );
  }

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const problem = newPasswordProblem(password, again, info.email);
    if (problem) return setError(problem);
    setBusy(true);
    setError('');
    try {
      const reply = isInvite ? await accountApi.acceptInvite(code, password) : await accountApi.reset(code, password);
      setPassword('');
      setAgain('');
      setRecoveryCode(reply.recoveryCode);
      await refresh();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="account-page">
      <h1>{isInvite ? 'Create your account' : 'Set a new password'}</h1>
      {!isInvite && (
        <div className="notice">
          This link sets a new password without your old one. Logins for job sites that are stored in your account are erased when you use it,
          because only your old password or your recovery code can open them. If you still have your recovery code,{' '}
          <a href="#/recover">use it instead</a> and nothing is lost.
        </div>
      )}
      <form className="card form" onSubmit={submit}>
        <div className="form-field">
          <label htmlFor={emailId}>Email</label>
          {/* Read-only, and here so a password manager saves the password under the right name. */}
          <input id={emailId} type="email" value={info.email} autoComplete="username" readOnly />
        </div>
        <NewPasswordFields password={password} setPassword={setPassword} again={again} setAgain={setAgain} label={isInvite ? 'Password' : 'New password'} autoFocus />
        <ErrorNotice>{error}</ErrorNotice>
        <div className="actions">
          <button type="submit" className="btn primary" disabled={busy}>
            {busy ? 'Working…' : isInvite ? 'Create account' : 'Set password'}
          </button>
        </div>
      </form>
    </main>
  );
}

/** Forgot the password, still has the recovery code. */
export function RecoverPage() {
  const { state, refresh } = useAccount();
  const [, go] = useRoute();
  const emailId = useId();
  const codeId = useId();
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [again, setAgain] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [newCode, setNewCode] = useState('');

  if (state.status === 'off' || state.status === 'checking') {
    return (
      <main className="account-page">
        <h1>Forgot your password?</h1>
        <AccountsUnavailable state={state} retry={() => void refresh()} />
      </main>
    );
  }

  if (newCode) {
    return (
      <main className="account-page">
        <h1>Your password is changed</h1>
        <RecoveryCodePanel code={newCode} email={email.trim()} done="Go to sign in" onDone={() => go('sign-in')}>
          <p>This is a new code. The one you just used no longer works. Every browser that was signed in to your account has been signed out.</p>
        </RecoveryCodePanel>
      </main>
    );
  }

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const problem = newPasswordProblem(password, again, email);
    if (problem) return setError(problem);
    setBusy(true);
    setError('');
    try {
      const reply = await accountApi.recover(email, code, password);
      setPassword('');
      setAgain('');
      setCode('');
      setNewCode(reply.recoveryCode);
      await refresh();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="account-page">
      <h1>Forgot your password?</h1>
      <p className="muted">Enter the recovery code you saved when the account was made, and choose a new password. Everything in your account is kept.</p>
      <form className="card form" onSubmit={submit}>
        <div className="form-field">
          <label htmlFor={emailId}>Email</label>
          <input id={emailId} type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" autoFocus required />
        </div>
        <div className="form-field">
          <label htmlFor={codeId}>Recovery code</label>
          <input
            id={codeId}
            type="text"
            className="code-input"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder="XXXX-XXXX-XXXX-XXXX-XXXX-XXXX"
            autoComplete="off"
            autoCapitalize="characters"
            autoCorrect="off"
            spellCheck={false}
            required
          />
        </div>
        <NewPasswordFields password={password} setPassword={setPassword} again={again} setAgain={setAgain} label="New password" />
        <ErrorNotice>{error}</ErrorNotice>
        <div className="actions">
          <button type="submit" className="btn primary" disabled={busy}>
            {busy ? 'Working…' : 'Set new password'}
          </button>
          <a href="#/sign-in">Back to sign in</a>
        </div>
      </form>
      <p className="small muted">
        No recovery code? Whoever runs this server can make you a password reset link. A reset link erases the job site logins stored in your account,
        because those cannot be opened without your old password or the code.
      </p>
    </main>
  );
}
