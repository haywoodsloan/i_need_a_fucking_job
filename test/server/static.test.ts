import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer, request, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { APP_CSP, NoBuiltApp, loadApp, requestUrl } from '../../server/src/static';

const INDEX = '<!doctype html>\n<html>\n  <head>\n    <title>App</title>\n  </head>\n  <body><div id="root"></div></body>\n</html>\n';

let root: string;
let dir: string;
let server: Server;
let port: number;

/** A request sent exactly as written, without the path tidying that fetch() does. */
function raw(path: string, o: { method?: string; headers?: Record<string, string> } = {}): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method: o.method ?? 'GET', headers: o.headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end();
  });
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'static-test-'));
  dir = join(root, 'dist');
  mkdirSync(join(dir, 'assets'), { recursive: true });
  writeFileSync(join(dir, 'index.html'), INDEX);
  writeFileSync(join(dir, 'assets', 'index-abc123.js'), 'console.log("app")');
  writeFileSync(join(dir, 'assets', 'index-abc123.css'), 'body{}');
  writeFileSync(join(dir, '.secret'), 'hidden file');
  writeFileSync(join(dir, 'notes.exe'), 'unknown kind of file');
  writeFileSync(join(root, 'outside.txt'), 'a file next to the folder');
  try {
    symlinkSync(join(root, 'outside.txt'), join(dir, 'link.txt'));
  } catch {
    // Windows only lets administrators and Developer Mode create links. Without one, "/link.txt" below is simply a
    // file that is not there, and the rest of the checks still run.
  }

  const app = loadApp(dir, { accounts: true });
  // The same order as the real server: parse the address, let the app answer, otherwise 404.
  server = createServer((req, res) => {
    if (!app.handle(req, res, requestUrl(req.url).pathname)) res.writeHead(404, { 'Content-Type': 'application/json' }).end('{"error":"Not found"}');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as { port: number }).port;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe('serving the built app', () => {
  it('serves only the files that belong to the app', () => {
    expect(loadApp(dir).paths).toEqual(['/assets/index-abc123.css', '/assets/index-abc123.js', '/index.html']);
  });

  it('answers the page with the security headers', async () => {
    const res = await raw('/');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(res.headers['content-security-policy']).toBe(APP_CSP);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    expect(res.headers['cross-origin-opener-policy']).toBe('same-origin');
    expect(res.headers['cache-control']).toBe('no-cache');
    expect(res.headers['strict-transport-security']).toBeUndefined();
    expect((await raw('/index.html')).body).toBe(res.body);
  });

  it('lets scripts and styles come only from its own files', () => {
    const policy = Object.fromEntries(APP_CSP.split('; ').map((d) => [d.split(' ')[0], d.split(' ').slice(1)]));
    expect(policy['default-src']).toEqual(["'none'"]);
    expect(policy['script-src']).toEqual(["'self'"]);
    expect(policy['style-src']).toEqual(["'self'"]);
    expect(policy['frame-ancestors']).toEqual(["'none'"]);
    expect(policy['base-uri']).toEqual(["'none'"]);
    expect(APP_CSP).not.toMatch(/unsafe-inline|unsafe-eval|\*/);
  });

  it('tells the page to search through this server, and that accounts are on only when they are', async () => {
    const on = (await raw('/')).body;
    expect(on).toContain('<title>App</title>\n    <meta name="job-hunt-server" content="on" />\n    <meta name="job-hunt-accounts" content="on" />\n  </head>');
    const off = loadApp(dir);
    const answered = await new Promise<string>((resolve) => {
      const res = { writeHead: () => res, end: (body?: Buffer) => resolve(String(body)) };
      off.handle({ method: 'GET', headers: {} } as never, res as never, '/');
    });
    expect(answered).toBe(INDEX.replace('  </head>', '    <meta name="job-hunt-server" content="on" />\n  </head>'));
    expect(answered).not.toContain('job-hunt-accounts');
  });

  it('lets the browser keep hashed files and recheck the page', async () => {
    const js = await raw('/assets/index-abc123.js');
    expect(js.headers['content-type']).toBe('text/javascript; charset=utf-8');
    expect(js.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    expect(js.body).toBe('console.log("app")');

    const page = await raw('/');
    const again = await raw('/', { headers: { 'If-None-Match': String(page.headers.etag) } });
    expect(again.status).toBe(304);
    expect(again.body).toBe('');
    const head = await raw('/', { method: 'HEAD' });
    expect(head.status).toBe(200);
    expect(head.headers['content-length']).toBe(String(Buffer.byteLength(page.body)));
    expect(head.body).toBe('');
  });

  it('does not reach outside its folder, however the path is written', async () => {
    const attempts = [
      '/../outside.txt',
      '/assets/../../outside.txt',
      '/%2e%2e/outside.txt',
      '/assets/%2e%2e%2f%2e%2e%2foutside.txt',
      '/..%2foutside.txt',
      '/assets/..%5c..%5coutside.txt',
      '//outside.txt',
      '/link.txt', // a link inside the folder that points outside it
      '/.secret',
      '/notes.exe',
      '/assets',
      '/assets/',
      '/index.html/',
      '/INDEX.HTML',
      '/assets/index-abc123.js%00.html',
    ];
    for (const path of attempts) {
      const res = await raw(path);
      expect(res.status, path).toBe(404);
      expect(res.body, path).not.toContain('a file next to the folder');
    }
  });

  it('reads what a request asks for as a path on this server', () => {
    expect(requestUrl('/api/search?x=1').pathname).toBe('/api/search');
    expect(requestUrl('/api/search?x=1').searchParams.get('x')).toBe('1');
    expect(requestUrl(undefined).pathname).toBe('/');
    // Not another server's address, which is what a leading "//" means inside a web page.
    expect(requestUrl('//evil.example/api/auth/session').pathname).toBe('//evil.example/api/auth/session');
    // Some proxies send the whole address. Its path is what counts.
    expect(requestUrl('http://localhost:8787/api/health').pathname).toBe('/api/health');
  });

  it('leaves everything but reading to the rest of the server', async () => {
    for (const method of ['POST', 'PUT', 'DELETE']) expect((await raw('/', { method })).status, method).toBe(404);
  });

  it('adds HSTS when the app is on HTTPS', () => {
    const secure = loadApp(dir, { https: true });
    let sent: Record<string, unknown> = {};
    const res = { writeHead: (_status: number, headers: Record<string, unknown>) => ((sent = headers), res), end: () => {} };
    secure.handle({ method: 'GET', headers: {} } as never, res as never, '/');
    expect(sent['Strict-Transport-Security']).toBe('max-age=31536000');
  });

  it('says what to do when the app has not been built', () => {
    expect(() => loadApp(join(root, 'nothing-here'))).toThrow(NoBuiltApp);
    expect(() => loadApp(join(root, 'nothing-here'))).toThrow('Run "npm run build" in the repo root first');
  });
});
