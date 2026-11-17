/**
 * The account API as the browser and the server both see it: paths, request and reply shapes, and the rules the
 * sign-up form can check before asking the server. The server enforces every rule again.
 */

export const PASSWORD_MIN = 14;
export const PASSWORD_MAX = 256;

/** Why a new password was turned down. */
export type PasswordProblem = 'too_short' | 'too_long' | 'is_email' | 'breached';

export const PASSWORD_PROBLEM_TEXT: Record<PasswordProblem, string> = {
  too_short: `Use at least ${PASSWORD_MIN} characters. A few unrelated words work well.`,
  too_long: `Use at most ${PASSWORD_MAX} characters.`,
  is_email: 'Your password cannot be your email address.',
  breached: 'This password appears in lists of stolen passwords, so it is one of the first an attacker would try. Choose a different one.',
};

/** The checks that need nothing but the password itself. Counted in characters as typed, emoji included. */
export function passwordProblem(password: string, email: string): PasswordProblem | undefined {
  const length = [...password].length;
  if (length < PASSWORD_MIN) return 'too_short';
  if (length > PASSWORD_MAX) return 'too_long';
  if (password.trim().toLowerCase() === email.trim().toLowerCase()) return 'is_email';
  return undefined;
}

export const normalizeEmail = (email: string) => email.trim().toLowerCase();
export const looksLikeEmail = (email: string) => email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);

export type Role = 'user' | 'admin';

export interface AccountUser {
  email: string;
  role: Role;
}

export interface VaultState {
  /** Whether stored site logins can be used right now without typing the password again. */
  unlocked: boolean;
  /** When it locks by itself if not used (ISO time). */
  until?: string;
}

/** GET /api/auth/session */
export interface SessionReply {
  /** False when this server has accounts switched off. */
  available: boolean;
  user: AccountUser | null;
  vault?: VaultState;
}

/** One place the user is signed in. */
export interface SessionSummary {
  id: string;
  current: boolean;
  createdAt: string;
  lastSeenAt: string;
  userAgent: string;
}

export interface InviteInfo {
  kind: 'invite' | 'reset';
  email: string;
  expiresAt: string;
}

/** Replies that hand over a recovery code. It is shown once and never sent again. */
export interface RecoveryCodeReply {
  recoveryCode: string;
}

export type ErrorCode =
  | 'bad_request'
  | 'bad_origin'
  | 'not_signed_in'
  | 'invalid_credentials'
  | 'invalid_recovery'
  | 'wrong_password'
  | 'invalid_code'
  | 'weak_password'
  | 'vault_locked'
  | 'rate_limited'
  | 'busy'
  | 'not_found'
  | 'server_error';

/** Every failed reply has this body. `error` is a sentence that can be shown to the user as it is. */
export interface ErrorReply {
  error: string;
  code: ErrorCode;
  /** With `weak_password`. */
  problem?: PasswordProblem;
  /** With `rate_limited`: seconds until another try is allowed. */
  retryAfter?: number;
}
