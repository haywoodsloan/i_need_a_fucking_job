/** The pieces the sign-in and account pages share: password fields, the recovery code panel, error and status text. */
import { useId, useState, type ReactNode } from 'react';
import { PASSWORD_MIN, PASSWORD_PROBLEM_TEXT, passwordProblem } from '../account/api';
import type { AccountState } from '../account/AccountProvider';
import { AccountApiError } from '../account/client';

/** The sentence to show for a failed account call. */
export const errorText = (e: unknown) => (e instanceof AccountApiError ? e.message : 'Something went wrong. Try again.');

export function ErrorNotice({ children }: { children: ReactNode }) {
  return children ? (
    <div className="notice bad" role="alert">
      {children}
    </div>
  ) : null;
}

interface PasswordFieldProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  /** Tells password managers whether to offer the saved password or suggest a new one. */
  autoComplete: 'current-password' | 'new-password';
  autoFocus?: boolean;
  hint?: ReactNode;
}

export function PasswordField({ label, value, onChange, autoComplete, autoFocus, hint }: PasswordFieldProps) {
  const id = useId();
  const [shown, setShown] = useState(false);
  return (
    <div className="form-field">
      <label htmlFor={id}>{label}</label>
      <div className="password-row">
        <input
          id={id}
          type={shown ? 'text' : 'password'}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          autoComplete={autoComplete}
          autoFocus={autoFocus}
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          required
          aria-describedby={hint ? `${id}-hint` : undefined}
        />
        <button type="button" className="btn" onClick={() => setShown(!shown)} aria-label={shown ? `Hide ${label.toLowerCase()}` : `Show ${label.toLowerCase()}`}>
          {shown ? 'Hide' : 'Show'}
        </button>
      </div>
      {hint && (
        <div className="small muted" id={`${id}-hint`}>
          {hint}
        </div>
      )}
    </div>
  );
}

/** Why a new password cannot be sent yet, as a sentence for the user. Undefined when it can. The server checks again. */
export function newPasswordProblem(password: string, again: string, email: string): string | undefined {
  const problem = passwordProblem(password, email);
  if (problem) return PASSWORD_PROBLEM_TEXT[problem];
  return password === again ? undefined : 'The two passwords are not the same.';
}

interface NewPasswordProps {
  password: string;
  setPassword: (value: string) => void;
  again: string;
  setAgain: (value: string) => void;
  label?: string;
  autoFocus?: boolean;
}

export function NewPasswordFields({ password, setPassword, again, setAgain, label = 'Password', autoFocus }: NewPasswordProps) {
  const count = [...password].length;
  return (
    <>
      <PasswordField
        label={label}
        value={password}
        onChange={setPassword}
        autoComplete="new-password"
        autoFocus={autoFocus}
        hint={
          count >= PASSWORD_MIN
            ? 'Long enough.'
            : `At least ${PASSWORD_MIN} characters${count ? `, ${count} so far` : ''}. A few unrelated words work well, and no symbols are required.`
        }
      />
      <PasswordField label={`${label}, once more`} value={again} onChange={setAgain} autoComplete="new-password" />
    </>
  );
}

interface RecoveryCodeProps {
  code: string;
  email: string;
  /** The label of the button that leaves this panel. */
  done: string;
  onDone: () => void;
  children?: ReactNode;
}

/** Shows a recovery code, which the server hands over exactly once, and holds the user here until they have kept it. */
export function RecoveryCodePanel({ code, email, done, onDone, children }: RecoveryCodeProps) {
  const [saved, setSaved] = useState(false);
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
    } catch {
      setCopied(false); // no clipboard access: the code can still be selected and copied by hand
    }
  };

  const download = () => {
    const text = [
      'Job Hunt recovery code',
      '',
      `Account: ${email}`,
      `Site: ${window.location.origin}`,
      `Code: ${code}`,
      '',
      'If you forget your password, choose "Forgot your password?" on the sign-in page and enter this code.',
      'Keep this somewhere safe, and do not leave it in your Downloads folder.',
      '',
    ].join('\n');
    const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'job-hunt-recovery-code.txt';
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <section className="card" aria-labelledby="recovery-code-title">
      <h2 id="recovery-code-title">Save your recovery code</h2>
      <div className="code-box" data-testid="recovery-code">
        {code}
      </div>
      <div className="actions">
        <button type="button" className="btn" onClick={copy}>
          {copied ? 'Copied' : 'Copy'}
        </button>
        <button type="button" className="btn" onClick={download}>
          Download as a file
        </button>
      </div>
      <p>
        This is the only time the code is shown. If you forget your password, it is the one way back into your account that keeps everything in
        it. Put it in a password manager or on paper.
      </p>
      {children}
      <label className="check">
        <input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} />
        <span>I have saved my recovery code</span>
      </label>
      <div className="actions">
        <button type="button" className="btn primary" disabled={!saved} onClick={onDone}>
          {done}
        </button>
      </div>
    </section>
  );
}

/** What an account page shows while accounts cannot be used. Renders nothing when they can. */
export function AccountsUnavailable({ state, retry }: { state: AccountState; retry: () => void }) {
  if (state.status === 'checking') {
    return (
      <p className="muted" role="status">
        Checking who is signed in…
      </p>
    );
  }
  if (state.status !== 'off') return null;
  return (
    <section className="card">
      {state.why === 'build' && <p>This copy of the app has no accounts. They are part of the app when it runs together with its own server.</p>}
      {state.why === 'server' && (
        <>
          <p>Accounts are switched off on this server.</p>
          <p className="small muted">
            Whoever runs it turns them on with <code>npm run admin -- setup &lt;email&gt;</code> and then starts the server again.
          </p>
        </>
      )}
      {state.why === 'unreachable' && (
        <>
          <p>The app could not reach its server.</p>
          <p className="small muted">
            If you run it yourself, start it with <code>npm run local</code>, then try again.
          </p>
          <div className="actions">
            <button type="button" className="btn" onClick={retry}>
              Try again
            </button>
          </div>
        </>
      )}
    </section>
  );
}
