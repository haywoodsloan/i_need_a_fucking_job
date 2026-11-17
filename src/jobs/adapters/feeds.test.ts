/**
 * The three feed sources: USAJOBS, Remotive and Remote OK. These are the edge cases, with small samples written
 * here. Each source is also run against a whole recorded answer in test/sources/contract.test.ts.
 */
import { describe, expect, it } from 'vitest';
import type { AdapterContext, FetchLike } from '../types';
import { normalizeRemoteOk, normalizeRemotive, normalizeUsajobs, remoteok, remotive, usajobs } from './feeds';

/** A job source that answers every request with the same body, and keeps what was asked. */
function source(body: unknown, env: Record<string, string> = {}) {
  const asked: { url: string; init?: RequestInit }[] = [];
  const fetch: FetchLike = async (url, init) => {
    asked.push({ url, init });
    return Response.json(body);
  };
  const ctx: AdapterContext = { fetch, env };
  return { ctx, asked };
}

const params = (url: string) => Object.fromEntries(new URL(url).searchParams);

describe('USAJOBS', () => {
  const env = { USAJOBS_API_KEY: 'the-key', USAJOBS_USER_AGENT: 'someone@example.com' };
  const empty = { SearchResult: { SearchResultItems: [] } };

  it('searches near the typed place, within the distance and the age asked for', async () => {
    const { ctx, asked } = source(empty, env);
    await usajobs.search({ role: 'air traffic controller', location: 'Oklahoma City, OK', distanceMiles: 50, postedWithinDays: 14 }, ctx);
    expect(asked[0].url.startsWith('https://data.usajobs.gov/api/search?')).toBe(true);
    expect(params(asked[0].url)).toEqual({ Keyword: 'air traffic controller', ResultsPerPage: '50', LocationName: 'Oklahoma City, OK', Radius: '50', DatePosted: '14' });
  });

  it('signs each request with the key and the contact address it was registered with', async () => {
    const { ctx, asked } = source(empty, env);
    await usajobs.search({ role: 'pilot' }, ctx);
    const headers = new Headers(asked[0].init?.headers);
    expect(headers.get('authorization-key')).toBe('the-key');
    expect(headers.get('user-agent')).toBe('someone@example.com');
  });

  it('asks for remote jobs, and no place, in a remote-only search', async () => {
    const { ctx, asked } = source(empty, env);
    await usajobs.search({ role: 'pilot', location: 'Austin, TX', distanceMiles: 25, workplace: ['remote'] }, ctx);
    expect(params(asked[0].url)).toEqual({ Keyword: 'pilot', ResultsPerPage: '50', RemoteIndicator: 'True' });
  });

  it('never asks for postings older than the 60 days the service keeps, and can be narrowed to one agency', async () => {
    const { ctx, asked } = source(empty, env);
    await usajobs.search({ role: 'pilot', postedWithinDays: 365 }, ctx, { organization: 'TD03' });
    expect(params(asked[0].url)).toMatchObject({ DatePosted: '60', Organization: 'TD03' });
  });

  it('builds the description from the summary, the duties and the qualifications', () => {
    const job = normalizeUsajobs({
      MatchedObjectId: '9',
      MatchedObjectDescriptor: {
        PositionTitle: 'Pilot',
        PositionURI: 'https://www.usajobs.gov/job/9',
        DepartmentName: 'Department of Transportation',
        QualificationSummary: 'A commercial licence.',
        UserArea: { Details: { JobSummary: 'Fly inspection routes.', MajorDuties: ['Plan flights', 'File reports'], RemoteIndicator: true, TeleworkEligible: true } },
      },
    });
    expect(job.descriptionText).toBe('Fly inspection routes.\n\n• Plan flights\n\n• File reports\n\nQualifications\nA commercial licence.');
    // With no agency name the department stands in. A fully remote job is remote even if it also allows telework.
    expect(job).toMatchObject({ company: 'Department of Transportation', workplace: 'remote', salary: undefined });
    expect(job.listings).toEqual([{ sourceId: 'usajobs', via: 'USAJOBS', url: 'https://www.usajobs.gov/job/9', applyUrl: 'https://www.usajobs.gov/job/9' }]);
  });

  it('has no description, and a general employer name, for a posting that gives neither', () => {
    const job = normalizeUsajobs({ MatchedObjectId: '1', MatchedObjectDescriptor: { PositionTitle: 'Clerk', PositionURI: 'https://www.usajobs.gov/job/1', PositionLocationDisplay: 'Remote' } });
    expect(job).toMatchObject({ company: 'U.S. Federal Government', workplace: 'remote', descriptionText: undefined });
  });
});

describe('Remotive', () => {
  const posting = { id: 7, url: 'https://remotive.com/remote-jobs/7', title: 'Senior Software Engineer', company_name: 'Acme' };

  it('is asked for the role, and its remote jobs are kept whatever place was typed', async () => {
    const { ctx, asked } = source({ jobs: [posting, { ...posting, id: 8, title: 'Account Executive' }] });
    const jobs = await remotive.search({ role: 'software engineer', location: 'Austin, TX' }, ctx);
    expect(asked.map((a) => a.url)).toEqual(['https://remotive.com/api/remote-jobs?search=software%20engineer&limit=50']);
    expect(jobs.map((j) => j.id)).toEqual(['remotive:7']);
  });

  it('is not asked at all when the search leaves remote work out', async () => {
    const { ctx, asked } = source({ jobs: [posting] });
    expect(await remotive.search({ role: 'software engineer', workplace: ['onsite', 'hybrid'] }, ctx)).toEqual([]);
    expect(asked).toEqual([]);
    expect(await remotive.search({ role: 'software engineer', workplace: ['remote', 'hybrid'] }, ctx)).toHaveLength(1);
  });

  it('says where a remote job may be done from, and keeps the salary as written', () => {
    const job = normalizeRemotive({ ...posting, candidate_required_location: 'USA Only', job_type: 'full_time', salary: '$120k - $150k', publication_date: '2026-11-10T08:00:00', description: '<p>Build &amp; run services.</p>' });
    expect(job).toMatchObject({
      location: 'Remote (USA Only)',
      workplace: 'remote',
      employmentType: 'full time',
      salary: { text: '$120k - $150k' },
      descriptionHtml: '<p>Build &amp; run services.</p>',
      descriptionText: 'Build & run services.',
    });
    expect(normalizeRemotive(posting)).toMatchObject({ location: 'Remote', salary: undefined, descriptionText: undefined, postedAt: undefined });
  });
});

describe('Remote OK', () => {
  const notice = { legal: 'Terms of the feed' };
  const posting = { id: '42', position: 'Software Engineer', company: 'Acme' };

  it('is read as one feed and filtered here, naming this tool to the service', async () => {
    const { ctx, asked } = source([notice, posting, { id: '43', position: 'Recruiter', company: 'Acme' }]);
    const jobs = await remoteok.search({ role: 'engineer', location: 'Austin, TX' }, ctx);
    expect(asked.map((a) => a.url)).toEqual(['https://remoteok.com/api']);
    expect(new Headers(asked[0].init?.headers).get('user-agent')).toBe('job-hunt-workbench/0.1');
    expect(jobs.map((j) => j.id)).toEqual(['remoteok:42']);
  });

  it('is not asked at all when the search leaves remote work out', async () => {
    const { ctx, asked } = source([notice, posting]);
    expect(await remoteok.search({ role: 'engineer', workplace: ['onsite'] }, ctx)).toEqual([]);
    expect(asked).toEqual([]);
  });

  it('links to the posting by its address, or builds one from its name or number', () => {
    const link = (j: Parameters<typeof normalizeRemoteOk>[0]) => normalizeRemoteOk(j)?.listings[0];
    expect(link({ ...posting, url: 'https://remoteok.com/remote-jobs/42-engineer', apply_url: 'https://acme.example/apply' })).toMatchObject({ url: 'https://remoteok.com/remote-jobs/42-engineer', applyUrl: 'https://acme.example/apply' });
    expect(link({ ...posting, slug: 'software-engineer-acme-42' })).toMatchObject({ url: 'https://remoteok.com/remote-jobs/software-engineer-acme-42', applyUrl: 'https://remoteok.com/remote-jobs/software-engineer-acme-42' });
    expect(link(posting)?.url).toBe('https://remoteok.com/remote-jobs/42');
  });

  it('treats a salary of 0 as no salary, and unpacks a description sent as escaped HTML', () => {
    expect(normalizeRemoteOk({ ...posting, salary_min: 0, salary_max: 0 })?.salary).toBeUndefined();
    expect(normalizeRemoteOk({ ...posting, salary_min: 90_000, salary_max: 0 })?.salary).toEqual({ min: 90_000, max: undefined, currency: 'USD', period: 'year' });
    expect(normalizeRemoteOk({ ...posting, company: undefined, company_logo: '', location: 'Worldwide', description: '&lt;p&gt;Ship code.&lt;/p&gt;' })).toMatchObject({
      company: 'Unknown',
      companyLogo: undefined,
      location: 'Remote (Worldwide)',
      descriptionHtml: '<p>Ship code.</p>',
      descriptionText: 'Ship code.',
    });
  });
});
