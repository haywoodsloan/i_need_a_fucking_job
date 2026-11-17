/**
 * Which key locks what.
 *
 *   password ── Argon2id(salt, pepper) ──► master ── "auth" ──► auth key ── SHA-256 ──► verifier      (database)
 *                                                 └─ "vault" ─► password key ── locks ──► vault key   (copy 1)
 *
 *   recovery code ── HKDF(recovery salt) ──► recovery key ── locks ──► vault key                       (copy 2)
 *
 *   session token (cookie only) ── "id" ──► session id                                     (database, lookup only)
 *                               └─ "wrap" ─► session key ── locks ──► vault key        (copy 3, deleted on lock)
 *
 * Each user has one random vault key, which will encrypt their stored site logins. It is never stored in the
 * clear. The database holds it locked by the password (copy 1) and by the recovery code (copy 2), and, while a
 * session has the vault unlocked, locked by a key made from that session's token (copy 3). The token exists only in
 * the user's cookie and the database keeps only a one-way id of it, so the database alone, or the cookie alone,
 * opens nothing.
 */
import { deriveKey, randomKey, seal, sha256, stretchPassword, unseal, wipe, type KdfParams } from './crypto';

const V = 'job-hunt/v1';

export interface PasswordKeys {
  /** What the database stores to check a password. Knowing it does not help with `wrapKey`. */
  verifier: Buffer;
  /** Opens copy 1 of the vault key. Never stored. */
  wrapKey: Buffer;
}

export async function passwordKeys(password: string, salt: Uint8Array, pepper: Uint8Array, kdf: KdfParams): Promise<PasswordKeys> {
  const master = await stretchPassword(password, salt, pepper, kdf);
  try {
    const auth = deriveKey(master, `${V}/auth`);
    try {
      return { verifier: sha256(auth), wrapKey: deriveKey(master, `${V}/vault-wrap/password`) };
    } finally {
      wipe(auth);
    }
  } finally {
    wipe(master);
  }
}

/** `code` is the canonical 24-character form (see parseRecoveryCode). It has 120 random bits, so HKDF is enough. */
export const recoveryKey = (code: string, salt: Uint8Array): Buffer => deriveKey(Buffer.from(code, 'ascii'), `${V}/vault-wrap/recovery`, salt);

export interface SessionKeys {
  /** The session's row id. One-way: the token cannot be worked out from it. */
  sid: Buffer;
  /** Opens copy 3 of the vault key. Never stored. */
  wrapKey: Buffer;
}

export const sessionKeys = (token: Uint8Array): SessionKeys => ({
  sid: deriveKey(token, `${V}/session/id`),
  wrapKey: deriveKey(token, `${V}/session/wrap`),
});

export const newVaultKey = randomKey;

export type VaultCopy = 'password' | 'recovery' | 'session';

/** A copy is tied to its kind and owner, and copy 3 to its session, so it cannot be moved somewhere else. */
const context = (copy: VaultCopy, userId: string, sid?: Uint8Array) =>
  `${V}/vault-key/${copy}/${userId}${sid ? `/${Buffer.from(sid).toString('hex')}` : ''}`;

export const lockVaultKey = (vaultKey: Uint8Array, wrapKey: Uint8Array, copy: VaultCopy, userId: string, sid?: Uint8Array): Buffer =>
  seal(wrapKey, vaultKey, context(copy, userId, sid));

/** Throws SealError when the key, the owner or the copy kind is wrong. */
export const openVaultKey = (locked: Uint8Array, wrapKey: Uint8Array, copy: VaultCopy, userId: string, sid?: Uint8Array): Buffer =>
  unseal(wrapKey, locked, context(copy, userId, sid));
