/**
 * A stand-in for the account routes of the server, for component tests. It keeps one account in memory and answers
 * the way server/src/accounts/http.ts does: the same paths, the same reply shapes (src/account/api.ts) and the same
 * sentences for a refusal. The real routes, with their real rules, are tested in test/server/accounts.test.ts.
 */
import type { AccountUser, InviteInfo, Role, SessionSummary } from '../account/api';
import { PASSWORD_PROBLEM_TEXT } from '../account/api';
import { fakeServer, refusal, type Call, type Route } from './fakeServer';

export interface FakeAccount {
  email: string;
  password: string;
  role?: Role;
  recoveryCode?: string;
}

export interface FakeAccountsOptions {
  /** False for a server that has accounts switched off. */
  available?: boolean;
  /** The account the server has. */
  account?: FakeAccount;
  /** Whether the browser is signed in to it when the page opens. */
  signedIn?: boolean;
  /** Where the account is signed in. The browser under test is the one marked `current`. */
  sessions?: SessionSummary[];
  /** Invite and reset links that are still good, by their code. */
  links?: Record<string, InviteInfo>;
  /** Passwords the server turns down as known from breaches. */
  breached?: string[];
}

const CHROME_WINDOWS = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const FIREFOX_MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:131.0) Gecko/20100101 Firefox/131.0';

export const session = (over: Partial<SessionSummary> = {}): SessionSummary => ({
  id: 's-current',
  current: true,
  createdAt: '2026-11-10T09:00:00.000Z',
  lastSeenAt: '2026-11-17T12:00:00.000Z',
  userAgent: CHROME_WINDOWS,
  ...over,
});
export const otherSession = (over: Partial<SessionSummary> = {}): SessionSummary => session({ id: 's-other', current: false, userAgent: FIREFOX_MAC, ...over });

export function fakeAccounts(options: FakeAccountsOptions = {}, extraRoutes: Record<string, Route> = {}) {
  const state = {
    available: options.available ?? true,
    account: options.account as FakeAccount | undefined,
    signedIn: options.signedIn ?? false,
    sessions: options.sessions ?? [session()],
    links: { ...options.links },
    /** Recovery codes handed out, newest last. */
    issued: [] as string[],
  };
  const breached = new Set(options.breached ?? []);

  const user = (): AccountUser | null => (state.signedIn && state.account ? { email: state.account.email, role: state.account.role ?? 'user' } : null);
  const newCode = () => {
    const code = `NEW${state.issued.length + 1}-AAAA-BBBB-CCCC-DDDD-EEEE`;
    state.issued.push(code);
    if (state.account) state.account.recoveryCode = code;
    return code;
  };
  const body = <T extends object>(call: Call) => (call.body ?? {}) as Partial<T>;
  const weak = (password: string) => (breached.has(password) ? refusal(400, 'weak_password', PASSWORD_PROBLEM_TEXT.breached, { problem: 'breached' }) : undefined);

  /** A route only a signed-in browser may use. */
  const signed =
    (route: Route): Route =>
    (call) =>
      state.signedIn ? route(call) : refusal(401, 'not_signed_in', 'Sign in to continue.');
  /** A route that asks for the password again. */
  const withPassword =
    (route: Route): Route =>
    (call) =>
      body<{ currentPassword: string }>(call).currentPassword === state.account?.password ? route(call) : refusal(403, 'wrong_password', 'That password is not correct.');

  const routes: Record<string, Route> = {
    'GET /api/auth/session': () => ({ available: state.available, user: state.available ? user() : null }),

    'POST /api/auth/sign-in': (call) => {
      const { email, password } = body<{ email: string; password: string }>(call);
      if (!state.account || email?.trim().toLowerCase() !== state.account.email || password !== state.account.password) {
        return refusal(401, 'invalid_credentials', 'Email or password is incorrect.');
      }
      state.signedIn = true;
      return { user: user() };
    },
    'POST /api/auth/sign-out': () => {
      state.signedIn = false;
      return {};
    },

    'POST /api/auth/invite': (call) => state.links[body<{ code: string }>(call).code ?? ''] ?? refusal(400, 'invalid_code', 'This link is no longer valid. Ask for a new one.'),
    'POST /api/auth/accept-invite': (call) => {
      const { code = '', password = '' } = body<{ code: string; password: string }>(call);
      const link = state.links[code];
      if (!link || link.kind !== 'invite') return refusal(400, 'invalid_code', 'This link is no longer valid. Ask for a new one.');
      const refused = weak(password);
      if (refused) return refused;
      delete state.links[code];
      state.account = { email: link.email, password };
      state.signedIn = true;
      return { user: user(), recoveryCode: newCode() };
    },
    'POST /api/auth/reset': (call) => {
      const { code = '', password = '' } = body<{ code: string; password: string }>(call);
      const link = state.links[code];
      if (!link || link.kind !== 'reset') return refusal(400, 'invalid_code', 'This link is no longer valid. Ask for a new one.');
      const refused = weak(password);
      if (refused) return refused;
      delete state.links[code];
      state.account = { ...state.account, email: link.email, password };
      state.signedIn = false;
      return { email: link.email, recoveryCode: newCode() };
    },
    'POST /api/auth/recover': (call) => {
      const { email, recoveryCode, password = '' } = body<{ email: string; recoveryCode: string; password: string }>(call);
      if (!state.account || email?.trim().toLowerCase() !== state.account.email || recoveryCode?.trim() !== state.account.recoveryCode) {
        return refusal(401, 'invalid_recovery', 'Email or recovery code is incorrect.');
      }
      const refused = weak(password);
      if (refused) return refused;
      state.account.password = password;
      state.signedIn = false;
      return { recoveryCode: newCode() };
    },

    'GET /api/account/sessions': signed(() => ({ sessions: state.sessions })),
    'POST /api/account/sessions/end': signed((call) => {
      const ended = state.sessions.find((s) => s.id === body<{ id: string }>(call).id);
      state.sessions = state.sessions.filter((s) => s !== ended);
      if (ended?.current) state.signedIn = false;
      return {};
    }),
    'POST /api/account/sign-out-everywhere': signed(() => {
      state.sessions = [];
      state.signedIn = false;
      return {};
    }),
    'POST /api/account/password': signed(
      withPassword((call) => {
        const { newPassword = '' } = body<{ newPassword: string }>(call);
        const refused = weak(newPassword);
        if (refused) return refused;
        state.account!.password = newPassword;
        state.sessions = state.sessions.filter((s) => s.current);
        return {};
      }),
    ),
    'POST /api/account/recovery-code': signed(withPassword(() => ({ recoveryCode: newCode() }))),
    'POST /api/account/delete': signed(
      withPassword(() => {
        state.account = undefined;
        state.signedIn = false;
        return {};
      }),
    ),
    ...extraRoutes,
  };

  const server = fakeServer(routes);
  return { state, server };
}
