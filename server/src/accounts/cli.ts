/**
 * The account commands behind `npm run admin` (see ../admin.ts for the list).
 *
 * They work whether or not the server is running. Only one process may have the local database open, so when the
 * server holds it the command is passed to the server over a loopback-only channel (see index.ts).
 */
import '../env';
import { randomBytes } from 'node:crypto';
import { appendFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DatabaseInUse, lockPath, readLock } from '../db/db';
import { runAdminCommand, type AdminCommand } from './admin-commands';
import { adminToken, databaseDir, openAccounts, readAccountsConfig, type AccountsConfig } from './index';

const env = process.env as Record<string, string | undefined>;
const ENV_FILE = fileURLToPath(new URL('../../.env', import.meta.url));

const USAGE = `Usage: npm run admin -- <command>

  setup <email>             Turn accounts on for this server and print an admin invite for <email>
  invite <email> [--admin]  Print a one-time invite link
  reset <email>             Print a one-time password reset link
  users                     List accounts
  sign-out <email>          Sign someone out everywhere`;

class Failure extends Error {}

async function viaServer(port: number, config: AccountsConfig, command: AdminCommand): Promise<string[]> {
  let res: Response;
  try {
    res = await fetch(`http://127.0.0.1:${port}/api/admin/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken(config).toString('hex')}` },
      body: JSON.stringify(command),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (e) {
    throw new Failure(
      `The server holds the database but did not answer on port ${port} (${(e as Error).message}). Stop it and run this command again.\n` +
        `If no server is running, delete ${lockPath(databaseDir(config))} and run this command again.`,
    );
  }
  if (res.status === 404) {
    throw new Failure('The running server did not accept the command. It was probably started with a different AUTH_PEPPER than server/.env has now. Restart it and try again.');
  }
  const answer = (await res.json()) as { ok: boolean; lines?: string[]; error?: string };
  if (!answer.ok) throw new Failure(answer.error ?? 'The server could not run the command.');
  return answer.lines ?? [];
}

/** Runs a command against the database: directly, or through the server when the server has it open. */
async function run(config: AccountsConfig, command: AdminCommand): Promise<string[]> {
  const holder = readLock(databaseDir(config));
  if (holder?.role === 'server') return viaServer(holder.port ?? config.port, config, command);
  let opened: Awaited<ReturnType<typeof openAccounts>>;
  try {
    opened = await openAccounts(config, { holder: { pid: process.pid, role: 'admin' } });
  } catch (e) {
    if (e instanceof DatabaseInUse && e.holder.role === 'server') return viaServer(e.holder.port ?? config.port, config, command);
    throw e instanceof DatabaseInUse ? new Failure(`${e.message} Try again in a moment.`) : e;
  }
  try {
    return await runAdminCommand(opened.service, config, command);
  } catch (e) {
    throw new Failure((e as Error).message);
  } finally {
    await opened.db.close();
  }
}

/** Says so when a server is up on the port but has accounts switched off, which means it predates the setup. */
async function serverNeedsRestart(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/auth/session`, { signal: AbortSignal.timeout(1500) });
    return res.ok && ((await res.json()) as { available?: boolean }).available === false;
  } catch {
    return false; // nothing is listening
  }
}

async function setup(email: string | undefined): Promise<string[]> {
  const lines: string[] = [];
  if (!env.AUTH_PEPPER) {
    const pepper = `1:${randomBytes(32).toString('base64')}`;
    const fresh = !existsSync(ENV_FILE);
    appendFileSync(
      ENV_FILE,
      `${fresh ? '' : '\n'}# Accounts. Added by "npm run admin -- setup". Keep it secret and keep a copy somewhere safe:\n# if it is lost, nobody can sign in and every stored login is unreadable.\nAUTH_PEPPER=${pepper}\n`,
      { mode: 0o600 },
    );
    env.AUTH_PEPPER = pepper;
    lines.push(`Created the password secret in server/.env${fresh ? ' (new file)' : ''}.`);
  } else {
    lines.push('The password secret in server/.env is already there.');
  }
  const config = readAccountsConfig(env)!;
  const users = await run(config, { command: 'users' });
  lines.push(`The account database is ready in ${databaseDir(config)}.`);
  if (email) {
    lines.push('', ...(await run(config, { command: 'invite', email, admin: true })));
  } else if (users[0]?.startsWith('No accounts')) {
    lines.push('', users[0]);
  }
  const then = email ? ', then open the link' : '';
  lines.push(
    '',
    (await serverNeedsRestart(config.port))
      ? `The server that is running now was started before this setup. Stop it (Ctrl+C) and start it again with "npm run local"${then}.`
      : `Start the app with "npm run local" if it is not running${then}.`,
  );
  return lines;
}

async function main(): Promise<string[]> {
  const [command, ...rest] = process.argv.slice(2);
  const flags = new Set(rest.filter((a) => a.startsWith('--')));
  const [email] = rest.filter((a) => !a.startsWith('--'));
  if (!command || command === 'help' || flags.has('--help')) return [USAGE];
  if (command === 'setup') return setup(email);

  const needsEmail = command === 'invite' || command === 'reset' || command === 'sign-out';
  if (!['invite', 'reset', 'users', 'sign-out'].includes(command) || (needsEmail && !email)) throw new Failure(USAGE);
  const config = readAccountsConfig(env);
  if (!config) throw new Failure('Accounts are not set up on this server yet. Run: npm run admin -- setup <your email>');
  const cmd = (command === 'users' ? { command } : command === 'invite' ? { command, email, admin: flags.has('--admin') } : { command, email }) as AdminCommand;
  const lines = await run(config, cmd);
  if ((command === 'invite' || command === 'reset') && (await serverNeedsRestart(config.port))) {
    lines.push('', 'The server that is running now was started before accounts were set up. Restart it before using the link.');
  }
  return lines;
}

try {
  console.log((await main()).join('\n'));
} catch (e) {
  // A Failure or a settings problem is a message for the person at the keyboard. Anything else is a bug: show it all.
  if (e instanceof Failure || (e as Error).name === 'ConfigError') console.error((e as Error).message);
  else console.error(e);
  process.exitCode = 1;
}
