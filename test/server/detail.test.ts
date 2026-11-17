/** Loading the full description of a posting whose search result only had a summary. The route is picked from the posting's id. */
import { describe, expect, it } from 'vitest';
import { jobDetail } from '../../server/src/detail';
import { COMPANIES } from '../../src/jobs/catalog';
import type { AdapterContext, FetchLike } from '../../src/jobs/types';

function context(answer: (url: string) => Response, env: Record<string, string> = {}) {
  const asked: { url: string; init?: RequestInit }[] = [];
  const fetch: FetchLike = async (url, init) => {
    asked.push({ url, init });
    return answer(url);
  };
  const ctx: AdapterContext = { fetch, env };
  return { ctx, asked };
}

const json = (body: unknown) => new Response(JSON.stringify(body));
const unreachable = () => {
  throw new Error('nothing should have been asked');
};

describe('the full description of a posting', () => {
  it('comes from SmartRecruiters as the sections of the job ad, in order, without the empty ones', async () => {
    const { ctx, asked } = context(() =>
      json({
        jobAd: {
          sections: {
            companyDescription: { title: 'Company Description', text: '<p>We build robots.</p>' },
            jobDescription: { title: 'Job Description', text: '<ul><li>Plan routes</li></ul>' },
            additionalInformation: { title: 'Additional Information', text: '' },
            videos: {},
          },
        },
      }),
    );
    const detail = await jobDetail('smartrecruiters:Acme Co:744000012345678', ctx);
    expect(asked[0].url).toBe('https://api.smartrecruiters.com/v1/companies/Acme%20Co/postings/744000012345678');
    expect(detail).toEqual({
      descriptionHtml: '<h3>Company Description</h3><p>We build robots.</p><h3>Job Description</h3><ul><li>Plan routes</li></ul>',
      descriptionText: 'Company Description\nWe build robots.\nJob Description\n\n• Plan routes',
    });
  });

  it('comes from Workday through the site of the company that owns the posting', async () => {
    const company = COMPANIES.find((c) => c.workday)!;
    const board = company.workday!;
    const { ctx, asked } = context(() => json({ jobPostingInfo: { jobDescription: '<p>Fly planes.</p>', timeType: 'Full time' } }));
    // A Workday path can hold colons of its own. Everything after the tenant is the path.
    const detail = await jobDetail(`workday:${board.tenant}:/job/Austin-TX/Pilot_R-1:2`, ctx);
    expect(asked[0].url).toBe(`https://${board.host}/wday/cxs/${board.tenant}/${board.site}/job/Austin-TX/Pilot_R-1:2`);
    expect(new Headers(asked[0].init?.headers).get('accept')).toBe('application/json');
    expect(detail).toEqual({ descriptionHtml: '<p>Fly planes.</p>', descriptionText: 'Fly planes.', employmentType: 'Full time' });
  });

  it('is empty, not an error, when Workday has no description for the posting', async () => {
    const tenant = COMPANIES.find((c) => c.workday)!.workday!.tenant;
    const { ctx } = context(() => json({}));
    expect(await jobDetail(`workday:${tenant}:/job/x`, ctx)).toEqual({ descriptionHtml: '', descriptionText: '', employmentType: undefined });
  });

  it('comes from LinkedIn only on a server that has that route switched on', async () => {
    const page = '<div class="show-more-less-html__markup"><p>We build <strong>rockets</strong>.</p></div>';
    const on = context(() => new Response(page), { ENABLE_LINKEDIN_GUEST: '1' });
    expect(await jobDetail('linkedin:4100000001', on.ctx)).toMatchObject({ descriptionText: 'We build rockets.' });
    expect(on.asked[0].url).toBe('https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/4100000001');

    const off = context(unreachable);
    await expect(jobDetail('linkedin:4100000001', off.ctx)).rejects.toThrow('LinkedIn route is disabled on this server');
    expect(off.asked).toEqual([]);
  });

  it('is refused for a source that is switched off, or that has no such route', async () => {
    const { ctx, asked } = context(unreachable);
    await expect(jobDetail('indeed:abc123', ctx)).rejects.toThrow('Playwright route is disabled on this server');
    await expect(jobDetail('workday:no-such-tenant:/job/x', ctx)).rejects.toThrow('Unknown Workday tenant no-such-tenant');
    await expect(jobDetail('greenhouse:acme:1', ctx)).rejects.toThrow('No detail route for greenhouse');
    await expect(jobDetail('', ctx)).rejects.toThrow('No detail route for ');
    expect(asked).toEqual([]);
  });

  it('passes on what the service said when it fails', async () => {
    const { ctx } = context(() => new Response('gone', { status: 404 }));
    await expect(jobDetail('smartrecruiters:acme:1', ctx)).rejects.toMatchObject({ message: 'api.smartrecruiters.com answered 404', status: 404 });
  });
});
