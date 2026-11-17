import { aggregate } from './aggregate';
import { DEFAULT_BOARDS } from './boards';
import type { JobPosting, JobQuery, SearchResponse, SearchSettings } from './types';

/**
 * The search server the app uses until the user sets another one (gear icon → Search server). A build can name one
 * with VITE_API_URL. A server that serves the app itself says so in the page (server/src/static.ts), and then the
 * search server is the page's own address.
 */
const servedByServer = typeof document !== 'undefined' && document.querySelector('meta[name="job-hunt-server"]') !== null;
export const DEFAULT_API_URL: string = import.meta.env.VITE_API_URL || (servedByServer ? window.location.origin : '');

export const DEFAULT_SETTINGS: SearchSettings & { apiUrl: string } = {
  boards: DEFAULT_BOARDS,
  companies: [],
  industries: [],
  allowScraping: false,
  apiUrl: DEFAULT_API_URL,
};

export type ClientSettings = typeof DEFAULT_SETTINGS;

export async function searchJobs(query: JobQuery, s: ClientSettings, signal?: AbortSignal): Promise<SearchResponse> {
  const { apiUrl, ...settings } = s;
  if (apiUrl) {
    const res = await fetch(`${apiUrl.replace(/\/$/, '')}/api/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, settings }),
      signal,
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `Search server answered ${res.status}`);
    return res.json();
  }
  // No backend configured: run the sources a browser can reach directly.
  return aggregate(query, settings, { fetch: (u, i) => fetch(u, i), env: {}, signal }, { runtime: 'browser' });
}

export async function fetchJobDetail(id: string, apiUrl: string): Promise<Partial<JobPosting>> {
  const res = await fetch(`${apiUrl.replace(/\/$/, '')}/api/job?id=${encodeURIComponent(id)}`);
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `Server answered ${res.status}`);
  return res.json();
}

export interface Health {
  ok: boolean;
  sources: { googleJobs: string | null; usajobs: boolean; linkedinGuest: boolean; playwright: boolean };
}

export async function fetchHealth(apiUrl: string): Promise<Health> {
  const res = await fetch(`${apiUrl.replace(/\/$/, '')}/api/health`, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`Server answered ${res.status}`);
  return res.json();
}
