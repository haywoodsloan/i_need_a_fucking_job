/**
 * Indeed via a real headless Chromium (Playwright). Indeed serves a bot
 * challenge to plain HTTP clients, so we load the public, logged-out search
 * page like a visitor would. No account is used.
 *
 * Reliability depends on the egress IP. Datacenter IPs are often challenged;
 * set PLAYWRIGHT_PROXY_URL to a residential proxy for steady results.
 */
import type { Browser } from 'playwright';
import { SourceError, type Adapter } from '../../src/jobs/adapters/common';
import { indeedSearchUrl, isBotWall, parseIndeedPage } from '../../src/jobs/adapters/indeed';
import { htmlToText } from '../../src/jobs/adapters/common';

let browserP: Promise<Browser> | undefined;

async function browser(env: Record<string, string | undefined>): Promise<Browser> {
  if (!browserP) {
    browserP = import('playwright').then(({ chromium }) =>
      chromium.launch({
        headless: true,
        proxy: env.PLAYWRIGHT_PROXY_URL ? { server: env.PLAYWRIGHT_PROXY_URL } : undefined,
        args: ['--disable-blink-features=AutomationControlled'],
      }),
    );
    browserP.catch(() => (browserP = undefined));
  }
  return browserP;
}

async function withPage<T>(env: Record<string, string | undefined>, fn: (html: (url: string) => Promise<string>) => Promise<T>): Promise<T> {
  const b = await browser(env);
  const context = await b.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
    locale: 'en-US',
    viewport: { width: 1366, height: 900 },
  });
  // Skip images/fonts/media: faster and lighter on the proxy.
  await context.route('**/*', (r) => (['image', 'font', 'media'].includes(r.request().resourceType()) ? r.abort() : r.continue()));
  const page = await context.newPage();
  try {
    return await fn(async (url) => {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20_000 });
      let html = await page.content();
      if (isBotWall(html)) {
        // Some challenges clear themselves after a few seconds.
        await page.waitForTimeout(6000);
        html = await page.content();
        if (isBotWall(html)) throw new SourceError('Indeed showed a bot check to this server (try PLAYWRIGHT_PROXY_URL)', 403);
      }
      return html;
    });
  } finally {
    await context.close();
  }
}

export const indeedBrowser: Adapter = {
  id: 'indeed-browser',
  label: 'Indeed (headless browser)',
  requires: ['ENABLE_PLAYWRIGHT'],
  async search(q, ctx) {
    return withPage(ctx.env, async (load) => {
      const jobs = parseIndeedPage(await load(indeedSearchUrl(q, 0)));
      if (!jobs.length) throw new SourceError('Indeed page loaded but no results were found (layout may have changed)');
      return jobs;
    });
  },
};

export async function indeedDetail(env: Record<string, string | undefined>, jobkey: string) {
  return withPage(env, async (load) => {
    const html = await load(`https://www.indeed.com/viewjob?jk=${encodeURIComponent(jobkey)}`);
    const m = html.match(/id="jobDescriptionText"[^>]*>([\s\S]*?)<\/div>\s*<\/div>/);
    const descriptionHtml = m?.[1];
    return { descriptionHtml, descriptionText: descriptionHtml ? htmlToText(descriptionHtml) : undefined };
  });
}

export async function closeBrowser() {
  if (browserP) (await browserP).close();
}
