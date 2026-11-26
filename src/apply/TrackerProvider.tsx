/**
 * The tracked applications, for the whole app: whether this copy of the app has a tracker at all, and the list.
 * The list always comes from the server (GET /api/applications). Nothing of it is kept in the browser, so the
 * user's browser and an assistant working on the same computer always see the same applications.
 */
import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useState, type ReactNode } from 'react';
import type { UnreadableFile } from './api';
import { TRACKER_ENABLED, TrackerError, trackerApi } from './client';
import type { ApplicationSummary } from './model';

export type TrackerState =
  /** No applications here: this build has no server of its own, the server keeps none, or it did not answer. */
  | { status: 'off'; why: 'build' | 'server' | 'unreachable' }
  /** Still asking the server. */
  | { status: 'checking' }
  /** Newest change first. `unreadable` are files in the server's folder that are not applications it can read. */
  | { status: 'on'; applications: ApplicationSummary[]; unreadable: UnreadableFile[] };

interface TrackerContextValue {
  state: TrackerState;
  /** Asks the server for the list again. Call it after anything that changes an application. */
  refresh: () => Promise<TrackerState>;
}

const OFF: TrackerState = { status: 'off', why: 'build' };

const TrackerContext = createContext<TrackerContextValue>({ state: OFF, refresh: async () => OFF });

export const useTracker = () => useContext(TrackerContext);

const RETRY_MS = 1500;

/** One question to the server, asked again a few times if the server is not up yet (it starts alongside the page). */
export async function loadTrackerState(tries = 1, wait: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms))): Promise<TrackerState> {
  for (let attempt = 1; ; attempt++) {
    try {
      const reply = await trackerApi.list();
      if (!reply.available) return { status: 'off', why: 'server' };
      return { status: 'on', applications: reply.applications, unreadable: reply.unreadable ?? [] };
    } catch (e) {
      const down = e instanceof TrackerError && e.code === 'unreachable' && (e.status === 0 || e.status >= 500);
      if (!down || attempt >= tries) return { status: 'off', why: 'unreachable' };
      await wait(RETRY_MS);
    }
  }
}

export function TrackerProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<TrackerState>(TRACKER_ENABLED ? { status: 'checking' } : OFF);
  const on = state.status === 'on';

  useEffect(() => {
    if (!TRACKER_ENABLED) return;
    let current = true;
    void loadTrackerState(3).then((s) => current && setState(s));
    return () => {
      current = false;
    };
  }, []);

  const refresh = useCallback(async () => {
    if (!TRACKER_ENABLED) return OFF;
    const next = await loadTrackerState();
    // A list that is on the page is not taken away because one question went unanswered. If the server is really
    // gone, whatever the user does next says so.
    setState((old) => (old.status === 'on' && next.status === 'off' && next.why === 'unreachable' ? old : next));
    return next;
  }, []);

  // An assistant may have changed the applications while this window was in the background.
  // A layout effect, so that the listening starts in the same step in which the list is put on the page. A plain
  // effect starts a moment later, and a focus that comes in between is missed until the next look at the server.
  useLayoutEffect(() => {
    if (!on) return;
    const again = () => void refresh();
    window.addEventListener('focus', again);
    return () => window.removeEventListener('focus', again);
  }, [on, refresh]);

  const value = useMemo(() => ({ state, refresh }), [state, refresh]);
  return <TrackerContext.Provider value={value}>{children}</TrackerContext.Provider>;
}
