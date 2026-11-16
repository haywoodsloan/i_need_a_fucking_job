import { describe, expect, it } from 'vitest';
import { aggregate, dedupeKey, mergeJobs } from './aggregate';
import { normalizeAshby, normalizeGreenhouse, normalizeLever, normalizeWorkday, workdayPostedToIso } from './adapters/ats';
import { matchesQuery } from './adapters/common';
import { normalizeRemoteOk, normalizeUsajobs } from './adapters/feeds';
import { jsearchUrl, normalizeJSearch, normalizeSerp, parseSalaryText, relativeToIso } from './adapters/googleJobs';
import { parseIndeedPage, readJsonObject } from './adapters/indeed';
import { linkedinSearchUrl, parseLinkedinCards, parseLinkedinDetail } from './adapters/linkedin';
import { boardsForPublisher } from './boards';
import { searchCatalog, slugCandidates } from './catalog';
import type { FetchLike, JobPosting } from './types';

const NOW = Date.parse('2026-11-16T12:00:00Z');

describe('Google for Jobs', () => {
  it('normalizes JSearch results and keeps every board a job appears on', () => {
    const j = normalizeJSearch({
      job_id: 'abc',
      job_title: 'Backend Engineer',
      employer_name: 'Globex',
      job_publisher: 'LinkedIn',
      job_apply_link: 'https://linkedin.com/jobs/view/1',
      apply_options: [
        { publisher: 'LinkedIn', apply_link: 'https://linkedin.com/jobs/view/1' },
        { publisher: 'Indeed', apply_link: 'https://indeed.com/viewjob?jk=2' },
      ],
      job_is_remote: false,
      job_city: 'Austin',
      job_state: 'TX',
      job_min_salary: 140000,
      job_max_salary: 170000,
      job_salary_period: 'YEAR',
      job_posted_at_datetime_utc: '2026-11-10T00:00:00.000Z',
      job_description: 'Build things.',
    });
    expect(j).toMatchObject({ title: 'Backend Engineer', company: 'Globex', location: 'Austin, TX', salary: { min: 140000, max: 170000, period: 'year' } });
    expect(j.listings.map((l) => l.via)).toEqual(['LinkedIn', 'Indeed']);
  });

  it('builds JSearch queries with remote/radius/date filters', () => {
    const u = new URL(jsearchUrl({ role: 'data analyst', location: 'Chicago, IL', distanceMiles: 25, postedWithinDays: 7 }));
    expect(u.searchParams.get('query')).toBe('data analyst in Chicago, IL');
    expect(u.searchParams.get('radius')).toBe('40');
    expect(u.searchParams.get('date_posted')).toBe('week');
    const r = new URL(jsearchUrl({ role: 'designer', location: 'Chicago, IL', workplace: ['remote'] }));
    expect(r.searchParams.get('query')).toBe('designer');
    expect(r.searchParams.get('remote_jobs_only')).toBe('true');
  });

  it('normalizes SerpAPI results', () => {
    const j = normalizeSerp(
      {
        job_id: 'xyz',
        title: 'Product Designer',
        company_name: 'Initech',
        location: '  Dallas, TX ',
        via: 'via Glassdoor',
        detected_extensions: { posted_at: '3 days ago', salary: '$120K–$150K a year', schedule_type: 'Full-time' },
        apply_options: [{ title: 'Glassdoor', link: 'https://glassdoor.com/x' }],
      },
      NOW,
    );
    expect(j).toMatchObject({ location: 'Dallas, TX', employmentType: 'Full-time', salary: { min: 120000, max: 150000, period: 'year' } });
    expect(j.postedAt).toBe(new Date(NOW - 3 * 86400000).toISOString());
  });

  it('parses relative dates and salary text', () => {
    expect(relativeToIso('2 hours ago', NOW)).toBe(new Date(NOW - 7.2e6).toISOString());
    expect(parseSalaryText('$45–$60 an hour')).toMatchObject({ min: 45, max: 60, period: 'hour' });
  });
});

describe('board mapping', () => {
  it('maps publisher names to boards, defaulting to company sites', () => {
    expect(boardsForPublisher('via LinkedIn')).toEqual(['linkedin']);
    expect(boardsForPublisher('ZipRecruiter')).toEqual(['ziprecruiter']);
    expect(boardsForPublisher('Indeed.com')).toEqual(['indeed']);
    expect(boardsForPublisher('Acme Careers')).toEqual(['company-sites']);
  });
});

describe('ATS adapters', () => {
  it('Greenhouse: decodes escaped HTML content', () => {
    const j = normalizeGreenhouse(
      { id: 1, title: ' SRE ', location: { name: 'Remote - US' }, absolute_url: 'https://boards.greenhouse.io/x/jobs/1', content: '&lt;p&gt;Keep it &amp;amp; running&lt;/p&gt;', first_published: '2026-11-01T00:00:00Z' },
      { board: 'x', company: 'X Corp' },
    );
    expect(j).toMatchObject({ title: 'SRE', company: 'X Corp', workplace: 'remote', descriptionText: 'Keep it & running' });
  });

  it('Lever: uses workplaceType and salary range', () => {
    const j = normalizeLever(
      { id: 'a', text: 'Data Engineer', categories: { location: 'NYC', commitment: 'Full-time' }, workplaceType: 'hybrid', hostedUrl: 'https://jobs.lever.co/p/a', createdAt: 1763000000000, description: '<p>Hi</p>', salaryRange: { min: 1, max: 2, currency: 'USD', interval: 'per-year-salary' } },
      { board: 'p', company: 'P' },
    );
    expect(j).toMatchObject({ workplace: 'hybrid', employmentType: 'Full-time', salary: { period: 'year' } });
  });

  it('Ashby: workplace + compensation summary', () => {
    const j = normalizeAshby(
      { id: 'z', title: 'ML Engineer', location: 'San Francisco', workplaceType: 'Remote', jobUrl: 'https://jobs.ashbyhq.com/o/z', compensation: { compensationTierSummary: '$200K – $300K' } },
      { board: 'o', company: 'O' },
    );
    expect(j).toMatchObject({ workplace: 'remote', salary: { text: '$200K – $300K' } });
  });

  it('Workday: public URL and relative posted date', () => {
    const b = { host: 'boeing.wd1.myworkdayjobs.com', tenant: 'boeing', site: 'EXTERNAL_CAREERS' };
    const j = normalizeWorkday({ title: 'Engineer', externalPath: '/job/Seattle/Engineer_R1', locationsText: 'Seattle, WA', postedOn: 'Posted 3 Days Ago' }, b, 'Boeing', NOW);
    expect(j.listings[0].url).toBe('https://boeing.wd1.myworkdayjobs.com/en-US/EXTERNAL_CAREERS/job/Seattle/Engineer_R1');
    expect(j.postedAt).toBe(new Date(NOW - 3 * 86400000).toISOString());
    expect(workdayPostedToIso('Posted 30+ Days Ago', NOW)).toBe(new Date(NOW - 30 * 86400000).toISOString());
  });

  it('filters whole-board feeds by role words, location and workplace', () => {
    const base = { title: 'Senior Software Engineer', location: 'Austin, TX', workplace: 'onsite' as const };
    expect(matchesQuery(base, { role: 'software engineer' })).toBe(true);
    expect(matchesQuery(base, { role: 'designer' })).toBe(false);
    expect(matchesQuery(base, { role: 'engineer', location: 'Denver, CO' })).toBe(false);
    expect(matchesQuery(base, { role: 'engineer', workplace: ['remote'] })).toBe(false);
  });
});

describe('feeds', () => {
  it('USAJOBS: pay range, telework, apply link', () => {
    const j = normalizeUsajobs({
      MatchedObjectId: '123',
      MatchedObjectDescriptor: {
        PositionTitle: 'Air Traffic Control Specialist',
        PositionURI: 'https://www.usajobs.gov/job/123',
        ApplyURI: ['https://www.usajobs.gov/job/123/apply'],
        PositionLocationDisplay: 'Oklahoma City, Oklahoma',
        OrganizationName: 'Federal Aviation Administration',
        PositionRemuneration: [{ MinimumRange: '60000', MaximumRange: '90000', RateIntervalCode: 'PA' }],
        UserArea: { Details: { JobSummary: 'Keep planes apart.', TeleworkEligible: true } },
      },
    });
    expect(j).toMatchObject({ company: 'Federal Aviation Administration', workplace: 'hybrid', salary: { min: 60000, max: 90000, period: 'year' } });
    expect(j.listings[0].applyUrl).toBe('https://www.usajobs.gov/job/123/apply');
  });

  it('Remote OK: skips the legal notice row', () => {
    expect(normalizeRemoteOk({ legal: 'x' } as never)).toBeUndefined();
    expect(normalizeRemoteOk({ id: '9', position: 'Dev', company: 'C', url: 'https://remoteok.com/remote-jobs/9' })?.workplace).toBe('remote');
  });
});

describe('LinkedIn guest pages', () => {
  const html = `
<li>
  <div class="base-card base-search-card job-search-card" data-entity-urn="urn:li:jobPosting:3912345678">
    <a class="base-card__full-link" href="https://www.linkedin.com/jobs/view/x-3912345678?position=1"><span class="sr-only">Senior Engineer</span></a>
    <div class="search-entity-media"><img data-delayed-url="https://media.licdn.com/logo.png?a=1&amp;b=2" alt="Acme"></div>
    <div class="base-search-card__info">
      <h3 class="base-search-card__title">
            Senior Engineer
          </h3>
      <h4 class="base-search-card__subtitle"><a class="hidden-nested-link" href="https://www.linkedin.com/company/acme">Acme &amp; Co</a></h4>
      <div class="base-search-card__metadata">
        <span class="job-search-card__location">Austin, TX</span>
        <span class="job-search-card__salary-info">$150,000.00 - $180,000.00</span>
        <time class="job-search-card__listdate" datetime="2026-11-12">4 days ago</time>
      </div>
    </div>
  </div>
</li>
<li><div class="base-card">ad slot without a job</div></li>`;

  it('parses result cards', () => {
    const jobs = parseLinkedinCards(html);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      id: 'linkedin:3912345678',
      title: 'Senior Engineer',
      company: 'Acme & Co',
      location: 'Austin, TX',
      companyLogo: 'https://media.licdn.com/logo.png?a=1&b=2',
      salary: { min: 150000, max: 180000 },
      descriptionPartial: true,
    });
  });

  it('parses the detail page', () => {
    const d = parseLinkedinDetail(`<div class="show-more-less-html__markup relative">
      <p>We build <strong>rockets</strong>.</p></div>
      <li class="description__job-criteria-item"><h3 class="description__job-criteria-subheader">Employment type</h3>
      <span class="description__job-criteria-text description__job-criteria-text--criteria">Full-time</span></li>`);
    expect(d.descriptionText).toBe('We build rockets.');
    expect(d.employmentType).toBe('Full-time');
  });

  it('maps filters onto LinkedIn query params', () => {
    const u = new URL(linkedinSearchUrl({ role: 'pm', location: 'Denver, CO', distanceMiles: 50, workplace: ['remote', 'hybrid'], postedWithinDays: 1 }));
    expect(u.searchParams.get('f_WT')).toBe('2,3');
    expect(u.searchParams.get('f_TPR')).toBe('r86400');
    expect(u.searchParams.get('distance')).toBe('50');
  });
});

describe('Indeed page parsing', () => {
  it('extracts embedded job cards JSON', () => {
    const data = {
      metaData: {
        mosaicProviderJobCardsModel: {
          results: [
            { jobkey: 'k1', displayTitle: 'Nurse "RN"', company: 'Mercy', formattedLocation: 'Remote in Texas', remoteLocation: true, pubDate: 1763000000000, extractedSalary: { min: 80000, max: 95000, type: 'yearly' }, snippet: '<ul><li>Care {for} patients</li></ul>' },
          ],
        },
      },
    };
    const html = `<script>window.mosaic.providerData["mosaic-provider-jobcards"]=${JSON.stringify(data)};window.other={};</script>`;
    const jobs = parseIndeedPage(html);
    expect(jobs[0]).toMatchObject({ id: 'indeed:k1', title: 'Nurse "RN"', workplace: 'remote', salary: { min: 80000, period: 'year' }, descriptionText: '• Care {for} patients' });
    expect(readJsonObject('x={"a":"}"}', 0)).toBe('{"a":"}"}');
  });
});

describe('catalog', () => {
  it('finds companies by name, alias and industry', () => {
    expect(searchCatalog('FAA')[0].id).toBe('faa');
    expect(searchCatalog('boe')[0].id).toBe('boeing');
    expect(searchCatalog('aviation').map((c) => c.id)).toContain('boeing');
  });
  it('generates slug guesses for discovery', () => {
    expect(slugCandidates('Acme Robotics, Inc.')).toEqual(['acmerobotics', 'acme-robotics', 'acme', 'acme_robotics']);
  });
});

describe('aggregate', () => {
  const job = (over: Partial<JobPosting>): JobPosting => ({ id: 'x', title: 'Engineer', company: 'Acme', location: 'Austin, TX', listings: [], ...over });

  it('merges the same job from several sources and keeps the longest description', () => {
    const merged = mergeJobs([
      [job({ id: 'a', listings: [{ sourceId: 'google-jobs', via: 'LinkedIn', url: 'l' }], descriptionText: 'short' })],
      [job({ id: 'b', company: 'Acme Inc', listings: [{ sourceId: 'greenhouse', via: 'Acme careers', url: 'g' }], descriptionText: 'a much longer description' })],
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0].listings.map((l) => l.via)).toEqual(['LinkedIn', 'Acme careers']);
    expect(merged[0].descriptionText).toBe('a much longer description');
    expect(dedupeKey(job({}))).toBe(dedupeKey(job({ company: 'ACME, Inc.', location: 'Austin, Texas' })));
  });

  it('runs selected sources, filters Google results to chosen boards, and reports per-source status', async () => {
    const fetch: FetchLike = async (url) => {
      if (url.startsWith('https://jsearch')) {
        return Response.json({
          data: [
            { job_id: '1', job_title: 'Software Engineer', employer_name: 'Globex', job_publisher: 'LinkedIn', job_apply_link: 'https://l/1' },
            { job_id: '2', job_title: 'Software Engineer II', employer_name: 'Hooli', job_publisher: 'Monster', job_apply_link: 'https://m/2' },
          ],
        });
      }
      if (url.startsWith('https://boards-api.greenhouse.io/v1/boards/airbnb')) {
        return Response.json({ jobs: [{ id: 7, title: 'Software Engineer, Payments', location: { name: 'Remote' }, absolute_url: 'https://a/7' }, { id: 8, title: 'Chef', absolute_url: 'https://a/8' }] });
      }
      return new Response('nope', { status: 500 });
    };
    const res = await aggregate(
      { role: 'software engineer' },
      { boards: ['linkedin', 'usajobs'], companies: ['airbnb', 'custom:Duolingo'], industries: [], allowScraping: false },
      { fetch, env: { JSEARCH_API_KEY: 'k' } },
      { runtime: 'server', discover: async () => undefined },
    );
    expect(res.jobs.map((j) => j.company).sort()).toEqual(['Airbnb', 'Globex']);
    const by = Object.fromEntries(res.sources.map((s) => [s.sourceId, s]));
    expect(by['google-jobs']).toMatchObject({ ok: true, count: 1 });
    expect(by['usajobs'].skipped).toMatch(/USAJOBS_API_KEY/);
    expect(by['company:airbnb']).toMatchObject({ ok: true, count: 1 });
    expect(by['company:duolingo'].ok).toBe(true);
  });

  it('in the browser, runs only browser-safe sources', async () => {
    const res = await aggregate(
      { role: 'engineer' },
      { boards: ['linkedin'], companies: ['boeing'], industries: [], allowScraping: true },
      { fetch: async () => Response.json({}), env: {} },
      { runtime: 'browser' },
    );
    expect(res.sources.every((s) => s.skipped)).toBe(true);
  });
});
