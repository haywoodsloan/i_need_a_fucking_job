/**
 * The browser tier: loads a web page in a real headless browser. It is for pages that only render with JavaScript,
 * and for sites that answer a browser but not a plain HTTP client.
 *
 * It is a standard, unmodified browser and it says so: the automation flag stays on, this tool's name is added to
 * the user agent, and there is no proxy. When it is shown a bot check instead of the page it stops with
 * BlockedError. It does not wait a challenge out or interact with one.
 *
 * Off unless ENABLE_BROWSER_TIER is set. Needs a Chromium: either Playwright's own (`npx playwright install
 * chromium`, already in the Docker image) or an installed browser named by BROWSER_CHANNEL (`msedge` or `chrome`).
 */
import type { Browser } from 'playwright';
import { BlockedError } from '../../src/jobs/adapters/common';
import { isBotCheckPage, type FetchTier } from './fetcher';

export interface PageLoad {
  status: number;
  html: string;
}

export type PageLoader = (url: string) => Promise<PageLoad>;

const TOOL = 'job-hunt-workbench/0.1';

/** The browser tier only takes what a person would open in a browser: a GET that asks for a web page. */
export function wantsPage(init?: RequestInit): boolean {
  if ((init?.method ?? 'GET').toUpperCase() !== 'GET') return false;
  return /text\/html/i.test(new Headers(init?.headers).get('accept') ?? '');
}

export function browserTier(load: PageLoader): FetchTier {
  return {
    name: 'browser',
    async fetch({ url, init }) {
      if (!wantsPage(init)) return undefined;
      const { status, html } = await load(url);
      if (status === 999 || isBotCheckPage(status, html.slice(0, 20_000))) throw new BlockedError(new URL(url).hostname, status);
      // A Response cannot carry a status outside 200-599. Anything odd is passed on as a gateway error.
      const ok = status >= 200 && status <= 599;
      return new Response(html, { status: ok ? status : 502, headers: { 'content-type': 'text/html; charset=utf-8' } });
    },
  };
}

/** Loads pages with Playwright. One browser is started on first use and shared; each page gets a clean context. */
export function playwrightLoader(env: Record<string, string | undefined>): PageLoader & { close(): Promise<void> } {
  let browserP: Promise<Browser> | undefined;
  let userAgent: Promise<string> | undefined;

  const browser = () => {
    browserP ??= import('playwright')
      .then(({ chromium }) => chromium.launch({ headless: true, channel: env.BROWSER_CHANNEL || undefined }))
      .catch((e: Error) => {
        browserP = undefined;
        const missing = /Executable doesn't exist|is not found at|playwright install/i.test(e.message);
        throw new Error(missing ? 'The browser tier has no browser to start. Run `npx playwright install chromium`, or set BROWSER_CHANNEL=msedge or chrome.' : e.message);
      });
    return browserP;
  };

  /** The browser's own user agent with this tool's name added, so a site can see what is calling. */
  const identify = () => {
    userAgent ??= (async () => {
      const context = await (await browser()).newContext();
      try {
        const page = await context.newPage();
        return `${await page.evaluate(() => navigator.userAgent)} ${TOOL}`;
      } finally {
        await context.close();
      }
    })();
    return userAgent;
  };

  const load: PageLoader = async (url) => {
    const context = await (await browser()).newContext({ userAgent: await identify(), locale: 'en-US', viewport: { width: 1366, height: 900 } });
    try {
      // Pictures, fonts and video are not needed to read a page.
      await context.route('**/*', (r) => (['image', 'font', 'media'].includes(r.request().resourceType()) ? r.abort() : r.continue()));
      const page = await context.newPage();
      const res = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 25_000 });
      const status = res?.status() ?? 200;
      const first = await page.content();
      // A bot check is the site's answer. Hand it back as it stands instead of letting its script run to see
      // whether it clears.
      if (status === 999 || isBotCheckPage(status, first.slice(0, 20_000))) return { status, html: first };
      // Otherwise give a script-rendered page time to fetch its data. A page that keeps polling is read as it is.
      await page.waitForLoadState('load', { timeout: 15_000 }).catch(() => {});
      await page.waitForLoadState('networkidle', { timeout: 4000 }).catch(() => {});
      return { status, html: await page.content() };
    } finally {
      await context.close();
    }
  };

  return Object.assign(load, {
    async close() {
      const p = browserP;
      browserP = undefined;
      userAgent = undefined;
      if (p) await (await p).close().catch(() => {});
    },
  });
}
