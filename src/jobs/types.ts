export type Workplace = 'remote' | 'hybrid' | 'onsite';

export interface JobQuery {
  role: string;
  location?: string;
  /** Miles around `location`. Ignored for remote-only searches. */
  distanceMiles?: number;
  /** Empty = any. */
  workplace?: Workplace[];
  postedWithinDays?: number;
  page?: number;
}

export interface Salary {
  min?: number;
  max?: number;
  currency?: string;
  period?: 'hour' | 'day' | 'week' | 'month' | 'year';
  /** Text as the posting shows it, when available. */
  text?: string;
}

/** Where a posting was found. One job can be listed on several boards. */
export interface JobListing {
  sourceId: string;
  /** Board or site name as shown to the user, e.g. "LinkedIn". */
  via: string;
  url: string;
  applyUrl?: string;
}

export interface JobPosting {
  /** Stable id: `${sourceId}:${nativeId}` of the first listing. */
  id: string;
  title: string;
  company: string;
  companyLogo?: string;
  location?: string;
  workplace?: Workplace;
  employmentType?: string;
  postedAt?: string;
  salary?: Salary;
  /** Sanitized-at-render HTML when the source gives it; plain text otherwise. */
  descriptionHtml?: string;
  descriptionText?: string;
  /** True when the source only gave a snippet; call /api/job for the rest. */
  descriptionPartial?: boolean;
  listings: JobListing[];
}

export interface SourceStatus {
  sourceId: string;
  label: string;
  ok: boolean;
  count: number;
  ms: number;
  error?: string;
  /** The error was the site refusing automated traffic (a bot check), not a fault in the source. */
  blocked?: boolean;
  /** e.g. "needs JSEARCH_API_KEY on the server". */
  skipped?: string;
}

export interface SearchResponse {
  jobs: JobPosting[];
  sources: SourceStatus[];
}

/** What the settings gear selects. */
export interface SearchSettings {
  boards: string[];
  /** Experimental: catalog company ids and free-typed company names. */
  companies: string[];
  industries: string[];
  /** Show the experimental scraping routes (LinkedIn guest pages, Playwright). */
  allowScraping: boolean;
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface AdapterContext {
  fetch: FetchLike;
  env: Record<string, string | undefined>;
  signal?: AbortSignal;
}
