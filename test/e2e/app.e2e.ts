/**
 * The built app in a real browser, served by the server's own code under its real security headers.
 *
 * This is the one place where everything is real at once: the production build, the content security policy, the
 * sign-in cookie, the embedded database on disk, the PDF reader and its background worker, the Word reader's
 * browser build, and the browser's own storage. Only the job sites are stand-ins (the cassettes), and the browser
 * is cut off from every address but the app's.
 *
 * These tests are slow next to the others and need a browser, so there are few of them: one per journey that
 * cannot be checked any other way. What each screen does in detail is tested in src/ui/*.test.tsx.
 *
 * Run them with `npm run test:e2e`. docs/testing.md, "In a real browser", says how to give them a browser.
 */
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser, type BrowserContext, type Locator, type Page } from 'playwright';
import { afterAll, afterEach, beforeAll, describe, expect, inject, it } from 'vitest';
import { readAccountsConfig, startAccounts, type Accounts } from '../../server/src/accounts/index';
import { APP_CSP, loadApp } from '../../server/src/static';
import { loadCassette, replay, type Replay } from '../helpers/cassette';
import { RESUME, resumeDocx, resumePdf } from '../helpers/resume-files';
import { startTestServer, type TestServer } from '../helpers/server';

const remotive = loadCassette('remotive');
const remoteok = loadCassette('remoteok');
const dataDir = mkdtempSync(join(tmpdir(), 'job-hunt-e2e-data-'));

let server: TestServer;
let accounts: Accounts;
let network: Replay;
let browser: Browser;
let origin: string;

/** One visitor: a browser window with storage and cookies of its own. */
interface Visit {
  context: BrowserContext;
  page: Page;
  /** Errors the page logged or threw, including anything the security policy refused. */
  problems: string[];
  /** Addresses outside the app that the page asked for. They were refused. */
  refused: string[];
}

const visits: Visit[] = [];

async function launch(): Promise<Browser> {
  const { BROWSER_PATH, BROWSER_CHANNEL } = process.env;
  try {
    return await chromium.launch({ headless: true, executablePath: BROWSER_PATH || undefined, channel: BROWSER_PATH ? undefined : BROWSER_CHANNEL || undefined });
  } catch (e) {
    throw new Error(
      'The browser tests have no browser to run in. Run "npx playwright install chromium" once, or name a browser that is already installed: ' +
        `BROWSER_CHANNEL=msedge (or chrome), or BROWSER_PATH=<path to a Chromium>. See docs/testing.md.\n${(e as Error).message}`,
    );
  }
}

/** Opens the app at an address like "/#/resume" in a fresh browser window. */
async function visit(address = '/'): Promise<Visit> {
  const context = await browser.newContext({ locale: 'en-US', viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  const v: Visit = { context, page, problems: [], refused: [] };
  visits.push(v);
  // The page may talk to the app's own server and to nothing else: no test may depend on a live site.
  await context.route(
    (url) => /^https?:$/.test(url.protocol) && url.origin !== origin,
    (route) => {
      v.refused.push(route.request().url());
      return route.abort();
    },
  );
  page.on('console', (message) => {
    // A refused address is logged by the browser as a failed load. That is this test's doing, not the page's.
    if (message.type() === 'error' && !v.refused.includes(message.location().url)) v.problems.push(message.text());
  });
  page.on('pageerror', (error) => v.problems.push(String(error)));
  await page.goto(origin + address);
  return v;
}

/** Waits for something to show on the page. When it never does, the failure says what the page shows instead. */
async function shown(locator: Locator): Promise<void> {
  try {
    await locator.waitFor({ timeout: 15_000 });
  } catch (e) {
    const page = locator.page();
    throw new Error(`${(e as Error).message}\nThe page at ${page.url()} shows:\n${await page.locator('body').innerText()}`);
  }
}

beforeAll(async () => {
  network = replay(remotive, remoteok);
  server = await startTestServer({
    network,
    builtApp: loadApp(inject('appDir'), { accounts: true }),
    // Accounts are told the app's address, which is only known once the server listens. So they start second.
    accounts: { owns: (path) => accounts.owns(path), handle: (req, res, url) => accounts.handle(req, res, url) },
  });
  origin = server.url;
  accounts = await startAccounts(
    readAccountsConfig({
      AUTH_PEPPER: `1:${randomBytes(32).toString('base64')}`,
      ACCOUNTS_DATA_DIR: dataDir,
      APP_ORIGIN: origin,
      PORT: new URL(origin).port,
      PASSWORD_BREACH_CHECK: '0',
    })!,
  );
  browser = await launch();
});

afterEach(async () => {
  for (const v of visits.splice(0)) await v.context.close();
});

afterAll(async () => {
  await browser?.close();
  await server?.close();
  await accounts?.close();
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

describe('the built app in a browser', () => {
  it('is served with its security policy, and runs under it with nothing refused', async () => {
    const v = await visit();
    const { page } = v;
    await shown(page.getByRole('textbox', { name: 'Role' }));
    await shown(page.getByRole('link', { name: 'Sign in' }));

    const headers = (await page.request.get(`${origin}/`)).headers();
    expect(headers['content-security-policy']).toBe(APP_CSP);
    expect(headers['x-content-type-options']).toBe('nosniff');
    expect(headers['x-frame-options']).toBe('DENY');
    expect(v.problems).toEqual([]);

    // The policy is enforced, not only sent: a script written into the page does not run. This is also what the
    // other tests rely on when they check `problems`: a refusal shows up there.
    const ran = await page.evaluate(() => {
      const script = document.createElement('script');
      script.textContent = 'window.injected = true';
      document.head.append(script);
      return (window as unknown as { injected?: boolean }).injected === true;
    });
    expect(ran).toBe(false);
    expect(v.problems).toHaveLength(1);
    expect(v.problems[0]).toMatch(/Content Security Policy/);
  });

  it('searches through the server it came from and shows a posting', async () => {
    const v = await visit();
    const { page } = v;
    // The remote job boards are the sources that need no key. They are off until chosen in the settings.
    await page.getByRole('button', { name: 'Search settings' }).click();
    await page.getByRole('checkbox', { name: /^Remote job boards/ }).check();
    await page.getByRole('button', { name: 'Close settings' }).click();
    await page.getByRole('textbox', { name: 'Role' }).fill('software engineer');
    // The filters are laid out by the real stylesheet here, so this is where a field that lies over another one,
    // or a list that opens out of reach, is caught: the browser refuses to press what a person could not.
    await page.getByRole('button', { name: /^Workplace/ }).click();
    await page.getByRole('checkbox', { name: 'Remote', exact: true }).check();
    await page.keyboard.press('Escape');
    expect(await page.getByRole('button', { name: /^Workplace/ }).textContent()).toBe('Remote');
    expect(await page.getByRole('textbox', { name: 'Location' }).isDisabled()).toBe(true);
    await page.getByRole('button', { name: 'Search', exact: true }).click();

    const list = page.getByRole('listbox');
    await shown(list.getByRole('option').first());
    // Both remote job boards were asked, through the server, and answered. The line under the search box opens to
    // a table that says how many jobs each one found.
    expect(network.calls.map((c) => new URL(c.url).hostname).sort()).toEqual(['remoteok.com', 'remotive.com']);
    const sources = page.getByRole('region', { name: 'Sources searched' });
    await sources.getByRole('button').click();
    for (const board of ['Remotive', 'Remote OK']) {
      const row = sources.getByRole('row').filter({ has: page.getByRole('rowheader', { name: board, exact: true }) });
      await shown(row);
      expect(await row.getByRole('cell').textContent()).toMatch(/^\d+ jobs?$/);
    }
    await page.keyboard.press('Escape');
    await sources.getByRole('table').waitFor({ state: 'detached' });
    const count = await list.getByRole('option').count();
    expect(await list.getAttribute('aria-label')).toBe(count === 1 ? '1 job' : `${count} jobs`);

    const card = list.getByRole('option').first();
    const title = (await card.locator('.title').textContent()) ?? '';
    await card.click();
    const detail = page.getByRole('article');
    await shown(detail.getByRole('heading', { level: 2 }));
    expect(await detail.getByRole('heading', { level: 2 }).textContent()).toBe(title);
    // The way out to the real posting opens in a new tab and tells the site nothing about where it came from.
    const out = detail.getByRole('link').first();
    expect(await out.getAttribute('href')).toMatch(/^https:\/\/(remotive\.com|remoteok\.com)\//);
    expect(await out.getAttribute('target')).toBe('_blank');
    expect(await out.getAttribute('rel')).toContain('noopener');

    expect(v.problems).toEqual([]);
    expect(server.errors).toEqual([]);
  });

  it('takes an invited person from the invite link to a signed-in account that survives a reload', async () => {
    const email = 'sam@example.com';
    const password = 'correct horse battery staple';
    const invite = await accounts.service.admin.invite(email, 'user');
    const v = await visit(`/#/invite/${invite.code}`);
    const { page, context } = v;

    await shown(page.getByRole('heading', { name: 'Create your account' }));
    await page.getByLabel('Password', { exact: true }).fill(password);
    await page.getByLabel('Password, once more', { exact: true }).fill(password);
    await page.getByRole('button', { name: 'Create account' }).click();

    await shown(page.getByRole('heading', { name: 'Your account is ready' }));
    await page.getByRole('checkbox', { name: 'I have saved my recovery code' }).check();
    await page.getByRole('button', { name: 'Continue to your account' }).click();
    await shown(page.getByText(`Signed in as ${email}`));
    // The one-time code is no longer in the address bar.
    expect(page.url()).not.toContain(invite.code);

    // The session is a cookie that scripts cannot read and that is never sent from another site.
    const cookies = await context.cookies();
    expect(cookies.map((c) => ({ name: c.name, httpOnly: c.httpOnly, sameSite: c.sameSite, path: c.path }))).toEqual([{ name: 'session', httpOnly: true, sameSite: 'Strict', path: '/' }]);
    expect(await page.evaluate(() => document.cookie)).toBe('');

    await page.reload();
    await shown(page.getByText(`Signed in as ${email}`));

    // Signing out leaves the account pages for the search page, and takes the cookie with it.
    await page.getByRole('button', { name: 'Sign out', exact: true }).first().click();
    await shown(page.getByRole('link', { name: 'Sign in' }));
    expect(await context.cookies()).toEqual([]);
    await page.getByRole('link', { name: 'Sign in' }).click();
    await shown(page.getByRole('button', { name: 'Sign in' }));

    // A wrong password is refused in words, and the right one gets back in.
    await page.getByLabel('Email').fill(email);
    await page.getByLabel('Password', { exact: true }).fill('not the password');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await shown(page.getByRole('alert'));
    expect(await page.getByRole('alert').textContent()).toBe('Email or password is incorrect.');
    await page.getByLabel('Password', { exact: true }).fill(password);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await shown(page.getByText(`Signed in as ${email}`));

    // The refused sign-in was answered with 401, which the browser logs. Nothing else went wrong.
    expect(v.problems).toEqual([expect.stringMatching(/401/)]);
    expect(server.errors).toEqual([]);
  });

  it('reads a PDF resume with the real PDF reader, draws its page, and keeps the review across a reload', async () => {
    const v = await visit('/#/resume');
    const { page } = v;
    await page.locator('input[type=file]').first().setInputFiles({ name: 'resume.pdf', mimeType: 'application/pdf', buffer: Buffer.from(await resumePdf()) });

    const fields = page.locator('section[aria-label="Extracted fields"]');
    await shown(fields.getByText(RESUME.name, { exact: true }));
    expect(await fields.locator('.field .value').allTextContents()).toEqual(expect.arrayContaining([RESUME.email, RESUME.phone, RESUME.location, RESUME.title, RESUME.company, RESUME.dates, ...RESUME.bullets, RESUME.school, ...RESUME.skills]));
    await shown(page.getByText('Every field matches the source word for word'));

    // The page of the PDF is drawn by the PDF reader's worker, with a highlight over each field.
    await page.waitForFunction(() => {
      const canvas = document.querySelector<HTMLCanvasElement>('.pdf-page canvas');
      if (!canvas || canvas.width < 100) return false;
      const { data } = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height);
      let dark = 0;
      for (let i = 0; i < data.length; i += 4) if (data[i + 3] === 255 && data[i] < 100 && data[i + 1] < 100 && data[i + 2] < 100) dark++;
      return dark > 500; // the letters
    });
    expect(await page.locator('.pdf-page .hl').count()).toBeGreaterThan(10);

    await fields.locator('.field', { hasText: RESUME.name }).getByRole('button', { name: 'Confirm' }).click();
    await shown(page.getByText(/^1 of \d+ reviewed$/));

    // The resume and its file are kept in this browser (and nowhere else), so a reload brings both back.
    await page.reload();
    await shown(page.getByText(/^1 of \d+ reviewed$/));
    expect(await fields.locator('.field', { hasText: RESUME.name }).getByRole('button', { name: 'Confirm' }).getAttribute('aria-pressed')).toBe('true');
    await page.waitForFunction(() => (document.querySelector<HTMLCanvasElement>('.pdf-page canvas')?.width ?? 0) > 100);

    expect(v.problems).toEqual([]);
    expect(v.refused).toEqual([]);
  });

  it('reads a Word resume with the real Word reader', async () => {
    const v = await visit('/#/resume');
    const { page } = v;
    await page
      .locator('input[type=file]')
      .first()
      .setInputFiles({ name: 'resume.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', buffer: Buffer.from(resumeDocx()) });

    const fields = page.locator('section[aria-label="Extracted fields"]');
    await shown(fields.getByText(RESUME.name, { exact: true }));
    expect(await fields.locator('.field .value').allTextContents()).toEqual([
      RESUME.name,
      RESUME.email,
      RESUME.phone,
      RESUME.location,
      RESUME.title,
      RESUME.company,
      RESUME.dates,
      ...RESUME.bullets,
      RESUME.school,
      'Bachelor of Science',
      'Statistics',
      '2019',
      ...RESUME.skills,
    ]);
    await shown(page.getByText('Every field matches the source word for word'));

    expect(v.problems).toEqual([]);
    expect(v.refused).toEqual([]);
  });
});
