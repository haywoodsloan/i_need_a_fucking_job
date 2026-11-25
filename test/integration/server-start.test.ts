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
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { freePort, newPepper, startServerProcess, type ServerProcess } from '../helpers/process';

const dataDir = mkdtempSync(join(tmpdir(), 'server-start-test-'));
let port: number;
let origin: string;
let server: ServerProcess;

beforeAll(async () => {
  port = await freePort();
  origin = `http://127.0.0.1:${port}`;
  server = await startServerProcess(port, {
    ALLOWED_ORIGINS: origin,
    AUTH_PEPPER: newPepper(),
    AUTH_PEPPER_OLD: ',',
    ACCOUNTS_DATA_DIR: dataDir,
    APP_ORIGIN: origin,
    PASSWORD_BREACH_CHECK: '0',
    APPLICATIONS: '1',
    APPLICATIONS_DIR: join(dataDir, 'applications'),
  });
}, 90_000);

afterAll(async () => {
  await server?.kill();
  // Windows can take a moment to let go of files that were just closed.
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

describe('the server, started as its own process', () => {
  it('says what it started with', () => {
    const printed = server.printed();
    expect(printed).toContain(`job search backend on :${port} (fetch tiers: `);
    expect(printed).toContain('listening: for this computer only (set HOST=0.0.0.0 to answer other computers too)');
    expect(printed).toContain(`applications: kept on this computer, in ${join(dataDir, 'applications')}`);
    expect(printed).toContain(`accounts: on, for the app at ${origin}`);
    // ALLOWED_ORIGINS was given, so there is no warning about accepting every origin.
    expect(printed).not.toContain('ALLOWED_ORIGINS is not set');
  });

  it('answers a health check', async () => {
    const res = await fetch(`${origin}/api/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, accounts: true, applications: true, tiers: expect.arrayContaining(['cache', 'http']) });
  });

  it('keeps applications, in the folder it was given, and makes that folder only when there is one to keep', async () => {
    const res = await fetch(`${origin}/api/applications`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ available: true, applications: [], unreadable: [] });
    expect(existsSync(join(dataDir, 'applications'))).toBe(false);
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

  it('says what is in the way when it cannot start, and stops', { timeout: 120_000 }, async () => {
    // Accounts stay off in these two, whatever this machine's server/.env holds.
    const plain = { AUTH_PEPPER: '', ACCOUNTS_DATA_DIR: join(dataDir, 'unused'), ALLOWED_ORIGINS: '' };
    // The port is taken, by the server above.
    const second = await startServerProcess(port, plain).then(
      (started) => started.kill().then(() => 'it started'),
      (e: Error) => e.message,
    );
    expect(second).toContain('The server stopped while starting (exit code 1).');
    expect(second).toContain(`Port ${port} is in use. The server may be running already: look for another window of this app, or set PORT to another number.`);
    // HOST names an address that is not this machine's. 203.0.113.1 is set aside for examples: no machine has it.
    const elsewhere = await startServerProcess(await freePort(), { ...plain, HOST: '203.0.113.1' }).then(
      (started) => started.kill().then(() => 'it started'),
      (e: Error) => e.message,
    );
    expect(elsewhere).toContain('The server stopped while starting (exit code 1).');
    expect(elsewhere).toContain('HOST is set to "203.0.113.1", and this computer has no such address. Leave HOST empty to answer this computer only, or set HOST=0.0.0.0 to answer other computers too.');
  });

  // Windows has no way to ask a process to stop: it is ended on the spot, and never gets to tidy up.
  it.skipIf(process.platform === 'win32')('stops when asked, and lets go of the database', async () => {
    server.child.kill('SIGTERM');
    expect(await server.ended).toBe(0);
    expect(existsSync(join(dataDir, 'pg.lock'))).toBe(false);
  });
});
