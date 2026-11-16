/**
 * Major job boards, ordered by how much they're used for professional roles
 * paying roughly $50k+/yr. The order is an estimate from public traffic and
 * survey data (LinkedIn and Indeed dominate; Glassdoor and ZipRecruiter
 * follow; Dice, Built In and Wellfound are the big niche boards for tech;
 * Ladders focuses on $100k+; USAJOBS is the only route to most federal jobs).
 *
 * `publishers` are the names those boards appear under in Google for Jobs
 * results, which is how most of them are reached (see docs/job-sources.md).
 */
export interface BoardDef {
  id: string;
  name: string;
  blurb: string;
  publishers: string[];
  /** Adapters that can pull this board, in preference order. */
  routes: ('google-jobs' | 'linkedin-guest' | 'indeed-browser' | 'usajobs' | 'remotive' | 'remoteok')[];
  defaultOn: boolean;
}

export const BOARDS: BoardDef[] = [
  { id: 'linkedin', name: 'LinkedIn', blurb: 'Largest professional network and job board', publishers: ['LinkedIn'], routes: ['google-jobs', 'linkedin-guest'], defaultOn: true },
  { id: 'indeed', name: 'Indeed', blurb: 'Largest general job board by traffic', publishers: ['Indeed'], routes: ['google-jobs', 'indeed-browser'], defaultOn: true },
  { id: 'glassdoor', name: 'Glassdoor', blurb: 'Jobs with salary and company reviews', publishers: ['Glassdoor'], routes: ['google-jobs'], defaultOn: true },
  { id: 'ziprecruiter', name: 'ZipRecruiter', blurb: 'Large general board, strong in SMB hiring', publishers: ['ZipRecruiter'], routes: ['google-jobs'], defaultOn: true },
  { id: 'company-sites', name: 'Company career sites', blurb: 'Postings straight from employer career pages', publishers: ['Careers', 'Career', 'Jobs', 'Workday', 'Greenhouse', 'Lever', 'Ashby', 'SmartRecruiters', 'iCIMS'], routes: ['google-jobs'], defaultOn: true },
  { id: 'dice', name: 'Dice', blurb: 'Tech and engineering roles', publishers: ['Dice'], routes: ['google-jobs'], defaultOn: true },
  { id: 'builtin', name: 'Built In', blurb: 'Tech jobs by city', publishers: ['Built In', 'BuiltIn'], routes: ['google-jobs'], defaultOn: true },
  { id: 'wellfound', name: 'Wellfound', blurb: 'Startup jobs (formerly AngelList Talent)', publishers: ['Wellfound', 'AngelList'], routes: ['google-jobs'], defaultOn: true },
  { id: 'usajobs', name: 'USAJOBS', blurb: 'U.S. federal government jobs', publishers: ['USAJOBS', 'USAJobs'], routes: ['usajobs', 'google-jobs'], defaultOn: true },
  { id: 'ladders', name: 'Ladders', blurb: 'Roles paying $100k+', publishers: ['Ladders', 'TheLadders'], routes: ['google-jobs'], defaultOn: false },
  { id: 'monster', name: 'Monster', blurb: 'Long-running general board', publishers: ['Monster'], routes: ['google-jobs'], defaultOn: false },
  { id: 'simplyhired', name: 'SimplyHired', blurb: 'General aggregator', publishers: ['SimplyHired', 'Simply Hired'], routes: ['google-jobs'], defaultOn: false },
  { id: 'careerbuilder', name: 'CareerBuilder', blurb: 'General board', publishers: ['CareerBuilder'], routes: ['google-jobs'], defaultOn: false },
  { id: 'remote-boards', name: 'Remote job boards', blurb: 'Remotive and Remote OK feeds', publishers: ['Remotive', 'Remote OK', 'RemoteOK', 'We Work Remotely'], routes: ['remotive', 'remoteok', 'google-jobs'], defaultOn: false },
];

export const DEFAULT_BOARDS = BOARDS.filter((b) => b.defaultOn).map((b) => b.id);

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

/** Which board ids a publisher name (e.g. "via LinkedIn") belongs to. */
export function boardsForPublisher(publisher: string): string[] {
  const p = norm(publisher.replace(/^via\s+/i, ''));
  const exact = BOARDS.filter((b) => b.publishers.some((x) => norm(x) === p)).map((b) => b.id);
  if (exact.length) return exact;
  const partial = BOARDS.filter((b) => b.id !== 'company-sites' && b.publishers.some((x) => p.includes(norm(x)))).map((b) => b.id);
  // Anything that isn't a known board is treated as an employer's own site.
  return partial.length ? partial : ['company-sites'];
}
