/**
 * Serves the built app (the repo's dist/ folder) from this server, so the app and its API share one address. A
 * hosted copy runs this way: the sign-in cookie is then first-party, and the app's own pages get the security
 * headers below, which GitHub Pages cannot send.
 *
 * It is off unless the server is started with --serve-app or SERVE_APP=1. Locally `npm run local` serves the app
 * through Vite's dev server instead, and `npm run local:built` tries this for real.
 *
 * The files are read once at startup and looked up by exact path, so no request can reach outside the folder.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname, join } from 'node:path';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm',
  '.webmanifest': 'application/manifest+json',
};

/**
 * What the app's pages may load and do. Scripts and styles come only from this server's own files: nothing inline,
 * nothing evaluated from text. So even if hostile markup from a job description got past the sanitizer, the
 * browser would refuse to run it.
 *
 *   img-src      company logos come from the job sources, and PDF pages are drawn from in-memory images
 *   connect-src  searching without a backend calls the job sources straight from the browser, over HTTPS
 *   worker-src   the PDF reader works in a background worker
 */
export const APP_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data: blob: https:",
  "font-src 'self'",
  "connect-src 'self' https:",
  "worker-src 'self' blob:",
  "manifest-src 'self'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

export function appHeaders(https: boolean): Record<string, string> {
  return {
    'Content-Security-Policy': APP_CSP,
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
    // Only where the app is on HTTPS. On http://localhost it would be ignored anyway.
    ...(https ? { 'Strict-Transport-Security': 'max-age=31536000' } : {}),
  };
}

/**
 * The address a request asks for. It is almost always a path, and is read as one: "//host/file" must not be taken
 * for an address on another server, which is how a plain `new URL(target, base)` would read it.
 */
export function requestUrl(target: string | undefined): URL {
  const t = target ?? '/';
  return t.startsWith('/') ? new URL(`http://x${t}`) : new URL(t, 'http://x');
}

export class NoBuiltApp extends Error {
  constructor(dir: string) {
    super(`There is no built app in ${dir}. Run "npm run build" in the repo root first, or start the server without --serve-app.`);
    this.name = 'NoBuiltApp';
  }
}

interface StaticFile {
  body: Buffer;
  type: string;
  etag: string;
  /** Files under assets/ have a hash of their content in their name, so a browser may keep them for good. */
  cache: string;
}

export interface AppOptions {
  /** Accounts are on: the page is told so, and asks who is signed in. Left out, it never calls the account routes. */
  accounts?: boolean;
  /** The app is reached over HTTPS. */
  https?: boolean;
}

export type BuiltApp = ReturnType<typeof loadApp>;

export function loadApp(dir: string, o: AppOptions = {}) {
  if (!existsSync(join(dir, 'index.html'))) throw new NoBuiltApp(dir);
  const files = new Map<string, StaticFile>();
  const walk = (folder: string, prefix: string) => {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      const path = `${prefix}/${entry.name}`;
      if (entry.isDirectory()) walk(join(folder, entry.name), path);
      // isFile() is false for links, so a link placed in the folder cannot expose a file from somewhere else.
      else if (entry.isFile() && TYPES[extname(entry.name).toLowerCase()]) add(path, readFileSync(join(folder, entry.name)));
    }
  };
  const add = (path: string, raw: Buffer) => {
    let body = raw;
    if (path === '/index.html') {
      // Tells the page what the server it came from offers: search (src/jobs/client.ts), and accounts when they
      // are on (src/account/client.ts). A copy of the app on a static host has neither line.
      const tags = ['<meta name="job-hunt-server" content="on" />', ...(o.accounts ? ['<meta name="job-hunt-accounts" content="on" />'] : [])];
      body = Buffer.from(raw.toString('utf8').replace('</head>', `  ${tags.join('\n    ')}\n  </head>`));
    }
    files.set(path, {
      body,
      type: TYPES[extname(path).toLowerCase()],
      etag: `"${createHash('sha256').update(body).digest('hex').slice(0, 24)}"`,
      cache: path.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache',
    });
  };
  walk(dir, '');

  const headers = appHeaders(!!o.https);

  /** Answers the request if it is for one of the app's files. Returns false when it is not. */
  function handle(req: IncomingMessage, res: ServerResponse, path: string): boolean {
    if (req.method !== 'GET' && req.method !== 'HEAD') return false;
    const file = files.get(path === '/' ? '/index.html' : path);
    if (!file) return false;
    const common = { ...headers, ETag: file.etag, 'Cache-Control': file.cache };
    if (req.headers['if-none-match'] === file.etag) {
      res.writeHead(304, common).end();
      return true;
    }
    res.writeHead(200, { ...common, 'Content-Type': file.type, 'Content-Length': file.body.length });
    res.end(req.method === 'HEAD' ? undefined : file.body);
    return true;
  }

  return { handle, paths: [...files.keys()].sort() };
}
