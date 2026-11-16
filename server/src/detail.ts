/** Full description for postings whose search result only had a snippet. */
import { smartrecruitersDetail, workdayDetail } from '../../src/jobs/adapters/ats';
import { linkedinDetail } from '../../src/jobs/adapters/linkedin';
import { COMPANIES } from '../../src/jobs/catalog';
import type { AdapterContext } from '../../src/jobs/types';
import { indeedDetail } from './indeed';

export async function jobDetail(id: string, ctx: AdapterContext) {
  const [source, ...rest] = id.split(':');
  switch (source) {
    case 'linkedin':
      if (!ctx.env.ENABLE_LINKEDIN_GUEST) throw new Error('LinkedIn route is disabled on this server');
      return linkedinDetail(ctx, rest[0]);
    case 'indeed':
      if (!ctx.env.ENABLE_PLAYWRIGHT) throw new Error('Playwright route is disabled on this server');
      return indeedDetail(ctx.env, rest[0]);
    case 'smartrecruiters':
      return smartrecruitersDetail(ctx, rest[0], rest[1]);
    case 'workday': {
      const [tenant, ...path] = rest;
      const c = COMPANIES.find((x) => x.workday?.tenant === tenant);
      if (!c?.workday) throw new Error(`Unknown Workday tenant ${tenant}`);
      return workdayDetail(ctx, c.workday, path.join(':'));
    }
    default:
      throw new Error(`No detail route for ${source}`);
  }
}
