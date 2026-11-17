// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

/** The default is worked out once, when the module loads, so each case loads it afresh. */
async function load(o: { builtFor?: string; servedByServer?: boolean } = {}) {
  vi.resetModules();
  vi.stubEnv('VITE_API_URL', o.builtFor ?? '');
  document.head.innerHTML = o.servedByServer ? '<meta name="job-hunt-server" content="on" />' : '';
  return import('./client');
}

afterEach(() => {
  vi.unstubAllEnvs();
  document.head.innerHTML = '';
});

describe('the search server the app starts with', () => {
  it('is none for a copy on a static host, which searches from the browser', async () => {
    const { DEFAULT_API_URL, DEFAULT_SETTINGS } = await load();
    expect(DEFAULT_API_URL).toBe('');
    expect(DEFAULT_SETTINGS.apiUrl).toBe('');
  });

  it("is the page's own address when the search server served the page", async () => {
    const { DEFAULT_SETTINGS } = await load({ servedByServer: true });
    expect(DEFAULT_SETTINGS.apiUrl).toBe(window.location.origin);
    expect(DEFAULT_SETTINGS.apiUrl).toMatch(/^http:\/\/localhost(:\d+)?$/);
  });

  it('is the one named when the app was built, wherever the page came from', async () => {
    expect((await load({ builtFor: 'https://search.example.com' })).DEFAULT_API_URL).toBe('https://search.example.com');
    expect((await load({ builtFor: 'https://search.example.com', servedByServer: true })).DEFAULT_API_URL).toBe('https://search.example.com');
  });
});
