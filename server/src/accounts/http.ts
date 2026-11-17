/**
 * The account routes. Every one answers JSON, is never cached, and never carries CORS headers: they are for the
 * app's own pages only.
 *
 *   GET  /api/auth/session                who is signed in
 *   POST /api/auth/sign-in                { email, password }
 *   POST /api/auth/sign-out
 *   POST /api/auth/invite                 { code }                             what an invite or reset link is for
 *   POST /api/auth/accept-invite          { code, password }                   creates the account, signs in
 *   POST /api/auth/reset                  { code, password }                   admin reset link (replaces the vault key)
 *   POST /api/auth/recover                { email, recoveryCode, password }    forgot the password, has the code
 *   GET  /api/account/sessions            where this account is signed in
 *   POST /api/account/sessions/end        { id }
 *   POST /api/account/sign-out-everywhere
 *   POST /api/account/password            { currentPassword, newPassword }
 *   POST /api/account/recovery-code       { currentPassword }                  a new recovery code
 *   POST /api/account/delete              { currentPassword }
 *   POST /api/vault/unlock                { password }
 *   POST /api/vault/lock
 *
 * The session is one cookie holding a random token. It is HttpOnly (scripts cannot read it) and SameSite=Strict
 * (other sites cannot send it). On top of that, anything that changes state must be a JSON request whose Origin is
 * the app's own address, which a page on another site cannot produce.
 */
import type { ErrorReply, SessionReply } from '../../../src/account/api';
import { AccountError, SESSION_MAX_MS, type AccountService, type Signed } from './service';

export interface AccountRequest {
  method: string;
  /** The path alone, such as "/api/auth/sign-in". */
  path: string;
  /** Header names in lower case. */
  headers: Record<string, string | undefined>;
  /** The parsed JSON body of a POST. */
  body?: unknown;
  /** The client's network address, for counting attempts. */
  address: string;
}

export interface AccountReply {
  status: number;
  body: unknown;
  headers: Record<string, string>;
  /** Set-Cookie values. */
  cookies: string[];
}

export interface AccountHttpOptions {
  service: AccountService;
  /** The addresses the signed-in app is served from, as origins ("https://jobs.example.com"). */
  origins: string[];
  /** True when every origin is HTTPS: the cookie gets the __Host- prefix and the Secure flag. */
  secureCookies: boolean;
}

const REPLY_HEADERS: Record<string, string> = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
  'Cross-Origin-Resource-Policy': 'same-origin',
};

interface Outcome {
  body: unknown;
  /** A token to set as the session cookie, or null to remove the cookie. Left out, the cookie is not touched. */
  cookie?: string | null;
}

interface Context {
  req: AccountRequest;
  body: Record<string, unknown>;
  /** The session the request's cookie belongs to, if it is a live one. */
  signed?: Signed;
}

type Handler = (ctx: Context) => Promise<Outcome>;

const badRequest = (message: string) => new AccountError('bad_request', message, 400);

/** A required text field. Passwords and codes are passed on untrimmed: the service decides what is acceptable. */
function text(body: Record<string, unknown>, field: string): string {
  const value = body[field];
  if (typeof value !== 'string' || !value) throw badRequest(`"${field}" is required.`);
  return value;
}

export function createAccountHttp(o: AccountHttpOptions) {
  const { service } = o;
  const allowed = new Set(o.origins);
  const cookieName = o.secureCookies ? '__Host-session' : 'session';
  const cookieRules = `Path=/; HttpOnly; SameSite=Strict${o.secureCookies ? '; Secure' : ''}`;
  const setCookie = (token: string) => `${cookieName}=${token}; ${cookieRules}; Max-Age=${Math.floor(SESSION_MAX_MS / 1000)}`;
  const clearCookie = `${cookieName}=; ${cookieRules}; Max-Age=0`;

  function readCookie(header: string | undefined): string | undefined {
    for (const part of (header ?? '').split(';')) {
      const eq = part.indexOf('=');
      if (eq > 0 && part.slice(0, eq).trim() === cookieName) return part.slice(eq + 1).trim();
    }
    return undefined;
  }

  /** Why this request is not from the app's own pages, or undefined when it is. */
  function originProblem(req: AccountRequest): string | undefined {
    const origin = req.headers.origin;
    const site = req.headers['sec-fetch-site'];
    if (origin !== undefined && !allowed.has(origin)) {
      return `This page (${origin}) is not an address the server accepts sign-ins from. Open ${o.origins[0]} instead, or add this address to APP_ORIGIN in server/.env.`;
    }
    if (req.method === 'GET') {
      // Reading is harmless without the cookie, and SameSite=Strict keeps the cookie off cross-site requests.
      return site !== undefined && site !== 'same-origin' && site !== 'none' ? 'This request came from another site.' : undefined;
    }
    if (origin === undefined) return 'This request did not say which page sent it.';
    return site !== undefined && site !== 'same-origin' ? 'This request came from another site.' : undefined;
  }

  const signedIn =
    (fn: (signed: Signed, ctx: Context) => Promise<Outcome>): Handler =>
    async (ctx) => {
      if (!ctx.signed) throw new AccountError('not_signed_in', 'Sign in to continue.', 401);
      return fn(ctx.signed, ctx);
    };

  const routes: Record<string, Handler> = {
    'GET /api/auth/session': async ({ signed }) => {
      const body: SessionReply = signed ? { available: true, user: { email: signed.user.email, role: signed.user.role }, vault: signed.vault } : { available: true, user: null };
      return { body };
    },

    'POST /api/auth/sign-in': async ({ req, body, signed }) => {
      const result = await service.signIn({ email: text(body, 'email'), password: text(body, 'password'), userAgent: req.headers['user-agent'] ?? '', address: req.address });
      if (signed) await service.signOut(signed); // signing in again replaces the old session instead of leaving it behind
      return { body: { user: result.user }, cookie: result.token };
    },

    'POST /api/auth/sign-out': async ({ signed }) => {
      if (signed) await service.signOut(signed);
      return { body: {}, cookie: null };
    },

    'POST /api/auth/invite': async ({ req, body }) => ({ body: await service.peekInvite({ code: body.code, address: req.address }) }),

    'POST /api/auth/accept-invite': async ({ req, body, signed }) => {
      const result = await service.acceptInvite({ code: body.code, password: text(body, 'password'), userAgent: req.headers['user-agent'] ?? '', address: req.address });
      if (signed) await service.signOut(signed);
      return { body: { user: result.user, recoveryCode: result.recoveryCode }, cookie: result.token };
    },

    'POST /api/auth/reset': async ({ req, body }) => ({
      body: await service.resetWithLink({ code: body.code, password: text(body, 'password'), address: req.address }),
      cookie: null,
    }),

    'POST /api/auth/recover': async ({ req, body }) => ({
      body: await service.recover({ email: text(body, 'email'), recoveryCode: text(body, 'recoveryCode'), newPassword: text(body, 'password'), address: req.address }),
      cookie: null,
    }),

    'GET /api/account/sessions': signedIn(async (signed) => ({ body: { sessions: await service.listSessions(signed) } })),

    'POST /api/account/sessions/end': signedIn(async (signed, { body }) => {
      const { current } = await service.endSession(signed, body.id);
      return { body: {}, cookie: current ? null : undefined };
    }),

    'POST /api/account/sign-out-everywhere': signedIn(async (signed) => {
      await service.signOutEverywhere(signed);
      return { body: {}, cookie: null };
    }),

    'POST /api/account/password': signedIn(async (signed, { body }) => {
      await service.changePassword(signed, { currentPassword: text(body, 'currentPassword'), newPassword: text(body, 'newPassword') });
      return { body: {} };
    }),

    'POST /api/account/recovery-code': signedIn(async (signed, { body }) => ({
      body: await service.renewRecoveryCode(signed, { currentPassword: text(body, 'currentPassword') }),
    })),

    'POST /api/account/delete': signedIn(async (signed, { body }) => {
      await service.deleteAccount(signed, { currentPassword: text(body, 'currentPassword') });
      return { body: {}, cookie: null };
    }),

    'POST /api/vault/unlock': signedIn(async (signed, { body }) => ({ body: { vault: await service.unlockVault(signed, { password: text(body, 'password') }) } })),

    'POST /api/vault/lock': signedIn(async (signed) => ({ body: { vault: await service.lockVault(signed) } })),
  };

  const paths = new Set(Object.keys(routes).map((k) => k.split(' ')[1]));

  async function handle(req: AccountRequest): Promise<AccountReply> {
    const reply = (status: number, body: unknown, cookies: string[] = [], extra: Record<string, string> = {}): AccountReply => ({
      status,
      body,
      headers: { ...REPLY_HEADERS, ...extra },
      cookies,
    });
    const sentCookie = readCookie(req.headers.cookie);
    try {
      const route = routes[`${req.method} ${req.path}`];
      if (!route) {
        if (paths.has(req.path)) return reply(405, { error: 'That method is not allowed here.', code: 'bad_request' } satisfies ErrorReply);
        throw new AccountError('not_found', 'Not found.', 404);
      }
      const problem = originProblem(req);
      if (problem) throw new AccountError('bad_origin', problem, 403);

      let body: Record<string, unknown> = {};
      if (req.method === 'POST') {
        // Only a script on the app's own pages can send JSON here: an HTML form on another site cannot.
        if (!/^application\/json\s*(;|$)/i.test(req.headers['content-type'] ?? '')) throw badRequest('Send JSON.');
        if (typeof req.body !== 'object' || req.body === null || Array.isArray(req.body)) throw badRequest('Send a JSON object.');
        body = req.body as Record<string, unknown>;
      }

      const signed = await service.authenticate(sentCookie);
      const outcome = await route({ req, body, signed });
      const cookies =
        typeof outcome.cookie === 'string'
          ? [setCookie(outcome.cookie)]
          : outcome.cookie === null || (sentCookie !== undefined && !signed)
            ? [clearCookie] // signed out, or the browser is still sending a cookie that no longer means anything
            : [];
      return reply(200, outcome.body, cookies);
    } catch (e) {
      if (e instanceof AccountError) {
        const body: ErrorReply = { error: e.message, code: e.code, ...e.extra };
        return reply(e.status, body, [], e.extra.retryAfter ? { 'Retry-After': String(e.extra.retryAfter) } : {});
      }
      // Never the request itself: it can hold a password.
      console.error(`accounts: ${req.method} ${req.path} failed:`, e);
      return reply(500, { error: 'Something went wrong on the server.', code: 'server_error' } satisfies ErrorReply);
    }
  }

  return { handle, cookieName };
}
