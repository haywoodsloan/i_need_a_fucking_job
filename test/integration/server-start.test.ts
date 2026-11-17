/**
 * The server started the way `npm start` starts it: as its own process, reading its settings from the environment,
 * with the account database on disk.
 *
 * Everything the server does with a request is tested without a process (test/integration/search-server.test.ts,
 * test/server/accounts.test.ts). This is about the one file those tests cannot reach, server/src/index.ts, which
 * puts the parts together: if it stopped starting, every other test would still pass.
 *
 * The search asked for here names no job board, so the server has no source to call and nothing leaves this machine.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SERVER_DIR, TSX, freePort, newPepper } from '../helpers/process';

const dataDir = mkdtempSync(join(tmpdir(), 'server-start-test-'));
let port: number;
let origin: string;
let child: ChildProcess;
let printed = '';
let ended: Promise<number | null>;

beforeAll(async () => {
  port = await freePort();
  origin = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, [...TSX, 'src/index.ts'], {
    cwd: SERVER_DIR,
    env: {
      ...process.env,
      PORT: String(port),
      ALLOWED_ORIGINS: origin,
      AUTH_PEPPER: newPepper(),
      AUTH_PEPPER_OLD: ',',
      ACCOUNTS_DATA_DIR: dataDir,
      APP_ORIGIN: origin,
      TRUST_PROXY: '0',
      PASSWORD_BREACH_CHECK: '0',
      // Whatever this machine's server/.env switches on stays off here.
      SERVE_APP: '0',
      ENABLE_BROWSER_TIER: '',
      FETCH_TIERS_MODULE: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  ended = new Promise((resolve) => child.on('close', resolve));
  await new Promise<void>((resolve, reject) => {
    const failed = (why: string) => reject(new Error(`${why} It printed:\n${printed || '(nothing)'}`));
    const timer = setTimeout(() => failed('The server did not start within a minute.'), 60_000);
    const heard = (chunk: Buffer) => {
      printed += chunk.toString('utf8').replace(/\r\n/g, '\n');
      // The last thing it prints when it is up: whether accounts are on.
      if (/^accounts: /m.test(printed)) {
        clearTimeout(timer);
        resolve();
      }
    };
    child.stdout!.on('data', heard);
    child.stderr!.on('data', heard);
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timer);
      failed(`The server stopped while starting (exit code ${code}).`);
    });
  });
}, 90_000);

afterAll(async () => {
  if (child.exitCode === null && child.signalCode === null) child.kill();
  await ended;
  // Windows can take a moment to let go of files that were just closed.
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

describe('the server, started as its own process', () => {
  it('says what it started with', () => {
    expect(printed).toContain(`job search backend on :${port} (fetch tiers: `);
    expect(printed).toContain(`accounts: on, for the app at ${origin}`);
    // ALLOWED_ORIGINS was given, so there is no warning about accepting every origin.
    expect(printed).not.toContain('ALLOWED_ORIGINS is not set');
  });

  it('answers a health check', async () => {
    const res = await fetch(`${origin}/api/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, accounts: true, tiers: expect.arrayContaining(['cache', 'http']) });
  });

  it('answers a search', async () => {
    const res = await fetch(`${origin}/api/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: origin },
      body: JSON.stringify({ query: { role: 'pilot' }, settings: { boards: [], companies: [], industries: [], allowScraping: false } }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe(origin);
    expect(await res.json()).toMatchObject({ jobs: [], sources: [] });
  });

  it('has accounts running on a database in the folder it was given', async () => {
    const res = await fetch(`${origin}/api/auth/session`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ available: true, user: null });
    expect(existsSync(join(dataDir, 'pg'))).toBe(true);
    expect(existsSync(join(dataDir, 'pg.lock'))).toBe(true);
  });

  it('does not serve the app unless it was started to', async () => {
    const res = await fetch(`${origin}/`);
    expect(res.status).toBe(404);
  });

  // Windows has no way to ask a process to stop: it is ended on the spot, and never gets to tidy up.
  it.skipIf(process.platform === 'win32')('stops when asked, and lets go of the database', async () => {
    child.kill('SIGTERM');
    expect(await ended).toBe(0);
    expect(existsSync(join(dataDir, 'pg.lock'))).toBe(false);
  });
});
