/**
 * What an account can do: be created from an invite, sign in and out, list and end its sessions, change its
 * password, recover with the recovery code, be reset by an admin link, and lock or unlock its vault key.
 *
 * This file knows nothing about HTTP. http.ts turns requests into these calls, and admin-commands.ts uses the admin ones.
 * keys.ts explains the keys. The rules that matter most:
 *
 *   - The vault key is only ever in memory inside one of these calls, and is wiped before the call returns.
 *   - A password is needed to open copy 1, the recovery code to open copy 2, the session cookie to open copy 3.
 *     Nothing stored in the database opens any of them.
 *   - An admin reset link can set a new password but cannot open a vault: it replaces the vault key, so whatever
 *     the old one protected is gone.
 */
import { randomUUID } from 'node:crypto';
import {
  looksLikeEmail,
  normalizeEmail,
  type AccountUser,
  type ErrorCode,
  type InviteInfo,
  type PasswordProblem,
  type Role,
  type SessionSummary,
  type VaultState,
} from '../../../src/account/api';
import { PASSWORD_PROBLEM_TEXT } from '../../../src/account/api';
import { UNIQUE_VIOLATION, errorCode, type Db } from '../db/db';
import {
  DEFAULT_KDF,
  SealError,
  TOKEN_BYTES,
  deriveKey,
  formatRecoveryCode,
  fromBase64Url,
  newRecoveryCode,
  newToken,
  normalizePassword,
  parseRecoveryCode,
  randomSalt,
  sameBytes,
  sha256,
  stretchPassword,
  toBase64Url,
  wipe,
  type KdfParams,
} from './crypto';
import { lockVaultKey, newVaultKey, openVaultKey, passwordKeys, recoveryKey, sessionKeys, type PasswordKeys } from './keys';
import { Attempts, Busy, Slots } from './limits';
import { checkNewPassword, type BreachCheck } from './policy';

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

/** A session ends after a week without use, and after 30 days whatever happens. */
export const SESSION_IDLE_MS = 7 * DAY;
export const SESSION_MAX_MS = 30 * DAY;
/** The vault locks after an hour without vault use. Unlocking again takes the password. */
export const VAULT_IDLE_MS = 60 * MINUTE;
export const INVITE_TTL_MS = 7 * DAY;
export const RESET_TTL_MS = DAY;

/** `last_seen_at` is written at most this often, so reading a page does not mean a database write each time. */
const TOUCH_EVERY_MS = MINUTE;
/** Tries are counted over 15 minutes: per account (guessing one password), per address (trying many accounts). */
const WINDOW_MS = 15 * MINUTE;
const MAX_PER_ACCOUNT = 10;
const MAX_PER_ADDRESS = 50;
/** A typed password longer than this is refused before any hashing. Real limits are in src/account/api.ts. */
const MAX_INPUT = 1024;

export class AccountError extends Error {
  constructor(
    public code: ErrorCode,
    message: string,
    public status: number,
    public extra: { problem?: PasswordProblem; retryAfter?: number } = {},
  ) {
    super(message);
    this.name = 'AccountError';
  }
}

const invalidCredentials = () => new AccountError('invalid_credentials', 'Email or password is incorrect.', 401);
const invalidRecovery = () => new AccountError('invalid_recovery', 'Email or recovery code is incorrect.', 401);
const wrongPassword = () => new AccountError('wrong_password', 'That password is not correct.', 403);
const invalidCode = () => new AccountError('invalid_code', 'This link is no longer valid. Ask for a new one.', 400);
const badRequest = (message: string) => new AccountError('bad_request', message, 400);
const weakPassword = (problem: PasswordProblem) => new AccountError('weak_password', PASSWORD_PROBLEM_TEXT[problem], 400, { problem });
const vaultLocked = () => new AccountError('vault_locked', 'Enter your password to unlock your stored logins.', 403);

function tooMany(waitMs: number) {
  const minutes = Math.ceil(waitMs / MINUTE);
  return new AccountError('rate_limited', `Too many attempts. Try again in ${minutes === 1 ? 'a minute' : `${minutes} minutes`}.`, 429, {
    retryAfter: Math.ceil(waitMs / 1000),
  });
}

interface UserRow {
  id: string;
  email: string;
  role: Role;
  created_at: Date;
  kdf: KdfParams;
  salt: Buffer;
  pepper_version: number;
  verifier: Buffer;
  vault_generation: number;
  vault_by_password: Buffer;
  recovery_salt: Buffer;
  vault_by_recovery: Buffer;
}

interface SessionRow {
  sid: Buffer;
  public_id: string;
  user_id: string;
  created_at: Date;
  last_seen_at: Date;
  expires_at: Date;
  user_agent: string;
  vault_by_session: Buffer | null;
  vault_expires_at: Date | null;
}

interface InviteRow {
  id: string;
  kind: 'invite' | 'reset';
  email: string;
  role: Role;
  expires_at: Date;
}

/** A request that carried a valid session cookie. Lives for one request. */
export interface Signed {
  user: AccountUser & { id: string };
  /** The raw session token from the cookie. Needed to open copy 3 of the vault key. */
  token: Buffer;
  sid: Buffer;
  publicId: string;
  vault: VaultState;
}

export interface AccountServiceOptions {
  db: Db;
  /** The server secrets mixed into password hashing, by version. Old versions stay until every user has moved on. */
  peppers: Map<number, Buffer>;
  /** The version new and changed passwords are hashed with. */
  pepperVersion: number;
  kdf?: KdfParams;
  /** Looks a new password up among breached ones. Left out, that check is skipped. */
  breached?: BreachCheck;
  now?: () => Date;
}

export interface UserSummary {
  email: string;
  role: Role;
  createdAt: Date;
  sessions: number;
  lastSeenAt: Date | null;
}

export type AccountService = ReturnType<typeof createAccountService>;

export function createAccountService(o: AccountServiceOptions) {
  const { db } = o;
  const now = o.now ?? (() => new Date());
  const kdf = o.kdf ?? DEFAULT_KDF;
  const attempts = new Attempts(() => now().getTime(), WINDOW_MS);
  // Two hashes at a time (64 MiB each), sixteen more may wait. Past that the answer is "busy", not a memory spike.
  const slots = new Slots(2, 16);

  const pepper = (version: number): Buffer => {
    const p = o.peppers.get(version);
    if (!p) throw new Error(`Password secret version ${version} is not configured (see AUTH_PEPPER_OLD in server/.env.example).`);
    return p;
  };

  const later = (ms: number) => new Date(now().getTime() + ms);
  const publicUser = (u: { email: string; role: Role }): AccountUser => ({ email: u.email, role: u.role });

  const audit = (event: string, userId: string | null, detail: Record<string, unknown> = {}, on: Db = db) =>
    on.run('insert into audit_log (at, user_id, event, detail) values ($1, $2, $3, $4)', [now(), userId, event, detail]);

  const hashing = async <T>(fn: () => Promise<T>): Promise<T> => {
    try {
      return await slots.run(fn);
    } catch (e) {
      if (e instanceof Busy) throw new AccountError('busy', 'The server is busy. Try again in a moment.', 503);
      throw e;
    }
  };

  /** Refuses when any of the keys has used up its tries, and otherwise counts one try against each. */
  function throttle(...keys: [key: string, max: number][]) {
    const wait = Math.max(...keys.map(([key, max]) => attempts.wait(key, max)));
    if (wait > 0) throw tooMany(wait);
    for (const [key] of keys) attempts.count(key);
  }

  const findUser = async (email: string) => (await db.query<UserRow>('select * from users where email = $1', [email]))[0];
  const userById = async (id: string) => (await db.query<UserRow>('select * from users where id = $1', [id]))[0];

  async function checkPassword(user: UserRow, password: string): Promise<PasswordKeys | undefined> {
    if (typeof password !== 'string' || !password || password.length > MAX_INPUT) return undefined;
    const keys = await hashing(() => passwordKeys(password, user.salt, pepper(user.pepper_version), user.kdf));
    if (sameBytes(keys.verifier, user.verifier)) return keys;
    wipe(keys.wrapKey);
    return undefined;
  }

  /** For a request from a signed-in user that also needs the password typed again. */
  async function confirmPassword(signed: Signed, password: string): Promise<{ user: UserRow; keys: PasswordKeys }> {
    const key = `password:${signed.user.id}`;
    throttle([key, MAX_PER_ACCOUNT]);
    const user = await userById(signed.user.id);
    const keys = user && (await checkPassword(user, password));
    if (!keys) {
      await audit('password_check_failed', signed.user.id);
      throw wrongPassword();
    }
    attempts.clear(key);
    return { user, keys };
  }

  async function newCredentials(password: string) {
    const salt = randomSalt();
    const keys = await hashing(() => passwordKeys(password, salt, pepper(o.pepperVersion), kdf));
    return { salt, keys };
  }

  function newRecovery(vaultKey: Buffer, userId: string) {
    const code = newRecoveryCode();
    const salt = randomSalt();
    const key = recoveryKey(code, salt);
    try {
      return { code, salt, locked: lockVaultKey(vaultKey, key, 'recovery', userId) };
    } finally {
      wipe(key);
    }
  }

  async function requireStrong(password: string, email: string) {
    if (typeof password !== 'string') throw badRequest('A password is required.');
    if (password.length > MAX_INPUT) throw weakPassword('too_long');
    const problem = await checkNewPassword(password, email, o.breached);
    if (problem) throw weakPassword(problem);
  }

  async function startSession(on: Db, userId: string, vaultKey: Buffer, userAgent: string): Promise<Buffer> {
    const token = newToken();
    const { sid, wrapKey } = sessionKeys(token);
    try {
      await on.run(
        `insert into sessions (sid, public_id, user_id, created_at, last_seen_at, expires_at, user_agent, vault_by_session, vault_expires_at)
         values ($1, $2, $3, $4, $4, $5, $6, $7, $8)`,
        [sid, randomUUID(), userId, now(), later(SESSION_MAX_MS), String(userAgent ?? '').slice(0, 300), lockVaultKey(vaultKey, wrapKey, 'session', userId, sid), later(VAULT_IDLE_MS)],
      );
    } finally {
      wipe(wrapKey);
    }
    return token;
  }

  const sweepSessions = (on: Db) =>
    on.run('delete from sessions where expires_at <= $1 or last_seen_at <= $2', [now(), later(-SESSION_IDLE_MS)]);

  const vaultState = (row: Pick<SessionRow, 'vault_by_session' | 'vault_expires_at'>): VaultState =>
    row.vault_by_session && row.vault_expires_at && row.vault_expires_at.getTime() > now().getTime()
      ? { unlocked: true, until: row.vault_expires_at.toISOString() }
      : { unlocked: false };

  // ------------------------------------------------------------------------------------------------- invites

  async function findInvite(codeText: unknown): Promise<InviteRow | undefined> {
    const code = typeof codeText === 'string' ? fromBase64Url(codeText, TOKEN_BYTES) : undefined;
    if (!code) return undefined;
    const rows = await db.query<InviteRow>('select id, kind, email, role, expires_at from invites where code_hash = $1 and used_at is null and expires_at > $2', [
      sha256(code),
      now(),
    ]);
    return rows[0];
  }

  /** What an invite or reset link is for, so the page can show whose account it is before asking for a password. */
  async function peekInvite(input: { code: unknown; address: string }): Promise<InviteInfo> {
    throttle([`code:${input.address}`, MAX_PER_ADDRESS]);
    const invite = await findInvite(input.code);
    if (!invite) throw invalidCode();
    return { kind: invite.kind, email: invite.email, expiresAt: invite.expires_at.toISOString() };
  }

  async function acceptInvite(input: { code: unknown; password: string; userAgent: string; address: string }) {
    throttle([`code:${input.address}`, MAX_PER_ADDRESS]);
    const invite = await findInvite(input.code);
    if (!invite || invite.kind !== 'invite') throw invalidCode();
    await requireStrong(input.password, invite.email);

    const id = randomUUID();
    const fresh = await newCredentials(input.password);
    const vaultKey = newVaultKey();
    try {
      const recovery = newRecovery(vaultKey, id);
      const token = await db.tx(async (t) => {
        // The link works once: of two requests racing with the same code, only one changes this row.
        if (!(await t.run('update invites set used_at = $1 where id = $2 and used_at is null', [now(), invite.id]))) throw invalidCode();
        await t.run(
          `insert into users (id, email, role, created_at, kdf, salt, pepper_version, verifier, password_changed_at,
                              vault_generation, vault_by_password, recovery_salt, vault_by_recovery)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $4, 1, $9, $10, $11)`,
          [id, invite.email, invite.role, now(), kdf, fresh.salt, o.pepperVersion, fresh.keys.verifier, lockVaultKey(vaultKey, fresh.keys.wrapKey, 'password', id), recovery.salt, recovery.locked],
        );
        const token = await startSession(t, id, vaultKey, input.userAgent);
        await audit('account_created', id, { role: invite.role }, t);
        return token;
      });
      return { token: toBase64Url(token), user: publicUser(invite), recoveryCode: formatRecoveryCode(recovery.code) };
    } catch (e) {
      if (errorCode(e) === UNIQUE_VIOLATION) throw invalidCode(); // that email already has an account
      throw e;
    } finally {
      wipe(vaultKey, fresh.keys.wrapKey);
    }
  }

  // ------------------------------------------------------------------------------------- sign-in and sessions

  /** A stand-in salt for an email with no account, so a sign-in attempt costs the same either way. */
  const dummySalt = (email: string) => deriveKey(pepper(o.pepperVersion), 'job-hunt/v1/no-such-user', Buffer.from(email, 'utf8')).subarray(0, 16);

  async function signIn(input: { email: string; password: string; userAgent: string; address: string }) {
    const email = normalizeEmail(String(input.email ?? ''));
    const password = input.password;
    if (!looksLikeEmail(email) || typeof password !== 'string' || !password || password.length > MAX_INPUT) throw invalidCredentials();
    const accountKey = `sign-in:${email}`;
    throttle([accountKey, MAX_PER_ACCOUNT], [`sign-in-from:${input.address}`, MAX_PER_ADDRESS]);

    const user = await findUser(email);
    if (!user) {
      // The same work and the same answer as a wrong password, so the reply does not say whether the account exists.
      wipe(await hashing(() => stretchPassword(password, dummySalt(email), pepper(o.pepperVersion), kdf)));
      await audit('sign_in_failed', null);
      throw invalidCredentials();
    }
    const keys = await checkPassword(user, password);
    if (!keys) {
      await audit('sign_in_failed', user.id);
      throw invalidCredentials();
    }
    attempts.clear(accountKey);

    const vaultKey = openVaultKey(user.vault_by_password, keys.wrapKey, 'password', user.id);
    wipe(keys.wrapKey);
    try {
      await rehashIfOutdated(user, password, vaultKey);
      const token = await db.tx(async (t) => {
        await sweepSessions(t);
        const token = await startSession(t, user.id, vaultKey, input.userAgent);
        await audit('sign_in', user.id, {}, t);
        return token;
      });
      return { token: toBase64Url(token), user: publicUser(user) };
    } finally {
      wipe(vaultKey);
    }
  }

  /** Moves a user to the current hashing settings and server secret the next time they type their password. */
  async function rehashIfOutdated(user: UserRow, password: string, vaultKey: Buffer) {
    const k = user.kdf;
    if (user.pepper_version === o.pepperVersion && k.alg === kdf.alg && k.m === kdf.m && k.t === kdf.t && k.p === kdf.p) return;
    const fresh = await newCredentials(password);
    try {
      // `verifier = $7`: do nothing if the password was changed in the meantime.
      await db.run('update users set kdf = $1, salt = $2, pepper_version = $3, verifier = $4, vault_by_password = $5 where id = $6 and verifier = $7', [
        kdf,
        fresh.salt,
        o.pepperVersion,
        fresh.keys.verifier,
        lockVaultKey(vaultKey, fresh.keys.wrapKey, 'password', user.id),
        user.id,
        user.verifier,
      ]);
    } finally {
      wipe(fresh.keys.wrapKey);
    }
  }

  /** Turns the cookie's value into the signed-in user, or undefined when it is missing, unknown or expired. */
  async function authenticate(tokenText: string | undefined): Promise<Signed | undefined> {
    const token = tokenText ? fromBase64Url(tokenText, TOKEN_BYTES) : undefined;
    if (!token) return undefined;
    const { sid, wrapKey } = sessionKeys(token);
    wipe(wrapKey);
    const [row] = await db.query<SessionRow & { email: string; role: Role }>(
      'select s.*, u.email, u.role from sessions s join users u on u.id = s.user_id where s.sid = $1',
      [sid],
    );
    if (!row) return undefined;
    const at = now().getTime();
    if (at >= row.expires_at.getTime() || at - row.last_seen_at.getTime() >= SESSION_IDLE_MS) {
      await db.run('delete from sessions where sid = $1', [sid]);
      return undefined;
    }
    if (at - row.last_seen_at.getTime() >= TOUCH_EVERY_MS) await db.run('update sessions set last_seen_at = $1 where sid = $2', [new Date(at), sid]);
    return { token, sid, publicId: row.public_id, user: { id: row.user_id, email: row.email, role: row.role }, vault: vaultState(row) };
  }

  async function signOut(signed: Signed) {
    await db.run('delete from sessions where sid = $1', [signed.sid]);
    await audit('sign_out', signed.user.id);
  }

  async function signOutEverywhere(signed: Signed) {
    const ended = await db.run('delete from sessions where user_id = $1', [signed.user.id]);
    await audit('sign_out_everywhere', signed.user.id, { sessions: ended });
  }

  async function listSessions(signed: Signed): Promise<SessionSummary[]> {
    const rows = await db.query<SessionRow>('select * from sessions where user_id = $1 and expires_at > $2 and last_seen_at > $3 order by last_seen_at desc', [
      signed.user.id,
      now(),
      later(-SESSION_IDLE_MS),
    ]);
    return rows
      .map((r) => ({
        id: r.public_id,
        current: sameBytes(r.sid, signed.sid),
        createdAt: r.created_at.toISOString(),
        lastSeenAt: r.last_seen_at.toISOString(),
        userAgent: r.user_agent,
      }))
      .sort((a, b) => Number(b.current) - Number(a.current));
  }

  /** Ends one of the user's own sessions. Returns whether it was the one making the request. */
  async function endSession(signed: Signed, publicId: unknown): Promise<{ current: boolean }> {
    if (typeof publicId !== 'string' || !/^[0-9a-f-]{36}$/i.test(publicId)) throw badRequest('Unknown session.');
    const ended = await db.run('delete from sessions where user_id = $1 and public_id = $2', [signed.user.id, publicId]);
    if (ended) await audit('session_ended', signed.user.id);
    return { current: publicId.toLowerCase() === signed.publicId.toLowerCase() };
  }

  // ------------------------------------------------------------------------------------ password and recovery

  async function changePassword(signed: Signed, input: { currentPassword: string; newPassword: string }) {
    const { user, keys } = await confirmPassword(signed, input.currentPassword);
    let vaultKey: Buffer | undefined;
    let fresh: Awaited<ReturnType<typeof newCredentials>> | undefined;
    try {
      if (typeof input.newPassword === 'string' && normalizePassword(input.newPassword) === normalizePassword(input.currentPassword)) {
        throw badRequest('The new password is the same as the current one.');
      }
      await requireStrong(input.newPassword, user.email);
      vaultKey = openVaultKey(user.vault_by_password, keys.wrapKey, 'password', user.id);
      fresh = await newCredentials(input.newPassword);
      const relocked = lockVaultKey(vaultKey, fresh.keys.wrapKey, 'password', user.id);
      const { salt, keys: next } = fresh;
      await db.tx(async (t) => {
        const changed = await t.run(
          'update users set kdf = $1, salt = $2, pepper_version = $3, verifier = $4, vault_by_password = $5, password_changed_at = $6 where id = $7 and verifier = $8',
          [kdf, salt, o.pepperVersion, next.verifier, relocked, now(), user.id, user.verifier],
        );
        if (!changed) throw badRequest('Your password was changed somewhere else just now. Sign in again.');
        // Every other place this account is signed in is signed out. This session stays.
        await t.run('delete from sessions where user_id = $1 and sid <> $2', [user.id, signed.sid]);
        await audit('password_changed', user.id, {}, t);
      });
    } finally {
      wipe(keys.wrapKey, vaultKey, fresh?.keys.wrapKey);
    }
  }

  /**
   * Forgot the password, still has the recovery code: sets a new password and keeps the vault. The code is used up
   * and a new one is returned. Every session is ended.
   */
  async function recover(input: { email: string; recoveryCode: string; newPassword: string; address: string }) {
    const email = normalizeEmail(String(input.email ?? ''));
    const accountKey = `recover:${email}`;
    throttle([accountKey, MAX_PER_ACCOUNT], [`recover-from:${input.address}`, MAX_PER_ADDRESS]);

    const code = typeof input.recoveryCode === 'string' && input.recoveryCode.length <= 200 ? parseRecoveryCode(input.recoveryCode) : undefined;
    const user = looksLikeEmail(email) ? await findUser(email) : undefined;
    let vaultKey: Buffer | undefined;
    if (user && code) {
      const key = recoveryKey(code, user.recovery_salt);
      try {
        vaultKey = openVaultKey(user.vault_by_recovery, key, 'recovery', user.id);
      } catch (e) {
        if (!(e instanceof SealError)) throw e;
      } finally {
        wipe(key);
      }
    }
    if (!user || !vaultKey) {
      await audit('recovery_failed', user?.id ?? null);
      throw invalidRecovery();
    }
    let fresh: Awaited<ReturnType<typeof newCredentials>> | undefined;
    try {
      await requireStrong(input.newPassword, user.email);
      fresh = await newCredentials(input.newPassword);
      const recovery = newRecovery(vaultKey, user.id);
      const relocked = lockVaultKey(vaultKey, fresh.keys.wrapKey, 'password', user.id);
      const { salt, keys: next } = fresh;
      await db.tx(async (t) => {
        // `vault_by_recovery = $9`: a recovery code works once, even if two requests race with it.
        const changed = await t.run(
          `update users set kdf = $1, salt = $2, pepper_version = $3, verifier = $4, vault_by_password = $5, password_changed_at = $6,
                            recovery_salt = $7, vault_by_recovery = $8
           where id = $10 and vault_by_recovery = $9`,
          [kdf, salt, o.pepperVersion, next.verifier, relocked, now(), recovery.salt, recovery.locked, user.vault_by_recovery, user.id],
        );
        if (!changed) throw invalidRecovery();
        await t.run('delete from sessions where user_id = $1', [user.id]);
        await audit('recovered_with_code', user.id, {}, t);
      });
      attempts.clear(accountKey);
      return { recoveryCode: formatRecoveryCode(recovery.code) };
    } finally {
      wipe(vaultKey, fresh?.keys.wrapKey);
    }
  }

  /**
   * Forgot both: an admin issued a reset link. Sets a new password, but the vault key cannot be recovered, so the
   * account gets a new one and whatever the old one protected can no longer be read. Tracker data is untouched.
   */
  async function resetWithLink(input: { code: unknown; password: string; address: string }) {
    throttle([`code:${input.address}`, MAX_PER_ADDRESS]);
    const invite = await findInvite(input.code);
    const user = invite?.kind === 'reset' ? await findUser(invite.email) : undefined;
    if (!invite || !user) throw invalidCode();
    await requireStrong(input.password, user.email);

    const fresh = await newCredentials(input.password);
    const vaultKey = newVaultKey();
    try {
      const recovery = newRecovery(vaultKey, user.id);
      await db.tx(async (t) => {
        if (!(await t.run('update invites set used_at = $1 where id = $2 and used_at is null', [now(), invite.id]))) throw invalidCode();
        await t.run(
          `update users set kdf = $1, salt = $2, pepper_version = $3, verifier = $4, vault_by_password = $5, password_changed_at = $6,
                            recovery_salt = $7, vault_by_recovery = $8, vault_generation = vault_generation + 1
           where id = $9`,
          [kdf, fresh.salt, o.pepperVersion, fresh.keys.verifier, lockVaultKey(vaultKey, fresh.keys.wrapKey, 'password', user.id), now(), recovery.salt, recovery.locked, user.id],
        );
        // When the vault has contents (stored site logins), they are deleted here: nothing can open them any more.
        await t.run('delete from sessions where user_id = $1', [user.id]);
        await audit('password_reset_by_link', user.id, { vaultReplaced: true }, t);
      });
      return { email: user.email, recoveryCode: formatRecoveryCode(recovery.code) };
    } finally {
      wipe(vaultKey, fresh.keys.wrapKey);
    }
  }

  /** Lost the recovery code but knows the password: the old code stops working and a new one is returned. */
  async function renewRecoveryCode(signed: Signed, input: { currentPassword: string }) {
    const { user, keys } = await confirmPassword(signed, input.currentPassword);
    let vaultKey: Buffer | undefined;
    try {
      vaultKey = openVaultKey(user.vault_by_password, keys.wrapKey, 'password', user.id);
      const recovery = newRecovery(vaultKey, user.id);
      await db.run('update users set recovery_salt = $1, vault_by_recovery = $2 where id = $3', [recovery.salt, recovery.locked, user.id]);
      await audit('recovery_code_renewed', user.id);
      return { recoveryCode: formatRecoveryCode(recovery.code) };
    } finally {
      wipe(keys.wrapKey, vaultKey);
    }
  }

  async function deleteAccount(signed: Signed, input: { currentPassword: string }) {
    const { user, keys } = await confirmPassword(signed, input.currentPassword);
    wipe(keys.wrapKey);
    await db.tx(async (t) => {
      // Deleting the row deletes the locked copies of the vault key, so nothing it protected can be read again,
      // in this database or in any backup of it.
      await t.run('delete from users where id = $1', [user.id]);
      await t.run('delete from invites where email = $1', [user.email]);
      // The log keeps what happened to which account id, but no longer the address it belonged to.
      await t.run("update audit_log set detail = detail - 'email' where detail ->> 'email' = $1", [user.email]);
      await audit('account_deleted', user.id, {}, t);
    });
  }

  // --------------------------------------------------------------------------------------------------- vault

  async function unlockVault(signed: Signed, input: { password: string }): Promise<VaultState> {
    const { user, keys } = await confirmPassword(signed, input.password);
    const { wrapKey } = sessionKeys(signed.token);
    let vaultKey: Buffer | undefined;
    try {
      vaultKey = openVaultKey(user.vault_by_password, keys.wrapKey, 'password', user.id);
      const until = later(VAULT_IDLE_MS);
      await db.run('update sessions set vault_by_session = $1, vault_expires_at = $2 where sid = $3', [
        lockVaultKey(vaultKey, wrapKey, 'session', user.id, signed.sid),
        until,
        signed.sid,
      ]);
      await audit('vault_unlocked', user.id);
      return { unlocked: true, until: until.toISOString() };
    } finally {
      wipe(keys.wrapKey, wrapKey, vaultKey);
    }
  }

  async function lockVault(signed: Signed): Promise<VaultState> {
    const locked = await db.run('update sessions set vault_by_session = null, vault_expires_at = null where sid = $1 and vault_by_session is not null', [signed.sid]);
    if (locked) await audit('vault_locked', signed.user.id);
    return { unlocked: false };
  }

  /**
   * Runs `use` with the vault key, for a request that came with the session cookie while the vault is unlocked.
   * This is the only way the rest of the server gets the key, and the key is wiped when `use` returns. Each use
   * restarts the hour before the vault locks itself.
   */
  async function withVaultKey<T>(signed: Signed, use: (vaultKey: Buffer) => Promise<T>): Promise<T> {
    const [row] = await db.query<SessionRow>('select * from sessions where sid = $1', [signed.sid]);
    if (!row || !vaultState(row).unlocked) {
      if (row?.vault_by_session) await lockVault(signed); // its hour ran out: delete the copy
      throw vaultLocked();
    }
    const { wrapKey } = sessionKeys(signed.token);
    let vaultKey: Buffer | undefined;
    try {
      vaultKey = openVaultKey(row.vault_by_session!, wrapKey, 'session', signed.user.id, signed.sid);
      await db.run('update sessions set vault_expires_at = $1 where sid = $2', [later(VAULT_IDLE_MS), signed.sid]);
      return await use(vaultKey);
    } finally {
      wipe(wrapKey, vaultKey);
    }
  }

  // --------------------------------------------------------------------------------------------------- admin

  async function insertInvite(kind: 'invite' | 'reset', email: string, role: Role, ttlMs: number) {
    const code = newToken();
    const expiresAt = later(ttlMs);
    await db.tx(async (t) => {
      // A new link replaces any earlier unused one of the same kind for that person, and old ones are cleared out.
      await t.run('delete from invites where (email = $1 and kind = $2 and used_at is null) or expires_at < $3', [email, kind, later(-30 * DAY)]);
      await t.run('insert into invites (id, code_hash, kind, email, role, created_at, expires_at) values ($1, $2, $3, $4, $5, $6, $7)', [
        randomUUID(),
        sha256(code),
        kind,
        email,
        role,
        now(),
        expiresAt,
      ]);
      await audit(kind === 'invite' ? 'invite_created' : 'reset_link_created', null, { email, role }, t);
    });
    return { code: toBase64Url(code), email, expiresAt };
  }

  const admin = {
    async invite(emailText: string, role: Role = 'user') {
      const email = normalizeEmail(emailText);
      if (!looksLikeEmail(email)) throw badRequest(`"${emailText}" does not look like an email address.`);
      if (await findUser(email)) throw badRequest(`${email} already has an account. Use "reset" if they cannot sign in.`);
      return insertInvite('invite', email, role, INVITE_TTL_MS);
    },

    async reset(emailText: string) {
      const email = normalizeEmail(emailText);
      const user = await findUser(email);
      if (!user) throw badRequest(`There is no account for ${email}.`);
      return insertInvite('reset', email, user.role, RESET_TTL_MS);
    },

    async users(): Promise<UserSummary[]> {
      const rows = await db.query<{ email: string; role: Role; created_at: Date; sessions: number; last_seen_at: Date | null }>(
        `select u.email, u.role, u.created_at, count(s.sid)::int as sessions, max(s.last_seen_at) as last_seen_at
         from users u left join sessions s on s.user_id = u.id and s.expires_at > $1 and s.last_seen_at > $2
         group by u.id order by u.created_at`,
        [now(), later(-SESSION_IDLE_MS)],
      );
      return rows.map((r) => ({ email: r.email, role: r.role, createdAt: r.created_at, sessions: r.sessions, lastSeenAt: r.last_seen_at }));
    },

    /** Signs a user out everywhere, for when their device is lost or their session may have been copied. */
    async signOut(emailText: string): Promise<number> {
      const user = await findUser(normalizeEmail(emailText));
      if (!user) throw badRequest(`There is no account for ${emailText}.`);
      const ended = await db.run('delete from sessions where user_id = $1', [user.id]);
      await audit('signed_out_by_admin', user.id, { sessions: ended });
      return ended;
    },
  };

  return {
    peekInvite,
    acceptInvite,
    signIn,
    authenticate,
    signOut,
    signOutEverywhere,
    listSessions,
    endSession,
    changePassword,
    recover,
    resetWithLink,
    renewRecoveryCode,
    deleteAccount,
    unlockVault,
    lockVault,
    withVaultKey,
    admin,
  };
}
