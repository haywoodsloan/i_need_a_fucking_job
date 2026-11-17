/**
 * Who is signed in, for the whole app. The answer always comes from the server (GET /api/auth/session): the
 * browser's scripts cannot read the sign-in cookie, so nothing about the session is kept in local storage.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { AccountUser, VaultState } from './api';
import { ACCOUNTS_ENABLED, AccountApiError, accountApi } from './client';

export type AccountState =
  /** Accounts cannot be used: this build has none, the server has them switched off, or the server did not answer. */
  | { status: 'off'; why: 'build' | 'server' | 'unreachable' }
  /** Still asking the server. */
  | { status: 'checking' }
  | { status: 'signed-out' }
  | { status: 'signed-in'; user: AccountUser; vault?: VaultState };

interface AccountContextValue {
  state: AccountState;
  /** Asks the server again who is signed in. Call it after anything that signs in or out. */
  refresh: () => Promise<AccountState>;
}

const AccountContext = createContext<AccountContextValue>({
  state: { status: 'off', why: 'build' },
  refresh: async () => ({ status: 'off', why: 'build' }),
});

export const useAccount = () => useContext(AccountContext);

const RETRY_MS = 1500;

/** One question to the server, asked again a few times if the server is not up yet (it starts alongside the page). */
export async function loadAccountState(tries = 1, wait: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms))): Promise<AccountState> {
  for (let attempt = 1; ; attempt++) {
    try {
      const reply = await accountApi.session();
      if (!reply.available) return { status: 'off', why: 'server' };
      return reply.user ? { status: 'signed-in', user: reply.user, vault: reply.vault } : { status: 'signed-out' };
    } catch (e) {
      const down = e instanceof AccountApiError && e.code === 'unreachable' && (e.status === 0 || e.status >= 500);
      if (!down || attempt >= tries) return { status: 'off', why: 'unreachable' };
      await wait(RETRY_MS);
    }
  }
}

export function AccountProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AccountState>(ACCOUNTS_ENABLED ? { status: 'checking' } : { status: 'off', why: 'build' });
  const channel = useRef<BroadcastChannel | null>(null);

  useEffect(() => {
    if (!ACCOUNTS_ENABLED) return;
    let current = true;
    void loadAccountState(3).then((s) => current && setState(s));
    // Signing in or out in one tab is noticed by the others.
    if (typeof BroadcastChannel !== 'undefined') {
      const c = new BroadcastChannel('job-hunt-account');
      c.onmessage = () => void loadAccountState().then((s) => current && setState(s));
      channel.current = c;
    }
    return () => {
      current = false;
      channel.current?.close();
      channel.current = null;
    };
  }, []);

  const refresh = useCallback(async () => {
    if (!ACCOUNTS_ENABLED) return { status: 'off', why: 'build' } as const;
    const next = await loadAccountState();
    setState(next);
    channel.current?.postMessage('changed');
    return next;
  }, []);

  const value = useMemo(() => ({ state, refresh }), [state, refresh]);
  return <AccountContext.Provider value={value}>{children}</AccountContext.Provider>;
}
