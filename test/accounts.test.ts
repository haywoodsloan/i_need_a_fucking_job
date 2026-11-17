import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ErrorReply, SessionReply, SessionSummary } from '../src/account/api';
import { adminToken, clientAddress, readAccountsConfig, startAccounts, type Accounts, type AccountsConfig } from '../server/src/accounts/index';
import { when } from '../server/src/accounts/admin-commands';
import type { AccountReply } from '../server/src/accounts/http';
import { SESSION_IDLE_MS, SESSION_MAX_MS, VAULT_IDLE_MS } from '../server/src/accounts/service';
import type { KdfParams } from '../server/src/accounts/crypto';
import { DatabaseInUse, migrate, openDb, readLock, type Db } from '../server/src/db/db';
import { MIGRATIONS } from '../server/src/db/migrations';

const ORIGIN = 'http://localhost:5173';
const FAST: KdfParams = { alg: 'argon2id', m: 256, t: 1, p: 1 };
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const PASSWORD = 'correct horse battery staple';
const PEPPER = Buffer.alloc(32, 0x11).toString('base64');

let db: Db;
beforeAll(async () => {
  db = await openDb();
});
afterAll(async () => {
  await db.close();
});

let counter = 0;
const newEmail = () => `person${++counter}@example.com`;

/** Passwords the fake breach list knows. */
const BREACHED = new Set(['password1234567', 'qwertyuiopasdfgh']);

interface World {
  accounts: Accounts;
  config: AccountsConfig;
  advance(ms: number): void;
  /** The breach list stops answering. */
  breachServiceDown: { value: boolean };
  breachLookups: string[];
  browser(origin?: string, address?: string): Browser;
  /** An invite accepted, signed in. */
  member(email?: string, password?: string): Promise<{ browser: Browser; email: string; recoveryCode: string }>;
  invite(email: string, admin?: boolean): Promise<string>;
  resetLink(email: string): Promise<string>;
  vaultKeyOf(b: Browser): Promise<string>;
}

interface Browser {
  get(path: string, headers?: Record<string, string | undefined>): Promise<AccountReply>;
  post(path: string, body?: unknown, headers?: Record<string, string | undefined>): Promise<AccountReply>;
  /** The Cookie header this browser would send, if it holds a session cookie. */
  cookie: string | undefined;
  /** The Set-Cookie values of the last reply. */
  lastSetCookie: string[];
}

async function world(env: Record<string, string> = {}, kdf: KdfParams = FAST): Promise<World> {
  let clock = Date.parse('2026-11-17T12:00:00Z');
  const breachServiceDown = { value: false };
  const breachLookups: string[] = [];
  const { createHash } = await import('node:crypto');
  const fetch = async (url: string) => {
    breachLookups.push(url);
    if (breachServiceDown.value) throw new TypeError('fetch failed');
    const prefix = url.slice(-5);
    const lines = ['0000000000000000000000000000000000A:0', 'FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF:3'];
    for (const p of BREACHED) {
      const hash = createHash('sha1').update(p).digest('hex').toUpperCase();
      if (hash.startsWith(prefix)) lines.push(`${hash.slice(5)}:1234`);
    }
    return new Response(lines.join('\r\n'));
  };
  const config = readAccountsConfig({ AUTH_PEPPER: PEPPER, APP_ORIGIN: ORIGIN, ...env })!;
  const accounts = await startAccounts(config, { db, now: () => new Date(clock), fetch, kdf });

  const browser = (origin = ORIGIN, address = '203.0.113.7'): Browser => {
    const b: Browser = {
      cookie: undefined,
      lastSetCookie: [],
      get: (path, headers) => call('GET', path, undefined, headers),
      post: (path, body = {}, headers) => call('POST', path, body, headers),
    };
    async function call(method: string, path: string, body: unknown, extra: Record<string, string | undefined> = {}) {
      const headers: Record<string, string | undefined> = {
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0',
        'sec-fetch-site': 'same-origin',
        ...(method === 'POST' ? { origin, 'content-type': 'application/json' } : {}),
        ...(b.cookie ? { cookie: b.cookie } : {}),
        ...extra,
      };
      const reply = await accounts.http.handle({ method, path, headers, body, address });
      b.lastSetCookie = reply.cookies;
      for (const c of reply.cookies) {
        const [pair] = c.split(';');
        b.cookie = pair.endsWith('=') ? undefined : pair;
      }
      return reply;
    }
    return b;
  };

  const code = (lines: string[]) => /#\/(?:invite|reset)\/([A-Za-z0-9_-]{43})/.exec(lines.join('\n'))![1];
  const invite = async (email: string, admin = false) => code(await runAdmin(accounts, { command: 'invite', email, admin }));
  const resetLink = async (email: string) => code(await runAdmin(accounts, { command: 'reset', email }));

  const member: World['member'] = async (email = newEmail(), password = PASSWORD) => {
    const b = browser();
    const reply = await b.post('/api/auth/accept-invite', { code: await invite(email), password });
    expect(reply.status, JSON.stringify(reply.body)).toBe(200);
    return { browser: b, email, recoveryCode: (reply.body as { recoveryCode: string }).recoveryCode };
  };

  const vaultKeyOf = async (b: Browser) => {
    const signed = await accounts.service.authenticate(b.cookie?.split('=')[1]);
    return accounts.service.withVaultKey(signed!, async (k) => k.toString('hex'));
  };

  return { accounts, config, advance: (ms) => void (clock += ms), breachServiceDown, breachLookups, browser, member, invite, resetLink, vaultKeyOf };
}

async function runAdmin(accounts: Accounts, command: Parameters<typeof import('../server/src/accounts/admin-commands').runAdminCommand>[2]) {
  const { runAdminCommand } = await import('../server/src/accounts/admin-commands');
  return runAdminCommand(accounts.service, accounts.config, command);
}

const err = (reply: AccountReply) => reply.body as ErrorReply;
const session = async (b: Browser) => (await b.get('/api/auth/session')).body as SessionReply;

/** Runs a request that is meant to end in a server error, and returns the reply with what the server logged. */
async function failing(fn: () => Promise<AccountReply>): Promise<{ reply: AccountReply; logged: string }> {
  const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    const reply = await fn();
    return { reply, logged: spy.mock.calls.map((args) => args.map((a) => (a instanceof Error ? `${a.stack}` : String(a))).join(' ')).join('\n') };
  } finally {
    spy.mockRestore();
  }
}

describe('joining with an invite', () => {
  it('creates the account, signs in and hands over a recovery code once', async () => {
    const w = await world();
    const email = newEmail();
    const code = await w.invite(email);
    const b = w.browser();

    const peek = await b.post('/api/auth/invite', { code });
    expect(peek.body).toMatchObject({ kind: 'invite', email });

    const reply = await b.post('/api/auth/accept-invite', { code, password: PASSWORD });
    expect(reply.status).toBe(200);
    expect(reply.body).toMatchObject({ user: { email, role: 'user' } });
    expect((reply.body as { recoveryCode: string }).recoveryCode).toMatch(/^([0-9A-HJKMNP-TV-Z]{4}-){5}[0-9A-HJKMNP-TV-Z]{4}$/);
    expect(await session(b)).toMatchObject({ available: true, user: { email, role: 'user' }, vault: { unlocked: true } });
  });

  it('works once', async () => {
    const w = await world();
    const code = await w.invite(newEmail());
    expect((await w.browser().post('/api/auth/accept-invite', { code, password: PASSWORD })).status).toBe(200);
    const again = await w.browser().post('/api/auth/accept-invite', { code, password: PASSWORD });
    expect(again.status).toBe(400);
    expect(err(again).code).toBe('invalid_code');
    expect(err(await w.browser().post('/api/auth/invite', { code })).code).toBe('invalid_code');
  });

  it('lets only one of two simultaneous requests through', async () => {
    const w = await world();
    const code = await w.invite(newEmail());
    const replies = await Promise.all([w.browser(), w.browser(), w.browser()].map((b) => b.post('/api/auth/accept-invite', { code, password: PASSWORD })));
    expect(replies.map((r) => r.status).sort()).toEqual([200, 400, 400]);
  });

  it('expires after seven days', async () => {
    const w = await world();
    const code = await w.invite(newEmail());
    w.advance(7 * DAY + MINUTE);
    expect(err(await w.browser().post('/api/auth/accept-invite', { code, password: PASSWORD })).code).toBe('invalid_code');
  });

  it('rejects codes that were never issued or are malformed', async () => {
    const w = await world();
    for (const code of ['A'.repeat(43), 'short', '', 42, null, { $ne: '' }]) {
      const reply = await w.browser().post('/api/auth/accept-invite', { code, password: PASSWORD });
      expect(err(reply).code, String(code)).toBe('invalid_code');
    }
  });

  it('gives the newest link only: asking again cancels the earlier one', async () => {
    const w = await world();
    const email = newEmail();
    const first = await w.invite(email);
    const second = await w.invite(email);
    expect(err(await w.browser().post('/api/auth/invite', { code: first })).code).toBe('invalid_code');
    expect((await w.browser().post('/api/auth/invite', { code: second })).status).toBe(200);
  });

  it('can make the invited person an admin', async () => {
    const w = await world();
    const email = newEmail();
    const b = w.browser();
    await b.post('/api/auth/accept-invite', { code: await w.invite(email, true), password: PASSWORD });
    expect((await session(b)).user).toEqual({ email, role: 'admin' });
  });

  it('refuses to invite someone who already has an account', async () => {
    const w = await world();
    const { email } = await w.member();
    await expect(w.invite(email)).rejects.toThrow(/already has an account/);
    await expect(w.invite('not an email')).rejects.toThrow(/does not look like an email/);
  });
});

describe('password rules', () => {
  it('needs 14 characters, and counts characters rather than bytes', async () => {
    const w = await world();
    const email = newEmail();
    const code = await w.invite(email);
    const short = await w.browser().post('/api/auth/accept-invite', { code, password: 'thirteen chars' .slice(0, 13) });
    expect(short.status).toBe(400);
    expect(err(short)).toMatchObject({ code: 'weak_password', problem: 'too_short' });
    // The invite is still good after a rejected password.
    const emoji = '🙂'.repeat(14); // 14 characters, 56 bytes
    expect((await w.browser().post('/api/auth/accept-invite', { code, password: emoji })).status).toBe(200);
  });

  it('refuses the email address as the password', async () => {
    const w = await world();
    const email = 'a.rather.long.address@example.com';
    const reply = await w.browser().post('/api/auth/accept-invite', { code: await w.invite(email), password: email.toUpperCase() });
    expect(err(reply)).toMatchObject({ code: 'weak_password', problem: 'is_email' });
  });

  it('refuses a password found in the breach list, sending only five characters of its hash', async () => {
    const w = await world();
    const code = await w.invite(newEmail());
    const reply = await w.browser().post('/api/auth/accept-invite', { code, password: 'password1234567' });
    expect(err(reply)).toMatchObject({ code: 'weak_password', problem: 'breached' });
    expect(w.breachLookups).toHaveLength(1);
    expect(w.breachLookups[0]).toMatch(/^https:\/\/api\.pwnedpasswords\.com\/range\/[0-9A-F]{5}$/);
  });

  it('accepts the password when the breach list cannot be reached', async () => {
    const w = await world();
    w.breachServiceDown.value = true;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const reply = await w.browser().post('/api/auth/accept-invite', { code: await w.invite(newEmail()), password: 'password1234567' });
      expect(reply.status).toBe(200);
      // The server's log says the check was skipped, and says it once, not for every sign-up.
      await w.browser().post('/api/auth/accept-invite', { code: await w.invite(newEmail()), password: 'password1234567' });
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][0])).toContain('was not checked for a new password (it could not be reached)');
      expect(String(warn.mock.calls[0][0])).not.toContain('password1234567');
    } finally {
      warn.mockRestore();
    }
  });

  it('skips the breach list when it is switched off', async () => {
    const w = await world({ PASSWORD_BREACH_CHECK: '0' });
    const reply = await w.browser().post('/api/auth/accept-invite', { code: await w.invite(newEmail()), password: 'password1234567' });
    expect(reply.status).toBe(200);
    expect(w.breachLookups).toHaveLength(0);
  });

  it('refuses absurdly long passwords without hashing them', async () => {
    const w = await world();
    const reply = await w.browser().post('/api/auth/accept-invite', { code: await w.invite(newEmail()), password: 'x'.repeat(5000) });
    expect(err(reply)).toMatchObject({ code: 'weak_password', problem: 'too_long' });
  });
});

describe('signing in and out', () => {
  it('signs in with the right password and out again', async () => {
    const w = await world();
    const { email } = await w.member();
    const b = w.browser();
    const reply = await b.post('/api/auth/sign-in', { email: `  ${email.toUpperCase()} `, password: PASSWORD });
    expect(reply.status).toBe(200);
    expect(reply.body).toEqual({ user: { email, role: 'user' } });
    expect((await session(b)).user?.email).toBe(email);

    expect((await b.post('/api/auth/sign-out')).status).toBe(200);
    expect(b.cookie).toBeUndefined();
    expect((await session(b)).user).toBeNull();
  });

  it('gives the same answer for a wrong password and an unknown email', async () => {
    const w = await world();
    const { email } = await w.member();
    const wrong = await w.browser().post('/api/auth/sign-in', { email, password: 'not the right password' });
    const unknown = await w.browser().post('/api/auth/sign-in', { email: 'nobody@example.com', password: PASSWORD });
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(wrong.body).toEqual(unknown.body);
    expect(wrong.cookies).toEqual([]);
  });

  it('sets a cookie scripts cannot read and other sites cannot send', async () => {
    const w = await world();
    const { browser: b } = await w.member();
    const [cookie] = b.lastSetCookie;
    expect(cookie).toMatch(/^session=[A-Za-z0-9_-]{43}; /);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Strict');
    expect(cookie).toContain('Path=/');
    expect(cookie).toContain(`Max-Age=${SESSION_MAX_MS / 1000}`);
    expect(cookie).not.toContain('Domain');
    expect(cookie).not.toContain('Secure'); // http://localhost only
  });

  it('uses the __Host- prefix and Secure when the app is on HTTPS', async () => {
    const w = await world({ APP_ORIGIN: 'https://jobs.example.com' });
    const email = newEmail();
    const b = w.browser('https://jobs.example.com');
    await b.post('/api/auth/accept-invite', { code: await w.invite(email), password: PASSWORD });
    expect(b.lastSetCookie[0]).toMatch(/^__Host-session=[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; SameSite=Strict; Secure; Max-Age=\d+$/);
    expect((await session(b)).user?.email).toBe(email);
    await b.post('/api/auth/sign-out');
    expect(b.lastSetCookie[0]).toBe('__Host-session=; Path=/; HttpOnly; SameSite=Strict; Secure; Max-Age=0');
  });

  it('replaces the old session when signing in again', async () => {
    const w = await world();
    const { browser: b, email } = await w.member();
    const before = b.cookie;
    await b.post('/api/auth/sign-in', { email, password: PASSWORD });
    expect(b.cookie).not.toBe(before);
    const old = w.browser();
    old.cookie = before;
    expect((await session(old)).user).toBeNull();
    const list = (await b.get('/api/account/sessions')).body as { sessions: SessionSummary[] };
    expect(list.sessions).toHaveLength(1);
  });

  it('ignores cookies that are not session tokens and tells the browser to drop them', async () => {
    const w = await world();
    const b = w.browser();
    for (const value of ['x', 'A'.repeat(43), `${'A'.repeat(42)}=`, '../../etc/passwd', 'null']) {
      b.cookie = `session=${value}`;
      const reply = await b.get('/api/auth/session');
      expect((reply.body as SessionReply).user).toBeNull();
      expect(reply.cookies).toEqual(['session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0']);
    }
  });

  it('requires a session for the account routes', async () => {
    const w = await world();
    const b = w.browser();
    for (const [method, path] of [
      ['GET', '/api/account/sessions'],
      ['POST', '/api/account/sessions/end'],
      ['POST', '/api/account/sign-out-everywhere'],
      ['POST', '/api/account/password'],
      ['POST', '/api/account/recovery-code'],
      ['POST', '/api/account/delete'],
      ['POST', '/api/vault/unlock'],
      ['POST', '/api/vault/lock'],
    ]) {
      const reply = method === 'GET' ? await b.get(path) : await b.post(path, { currentPassword: PASSWORD, newPassword: PASSWORD, password: PASSWORD, id: 'x' });
      expect(reply.status, path).toBe(401);
      expect(err(reply).code, path).toBe('not_signed_in');
    }
  });
});

describe('sessions', () => {
  it('ends after a week without use', async () => {
    const w = await world();
    const { browser: b } = await w.member();
    w.advance(SESSION_IDLE_MS - MINUTE);
    expect((await session(b)).user).not.toBeNull();
    w.advance(SESSION_IDLE_MS + MINUTE);
    const reply = await b.get('/api/auth/session');
    expect((reply.body as SessionReply).user).toBeNull();
    expect(reply.cookies[0]).toContain('Max-Age=0');
  });

  it('ends after 30 days even when used every day', async () => {
    const w = await world();
    const { browser: b } = await w.member();
    for (let day = 1; day < 30; day++) {
      w.advance(DAY);
      expect((await session(b)).user, `day ${day}`).not.toBeNull();
    }
    w.advance(DAY + MINUTE);
    expect((await session(b)).user).toBeNull();
  });

  it('lists where the account is signed in and can end one of them', async () => {
    const w = await world();
    const { browser: laptop, email } = await w.member();
    const phone = w.browser();
    await phone.post('/api/auth/sign-in', { email, password: PASSWORD }, { 'user-agent': 'Phone/1.0' });

    const { sessions } = (await laptop.get('/api/account/sessions')).body as { sessions: SessionSummary[] };
    expect(sessions).toHaveLength(2);
    expect(sessions[0].current).toBe(true);
    expect(sessions[1]).toMatchObject({ current: false, userAgent: 'Phone/1.0' });
    expect(JSON.stringify(sessions)).not.toContain(laptop.cookie!.split('=')[1]);

    const ended = await laptop.post('/api/account/sessions/end', { id: sessions[1].id });
    expect(ended.status).toBe(200);
    expect(ended.cookies).toEqual([]);
    expect((await session(phone)).user).toBeNull();
    expect((await session(laptop)).user).not.toBeNull();
  });

  it("cannot end another account's session", async () => {
    const w = await world();
    const { browser: mine } = await w.member();
    const { browser: theirs } = await w.member();
    const { sessions } = (await theirs.get('/api/account/sessions')).body as { sessions: SessionSummary[] };
    expect((await mine.post('/api/account/sessions/end', { id: sessions[0].id })).status).toBe(200);
    expect((await session(theirs)).user).not.toBeNull();
    expect(err(await mine.post('/api/account/sessions/end', { id: "' or 1=1 --" })).code).toBe('bad_request');
  });

  it('signs out everywhere', async () => {
    const w = await world();
    const { browser: laptop, email } = await w.member();
    const phone = w.browser();
    await phone.post('/api/auth/sign-in', { email, password: PASSWORD });
    const reply = await laptop.post('/api/account/sign-out-everywhere');
    expect(reply.cookies[0]).toContain('Max-Age=0');
    expect((await session(phone)).user).toBeNull();
    expect((await session(laptop)).user).toBeNull();
  });

  it('lets an admin command sign someone out everywhere', async () => {
    const w = await world();
    const { browser: b, email } = await w.member();
    expect(await runAdmin(w.accounts, { command: 'sign-out', email })).toEqual([`Signed ${email} out of 1 session.`]);
    expect((await session(b)).user).toBeNull();
  });
});

describe('changing the password', () => {
  const NEW = 'a brand new passphrase 2';

  it('needs the current password, keeps this session and ends the others', async () => {
    const w = await world();
    const { browser: laptop, email } = await w.member();
    const phone = w.browser();
    await phone.post('/api/auth/sign-in', { email, password: PASSWORD });
    const vaultKey = await w.vaultKeyOf(laptop);

    const wrong = await laptop.post('/api/account/password', { currentPassword: 'not my password!!', newPassword: NEW });
    expect(wrong.status).toBe(403);
    expect(err(wrong).code).toBe('wrong_password');

    expect((await laptop.post('/api/account/password', { currentPassword: PASSWORD, newPassword: NEW })).status).toBe(200);
    expect((await session(laptop)).user).not.toBeNull();
    expect((await session(phone)).user).toBeNull();

    expect((await w.browser().post('/api/auth/sign-in', { email, password: PASSWORD })).status).toBe(401);
    const fresh = w.browser();
    expect((await fresh.post('/api/auth/sign-in', { email, password: NEW })).status).toBe(200);
    // The vault key is the same one, now locked by the new password.
    expect(await w.vaultKeyOf(fresh)).toBe(vaultKey);
    expect(await w.vaultKeyOf(laptop)).toBe(vaultKey);
  });

  it('applies the password rules to the new one', async () => {
    const w = await world();
    const { browser: b } = await w.member();
    expect(err(await b.post('/api/account/password', { currentPassword: PASSWORD, newPassword: 'too short' })).problem).toBe('too_short');
    expect(err(await b.post('/api/account/password', { currentPassword: PASSWORD, newPassword: 'qwertyuiopasdfgh' })).problem).toBe('breached');
    expect(err(await b.post('/api/account/password', { currentPassword: PASSWORD, newPassword: PASSWORD })).code).toBe('bad_request');
    expect((await w.browser().post('/api/auth/sign-in', { email: (await session(b)).user!.email, password: PASSWORD })).status).toBe(200);
  });
});

describe('recovery', () => {
  const NEW = 'a brand new passphrase 3';

  it('sets a new password with the recovery code and keeps the vault key', async () => {
    const w = await world();
    const { browser: old, email, recoveryCode } = await w.member();
    const vaultKey = await w.vaultKeyOf(old);

    const typed = ` ${recoveryCode.toLowerCase().replace(/-/g, ' ')} `;
    const reply = await w.browser().post('/api/auth/recover', { email, recoveryCode: typed, password: NEW });
    expect(reply.status).toBe(200);
    const next = (reply.body as { recoveryCode: string }).recoveryCode;
    expect(next).not.toBe(recoveryCode);

    expect((await session(old)).user).toBeNull(); // every session is ended
    expect((await w.browser().post('/api/auth/sign-in', { email, password: PASSWORD })).status).toBe(401);
    const b = w.browser();
    expect((await b.post('/api/auth/sign-in', { email, password: NEW })).status).toBe(200);
    expect(await w.vaultKeyOf(b)).toBe(vaultKey);

    // The used code is spent, and the new one works.
    expect((await w.browser().post('/api/auth/recover', { email, recoveryCode, password: 'yet another passphrase' })).status).toBe(401);
    expect((await w.browser().post('/api/auth/recover', { email, recoveryCode: next, password: 'yet another passphrase' })).status).toBe(200);
  });

  it('gives the same answer for a wrong code and an unknown email', async () => {
    const w = await world();
    const { email } = await w.member();
    const wrong = await w.browser().post('/api/auth/recover', { email, recoveryCode: 'ABCD-0123-EFGH-4567-JKMN-89PQ', password: NEW });
    const unknown = await w.browser().post('/api/auth/recover', { email: 'nobody@example.com', recoveryCode: 'ABCD-0123-EFGH-4567-JKMN-89PQ', password: NEW });
    const garbage = await w.browser().post('/api/auth/recover', { email, recoveryCode: 'not a code', password: NEW });
    expect(wrong.status).toBe(401);
    expect(wrong.body).toEqual(unknown.body);
    expect(wrong.body).toEqual(garbage.body);
    expect((await w.browser().post('/api/auth/sign-in', { email, password: PASSWORD })).status).toBe(200);
  });

  it('does not use up the code when the new password is turned down', async () => {
    const w = await world();
    const { email, recoveryCode } = await w.member();
    expect(err(await w.browser().post('/api/auth/recover', { email, recoveryCode, password: 'short' })).code).toBe('weak_password');
    expect((await w.browser().post('/api/auth/recover', { email, recoveryCode, password: NEW })).status).toBe(200);
  });

  it("does not open another account's vault", async () => {
    const w = await world();
    const a = await w.member();
    const b = await w.member();
    expect((await w.browser().post('/api/auth/recover', { email: b.email, recoveryCode: a.recoveryCode, password: NEW })).status).toBe(401);
  });

  it('issues a new recovery code to someone who knows the password', async () => {
    const w = await world();
    const { browser: b, email, recoveryCode } = await w.member();
    expect((await b.post('/api/account/recovery-code', { currentPassword: 'wrong wrong wrong' })).status).toBe(403);
    const reply = await b.post('/api/account/recovery-code', { currentPassword: PASSWORD });
    const next = (reply.body as { recoveryCode: string }).recoveryCode;
    expect(next).not.toBe(recoveryCode);
    expect((await w.browser().post('/api/auth/recover', { email, recoveryCode, password: NEW })).status).toBe(401);
    expect((await w.browser().post('/api/auth/recover', { email, recoveryCode: next, password: NEW })).status).toBe(200);
  });
});

describe('an admin reset link', () => {
  const NEW = 'a brand new passphrase 4';

  it('sets a new password but cannot keep the vault key', async () => {
    const w = await world();
    const { browser: old, email, recoveryCode } = await w.member();
    const vaultKey = await w.vaultKeyOf(old);
    const code = await w.resetLink(email);

    expect((await w.browser().post('/api/auth/invite', { code })).body).toMatchObject({ kind: 'reset', email });
    const reply = await w.browser().post('/api/auth/reset', { code, password: NEW });
    expect(reply.status).toBe(200);
    expect(reply.body).toMatchObject({ email });
    const nextCode = (reply.body as { recoveryCode: string }).recoveryCode;

    expect((await session(old)).user).toBeNull();
    const b = w.browser();
    expect((await b.post('/api/auth/sign-in', { email, password: NEW })).status).toBe(200);
    const replaced = await w.vaultKeyOf(b);
    expect(replaced).not.toBe(vaultKey);
    expect(replaced).toMatch(/^[0-9a-f]{64}$/);

    // The old recovery code went with the old vault key. The new one belongs to the new key.
    expect((await w.browser().post('/api/auth/recover', { email, recoveryCode, password: 'yet another passphrase' })).status).toBe(401);
    expect((await w.browser().post('/api/auth/recover', { email, recoveryCode: nextCode, password: 'yet another passphrase' })).status).toBe(200);
    const [row] = await db.query<{ vault_generation: number }>('select vault_generation from users where email = $1', [email]);
    expect(row.vault_generation).toBe(2);
  });

  it('works once and lasts a day', async () => {
    const w = await world();
    const { email } = await w.member();
    const code = await w.resetLink(email);
    expect((await w.browser().post('/api/auth/reset', { code, password: NEW })).status).toBe(200);
    expect(err(await w.browser().post('/api/auth/reset', { code, password: 'one more passphrase!' })).code).toBe('invalid_code');

    const late = await w.resetLink(email);
    w.advance(DAY + MINUTE);
    expect(err(await w.browser().post('/api/auth/reset', { code: late, password: 'one more passphrase!' })).code).toBe('invalid_code');
  });

  it('is not an invite, and an invite is not a reset link', async () => {
    const w = await world();
    const { email } = await w.member();
    const reset = await w.resetLink(email);
    const invite = await w.invite(newEmail());
    expect(err(await w.browser().post('/api/auth/accept-invite', { code: reset, password: NEW })).code).toBe('invalid_code');
    expect(err(await w.browser().post('/api/auth/reset', { code: invite, password: NEW })).code).toBe('invalid_code');
  });

  it('cannot be made for someone without an account', async () => {
    const w = await world();
    await expect(w.resetLink('nobody@example.com')).rejects.toThrow(/no account/);
  });
});

describe('deleting the account', () => {
  it('needs the password and removes everything', async () => {
    const w = await world();
    const { browser: b, email } = await w.member();
    const phone = w.browser();
    await phone.post('/api/auth/sign-in', { email, password: PASSWORD });

    expect((await b.post('/api/account/delete', { currentPassword: 'definitely not it' })).status).toBe(403);
    const reply = await b.post('/api/account/delete', { currentPassword: PASSWORD });
    expect(reply.status).toBe(200);
    expect(reply.cookies[0]).toContain('Max-Age=0');
    expect((await session(phone)).user).toBeNull();
    expect((await w.browser().post('/api/auth/sign-in', { email, password: PASSWORD })).status).toBe(401);
    expect(await db.query('select 1 from users where email = $1', [email])).toEqual([]);
    expect(await db.query('select 1 from sessions s join users u on u.id = s.user_id where u.email = $1', [email])).toEqual([]);
    // The address is free again.
    expect((await w.browser().post('/api/auth/accept-invite', { code: await w.invite(email), password: PASSWORD })).status).toBe(200);
  });
});

describe('the vault key', () => {
  it('is unlocked by signing in and locks itself after an hour without use', async () => {
    const w = await world();
    const { browser: b } = await w.member();
    expect((await session(b)).vault).toMatchObject({ unlocked: true });
    w.advance(VAULT_IDLE_MS - MINUTE);
    expect((await session(b)).vault?.unlocked).toBe(true);
    w.advance(2 * MINUTE);
    expect((await session(b)).vault).toEqual({ unlocked: false });
    await expect(w.vaultKeyOf(b)).rejects.toMatchObject({ code: 'vault_locked' });
    // The expired copy is deleted, not just ignored.
    const signed = await w.accounts.service.authenticate(b.cookie!.split('=')[1]);
    const [row] = await db.query<{ vault_by_session: Buffer | null }>('select vault_by_session from sessions where sid = $1', [signed!.sid]);
    expect(row.vault_by_session).toBeNull();
    // Still signed in: only the vault is locked.
    expect((await session(b)).user).not.toBeNull();
  });

  it('stays unlocked while it is being used', async () => {
    const w = await world();
    const { browser: b } = await w.member();
    const key = await w.vaultKeyOf(b);
    for (let i = 0; i < 5; i++) {
      w.advance(VAULT_IDLE_MS - MINUTE);
      expect(await w.vaultKeyOf(b)).toBe(key);
    }
  });

  it('locks on request and unlocks with the password', async () => {
    const w = await world();
    const { browser: b } = await w.member();
    const key = await w.vaultKeyOf(b);
    expect((await b.post('/api/vault/lock')).body).toEqual({ vault: { unlocked: false } });
    await expect(w.vaultKeyOf(b)).rejects.toMatchObject({ code: 'vault_locked' });

    expect((await b.post('/api/vault/unlock', { password: 'wrong password here' })).status).toBe(403);
    await expect(w.vaultKeyOf(b)).rejects.toMatchObject({ code: 'vault_locked' });

    const reply = await b.post('/api/vault/unlock', { password: PASSWORD });
    expect(reply.body).toMatchObject({ vault: { unlocked: true } });
    expect(await w.vaultKeyOf(b)).toBe(key);
  });

  it('cannot be opened with another session, even of the same account', async () => {
    const w = await world();
    const { browser: laptop, email } = await w.member();
    const phone = w.browser();
    await phone.post('/api/auth/sign-in', { email, password: PASSWORD });
    const a = (await w.accounts.service.authenticate(laptop.cookie!.split('=')[1]))!;
    const b = (await w.accounts.service.authenticate(phone.cookie!.split('=')[1]))!;
    // The phone's token against the laptop's row: the copy does not open.
    await expect(w.accounts.service.withVaultKey({ ...a, token: b.token }, async (k) => k.toString('hex'))).rejects.toThrow('Could not open the sealed value');
    // Swap the stored copies between the two rows: neither opens.
    const rows = await db.query<{ sid: Buffer; vault_by_session: Buffer }>('select sid, vault_by_session from sessions where sid = $1 or sid = $2', [a.sid, b.sid]);
    await db.run('update sessions set vault_by_session = $1 where sid = $2', [rows[1].vault_by_session, rows[0].sid]);
    await db.run('update sessions set vault_by_session = $1 where sid = $2', [rows[0].vault_by_session, rows[1].sid]);
    await expect(w.vaultKeyOf(laptop)).rejects.toThrow('Could not open the sealed value');
    await expect(w.vaultKeyOf(phone)).rejects.toThrow('Could not open the sealed value');
  });

  it("does not open with another account's copy", async () => {
    const w = await world();
    const mine = await w.member();
    const theirs = await w.member();
    const [their] = await db.query<{ vault_by_password: Buffer }>('select vault_by_password from users where email = $1', [theirs.email]);
    await db.run('update users set vault_by_password = $1 where email = $2', [their.vault_by_password, mine.email]);
    // Same password on both accounts, and still the copied value does not open: it is tied to its owner.
    const { reply, logged } = await failing(() => w.browser().post('/api/auth/sign-in', { email: mine.email, password: PASSWORD }));
    expect(reply.status).toBe(500);
    expect(err(reply)).toEqual({ error: 'Something went wrong on the server.', code: 'server_error' });
    // The server's own log says what went wrong, and never what was typed.
    expect(logged).toContain('POST /api/auth/sign-in failed');
    expect(logged).toContain('Could not open the sealed value');
    expect(logged).not.toContain(PASSWORD);
  });

  it('wipes the key it hands out once the caller is done', async () => {
    const w = await world();
    const { browser: b } = await w.member();
    const signed = (await w.accounts.service.authenticate(b.cookie!.split('=')[1]))!;
    let kept: Buffer | undefined;
    await w.accounts.service.withVaultKey(signed, async (k) => void (kept = k));
    expect(kept!.equals(Buffer.alloc(32))).toBe(true);
  });
});

describe('what the database holds', () => {
  it('has no password, session token, recovery code or vault key in it, in any form it could be read from', async () => {
    const w = await world();
    const password = 'a very particular passphrase';
    const { browser: b, email, recoveryCode } = await w.member(newEmail(), password);
    const token = b.cookie!.split('=')[1];
    const vaultKey = await w.vaultKeyOf(b);
    const inviteCode = await w.invite(newEmail());

    const dump: string[] = [];
    for (const table of ['users', 'sessions', 'invites', 'audit_log']) {
      for (const row of await db.query<Record<string, unknown>>(`select * from ${table}`)) {
        for (const value of Object.values(row)) {
          if (Buffer.isBuffer(value)) dump.push(value.toString('hex'), value.toString('base64'), value.toString('base64url'), value.toString('latin1'));
          else dump.push(typeof value === 'string' ? value : JSON.stringify(value));
        }
      }
    }
    const all = dump.join('\n');
    expect(all).toContain(email); // the check does see the data
    const raw = (text: string) => Buffer.from(text, 'base64url');
    for (const [name, secret] of [
      ['password', Buffer.from(password)],
      ['session token', raw(token)],
      ['vault key', Buffer.from(vaultKey, 'hex')],
      ['recovery code', Buffer.from(recoveryCode.replace(/-/g, ''))],
      ['invite code', raw(inviteCode)],
      ['server secret', Buffer.from(PEPPER, 'base64')],
    ] as const) {
      for (const form of [secret.toString('hex'), secret.toString('base64'), secret.toString('base64url'), secret.toString('latin1')]) {
        expect(all.includes(form), `${name} found in the database`).toBe(false);
      }
    }
    expect(all).not.toContain(recoveryCode);
  });

  it('cannot be turned back into a working session', async () => {
    const w = await world();
    const { browser: b } = await w.member();
    const signed = (await w.accounts.service.authenticate(b.cookie!.split('=')[1]))!;
    // An attacker who read the sessions table has the row id. Sent as a cookie, it is just an unknown token.
    const thief = w.browser();
    for (const stolen of [signed.sid.toString('base64url'), signed.publicId]) {
      thief.cookie = `session=${stolen}`;
      expect((await session(thief)).user).toBeNull();
    }
  });

  it('records sign-ins and failures without recording what was typed', async () => {
    const w = await world();
    const { email } = await w.member();
    await w.browser().post('/api/auth/sign-in', { email, password: 'oops-my-other-password' });
    await w.browser().post('/api/auth/sign-in', { email: 'oops-my-password@example.com', password: 'x' });
    const rows = await db.query<{ event: string; detail: unknown; user_id: string | null }>('select event, detail, user_id from audit_log order by id desc limit 4');
    expect(rows.map((r) => r.event)).toEqual(['sign_in_failed', 'sign_in_failed', 'account_created', 'invite_created']);
    expect(JSON.stringify(rows)).not.toContain('oops');
    expect(rows[0].user_id).toBeNull();
    expect(rows[1].user_id).not.toBeNull();
  });
});

describe('guessing', () => {
  it('stops after ten tries at one account, even for the right password, and recovers after the window', async () => {
    const w = await world();
    const { email } = await w.member();
    for (let i = 0; i < 10; i++) {
      expect((await w.browser(ORIGIN, `198.51.100.${i}`).post('/api/auth/sign-in', { email, password: `wrong password ${i}` })).status).toBe(401);
    }
    const blocked = await w.browser(ORIGIN, '198.51.100.99').post('/api/auth/sign-in', { email, password: PASSWORD });
    expect(blocked.status).toBe(429);
    expect(err(blocked).code).toBe('rate_limited');
    expect(err(blocked).retryAfter).toBeGreaterThan(14 * 60);
    expect(blocked.headers['Retry-After']).toBe(String(err(blocked).retryAfter));

    w.advance(15 * MINUTE + 1000);
    expect((await w.browser().post('/api/auth/sign-in', { email, password: PASSWORD })).status).toBe(200);
  });

  it('forgets the failures once the right password is given', async () => {
    const w = await world();
    const { email } = await w.member();
    for (let round = 0; round < 3; round++) {
      for (let i = 0; i < 8; i++) await w.browser().post('/api/auth/sign-in', { email, password: 'wrong password here' });
      expect((await w.browser(ORIGIN, '198.51.100.200').post('/api/auth/sign-in', { email, password: PASSWORD })).status, `round ${round}`).toBe(200);
      w.advance(15 * MINUTE + 1000); // the address counter is separate and needs the window to pass
    }
  });

  it('stops one address trying many accounts', async () => {
    const w = await world();
    const b = w.browser(ORIGIN, '198.51.100.50');
    for (let i = 0; i < 50; i++) expect((await b.post('/api/auth/sign-in', { email: `user${i}@example.com`, password: 'some password!' })).status).toBe(401);
    expect((await b.post('/api/auth/sign-in', { email: 'user50@example.com', password: 'some password!' })).status).toBe(429);
    // Someone else is not affected.
    expect((await w.browser(ORIGIN, '198.51.100.51').post('/api/auth/sign-in', { email: 'user50@example.com', password: 'some password!' })).status).toBe(401);
  });

  it('limits recovery codes, link codes and password re-entry the same way', async () => {
    const w = await world();
    const { browser: b, email } = await w.member();
    for (let i = 0; i < 10; i++) await w.browser().post('/api/auth/recover', { email, recoveryCode: 'ABCD-0123-EFGH-4567-JKMN-89PQ', password: PASSWORD });
    expect((await w.browser().post('/api/auth/recover', { email, recoveryCode: 'ABCD-0123-EFGH-4567-JKMN-89PQ', password: PASSWORD })).status).toBe(429);

    for (let i = 0; i < 10; i++) expect((await b.post('/api/account/password', { currentPassword: `guess number ${i}`, newPassword: 'whatever it will be' })).status).toBe(403);
    expect((await b.post('/api/account/delete', { currentPassword: PASSWORD })).status).toBe(429);

    const prober = w.browser(ORIGIN, '198.51.100.77');
    for (let i = 0; i < 50; i++) await prober.post('/api/auth/invite', { code: 'A'.repeat(43) });
    expect((await prober.post('/api/auth/invite', { code: 'A'.repeat(43) })).status).toBe(429);
  });
});

describe('requests from somewhere else', () => {
  it('refuses a change that does not come from the app itself', async () => {
    const w = await world();
    const { browser: b, email } = await w.member();
    const body = { email, password: PASSWORD };
    const cases: [string, Record<string, string | undefined>][] = [
      ['another site', { origin: 'https://evil.example' }],
      ['another port on this machine', { origin: 'http://localhost:3000' }],
      ['the same host over https', { origin: 'https://localhost:5173' }],
      ['no origin at all', { origin: undefined }],
      ['the literal null origin', { origin: 'null' }],
      ['a cross-site fetch that lies about its origin', { 'sec-fetch-site': 'cross-site' }],
      ['a same-site sibling', { 'sec-fetch-site': 'same-site' }],
    ];
    for (const [name, headers] of cases) {
      const reply = await b.post('/api/auth/sign-in', body, headers);
      expect(reply.status, name).toBe(403);
      expect(err(reply).code, name).toBe('bad_origin');
      expect(reply.cookies, name).toEqual([]);
    }
    // The signed-in browser's own destructive request is refused the same way when another site triggers it.
    expect((await b.post('/api/account/delete', { currentPassword: PASSWORD }, { origin: 'https://evil.example' })).status).toBe(403);
    expect((await session(b)).user).not.toBeNull();
  });

  it('refuses a form post, which is the one kind of request another site can send without asking', async () => {
    const w = await world();
    const b = w.browser();
    for (const type of ['application/x-www-form-urlencoded', 'text/plain', 'multipart/form-data; boundary=x', undefined, 'application/jsonp']) {
      const reply = await b.post('/api/auth/sign-in', { email: 'a@example.com', password: PASSWORD }, { 'content-type': type });
      expect(reply.status, String(type)).toBe(400);
    }
    expect((await b.post('/api/auth/sign-in', { email: 'a@example.com', password: PASSWORD }, { 'content-type': 'application/json; charset=utf-8' })).status).toBe(401);
  });

  it('refuses reads fetched by another site, and allows the app and a typed address', async () => {
    const w = await world();
    const { browser: b } = await w.member();
    expect((await b.get('/api/auth/session', { 'sec-fetch-site': 'cross-site' })).status).toBe(403);
    expect((await b.get('/api/auth/session', { 'sec-fetch-site': 'same-site' })).status).toBe(403);
    expect((await b.get('/api/auth/session', { origin: 'https://evil.example' })).status).toBe(403);
    expect((await b.get('/api/auth/session', { 'sec-fetch-site': 'none' })).status).toBe(200);
    expect((await b.get('/api/auth/session', { 'sec-fetch-site': undefined })).status).toBe(200);
  });

  it('never sends CORS headers and never lets a reply be cached', async () => {
    const w = await world();
    const { browser: b } = await w.member();
    const replies = [
      await b.get('/api/auth/session'),
      await b.post('/api/auth/sign-in', {}, { origin: 'https://evil.example' }),
      await b.get('/api/nothing-here'),
      await b.post('/api/auth/sign-out'),
    ];
    for (const reply of replies) {
      const names = Object.keys(reply.headers).map((h) => h.toLowerCase());
      expect(names.filter((h) => h.startsWith('access-control-'))).toEqual([]);
      expect(reply.headers['Cache-Control']).toBe('no-store');
      expect(reply.headers['X-Content-Type-Options']).toBe('nosniff');
      expect(reply.headers['Content-Security-Policy']).toContain("frame-ancestors 'none'");
    }
  });

  it('answers unknown paths and wrong methods plainly', async () => {
    const w = await world();
    const b = w.browser();
    expect((await b.get('/api/auth/nope')).status).toBe(404);
    expect((await b.get('/api/auth/sign-in')).status).toBe(405);
    expect((await b.post('/api/auth/session')).status).toBe(405);
  });

  it('rejects bodies that are not what the route expects', async () => {
    const w = await world();
    const b = w.browser();
    for (const body of [[], 'text', 42, null]) expect((await b.post('/api/auth/sign-in', body)).status).toBe(400);
    for (const body of [{}, { email: 'a@example.com' }, { email: 'a@example.com', password: 42 }, { email: ['a@example.com'], password: PASSWORD }, { email: 'a@example.com', password: '' }]) {
      const reply = await b.post('/api/auth/sign-in', body);
      expect(reply.status).toBe(400);
      expect(err(reply).code).toBe('bad_request');
    }
  });
});

describe('settings', () => {
  it('is switched off without a server secret', () => {
    expect(readAccountsConfig({})).toBeUndefined();
    expect(readAccountsConfig({ AUTH_PEPPER: '' })).toBeUndefined();
  });

  it('rejects a secret of the wrong size', () => {
    expect(() => readAccountsConfig({ AUTH_PEPPER: 'c2hvcnQ=' })).toThrow(/32 random bytes/);
    expect(() => readAccountsConfig({ AUTH_PEPPER: 'not base64 at all!' })).toThrow(/32 random bytes/);
  });

  it('defaults to the local addresses and plain-http cookies', () => {
    const config = readAccountsConfig({ AUTH_PEPPER: PEPPER, PORT: '9000' })!;
    expect(config.origins).toEqual(['http://localhost:5173', 'http://localhost:9000']);
    expect(config.secureCookies).toBe(false);
    expect(config.pepperVersion).toBe(1);
    expect(config.breachCheck).toBe(true);
    expect(config.trustedProxies).toBe(0);
    // Settings left blank, as in a copied .env.example, mean the same as settings left out.
    const blank = readAccountsConfig({ AUTH_PEPPER: PEPPER, PORT: '9000', APP_ORIGIN: '', AUTH_PEPPER_OLD: '', ACCOUNTS_DATA_DIR: '', PASSWORD_BREACH_CHECK: '', TRUST_PROXY: '' })!;
    expect(blank).toEqual(config);
    expect(readAccountsConfig({ AUTH_PEPPER: '' })).toBeUndefined();
    expect(() => readAccountsConfig({ AUTH_PEPPER: PEPPER, APP_ORIGIN: ' , ' })).toThrow('APP_ORIGIN has no address in it.');
  });

  it('takes the client address from proxy headers only when told how many proxies there are', () => {
    // No proxy: the header is whatever the caller typed, so it is ignored.
    expect(clientAddress('198.51.100.4', '203.0.113.9', 0)).toBe('198.51.100.4');
    // One proxy: it appended the address it saw. Anything in front of that came from the caller.
    expect(clientAddress('10.0.0.1', '203.0.113.9', 1)).toBe('203.0.113.9');
    expect(clientAddress('10.0.0.1', '1.2.3.4, 203.0.113.9', 1)).toBe('203.0.113.9');
    expect(clientAddress('10.0.0.1', ['1.2.3.4', '5.6.7.8 , 203.0.113.9'], 1)).toBe('203.0.113.9');
    // Two proxies: the outer one's entry is second from the end.
    expect(clientAddress('10.0.0.1', '1.2.3.4, 203.0.113.9, 10.0.0.2', 2)).toBe('203.0.113.9');
    // Fewer entries than proxies: the request did not come through them, so only the connection is believed.
    expect(clientAddress('198.51.100.4', undefined, 1)).toBe('198.51.100.4');
    expect(clientAddress('198.51.100.4', '203.0.113.9', 2)).toBe('198.51.100.4');
    expect(clientAddress(undefined, undefined, 0)).toBe('unknown');

    expect(readAccountsConfig({ AUTH_PEPPER: PEPPER, TRUST_PROXY: '1' })!.trustedProxies).toBe(1);
    expect(() => readAccountsConfig({ AUTH_PEPPER: PEPPER, TRUST_PROXY: 'yes' })).toThrow('TRUST_PROXY must be the number of proxies');
  });

  it('insists on https anywhere but this machine', () => {
    expect(() => readAccountsConfig({ AUTH_PEPPER: PEPPER, APP_ORIGIN: 'http://jobs.example.com' })).toThrow(/must be https/);
    expect(() => readAccountsConfig({ AUTH_PEPPER: PEPPER, APP_ORIGIN: 'http://192.168.1.20:5173' })).toThrow(/must be https/);
    expect(() => readAccountsConfig({ AUTH_PEPPER: PEPPER, APP_ORIGIN: 'ftp://localhost' })).toThrow(/must be https/);
    expect(() => readAccountsConfig({ AUTH_PEPPER: PEPPER, APP_ORIGIN: 'jobs.example.com' })).toThrow(/not an address/);
    const config = readAccountsConfig({ AUTH_PEPPER: PEPPER, APP_ORIGIN: 'https://jobs.example.com/, http://127.0.0.1:5173' })!;
    expect(config.origins).toEqual(['https://jobs.example.com', 'http://127.0.0.1:5173']);
    expect(config.secureCookies).toBe(false);
    expect(readAccountsConfig({ AUTH_PEPPER: PEPPER, APP_ORIGIN: 'https://jobs.example.com' })!.secureCookies).toBe(true);
  });

  it('moves a user to stronger hashing settings the next time they sign in', async () => {
    const before = await world();
    const { email, browser: b } = await before.member();
    const vaultKey = await before.vaultKeyOf(b);
    const stronger: KdfParams = { alg: 'argon2id', m: 512, t: 2, p: 1 };
    const after = await world({}, stronger);

    const [old] = await db.query<{ kdf: KdfParams; salt: Buffer }>('select kdf, salt from users where email = $1', [email]);
    expect(old.kdf).toEqual(FAST);
    expect((await after.browser().post('/api/auth/sign-in', { email, password: 'the wrong password!!' })).status).toBe(401);
    const signedIn = after.browser();
    expect((await signedIn.post('/api/auth/sign-in', { email, password: PASSWORD })).status).toBe(200);
    const [now] = await db.query<{ kdf: KdfParams; salt: Buffer }>('select kdf, salt from users where email = $1', [email]);
    expect(now.kdf).toEqual(stronger);
    expect(now.salt.equals(old.salt)).toBe(false);
    expect(await after.vaultKeyOf(signedIn)).toBe(vaultKey);
    expect((await after.browser().post('/api/auth/sign-in', { email, password: PASSWORD })).status).toBe(200);
  });

  it('moves a user to a new server secret the next time they sign in', async () => {
    const v1 = await world();
    const { email } = await v1.member();
    const next = Buffer.alloc(32, 0x22).toString('base64');

    // The new secret alone cannot check a password hashed with the old one: that is a setup mistake, not a wrong password.
    const broken = await world({ AUTH_PEPPER: `2:${next}` });
    const { reply, logged } = await failing(() => broken.browser().post('/api/auth/sign-in', { email, password: PASSWORD }));
    expect(reply.status).toBe(500);
    expect(logged).toContain('Password secret version 1 is not configured');
    expect(logged).not.toContain(PASSWORD);

    const rotating = await world({ AUTH_PEPPER: `2:${next}`, AUTH_PEPPER_OLD: `1:${PEPPER}` });
    expect((await rotating.browser().post('/api/auth/sign-in', { email, password: PASSWORD })).status).toBe(200);
    const [row] = await db.query<{ pepper_version: number }>('select pepper_version from users where email = $1', [email]);
    expect(row.pepper_version).toBe(2);

    // Once everyone has signed in, the old secret can be dropped.
    expect((await broken.browser().post('/api/auth/sign-in', { email, password: PASSWORD })).status).toBe(200);
  });
});

describe('admin commands', () => {
  it('prints links that point at the app', async () => {
    const w = await world({ APP_ORIGIN: 'https://jobs.example.com, http://localhost:5173' });
    const email = newEmail();
    const lines = await runAdmin(w.accounts, { command: 'invite', email });
    expect(lines.join('\n')).toMatch(new RegExp(`^Invite for ${email}, good for 7 days:\\n\\n  https://jobs\\.example\\.com/#/invite/[A-Za-z0-9_-]{43}\\n`));
    await w.member(email);
    expect((await runAdmin(w.accounts, { command: 'reset', email })).join('\n')).toMatch(new RegExp(`^Password reset for ${email}, good for 24 hours:\\n\\n  https://jobs\\.example\\.com/#/reset/[A-Za-z0-9_-]{43}\\n`));
    await expect(runAdmin(w.accounts, { command: 'nope' } as never)).rejects.toThrow(/Unknown admin command/);
  });

  it('lists accounts', async () => {
    const w = await world();
    const { email } = await w.member();
    const lines = await runAdmin(w.accounts, { command: 'users' });
    expect(lines[0]).toMatch(/^Email\s+Role\s+Created\s+Signed in$/);
    // Times are shown on the clock of the machine the command runs on.
    const noon = when(new Date('2026-11-17T12:00:00Z'));
    expect(lines.find((l) => l.startsWith(`${email} `))).toMatch(new RegExp(`^${email} +user   ${noon}  1 session, last used ${noon}$`));
  });
});

describe('the server in front of it', () => {
  let server: Server;
  let base: string;
  let w: World;

  beforeAll(async () => {
    w = await world();
    server = createServer((req, res) => void w.accounts.handle(req, res, new URL(req.url ?? '/', 'http://x')));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address() as { port: number };
    base = `http://127.0.0.1:${address.port}`;
  });
  afterAll(() => new Promise((resolve) => server.close(resolve)));

  const post = (path: string, body: string, headers: Record<string, string> = {}) =>
    fetch(base + path, { method: 'POST', body, headers: { 'Content-Type': 'application/json', Origin: ORIGIN, ...headers } });

  it('knows which paths are its own', () => {
    for (const path of ['/api/auth/session', '/api/account/sessions', '/api/vault/lock', '/api/admin/run', '/api/auth']) expect(w.accounts.owns(path), path).toBe(true);
    for (const path of ['/api/search', '/api/job', '/api/health', '/api/authx', '/', '/api/accounts']) expect(w.accounts.owns(path), path).toBe(false);
  });

  it('signs in over real HTTP and sets the cookie', async () => {
    const { email } = await w.member();
    const res = await post('/api/auth/sign-in', JSON.stringify({ email, password: PASSWORD }));
    expect(res.status).toBe(200);
    expect(res.headers.get('set-cookie')).toMatch(/^session=[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; SameSite=Strict; Max-Age=2592000$/);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
    const cookie = res.headers.get('set-cookie')!.split(';')[0];
    const me = await fetch(`${base}/api/auth/session`, { headers: { Cookie: cookie } });
    expect(((await me.json()) as SessionReply).user?.email).toBe(email);
  });

  it('refuses bodies that are too large or not JSON', async () => {
    const big = await post('/api/auth/sign-in', JSON.stringify({ email: 'a@example.com', password: 'x'.repeat(20_000) }));
    expect(big.status).toBe(413);
    const broken = await post('/api/auth/sign-in', '{"email": ');
    expect(broken.status).toBe(400);
    expect(((await broken.json()) as ErrorReply).code).toBe('bad_request');
  });

  it('runs admin commands only for a local caller that knows the secret', async () => {
    const token = adminToken(w.config).toString('hex');
    const body = JSON.stringify({ command: 'users' });
    const ok = await fetch(`${base}/api/admin/run`, { method: 'POST', body, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` } });
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { ok: boolean; lines: string[] }).ok).toBe(true);

    const refused: Record<string, string>[] = [
      {}, // no secret
      { Authorization: `Bearer ${'0'.repeat(64)}` },
      { Authorization: `Bearer ${token.slice(0, 62)}` },
      { Authorization: `Bearer ${token}`, Origin: ORIGIN }, // a browser always names the page a POST came from
      { Authorization: `Bearer ${token}`, 'X-Forwarded-For': '203.0.113.9' }, // arrived through a proxy
    ];
    for (const headers of refused) {
      const res = await fetch(`${base}/api/admin/run`, { method: 'POST', body, headers: { 'Content-Type': 'application/json', ...headers } });
      expect(res.status, JSON.stringify(headers)).toBe(404);
    }
    expect((await fetch(`${base}/api/admin/run`, { headers: { Authorization: `Bearer ${token}` } })).status).toBe(404);

    const failed = await fetch(`${base}/api/admin/run`, { method: 'POST', body: JSON.stringify({ command: 'reset', email: 'nobody@example.com' }), headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` } });
    expect(await failed.json()).toEqual({ ok: false, error: 'There is no account for nobody@example.com.' });
  });
});

describe('the database folder', () => {
  it('applies each schema change once', async () => {
    const fresh = await openDb();
    try {
      expect(await migrate(fresh, MIGRATIONS)).toEqual(MIGRATIONS.map((m) => m.version));
      expect(await migrate(fresh, MIGRATIONS)).toEqual([]);
      const tables = await fresh.query<{ table_name: string }>("select table_name from information_schema.tables where table_schema = 'public' order by 1");
      expect(tables.map((t) => t.table_name)).toEqual(['audit_log', 'invites', 'schema_migrations', 'sessions', 'users']);
    } finally {
      await fresh.close();
    }
  });

  it('undoes everything in a transaction that fails', async () => {
    const email = newEmail();
    await expect(
      db.tx(async (t) => {
        await t.run("insert into invites (id, code_hash, kind, email, role, created_at, expires_at) values (gen_random_uuid(), $1, 'invite', $2, 'user', now(), now())", [Buffer.from(email), email]);
        throw new Error('stop');
      }),
    ).rejects.toThrow('stop');
    expect(await db.query('select 1 from invites where email = $1', [email])).toEqual([]);
  });

  it('is held by one process at a time', async () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'accounts-test-')), 'pg');
    try {
      // Another live process (this test's parent) has it.
      writeFileSync(`${dir}.lock`, JSON.stringify({ pid: process.ppid, role: 'server', port: 8787 }));
      expect(readLock(dir)).toEqual({ pid: process.ppid, role: 'server', port: 8787 });
      await expect(openDb({ dir })).rejects.toBeInstanceOf(DatabaseInUse);

      // A lock left by a process that no longer exists is taken over.
      writeFileSync(`${dir}.lock`, JSON.stringify({ pid: 2 ** 22 + 12345, role: 'server', port: 8787 }));
      expect(readLock(dir)).toBeUndefined();
      const opened = await openDb({ dir, holder: { pid: process.pid, role: 'admin' } });
      expect(readLock(dir)).toEqual({ pid: process.pid, role: 'admin' });
      await opened.run('create table kept (n integer)');
      await opened.close();
      expect(readLock(dir)).toBeUndefined();

      // The files are still there the next time. A lock file with nothing in it (its writer died at once) is
      // waited on briefly, in case its owner is only just starting, and then taken over.
      writeFileSync(`${dir}.lock`, '');
      const again = await openDb({ dir });
      expect(readLock(dir)).toEqual({ pid: process.pid, role: 'admin' });
      expect(await again.query('select * from kept')).toEqual([]);
      await again.close();
    } finally {
      rmSync(join(dir, '..'), { recursive: true, force: true });
    }
  });
});
