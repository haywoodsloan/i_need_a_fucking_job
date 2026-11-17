/** The signed-in user's own page: where they are signed in, their password, their recovery code, and deleting the account. */
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import type { AccountUser, SessionSummary } from '../account/api';
import { useAccount } from '../account/AccountProvider';
import { AccountApiError, accountApi, describeDevice } from '../account/client';
import { AccountsUnavailable, ErrorNotice, NewPasswordFields, PasswordField, RecoveryCodePanel, errorText, newPasswordProblem } from './AccountForms';
import { SignInPage } from './SignInPages';
import { useRoute } from './hooks';

const time = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const when = (iso: string) => time.format(new Date(iso));

export function AccountPage() {
  const { state, refresh } = useAccount();
  const [, go] = useRoute();

  /** Runs an account call. If the session turns out to have ended, the page falls back to sign-in. */
  const run = useCallback(
    async <T,>(action: () => Promise<T>): Promise<T> => {
      try {
        return await action();
      } catch (e) {
        if (e instanceof AccountApiError && e.code === 'not_signed_in') await refresh();
        throw e;
      }
    },
    [refresh],
  );

  if (state.status === 'signed-out') return <SignInPage note="Sign in to see your account." />;
  if (state.status !== 'signed-in') {
    return (
      <main className="account-page">
        <h1>Your account</h1>
        <AccountsUnavailable state={state} retry={() => void refresh()} />
      </main>
    );
  }

  const signOut = async () => {
    await accountApi.signOut().catch(() => {});
    await refresh();
    go('');
  };

  return (
    <main className="account-page wide">
      <div className="account-head">
        <div>
          <h1>Your account</h1>
          <p className="muted">
            Signed in as <strong>{state.user.email}</strong>
            {state.user.role === 'admin' && (
              <>
                {' '}
                <span className="badge">Admin</span>
              </>
            )}
          </p>
        </div>
        <button type="button" className="btn" onClick={signOut}>
          Sign out
        </button>
      </div>
      <p className="small muted">
        Searching for jobs and the resume tools work the same whether or not you are signed in. Your resume stays in this browser and is not part of
        your account.
      </p>
      <Sessions run={run} onSignedOut={() => void refresh()} />
      <ChangePassword user={state.user} run={run} />
      <RecoveryCode user={state.user} run={run} />
      <DeleteAccount run={run} onDeleted={() => void refresh().then(() => go(''))} />
    </main>
  );
}

type Run = <T>(action: () => Promise<T>) => Promise<T>;

function Sessions({ run, onSignedOut }: { run: Run; onSignedOut: () => void }) {
  const [sessions, setSessions] = useState<SessionSummary[]>();
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      setSessions((await run(() => accountApi.sessions())).sessions);
      setError('');
    } catch (e) {
      setError(errorText(e));
    }
  }, [run]);

  useEffect(() => {
    void load();
  }, [load]);

  const end = async (session: SessionSummary) => {
    try {
      await run(() => accountApi.endSession(session.id));
      if (session.current) onSignedOut();
      else await load();
    } catch (e) {
      setError(errorText(e));
    }
  };

  const endAll = async () => {
    try {
      await run(() => accountApi.signOutEverywhere());
      onSignedOut();
    } catch (e) {
      setError(errorText(e));
    }
  };

  return (
    <section className="card" aria-labelledby="sessions-title">
      <h2 id="sessions-title">Where you are signed in</h2>
      <p className="small muted">A browser is signed out by itself after a week without use, and after 30 days in any case.</p>
      <ErrorNotice>{error}</ErrorNotice>
      {!sessions && !error && (
        <p className="muted" role="status">
          Loading…
        </p>
      )}
      {sessions && (
        <ul className="session-list">
          {sessions.map((s) => (
            <li key={s.id}>
              <div>
                <div>
                  {describeDevice(s.userAgent)} {s.current && <span className="badge ok">This browser</span>}
                </div>
                <div className="small muted">
                  Signed in {when(s.createdAt)}. Last used {when(s.lastSeenAt)}.
                </div>
              </div>
              <button type="button" className="btn small" onClick={() => void end(s)}>
                Sign out
              </button>
            </li>
          ))}
        </ul>
      )}
      {sessions && sessions.length > 1 && (
        <div className="actions">
          <button type="button" className="btn" onClick={() => void endAll()}>
            Sign out everywhere
          </button>
        </div>
      )}
    </section>
  );
}

function ChangePassword({ user, run }: { user: AccountUser; run: Run }) {
  const [current, setCurrent] = useState('');
  const [password, setPassword] = useState('');
  const [again, setAgain] = useState('');
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setDone(false);
    const problem = newPasswordProblem(password, again, user.email);
    if (problem) return setError(problem);
    setBusy(true);
    setError('');
    try {
      await run(() => accountApi.changePassword(current, password));
      setCurrent('');
      setPassword('');
      setAgain('');
      setDone(true);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card" aria-labelledby="password-title">
      <h2 id="password-title">Password</h2>
      <form className="form" onSubmit={submit}>
        {/* Not shown, and here so a password manager updates the right entry. */}
        <input type="email" className="sr-only" value={user.email} autoComplete="username" readOnly tabIndex={-1} aria-hidden="true" />
        <PasswordField label="Current password" value={current} onChange={setCurrent} autoComplete="current-password" />
        <NewPasswordFields password={password} setPassword={setPassword} again={again} setAgain={setAgain} label="New password" />
        <ErrorNotice>{error}</ErrorNotice>
        {done && (
          <div className="notice ok" role="status">
            Your password is changed. Other browsers that were signed in to your account have been signed out.
          </div>
        )}
        <div className="actions">
          <button type="submit" className="btn primary" disabled={busy}>
            {busy ? 'Working…' : 'Change password'}
          </button>
        </div>
      </form>
    </section>
  );
}

function RecoveryCode({ user, run }: { user: AccountUser; run: Run }) {
  const [asking, setAsking] = useState(false);
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [code, setCode] = useState('');

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const reply = await run(() => accountApi.newRecoveryCode(password));
      setPassword('');
      setAsking(false);
      setCode(reply.recoveryCode);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  if (code) {
    return (
      <RecoveryCodePanel code={code} email={user.email} done="Done" onDone={() => setCode('')}>
        <p>This is a new code. Your old recovery code no longer works.</p>
      </RecoveryCodePanel>
    );
  }

  return (
    <section className="card" aria-labelledby="recovery-title">
      <h2 id="recovery-title">Recovery code</h2>
      <p className="small muted">
        The recovery code you saved when the account was made lets you choose a new password if you forget yours, and keeps everything in your
        account. If you have lost it, get a new one here. The old one then stops working.
      </p>
      {asking ? (
        <form className="form" onSubmit={submit}>
          <PasswordField label="Your password" value={password} onChange={setPassword} autoComplete="current-password" autoFocus />
          <ErrorNotice>{error}</ErrorNotice>
          <div className="actions">
            <button type="submit" className="btn primary" disabled={busy}>
              {busy ? 'Working…' : 'Show a new recovery code'}
            </button>
            <button type="button" className="btn ghost" onClick={() => setAsking(false)}>
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <div className="actions">
          <button type="button" className="btn" onClick={() => setAsking(true)}>
            Get a new recovery code
          </button>
        </div>
      )}
    </section>
  );
}

function DeleteAccount({ run, onDeleted }: { run: Run; onDeleted: () => void }) {
  const [asking, setAsking] = useState(false);
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await run(() => accountApi.deleteAccount(password));
      onDeleted();
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  };

  return (
    <section className="card" aria-labelledby="delete-title">
      <h2 id="delete-title">Delete account</h2>
      <p className="small muted">
        Deleting removes your sign-in and everything stored in your account from this server. It cannot be undone. Your resume and search settings
        in this browser are not touched.
      </p>
      {asking ? (
        <form className="form" onSubmit={submit}>
          <PasswordField label="Your password" value={password} onChange={setPassword} autoComplete="current-password" autoFocus />
          <ErrorNotice>{error}</ErrorNotice>
          <div className="actions">
            <button type="submit" className="btn danger" disabled={busy}>
              {busy ? 'Deleting…' : 'Delete my account for good'}
            </button>
            <button type="button" className="btn ghost" onClick={() => setAsking(false)}>
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <div className="actions">
          <button type="button" className="btn danger" onClick={() => setAsking(true)}>
            Delete my account…
          </button>
        </div>
      )}
    </section>
  );
}
