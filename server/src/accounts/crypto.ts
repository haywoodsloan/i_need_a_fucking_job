/**
 * The cryptographic building blocks for accounts. Nothing here is invented: Argon2id (RFC 9106) stretches the
 * password, HKDF-SHA256 (RFC 5869) turns one secret into several independent keys, and AES-256-GCM locks things.
 * keys.ts says which key locks what.
 */
import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';
import { hashRaw } from '@node-rs/argon2';

export interface KdfParams {
  alg: 'argon2id';
  /** Memory, in KiB. */
  m: number;
  /** Passes over the memory. */
  t: number;
  /** Lanes. */
  p: number;
}

/** 64 MiB, 3 passes, 1 lane. The OWASP floor is 19 MiB and 2 passes. Stored per user, so it can be raised later. */
export const DEFAULT_KDF: KdfParams = { alg: 'argon2id', m: 65536, t: 3, p: 1 };

// The package types these as const enums, which cannot be imported as values: Argon2id is 2 and version 0x13 is 1.
const ARGON2ID = 2;
const VERSION_19 = 1;

/**
 * Stretches a password into 32 bytes. `pepper` is the server secret mixed in as Argon2's key, so the result cannot
 * be recomputed from the database alone. Passwords are compared in NFKC form, as NIST SP 800-63B recommends, so the
 * same characters typed on different keyboards match.
 */
export function stretchPassword(password: string, salt: Uint8Array, pepper: Uint8Array, kdf: KdfParams): Promise<Buffer> {
  if (kdf.alg !== 'argon2id') throw new Error(`Unknown password scheme: ${String(kdf.alg)}`);
  return hashRaw(normalizePassword(password), {
    algorithm: ARGON2ID,
    version: VERSION_19,
    memoryCost: kdf.m,
    timeCost: kdf.t,
    parallelism: kdf.p,
    outputLen: 32,
    salt,
    secret: pepper,
  });
}

export const normalizePassword = (password: string) => password.normalize('NFKC');

const NO_SALT = new Uint8Array(0);

/** One 32-byte key out of `secret`. Different `purpose` strings give keys that tell you nothing about each other. */
export function deriveKey(secret: Uint8Array, purpose: string, salt: Uint8Array = NO_SALT): Buffer {
  return Buffer.from(hkdfSync('sha256', secret, salt, purpose, 32));
}

export const sha256 = (data: Uint8Array | string): Buffer => createHash('sha256').update(data).digest();

/** Compares without leaking where the first difference is. */
export const sameBytes = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && timingSafeEqual(a, b);

export const randomKey = (): Buffer => randomBytes(32);
export const randomSalt = (): Buffer => randomBytes(16);

/** Thrown when something does not open: wrong key, wrong owner, or the bytes were changed. Never says which. */
export class SealError extends Error {
  constructor() {
    super('Could not open the sealed value');
    this.name = 'SealError';
  }
}

const SEAL_V1 = 1;
const IV_BYTES = 12;
const TAG_BYTES = 16;

/**
 * Locks `plain` with AES-256-GCM. `context` is not secret and is not stored: it names what the value is and whose
 * it is, and the same string has to be given to open it. A value copied to another user or another slot therefore
 * fails to open instead of opening as something else.
 *
 * Layout: version (1 byte), nonce (12), ciphertext, tag (16).
 */
export function seal(key: Uint8Array, plain: Uint8Array, context: string): Buffer {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(Buffer.from(context, 'utf8'));
  const body = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([Buffer.from([SEAL_V1]), iv, body, cipher.getAuthTag()]);
}

export function unseal(key: Uint8Array, sealed: Uint8Array, context: string): Buffer {
  const b = Buffer.from(sealed.buffer, sealed.byteOffset, sealed.byteLength);
  if (b.length < 1 + IV_BYTES + TAG_BYTES || b[0] !== SEAL_V1) throw new SealError();
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, b.subarray(1, 1 + IV_BYTES), { authTagLength: TAG_BYTES });
    decipher.setAAD(Buffer.from(context, 'utf8'));
    decipher.setAuthTag(b.subarray(b.length - TAG_BYTES));
    return Buffer.concat([decipher.update(b.subarray(1 + IV_BYTES, b.length - TAG_BYTES)), decipher.final()]);
  } catch {
    throw new SealError();
  }
}

/** Overwrites key material once it is no longer needed. Best effort: JavaScript strings cannot be wiped. */
export function wipe(...buffers: (Uint8Array | undefined)[]): void {
  for (const b of buffers) b?.fill(0);
}

export const toBase64Url = (b: Uint8Array): string => Buffer.from(b.buffer, b.byteOffset, b.byteLength).toString('base64url');

/** Decodes base64url and insists on the exact length, so a malformed token never reaches a key function. */
export function fromBase64Url(text: string, bytes: number): Buffer | undefined {
  if (!/^[A-Za-z0-9_-]+$/.test(text)) return undefined;
  const b = Buffer.from(text, 'base64url');
  return b.length === bytes && b.toString('base64url') === text ? b : undefined;
}

/** A one-time code for links (invites, resets) and the raw session token: 256 random bits. */
export const TOKEN_BYTES = 32;
export const newToken = (): Buffer => randomBytes(TOKEN_BYTES);

// ---------------------------------------------------------------------------------------------------------------
// Recovery codes: 24 characters of Crockford base32 (no I, L, O or U), which is 120 random bits.

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export const RECOVERY_CODE_CHARS = 24;

function base32(bytes: Uint8Array): string {
  let out = '';
  let acc = 0;
  let bits = 0;
  for (const byte of bytes) {
    acc = (acc << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += CROCKFORD[(acc >>> bits) & 31];
    }
    acc &= (1 << bits) - 1;
  }
  if (bits) out += CROCKFORD[(acc << (5 - bits)) & 31];
  return out;
}

/** A new recovery code in its canonical form: 24 characters, no separators. */
export const newRecoveryCode = (): string => base32(randomBytes((RECOVERY_CODE_CHARS * 5) / 8));

/** "ABCD-EFGH-…", the way it is shown to the user. */
export const formatRecoveryCode = (code: string): string => code.match(/.{1,4}/g)!.join('-');

/**
 * Turns what a person typed back into the canonical form: case, spaces and dashes do not matter, and the letters
 * people confuse are read the way Crockford's scheme says (O as 0, I and L as 1). Returns undefined when it cannot
 * be a recovery code.
 */
export function parseRecoveryCode(typed: string): string | undefined {
  const code = typed
    .toUpperCase()
    .replace(/[\s-]/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1');
  if (code.length !== RECOVERY_CODE_CHARS) return undefined;
  for (const ch of code) if (!CROCKFORD.includes(ch)) return undefined;
  return code;
}
