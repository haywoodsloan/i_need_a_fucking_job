import { describe, expect, it } from 'vitest';
import {
  DEFAULT_KDF,
  SealError,
  deriveKey,
  formatRecoveryCode,
  fromBase64Url,
  newRecoveryCode,
  newToken,
  parseRecoveryCode,
  randomKey,
  seal,
  sha256,
  stretchPassword,
  toBase64Url,
  unseal,
  type KdfParams,
} from '../server/src/accounts/crypto';
import { lockVaultKey, newVaultKey, openVaultKey, passwordKeys, recoveryKey, sessionKeys } from '../server/src/accounts/keys';

const FAST: KdfParams = { alg: 'argon2id', m: 256, t: 1, p: 1 };
const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');

describe('published test vectors', () => {
  it('Argon2id matches the reference implementation', async () => {
    // phc-winner-argon2, test.c: argon2id, version 0x13, t=2, m=2^16 KiB, p=1, "password" / "somesalt".
    const out = await stretchPassword('password', Buffer.from('somesalt'), new Uint8Array(0), { alg: 'argon2id', m: 65536, t: 2, p: 1 });
    expect(hex(out)).toBe('09316115d5cf24ed5a15a31a3ba326e5cf32edc24702987c02b6566f61913cf7');
  });

  it('HKDF-SHA256 matches RFC 5869 test case 3', () => {
    // Empty salt and info, 22 bytes of 0x0b. The RFC lists 42 bytes of output: a 32-byte key is its first 32.
    expect(hex(deriveKey(Buffer.alloc(22, 0x0b), ''))).toBe('8da4e775a563c18f715f802a063c5a31b8a11f5c5ee1879ec3454e5f3c738d2d');
  });

  it('SHA-256 matches FIPS 180-4', () => {
    expect(hex(sha256('abc'))).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});

describe('password stretching', () => {
  it('uses the settings the plan calls for by default', () => {
    expect(DEFAULT_KDF).toEqual({ alg: 'argon2id', m: 65536, t: 3, p: 1 });
  });

  it('depends on the password, the salt, the server secret and the settings', async () => {
    const salt = Buffer.alloc(16, 1);
    const pepper = Buffer.alloc(32, 2);
    const base = hex(await stretchPassword('correct horse battery staple', salt, pepper, FAST));
    expect(hex(await stretchPassword('correct horse battery staple', salt, pepper, FAST))).toBe(base);
    expect(hex(await stretchPassword('correct horse battery stapl3', salt, pepper, FAST))).not.toBe(base);
    expect(hex(await stretchPassword('correct horse battery staple', Buffer.alloc(16, 9), pepper, FAST))).not.toBe(base);
    expect(hex(await stretchPassword('correct horse battery staple', salt, Buffer.alloc(32, 9), FAST))).not.toBe(base);
    expect(hex(await stretchPassword('correct horse battery staple', salt, pepper, { ...FAST, t: 2 }))).not.toBe(base);
  });

  it('treats the same characters typed differently as the same password', async () => {
    const salt = Buffer.alloc(16, 1);
    const pepper = Buffer.alloc(32, 2);
    const composed = 'café au lait every day'; // é as one character
    const decomposed = 'café au lait every day'; // e followed by a combining accent
    expect(hex(await stretchPassword(composed, salt, pepper, FAST))).toBe(hex(await stretchPassword(decomposed, salt, pepper, FAST)));
  });

  it('refuses a scheme it does not know', () => {
    expect(() => stretchPassword('x', Buffer.alloc(16), Buffer.alloc(32), { ...FAST, alg: 'scrypt' as 'argon2id' })).toThrow(/Unknown password scheme/);
  });
});

describe('sealing', () => {
  const key = Buffer.alloc(32, 7);
  const secret = Buffer.from('the vault key goes here, 32 byte');

  it('opens with the same key and context', () => {
    const sealed = seal(key, secret, 'ctx/user-1');
    expect(sealed.length).toBe(1 + 12 + secret.length + 16);
    expect(unseal(key, sealed, 'ctx/user-1').equals(secret)).toBe(true);
  });

  it('never produces the same bytes twice', () => {
    expect(hex(seal(key, secret, 'ctx'))).not.toBe(hex(seal(key, secret, 'ctx')));
  });

  it('does not contain what it protects', () => {
    expect(hex(seal(key, secret, 'ctx'))).not.toContain(hex(secret));
  });

  it('fails with another key or another context', () => {
    const sealed = seal(key, secret, 'ctx/user-1');
    expect(() => unseal(Buffer.alloc(32, 8), sealed, 'ctx/user-1')).toThrow(SealError);
    expect(() => unseal(key, sealed, 'ctx/user-2')).toThrow(SealError);
    expect(() => unseal(key, sealed, '')).toThrow(SealError);
  });

  it('fails when any single bit is changed', () => {
    const sealed = seal(key, secret, 'ctx');
    for (let i = 0; i < sealed.length; i++) {
      const changed = Buffer.from(sealed);
      changed[i] ^= 0x01;
      expect(() => unseal(key, changed, 'ctx'), `byte ${i}`).toThrow(SealError);
    }
  });

  it('fails when cut short or empty', () => {
    const sealed = seal(key, secret, 'ctx');
    for (const length of [0, 1, 13, 28, sealed.length - 1]) {
      expect(() => unseal(key, sealed.subarray(0, length), 'ctx'), `length ${length}`).toThrow(SealError);
    }
  });

  it('does not accept a shortened tag', () => {
    const sealed = seal(key, Buffer.alloc(0), 'ctx'); // version + nonce + 16-byte tag, no ciphertext
    // Dropping tag bytes must not turn the remaining ones into a valid, weaker tag.
    expect(() => unseal(key, sealed.subarray(0, sealed.length - 4), 'ctx')).toThrow(SealError);
  });
});

describe('tokens and codes', () => {
  it('round-trips a token through its cookie form and rejects anything malformed', () => {
    const token = newToken();
    const text = toBase64Url(token);
    expect(text).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(fromBase64Url(text, 32)!.equals(token)).toBe(true);
    expect(fromBase64Url(text.slice(1), 32)).toBeUndefined();
    expect(fromBase64Url(`${text}A`, 32)).toBeUndefined();
    expect(fromBase64Url(`${text.slice(0, -1)}=`, 32)).toBeUndefined();
    expect(fromBase64Url(`${text.slice(0, -1)}+`, 32)).toBeUndefined();
    expect(fromBase64Url('', 32)).toBeUndefined();
  });

  it('accepts only the canonical spelling of a token', () => {
    // 43 base64url characters carry 258 bits: the last character has two spare bits that must be zero.
    const text = toBase64Url(Buffer.alloc(32, 0xff));
    expect(text.endsWith('8')).toBe(true);
    expect(fromBase64Url(`${text.slice(0, -1)}9`, 32)).toBeUndefined();
  });

  it('makes recovery codes of 24 unambiguous characters', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const code = newRecoveryCode();
      expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{24}$/);
      seen.add(code);
    }
    expect(seen.size).toBe(200);
  });

  it('shows a recovery code in groups of four and reads it back however it was typed', () => {
    const code = 'ABCD0123EFGH4567JKMN89PQ';
    expect(formatRecoveryCode(code)).toBe('ABCD-0123-EFGH-4567-JKMN-89PQ');
    expect(parseRecoveryCode('ABCD-0123-EFGH-4567-JKMN-89PQ')).toBe(code);
    expect(parseRecoveryCode('  abcd 0123 efgh 4567 jkmn 89pq ')).toBe(code);
    // O is read as 0, and I and L as 1: those letters are never in a code.
    expect(parseRecoveryCode('ABCD-O123-EFGH-4567-JKMN-89PQ')).toBe(code);
    expect(parseRecoveryCode('ABCD-0I23-EFGH-4567-JKMN-89PQ')).toBe(code);
    expect(parseRecoveryCode('ABCD-0l23-EFGH-4567-JKMN-89PQ')).toBe(code);
  });

  it('rejects text that cannot be a recovery code', () => {
    expect(parseRecoveryCode('')).toBeUndefined();
    expect(parseRecoveryCode('ABCD-0123-EFGH-4567-JKMN-89P')).toBeUndefined();
    expect(parseRecoveryCode('ABCD-0123-EFGH-4567-JKMN-89PQR')).toBeUndefined();
    expect(parseRecoveryCode('ABCD-0123-EFGH-4567-JKMN-89PU')).toBeUndefined(); // U is not in the alphabet
    expect(parseRecoveryCode('ABCD-0123-EFGH-4567-JKMN-89P!')).toBeUndefined();
  });
});

describe('the key hierarchy', () => {
  const salt = Buffer.alloc(16, 3);
  const pepper = Buffer.alloc(32, 4);

  it('gives a verifier and a wrapping key that are unrelated, and the same ones every time', async () => {
    const a = await passwordKeys('fourteen characters!', salt, pepper, FAST);
    const b = await passwordKeys('fourteen characters!', salt, pepper, FAST);
    expect(hex(a.verifier)).toBe(hex(b.verifier));
    expect(hex(a.wrapKey)).toBe(hex(b.wrapKey));
    expect(hex(a.verifier)).not.toBe(hex(a.wrapKey));
    // The stored verifier is a hash of the auth key, so it is not the auth key and not the wrapping key's source.
    expect(hex(sha256(a.wrapKey))).not.toBe(hex(a.verifier));
  });

  it('changes everything when the server secret changes', async () => {
    const a = await passwordKeys('fourteen characters!', salt, pepper, FAST);
    const b = await passwordKeys('fourteen characters!', salt, Buffer.alloc(32, 5), FAST);
    expect(hex(a.verifier)).not.toBe(hex(b.verifier));
    expect(hex(a.wrapKey)).not.toBe(hex(b.wrapKey));
  });

  it('derives a session id that does not open what the session key locks', () => {
    const token = newToken();
    const { sid, wrapKey } = sessionKeys(token);
    expect(hex(sid)).not.toBe(hex(wrapKey));
    expect(hex(sessionKeys(token).sid)).toBe(hex(sid));
    const vaultKey = newVaultKey();
    const locked = lockVaultKey(vaultKey, wrapKey, 'session', 'user-1', sid);
    expect(openVaultKey(locked, wrapKey, 'session', 'user-1', sid).equals(vaultKey)).toBe(true);
    // What the database holds (the id) and what an attacker could try with it:
    expect(() => openVaultKey(locked, sid, 'session', 'user-1', sid)).toThrow(SealError);
    expect(() => openVaultKey(locked, sha256(sid), 'session', 'user-1', sid)).toThrow(SealError);
    expect(() => openVaultKey(locked, deriveKey(sid, 'job-hunt/v1/session/wrap'), 'session', 'user-1', sid)).toThrow(SealError);
  });

  it('ties each locked copy to its kind, its owner and its session', () => {
    const vaultKey = newVaultKey();
    const key = randomKey();
    const sid = sessionKeys(newToken()).sid;
    const other = sessionKeys(newToken()).sid;
    const byPassword = lockVaultKey(vaultKey, key, 'password', 'user-1');
    expect(openVaultKey(byPassword, key, 'password', 'user-1').equals(vaultKey)).toBe(true);
    expect(() => openVaultKey(byPassword, key, 'password', 'user-2')).toThrow(SealError); // moved to another user
    expect(() => openVaultKey(byPassword, key, 'recovery', 'user-1')).toThrow(SealError); // moved to another slot
    const bySession = lockVaultKey(vaultKey, key, 'session', 'user-1', sid);
    expect(() => openVaultKey(bySession, key, 'session', 'user-1', other)).toThrow(SealError); // moved to another session
    expect(() => openVaultKey(bySession, key, 'session', 'user-1')).toThrow(SealError);
  });

  it('derives the recovery key from the code and its salt', () => {
    const code = 'ABCD0123EFGH4567JKMN89PQ';
    const a = recoveryKey(code, salt);
    expect(hex(recoveryKey(code, salt))).toBe(hex(a));
    expect(hex(recoveryKey(code, Buffer.alloc(16, 9)))).not.toBe(hex(a));
    expect(hex(recoveryKey('ABCD0123EFGH4567JKMN89PR', salt))).not.toBe(hex(a));
  });
});
