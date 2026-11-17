/**
 * Rules for a new password. Length is what matters: at least 14 characters, because this one password also guards
 * the vault. There are no symbol rules, and pasting from a password manager is fine.
 *
 * A new password is also looked up among passwords known from data breaches, using the Pwned Passwords range
 * service. Only the first five characters of the password's SHA-1 hash leave this server, and the answer is a
 * list of several hundred hashes that start that way, so the service learns neither the password nor whether it
 * was found. If the service cannot be reached the password is accepted: sign-up must not depend on a third party.
 */
import { createHash } from 'node:crypto';
import { passwordProblem, type PasswordProblem } from '../../../src/account/api';
import type { FetchLike } from '../../../src/jobs/types';
import { normalizePassword } from './crypto';

/** True when the password is in the breach list, false when it is not, undefined when the list could not be asked. */
export type BreachCheck = (password: string) => Promise<boolean | undefined>;

const RANGE_URL = 'https://api.pwnedpasswords.com/range/';

export interface BreachCheckOptions {
  timeoutMs?: number;
  /** Told why, each time the list could not be asked. The message never holds anything about the password. */
  onUnavailable?: (why: string) => void;
}

export function makeBreachCheck(fetch: FetchLike, o: BreachCheckOptions = {}): BreachCheck {
  return async (password) => {
    const hash = createHash('sha1').update(normalizePassword(password), 'utf8').digest('hex').toUpperCase();
    try {
      // Add-Padding makes every answer the same size, so its length says nothing about the prefix either.
      const res = await fetch(RANGE_URL + hash.slice(0, 5), { headers: { 'Add-Padding': 'true' }, signal: AbortSignal.timeout(o.timeoutMs ?? 3000) });
      if (!res.ok) {
        o.onUnavailable?.(`it answered ${res.status}`);
        return undefined;
      }
      const suffix = hash.slice(5);
      for (const line of (await res.text()).split('\n')) {
        const [candidate, count] = line.trim().split(':');
        if (candidate === suffix) return Number(count) > 0; // padding rows carry a count of 0
      }
      return false;
    } catch (e) {
      o.onUnavailable?.((e as Error).name === 'TimeoutError' ? 'it did not answer in time' : 'it could not be reached');
      return undefined;
    }
  };
}

export async function checkNewPassword(password: string, email: string, breached?: BreachCheck): Promise<PasswordProblem | undefined> {
  const problem = passwordProblem(password, email);
  if (problem) return problem;
  return breached && (await breached(password)) ? 'breached' : undefined;
}
