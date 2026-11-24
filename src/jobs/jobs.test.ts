import { describe, expect, it } from 'vitest';
import { aggregate, dedupeKey, mergeJobs } from './aggregate';
import {
  amazonSearchUrl,
  normalizeAmazon,
  normalizeAshby,
  normalizeGreenhouse,
  normalizeLever,
  normalizeWorkday,
  pickWorkdayLocations,
  pickWorkdayRemote,
  smartrecruiters,
  workday,
  workdayFacetLeaves,
  workdayPostedToIso,
  type WdFacetLeaf,
} from './adapters/ats';
import { matchesQuery, parsePlace } from './adapters/common';
import { normalizeRemoteOk, normalizeUsajobs } from './adapters/feeds';
import { jsearchUrl, normalizeJSearch, normalizeSerp, parseSalaryText, relativeToIso } from './adapters/googleJobs';
import { parseIndeedPage, readJsonObject } from './adapters/indeed';
import { linkedinGuest, linkedinSearchUrl, parseLinkedinCards, parseLinkedinDetail } from './adapters/linkedin';
import { boardsForPublisher } from './boards';
import { COMPANIES, searchCatalog, slugCandidates } from './catalog';
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
    expect(u.pathname.endsWith('/search-v2')).toBe(true);
    expect(u.searchParams.get('query')).toBe('data analyst in Chicago, IL');
    expect(u.searchParams.get('radius')).toBe('40');
    expect(u.searchParams.get('date_posted')).toBe('week');
    const r = new URL(jsearchUrl({ role: 'designer', location: 'Chicago, IL', workplace: ['remote'] }));
    expect(r.searchParams.get('query')).toBe('designer');
    expect(r.searchParams.get('work_from_home')).toBe('true');
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

  it('Ashby: a hybrid role flagged isRemote stays hybrid, so it is not shown for every city', () => {
    // Shape seen live on OpenAI's board: San Francisco roles carry isRemote: true and workplaceType: "Hybrid".
    const o = { board: 'openai', company: 'OpenAI' };
    const hybrid = normalizeAshby({ id: 'a', title: 'Software Engineer', location: 'San Francisco', isRemote: true, workplaceType: 'Hybrid', jobUrl: 'u' }, o);
    expect(hybrid.workplace).toBe('hybrid');
    expect(matchesQuery(hybrid, { role: 'software engineer', location: 'Austin, TX' })).toBe(false);
    expect(normalizeAshby({ id: 'b', title: 'Software Engineer', location: 'US - Remote', isRemote: true, workplaceType: 'Remote', jobUrl: 'u' }, o).workplace).toBe('remote');
    expect(normalizeAshby({ id: 'c', title: 'Software Engineer', location: 'Anywhere', isRemote: true, jobUrl: 'u' }, o).workplace).toBe('remote');
  });

  it('Workday: public URL and relative posted date', () => {
    const b = { host: 'boeing.wd1.myworkdayjobs.com', tenant: 'boeing', site: 'EXTERNAL_CAREERS' };
    const j = normalizeWorkday({ title: 'Engineer', externalPath: '/job/Seattle/Engineer_R1', locationsText: 'Seattle, WA', postedOn: 'Posted 3 Days Ago' }, b, 'Boeing', NOW);
    expect(j.listings[0].url).toBe('https://boeing.wd1.myworkdayjobs.com/en-US/EXTERNAL_CAREERS/job/Seattle/Engineer_R1');
    expect(j.postedAt).toBe(new Date(NOW - 3 * 86400000).toISOString());
    expect(workdayPostedToIso('Posted 30+ Days Ago', NOW)).toBe(new Date(NOW - 30 * 86400000).toISOString());
  });

  describe('Workday location filters', () => {
    const leaf = (descriptor: string, param = 'locations'): WdFacetLeaf => ({ param, id: descriptor, descriptor });
    const austin = parsePlace('Austin, TX')!;

    it('flattens the nested filter tree', () => {
      const leaves = workdayFacetLeaves([
        { facetParameter: 'remoteType', values: [{ descriptor: 'Hybrid', id: 'h' }] },
        {
          facetParameter: 'locationMainGroup',
          values: [
            { facetParameter: 'locationCountry', descriptor: 'Location Country', values: [{ descriptor: 'United States of America', id: 'us' }] },
            { facetParameter: 'locations', descriptor: 'Locations', values: [{ descriptor: 'US - Austin, TX', id: 'aus' }] },
          ],
        },
      ]);
      expect(leaves).toEqual([
        { param: 'remoteType', id: 'h', descriptor: 'Hybrid' },
        { param: 'locationCountry', id: 'us', descriptor: 'United States of America' },
        { param: 'locations', id: 'aus', descriptor: 'US - Austin, TX' },
      ]);
    });

    it('finds a city however the tenant writes its locations', () => {
      // One naming style per live tenant: Visa, NVIDIA, Salesforce, Adobe, Intel.
      for (const name of ['US - Austin, TX', 'US, TX, Austin', 'Texas - Austin', 'Austin', 'US, Texas, Austin']) {
        expect(pickWorkdayLocations([leaf('US - Bellevue, WA'), leaf(name)], austin)?.names).toEqual([name]);
      }
      expect(pickWorkdayLocations([leaf('Texas - Austin'), leaf('Texas - Austin Metro - Remote'), leaf('Texas - Dallas')], austin)?.ids).toEqual(['Texas - Austin', 'Texas - Austin Metro - Remote']);
      expect(pickWorkdayLocations([leaf('Austintown, OH'), leaf('US - Bellevue, WA')], austin)).toBeUndefined();
    });

    it('uses the state to tell same-named cities apart', () => {
      const leaves = [leaf('United States-Texas-Arlington'), leaf('United States-Virginia-Arlington')];
      expect(pickWorkdayLocations(leaves, parsePlace('Arlington, VA')!)?.names).toEqual(['United States-Virginia-Arlington']);
      expect(pickWorkdayLocations([leaf('Arlington, TX')], parsePlace('Arlington, VA')!)).toBeUndefined();
      expect(pickWorkdayLocations([leaf('Washington D.C. - Remote'), leaf('Washington - Seattle Metro - Remote')], parsePlace('Washington, DC')!)?.names).toEqual(['Washington D.C. - Remote']);
    });

    it('finds remote roles by remote type first, then by remote-named locations', () => {
      expect(pickWorkdayRemote([leaf('Hybrid', 'remoteType'), leaf('Fully Remote', 'remoteType'), leaf('BR - Remote - Brazil')])).toEqual({ param: 'remoteType', ids: ['Fully Remote'], names: ['Fully Remote'] });
      expect(pickWorkdayRemote([leaf('Onsite Job', 'remoteType'), leaf('US, TX, Remote'), leaf('Virtual US'), leaf('US, TX, Austin')])?.ids).toEqual(['US, TX, Remote', 'Virtual US']);
      expect(pickWorkdayRemote([leaf('Onsite Job', 'remoteType'), leaf('USA - Seattle, WA')])).toBeUndefined();
    });

    it('searches the role, applies the matching location filter, then pages through the results', async () => {
      const sent: { searchText: string; appliedFacets: Record<string, string[]>; offset: number; limit: number }[] = [];
      const facets = [{ facetParameter: 'locationMainGroup', values: [{ facetParameter: 'locations', values: [{ descriptor: 'US - Austin, TX', id: 'aus' }, { descriptor: 'US - Bellevue, WA', id: 'bel' }] }] }];
      const postings = Array.from({ length: 25 }, (_, i) => ({
        title: i === 3 ? 'Risk Consultant' : `Sr. SW Engineer ${i}`,
        externalPath: `/job/US---Austin-TX/x_${i}`,
        locationsText: i === 0 ? '2 Locations' : 'US - Austin, TX',
        postedOn: 'Posted Today',
      }));
      const fetch: FetchLike = async (_url, init) => {
        const body = JSON.parse(String(init!.body));
        sent.push(body);
        // Like the live API: only the first page carries the total and the filters.
        return Response.json({ total: body.offset ? 0 : body.appliedFacets.locations ? 25 : 300, jobPostings: postings.slice(body.offset, body.offset + body.limit), facets: body.offset ? [] : facets });
      };
      const board = { host: 'visa.wd5.myworkdayjobs.com', tenant: 'visa', site: 'Visa' };
      const jobs = await workday.search({ role: 'software engineer', location: 'austin, tx' }, { fetch, env: {} }, { board, company: 'Visa' });
      expect(sent.map((b) => [b.searchText, b.appliedFacets, b.offset])).toEqual([
        ['software engineer', {}, 0],
        ['software engineer', { locations: ['aus'] }, 0],
        ['software engineer', { locations: ['aus'] }, 20],
      ]);
      expect(sent.every((b) => b.limit === 20)).toBe(true);
      expect(jobs).toHaveLength(24); // the stray "Risk Consultant" is dropped; "SW Engineer" is kept
      expect(jobs[0].location).toBe('US - Austin, TX +1 more');
    });

    it('returns nothing, without a second request, when the tenant has no such location', async () => {
      let calls = 0;
      const fetch: FetchLike = async () => {
        calls++;
        return Response.json({ total: 9, jobPostings: [{ title: 'Software Engineer', externalPath: '/job/1', locationsText: 'USA - Hazelwood, MO' }], facets: [{ facetParameter: 'locations', values: [{ descriptor: 'USA - Hazelwood, MO', id: 'haz' }] }] });
      };
      const board = { host: 'boeing.wd1.myworkdayjobs.com', tenant: 'boeing', site: 'EXTERNAL_CAREERS' };
      expect(await workday.search({ role: 'software engineer', location: 'Austin, TX' }, { fetch, env: {} }, { board, company: 'Boeing' })).toEqual([]);
      expect(calls).toBe(1);
    });
  });

  it('Amazon: filters by city and state, and lists every place a role is open', () => {
    const { url, place } = amazonSearchUrl({ role: 'software engineer', location: 'austin, tx', distanceMiles: 25 });
    const u = new URL(url);
    expect(u.searchParams.getAll('normalized_city_name[]')).toEqual(['Austin']); // case-sensitive on Amazon's side
    expect(u.searchParams.getAll('normalized_state_name[]')).toEqual(['Texas']);
    expect(u.searchParams.has('loc_query')).toBe(false);
    expect(new URL(amazonSearchUrl({ role: 'sde', location: 'Austin, TX', workplace: ['remote'] }).url).searchParams.has('normalized_city_name[]')).toBe(false);
    const j = normalizeAmazon(
      {
        id_icims: '3112345',
        title: 'Software Dev Engineer, Amazon Leo',
        normalized_location: 'Redmond, Washington, USA',
        locations: ['{"normalizedLocation":"Austin, Texas, USA","type":"ONSITE"}', '{"normalizedLocation":"Redmond, Washington, USA","type":"ONSITE"}', 'not json'],
        job_path: '/en/jobs/3112345/software-dev-engineer',
        posted_date: 'November 16, 2026',
      },
      place?.city,
    );
    expect(j).toMatchObject({ location: 'Austin, Texas, USA · Redmond, Washington, USA', workplace: 'onsite', company: 'Amazon' });
    expect(j.listings[0].url).toBe('https://www.amazon.jobs/en/jobs/3112345/software-dev-engineer');
  });

  it('SmartRecruiters: an unknown board id is an error, not an empty result', async () => {
    // The live API answers 200 with zero postings for a company id that does not exist.
    const unknown: FetchLike = async () => Response.json({ totalFound: 0, content: [] });
    await expect(smartrecruiters.search({ role: 'engineer' }, { fetch: unknown, env: {} }, { board: 'Visa', company: 'Visa' })).rejects.toThrow(/no public postings/);
    const noMatch: FetchLike = async (url) => Response.json(url.includes('q=') ? { totalFound: 0, content: [] } : { totalFound: 817, content: [{}] });
    await expect(smartrecruiters.search({ role: 'astronaut' }, { fetch: noMatch, env: {} }, { board: 'ServiceNow', company: 'ServiceNow' })).resolves.toEqual([]);
  });

  it('filters whole-board feeds by role words, location and workplace', () => {
    const base = { title: 'Senior Software Engineer', location: 'Austin, TX', workplace: 'onsite' as const };
    expect(matchesQuery(base, { role: 'software engineer' })).toBe(true);
    expect(matchesQuery(base, { role: 'designer' })).toBe(false);
    expect(matchesQuery(base, { role: 'engineer', location: 'Denver, CO' })).toBe(false);
    expect(matchesQuery(base, { role: 'engineer', location: 'austin tx' })).toBe(true);
    expect(matchesQuery(base, { role: 'engineer', workplace: ['remote'] })).toBe(false);
  });

  it('filters search-backed sources more loosely, and ignores filler words', () => {
    expect(matchesQuery({ title: 'Sr. SW Engineer' }, { role: 'software engineer' })).toBe(false);
    expect(matchesQuery({ title: 'Sr. SW Engineer' }, { role: 'software engineer' }, { title: 'any' })).toBe(true);
    expect(matchesQuery({ title: 'Risk Consultant' }, { role: 'software engineer' }, { title: 'any' })).toBe(false);
    expect(matchesQuery({ title: 'Engineering Director' }, { role: 'director of engineering' })).toBe(true);
  });

  it('reads a typed place into city and state', () => {
    expect(parsePlace('austin, tx')).toEqual({ city: 'Austin', stateCode: 'TX', stateName: 'Texas' });
    expect(parsePlace('New York, New York')).toEqual({ city: 'New York', stateCode: 'NY', stateName: 'New York' });
    expect(parsePlace('san jose CA')).toEqual({ city: 'San Jose', stateCode: 'CA', stateName: 'California' });
    expect(parsePlace('Washington, D.C.')).toMatchObject({ city: 'Washington', stateCode: 'DC' });
    expect(parsePlace('London, UK')).toEqual({ city: 'London' });
    expect(parsePlace('  ')).toBeUndefined();
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

  const card = (id: number) => `<li><div data-entity-urn="urn:li:jobPosting:${id}"><h3 class="base-search-card__title">Engineer ${id}</h3><h4 class="base-search-card__subtitle">Acme</h4></div></li>`;

  it('walks the 10-per-page results without posing as a browser', async () => {
    const starts: string[] = [];
    const fetch: FetchLike = async (url, init) => {
      const start = new URL(url).searchParams.get('start')!;
      starts.push(start);
      expect((init!.headers as Record<string, string>)['User-Agent']).not.toMatch(/Mozilla|Chrome/);
      // The third page is short, and repeats one card from the second.
      const ids = start === '20' ? [19, 20, 21, 22] : Array.from({ length: 10 }, (_, i) => +start + i);
      return new Response(ids.map(card).join(''));
    };
    const jobs = await linkedinGuest.search({ role: 'engineer' }, { fetch, env: {} });
    expect(starts).toEqual(['0', '10', '20']);
    expect(jobs).toHaveLength(23);
  });

  it('reports being turned away instead of retrying around it', async () => {
    const limited: FetchLike = async () => new Response('', { status: 429 });
    await expect(linkedinGuest.search({ role: 'engineer' }, { fetch: limited, env: {} })).rejects.toThrow(/automated traffic \(429\)/);
    // LinkedIn's own "request denied" code. A Response can't be built with it, so stand one in.
    const denied: FetchLike = async () => ({ ok: false, status: 999 }) as Response;
    await expect(linkedinGuest.search({ role: 'engineer' }, { fetch: denied, env: {} })).rejects.toThrow(/automated traffic \(999\)/);
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
  it('gives every entry what its hiring system needs, with unique ids', () => {
    expect(new Set(COMPANIES.map((c) => c.id)).size).toBe(COMPANIES.length);
    for (const c of COMPANIES) {
      if (c.platform === 'workday') expect(c.workday, c.name).toMatchObject({ host: expect.stringMatching(/\.myworkdayjobs\.com$/), tenant: expect.any(String), site: expect.any(String) });
      else if (['greenhouse', 'lever', 'ashby', 'smartrecruiters', 'usajobs'].includes(c.platform)) expect(c.board, c.name).toBeTruthy();
    }
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
      if (url.startsWith('https://api.openwebninja.com/jsearch/')) {
        return Response.json({
          status: 'OK',
          data: {
            jobs: [
              { job_id: '1', job_title: 'Software Engineer', employer_name: 'Globex', job_publisher: 'LinkedIn', job_apply_link: 'https://l/1' },
              { job_id: '2', job_title: 'Software Engineer II', employer_name: 'Hooli', job_publisher: 'Monster', job_apply_link: 'https://m/2' },
            ],
            cursor: null,
          },
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
      { fetch, env: { OPENWEBNINJA_API_KEY: 'k' } },
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
