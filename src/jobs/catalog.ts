/**
 * EXPERIMENTAL company & industry catalog.
 *
 * The idea: most employers don't run their own job software. They rent it
 * from a handful of applicant-tracking systems (ATS) — Workday, Greenhouse,
 * Lever, Ashby, SmartRecruiters, iCIMS, Dayforce — and each ATS exposes the
 * same public job feed for every customer. So one adapter per ATS reaches
 * every company on it, and adding a company is just knowing its board id.
 *
 * Three ways a company gets resolved, in order:
 *   1. A catalog entry below (board ids are best-known values; the server
 *      re-checks them and reports when one stops resolving).
 *   2. Auto-discovery: the server probes each ATS with slugs made from the
 *      typed name (e.g. "Acme Robotics" → acmerobotics, acme-robotics) and
 *      caches whichever answers. See server/src/discover.ts.
 *   3. Fallback: a Google for Jobs search filtered to that employer, which
 *      covers companies with fully custom career sites (Google, Microsoft…).
 */
export type Platform =
  | 'greenhouse'
  | 'lever'
  | 'ashby'
  | 'smartrecruiters'
  | 'workday'
  | 'usajobs'
  | 'amazon'
  | 'dayforce'
  | 'google-jobs';

export const PLATFORM_LABEL: Record<Platform, string> = {
  greenhouse: 'Greenhouse',
  lever: 'Lever',
  ashby: 'Ashby',
  smartrecruiters: 'SmartRecruiters',
  workday: 'Workday',
  usajobs: 'USAJOBS',
  amazon: 'Amazon Jobs',
  dayforce: 'Dayforce',
  'google-jobs': 'Google for Jobs (employer filter)',
};

/** Platforms with a working adapter. Dayforce is planned (needs per-tenant research). */
export const SUPPORTED_PLATFORMS: Platform[] = ['greenhouse', 'lever', 'ashby', 'smartrecruiters', 'workday', 'usajobs', 'amazon', 'google-jobs'];

export interface WorkdayBoard {
  /** e.g. "boeing.wd1.myworkdayjobs.com" */
  host: string;
  tenant: string;
  site: string;
}

export interface CompanyDef {
  id: string;
  name: string;
  aliases?: string[];
  industries: string[];
  platform: Platform;
  /** Board token / org slug / USAJOBS organization code, depending on platform. */
  board?: string;
  workday?: WorkdayBoard;
}

export const INDUSTRIES = [
  'Software & Internet',
  'Fintech & Banking',
  'Aerospace & Aviation',
  'Defense',
  'Government',
  'Semiconductors & Hardware',
  'Retail & E-commerce',
  'Healthcare',
  'AI',
  'Media & Entertainment',
  'Transportation & Logistics',
] as const;

export const COMPANIES: CompanyDef[] = [
  // Big tech with custom career sites → employer-filtered Google for Jobs.
  { id: 'google', name: 'Google', aliases: ['Alphabet'], industries: ['Software & Internet', 'AI'], platform: 'google-jobs' },
  { id: 'microsoft', name: 'Microsoft', industries: ['Software & Internet', 'AI'], platform: 'google-jobs' },
  { id: 'apple', name: 'Apple', industries: ['Software & Internet', 'Semiconductors & Hardware'], platform: 'google-jobs' },
  { id: 'meta', name: 'Meta', aliases: ['Facebook'], industries: ['Software & Internet', 'AI'], platform: 'google-jobs' },
  { id: 'amazon', name: 'Amazon', aliases: ['AWS', 'Amazon Web Services'], industries: ['Software & Internet', 'Retail & E-commerce', 'Transportation & Logistics'], platform: 'amazon' },

  // Workday tenants.
  { id: 'boeing', name: 'Boeing', industries: ['Aerospace & Aviation', 'Defense'], platform: 'workday', workday: { host: 'boeing.wd1.myworkdayjobs.com', tenant: 'boeing', site: 'EXTERNAL_CAREERS' } },
  { id: 'nvidia', name: 'NVIDIA', industries: ['Semiconductors & Hardware', 'AI'], platform: 'workday', workday: { host: 'nvidia.wd5.myworkdayjobs.com', tenant: 'nvidia', site: 'NVIDIAExternalCareerSite' } },
  { id: 'salesforce', name: 'Salesforce', industries: ['Software & Internet'], platform: 'workday', workday: { host: 'salesforce.wd12.myworkdayjobs.com', tenant: 'salesforce', site: 'External_Career_Site' } },
  { id: 'adobe', name: 'Adobe', industries: ['Software & Internet', 'Media & Entertainment'], platform: 'workday', workday: { host: 'adobe.wd5.myworkdayjobs.com', tenant: 'adobe', site: 'external_experienced' } },
  { id: 'intel', name: 'Intel', industries: ['Semiconductors & Hardware'], platform: 'workday', workday: { host: 'intel.wd1.myworkdayjobs.com', tenant: 'intel', site: 'External' } },
  { id: 'capitalone', name: 'Capital One', industries: ['Fintech & Banking'], platform: 'workday', workday: { host: 'capitalone.wd12.myworkdayjobs.com', tenant: 'capitalone', site: 'Capital_One' } },
  { id: 'northrop', name: 'Northrop Grumman', industries: ['Aerospace & Aviation', 'Defense'], platform: 'workday', workday: { host: 'ngc.wd1.myworkdayjobs.com', tenant: 'ngc', site: 'Northrop_Grumman_External_Site' } },
  { id: 'unitedhealth', name: 'UnitedHealth Group', aliases: ['Optum'], industries: ['Healthcare'], platform: 'workday', workday: { host: 'uhg.wd1.myworkdayjobs.com', tenant: 'uhg', site: 'External' } },

  // Greenhouse boards.
  { id: 'airbnb', name: 'Airbnb', industries: ['Software & Internet'], platform: 'greenhouse', board: 'airbnb' },
  { id: 'stripe', name: 'Stripe', industries: ['Fintech & Banking', 'Software & Internet'], platform: 'greenhouse', board: 'stripe' },
  { id: 'figma', name: 'Figma', industries: ['Software & Internet'], platform: 'greenhouse', board: 'figma' },
  { id: 'discord', name: 'Discord', industries: ['Software & Internet', 'Media & Entertainment'], platform: 'greenhouse', board: 'discord' },
  { id: 'robinhood', name: 'Robinhood', industries: ['Fintech & Banking'], platform: 'greenhouse', board: 'robinhood' },
  { id: 'coinbase', name: 'Coinbase', industries: ['Fintech & Banking'], platform: 'greenhouse', board: 'coinbase' },
  { id: 'dropbox', name: 'Dropbox', industries: ['Software & Internet'], platform: 'greenhouse', board: 'dropbox' },
  { id: 'reddit', name: 'Reddit', industries: ['Software & Internet', 'Media & Entertainment'], platform: 'greenhouse', board: 'reddit' },
  { id: 'pinterest', name: 'Pinterest', industries: ['Software & Internet'], platform: 'greenhouse', board: 'pinterest' },
  { id: 'lyft', name: 'Lyft', industries: ['Software & Internet', 'Transportation & Logistics'], platform: 'greenhouse', board: 'lyft' },
  { id: 'anthropic', name: 'Anthropic', industries: ['AI'], platform: 'greenhouse', board: 'anthropic' },
  { id: 'datadog', name: 'Datadog', industries: ['Software & Internet'], platform: 'greenhouse', board: 'datadog' },
  { id: 'cloudflare', name: 'Cloudflare', industries: ['Software & Internet'], platform: 'greenhouse', board: 'cloudflare' },
  { id: 'spacex', name: 'SpaceX', industries: ['Aerospace & Aviation'], platform: 'greenhouse', board: 'spacex' },
  { id: 'anduril', name: 'Anduril', industries: ['Defense', 'Aerospace & Aviation'], platform: 'greenhouse', board: 'andurilindustries' },
  { id: 'jobyaviation', name: 'Joby Aviation', industries: ['Aerospace & Aviation'], platform: 'greenhouse', board: 'jobyaviation' },

  // Lever sites.
  { id: 'palantir', name: 'Palantir', industries: ['Software & Internet', 'Defense'], platform: 'lever', board: 'palantir' },
  { id: 'plaid', name: 'Plaid', industries: ['Fintech & Banking'], platform: 'lever', board: 'plaid' },
  { id: 'spotify', name: 'Spotify', industries: ['Media & Entertainment', 'Software & Internet'], platform: 'lever', board: 'spotify' },

  // Ashby boards.
  { id: 'openai', name: 'OpenAI', industries: ['AI'], platform: 'ashby', board: 'openai' },
  { id: 'ramp', name: 'Ramp', industries: ['Fintech & Banking'], platform: 'ashby', board: 'ramp' },
  { id: 'notion', name: 'Notion', industries: ['Software & Internet'], platform: 'ashby', board: 'notion' },
  { id: 'linear', name: 'Linear', industries: ['Software & Internet'], platform: 'ashby', board: 'linear' },

  // SmartRecruiters.
  { id: 'visa', name: 'Visa', industries: ['Fintech & Banking'], platform: 'smartrecruiters', board: 'Visa' },
  { id: 'bosch', name: 'Bosch', industries: ['Semiconductors & Hardware'], platform: 'smartrecruiters', board: 'BoschGroup' },

  // Federal agencies via USAJOBS organization codes.
  { id: 'faa', name: 'Federal Aviation Administration', aliases: ['FAA'], industries: ['Government', 'Aerospace & Aviation'], platform: 'usajobs', board: 'TD03' },
  { id: 'nasa', name: 'NASA', aliases: ['National Aeronautics and Space Administration'], industries: ['Government', 'Aerospace & Aviation'], platform: 'usajobs', board: 'NN' },
  { id: 'va', name: 'Department of Veterans Affairs', aliases: ['VA'], industries: ['Government', 'Healthcare'], platform: 'usajobs', board: 'VA' },
  { id: 'dod', name: 'Department of Defense', aliases: ['DoD'], industries: ['Government', 'Defense'], platform: 'usajobs', board: 'DD' },
  { id: 'tsa', name: 'Transportation Security Administration', aliases: ['TSA'], industries: ['Government', 'Transportation & Logistics'], platform: 'usajobs', board: 'HSBC' },
];

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

/** Combo-box search over names, aliases and industries. */
export function searchCatalog(q: string, limit = 8): CompanyDef[] {
  const n = norm(q);
  if (!n) return [];
  const scored = COMPANIES.map((c) => {
    const names = [c.name, ...(c.aliases ?? [])].map(norm);
    let score = 0;
    if (names.some((x) => x === n)) score = 100;
    else if (names.some((x) => x.startsWith(n))) score = 60;
    else if (names.some((x) => x.includes(n))) score = 40;
    else if (c.industries.some((i) => norm(i).includes(n))) score = 20;
    return { c, score };
  }).filter((x) => x.score > 0);
  return scored.sort((a, b) => b.score - a.score || a.c.name.localeCompare(b.c.name)).slice(0, limit).map((x) => x.c);
}

export const companyById = (id: string) => COMPANIES.find((c) => c.id === id);

/** Free-typed company names are stored as "custom:<name>" in settings. */
export const customCompany = (name: string) => `custom:${name.trim()}`;
export const isCustomCompany = (id: string) => id.startsWith('custom:');

/** Slug candidates used by auto-discovery to guess a board token. */
export function slugCandidates(name: string): string[] {
  const words = name
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/\b(inc|llc|ltd|corp|corporation|co|company|group|holdings|technologies|the)\b\.?/g, ' ')
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  if (!words.length) return [];
  const set = new Set([words.join(''), words.join('-'), words[0], words.join('_')]);
  return [...set].filter((s) => s.length >= 2);
}
