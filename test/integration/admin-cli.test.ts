/**
 * `npm run admin`, run the way a person runs it: as its own process, against a real database on disk, both with the
 * server stopped and with the server running and holding the database.
 *
 * What each command does to accounts is tested without a process in test/server/accounts.test.ts. This is about the
 * command line itself: its arguments, what it prints, its exit code, and handing a command to a running server.
 *
 * Every run gets its own database folder, port and password secret. The secret is always given: without one,
 * `setup` would create one and write it into server/.env, which a test must never do. The last test checks that
 * file was left alone.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readAccountsConfig, startAccounts, type Accounts } from '../../server/src/accounts/index';
import { SERVER_DIR, TSX, freePort, newPepper } from '../helpers/process';

const ENV_FILE = join(SERVER_DIR, '.env');
const PEPPER = newPepper();
const TIMEOUT = 120_000;

const envFileState = () => (existsSync(ENV_FILE) ? `${statSync(ENV_FILE).size} bytes, changed ${statSync(ENV_FILE).mtimeMs}` : 'absent');
const envFileBefore = envFileState();

const dataDir = mkdtempSync(join(tmpdir(), 'admin-cli-test-'));
let port: number;
let origin: string;

const settings = () => ({
  AUTH_PEPPER: PEPPER,
  AUTH_PEPPER_OLD: ',',
  ACCOUNTS_DATA_DIR: dataDir,
  PORT: String(port),
  APP_ORIGIN: origin,
  TRUST_PROXY: '0',
  PASSWORD_BREACH_CHECK: '0',
});

/** Runs `npm run admin -- <args>` as its own process and returns what it printed and how it ended. */
function admin(...args: string[]): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [...TSX, 'src/admin.ts', ...args], { cwd: SERVER_DIR, env: { ...process.env, ...settings() }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk: Buffer) => (out += chunk.toString('utf8')));
    child.stderr.on('data', (chunk: Buffer) => (err += chunk.toString('utf8')));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, out: out.replace(/\r\n/g, '\n'), err: err.replace(/\r\n/g, '\n') }));
  });
}

const linkIn = (text: string, kind: 'invite' | 'reset') => new RegExp(`^  (\\S+)/#/${kind}/([A-Za-z0-9_-]{43})$`, 'm').exec(text);

beforeAll(async () => {
  port = await freePort();
  origin = `http://127.0.0.1:${port}`;
});

afterAll(() => {
  // Windows can take a moment to let go of files that were just closed.
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

describe('the admin command line, with the server stopped', () => {
  it('explains itself when run with nothing, and with something it does not know', { timeout: TIMEOUT }, async () => {
    const help = await admin();
    expect(help.code).toBe(0);
    expect(help.out).toContain('Usage: npm run admin -- <command>');
    expect(help.out).toContain('setup <email>');
    expect(help.err).toBe('');

    const unknown = await admin('delete-everything');
    expect(unknown.code).toBe(1);
    expect(unknown.err).toContain('Usage: npm run admin -- <command>');
    expect(unknown.out).toBe('');

    // A command that needs an email and did not get one.
    const noEmail = await admin('invite', '--admin');
    expect(noEmail.code).toBe(1);
    expect(noEmail.err).toContain('Usage: npm run admin -- <command>');
  });

  it('sets accounts up: makes the database and prints an admin invite for the address given', { timeout: TIMEOUT }, async () => {
    const setup = await admin('setup', 'owner@example.com');
    expect(setup.err).toBe('');
    expect(setup.code).toBe(0);
    expect(setup.out).toContain('The password secret in server/.env is already there.');
    expect(setup.out).toContain(`The account database is ready in ${join(dataDir, 'pg')}.`);
    expect(setup.out).toContain('Invite for owner@example.com (admin), good for 7 days:');
    expect(linkIn(setup.out, 'invite')?.[1]).toBe(origin);
    expect(setup.out).toContain('Start the app with "npm run local" if it is not running, then open the link.');
    expect(existsSync(join(dataDir, 'pg'))).toBe(true);
    // The command is done, so it no longer holds the database.
    expect(existsSync(join(dataDir, 'pg.lock'))).toBe(false);
  });

  it('lists accounts, and says so plainly when a command cannot be carried out', { timeout: TIMEOUT }, async () => {
    const users = await admin('users');
    expect(users.code).toBe(0);
    // The invite from the setup has not been accepted, so there is no account yet.
    expect(users.out.trim()).toBe('No accounts yet. Create the first one with: npm run admin -- invite <email> --admin');

    const reset = await admin('reset', 'nobody@example.com');
    expect(reset.code).toBe(1);
    expect(reset.err.trim()).toBe('There is no account for nobody@example.com.');
    expect(reset.err).not.toContain('at '); // a sentence for the person at the keyboard, not a stack trace
  });
});

describe('the admin command line, with the server running', () => {
  let accounts: Accounts;
  let server: Server;

  beforeAll(async () => {
    const config = readAccountsConfig(settings())!;
    // The real server would hash with its real cost. Nothing here sets a password, so that cost is never paid.
    accounts = await startAccounts(config);
    server = createServer((req, res) => void accounts.handle(req, res, new URL(req.url ?? '/', origin)));
    await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
  }, TIMEOUT);

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
    await accounts.close();
  });

  it('hands the command to the server, which is the one process that may have the database open', { timeout: TIMEOUT }, async () => {
    const invite = await admin('invite', 'new.person@example.com');
    expect(invite.err).toBe('');
    expect(invite.code).toBe(0);
    expect(invite.out).toContain('Invite for new.person@example.com, good for 7 days:');
    const [, site, code] = linkIn(invite.out, 'invite')!;
    expect(site).toBe(origin);

    // The link the command printed is one this server accepts.
    const res = await fetch(`${origin}/api/auth/invite`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify({ code }) });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ kind: 'invite', email: 'new.person@example.com' });
  });

  it("passes on the server's reason when the command cannot be carried out", { timeout: TIMEOUT }, async () => {
    const signOut = await admin('sign-out', 'nobody@example.com');
    expect(signOut.code).toBe(1);
    expect(signOut.err.trim()).toBe('There is no account for nobody@example.com.');
  });
});

describe('the tests of the admin command line', () => {
  it('left server/.env exactly as it was', () => {
    expect(envFileState()).toBe(envFileBefore);
  });
});
