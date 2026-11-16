import { aggregate } from './aggregate';
import { DEFAULT_BOARDS } from './boards';
import type { JobPosting, JobQuery, SearchResponse, SearchSettings } from './types';

export const DEFAULT_API_URL: string = import.meta.env.VITE_API_URL ?? '';

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
