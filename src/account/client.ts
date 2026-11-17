/**
 * Calls to the account routes of the server (server/src/accounts/http.ts).
 *
 * They always go to the page's own address, never to the search server setting, because the page's own address is
 * the only place the browser sends the sign-in cookie. Locally the dev server passes them on (see vite.config.ts).
 */
import type { AccountUser, ErrorCode, ErrorReply, InviteInfo, PasswordProblem, RecoveryCodeReply, SessionReply, SessionSummary } from './api';

/**
 * Whether this page looks for an account server at all. The public demo on GitHub Pages has none, so it never asks.
 * A server that serves the app itself and has accounts on says so in the page (server/src/static.ts). In local
 * development the dev server passes the question on to the backend. VITE_ACCOUNTS=1 at build time is for any other
 * setup where the app and the account routes share an address.
 */
export const ACCOUNTS_ENABLED: boolean =
  import.meta.env.DEV || !!import.meta.env.VITE_ACCOUNTS || (typeof document !== 'undefined' && document.querySelector('meta[name="job-hunt-accounts"]') !== null);

/** A failed account call. `message` is a sentence that can be shown to the user as it is. */
export class AccountApiError extends Error {
  constructor(
    /** `unreachable`: there was no answer from an account server at all. */
    public code: ErrorCode | 'unreachable',
    message: string,
    /** The HTTP status, or 0 when the request never got an answer. */
    public status: number,
    public problem?: PasswordProblem,
    public retryAfter?: number,
  ) {
    super(message);
    this.name = 'AccountApiError';
  }
}

const UNREACHABLE = 'The server could not be reached. Check that it is running, then try again.';

async function call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      credentials: 'same-origin',
      cache: 'no-store',
      headers: method === 'POST' ? { 'Content-Type': 'application/json' } : undefined,
      body: method === 'POST' ? JSON.stringify(body ?? {}) : undefined,
    });
  } catch {
    throw new AccountApiError('unreachable', UNREACHABLE, 0);
  }
  // Anything that is not JSON did not come from the account server: a dev server's fallback page, a proxy's error.
  const isJson = (res.headers.get('content-type') ?? '').includes('application/json');
  const data: unknown = isJson ? await res.json().catch(() => undefined) : undefined;
  if (res.ok && data !== undefined && data !== null) return data as T;
  const failure = data as Partial<ErrorReply> | undefined;
  if (failure?.code && failure.error) throw new AccountApiError(failure.code, failure.error, res.status, failure.problem, failure.retryAfter);
  throw new AccountApiError('unreachable', UNREACHABLE, res.status);
}

export const accountApi = {
  session: () => call<SessionReply>('GET', '/api/auth/session'),
  signIn: (email: string, password: string) => call<{ user: AccountUser }>('POST', '/api/auth/sign-in', { email, password }),
  signOut: () => call<object>('POST', '/api/auth/sign-out'),
  /** What an invite or reset link is for. */
  invite: (code: string) => call<InviteInfo>('POST', '/api/auth/invite', { code }),
  acceptInvite: (code: string, password: string) => call<{ user: AccountUser } & RecoveryCodeReply>('POST', '/api/auth/accept-invite', { code, password }),
  reset: (code: string, password: string) => call<{ email: string } & RecoveryCodeReply>('POST', '/api/auth/reset', { code, password }),
  recover: (email: string, recoveryCode: string, password: string) => call<RecoveryCodeReply>('POST', '/api/auth/recover', { email, recoveryCode, password }),
  sessions: () => call<{ sessions: SessionSummary[] }>('GET', '/api/account/sessions'),
  endSession: (id: string) => call<object>('POST', '/api/account/sessions/end', { id }),
  signOutEverywhere: () => call<object>('POST', '/api/account/sign-out-everywhere'),
  changePassword: (currentPassword: string, newPassword: string) => call<object>('POST', '/api/account/password', { currentPassword, newPassword }),
  newRecoveryCode: (currentPassword: string) => call<RecoveryCodeReply>('POST', '/api/account/recovery-code', { currentPassword }),
  deleteAccount: (currentPassword: string) => call<object>('POST', '/api/account/delete', { currentPassword }),
};

/** "Edge on Windows", from a browser's User-Agent text. Only used to show people where they are signed in. */
export function describeDevice(userAgent: string): string {
  const ua = userAgent ?? '';
  // Order matters: Edge and Opera also say Chrome and Safari, and Chrome also says Safari.
  const browser = /\bEdg(?:e|A|iOS)?\//.test(ua)
    ? 'Edge'
    : /\bOPR\//.test(ua)
      ? 'Opera'
      : /\b(?:Firefox|FxiOS)\//.test(ua)
        ? 'Firefox'
        : /(?:Chrome|CriOS)\//.test(ua)
          ? 'Chrome'
          : /\bSafari\//.test(ua)
            ? 'Safari'
            : undefined;
  // Android also says Linux, and an iPhone also says Mac OS X.
  const system = /\bWindows\b/.test(ua)
    ? 'Windows'
    : /\biPhone\b/.test(ua)
      ? 'iPhone'
      : /\biPad\b/.test(ua)
        ? 'iPad'
        : /\bAndroid\b/.test(ua)
          ? 'Android'
          : /\bCrOS\b/.test(ua)
            ? 'Chromebook'
            : /\bMac(?:intosh| OS X)\b/.test(ua)
              ? 'Mac'
              : /\bLinux\b/.test(ua)
                ? 'Linux'
                : undefined;
  if (browser && system) return `${browser} on ${system}`;
  return browser ?? system ?? 'Unknown device';
}
