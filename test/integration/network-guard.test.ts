/** The rule that no test reaches a live site (test/setup/network.ts), tested like any other rule. */
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it, vi } from 'vitest';

describe('the network in tests', () => {
  it.each([
    ['an address', 'https://jobs.example.com/api/search?q=pilot'],
    ['a URL', new URL('https://jobs.example.com/api/search?q=pilot')],
    ['a Request', new Request('https://jobs.example.com/api/search?q=pilot', { method: 'POST' })],
  ])('is closed to a live site, asked for by %s', async (_how, target) => {
    const failure = await fetch(target).catch((e: unknown) => e);
    expect(failure).toMatchObject({ name: 'NetworkInTestError' });
    expect((failure as Error).message).toContain('A test tried to reach the network: https://jobs.example.com/api/search?q=pilot');
    expect((failure as Error).message).toContain('docs/testing.md');
  });

  it('is closed to an address that is not a web address at all', async () => {
    await expect(fetch('/api/search')).rejects.toMatchObject({ name: 'NetworkInTestError' });
  });

  it('is open to a server the test started on this machine', async () => {
    const server = createServer((_req, res) => res.end('hello from the test server'));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const { port } = server.address() as AddressInfo;
      const res = await fetch(`http://127.0.0.1:${port}/`);
      expect(await res.text()).toBe('hello from the test server');
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('gives way to a fake that a test puts in its place, for that test only', async () => {
    vi.stubGlobal('fetch', async () => new Response('from the fake'));
    expect(await (await fetch('https://jobs.example.com/')).text()).toBe('from the fake');
    vi.unstubAllGlobals();
    await expect(fetch('https://jobs.example.com/')).rejects.toMatchObject({ name: 'NetworkInTestError' });
  });
});
