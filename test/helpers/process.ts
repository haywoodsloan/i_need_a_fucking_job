/**
 * For the few tests that run the server's own commands as separate processes, the way a person does
 * (test/integration/admin-cli.test.ts and server-start.test.ts).
 *
 * A process started here reads server/.env like any other run of that command. A setting the test passes always
 * wins over the file, so every setting that matters to the test is passed, and none is left to the file. Most
 * important: AUTH_PEPPER is always given. Without one, `npm run admin -- setup` would write a new secret into
 * server/.env, which a test must never do.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer, request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { networkInterfaces } from 'node:os';
import { fileURLToPath } from 'node:url';

export const SERVER_DIR = fileURLToPath(new URL('../../server/', import.meta.url));

/** How to start one of the server's TypeScript files with this same Node: `spawn(process.execPath, [...TSX, 'src/admin.ts'])`. */
export const TSX = ['--import', 'tsx'];

/** A password secret for one test run, in the form the server expects. */
export const newPepper = () => `1:${randomBytes(32).toString('base64')}`;

/** A port nothing is listening on, so a test never talks to a server that happens to run on this machine. */
export async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const found = (probe.address() as AddressInfo).port;
  await new Promise((resolve) => probe.close(resolve));
  return found;
}

export interface ServerProcess {
  port: number;
  /** The address the tests reach it at. */
  origin: string;
  child: ChildProcess;
  /** Everything it has printed so far, with Unix line ends. */
  printed(): string;
  /** Its exit code, once it has ended. */
  ended: Promise<number | null>;
  /** Ends it on the spot, the way a closed window or a power cut does, and waits until it is gone. */
  kill(): Promise<number | null>;
}

/**
 * Starts the server the way `npm start` does, as its own process, and waits until it is up.
 *
 * Whatever this machine's server/.env switches on stays off: every setting that could change what a test sees is
 * given here, and `settings` are laid over them. In particular the server answers this machine only and keeps no
 * applications unless a test gives it a folder of its own for them (APPLICATIONS=1 with APPLICATIONS_DIR), so no
 * test can touch the applications in server/.data.
 */
export async function startServerProcess(port: number, settings: Record<string, string>): Promise<ServerProcess> {
  let printed = '';
  const child = spawn(process.execPath, [...TSX, 'src/index.ts'], {
    cwd: SERVER_DIR,
    env: {
      ...process.env,
      PORT: String(port),
      SERVE_APP: '0',
      ENABLE_BROWSER_TIER: '',
      FETCH_TIERS_MODULE: '',
      HOST: 'localhost',
      NODE_ENV: 'test',
      TRUST_PROXY: '0',
      APPLICATIONS: '0',
      ...settings,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const ended = new Promise<number | null>((resolve) => child.on('close', resolve));
  await new Promise<void>((resolve, reject) => {
    const failed = (why: string) => reject(new Error(`${why} It printed:\n${printed || '(nothing)'}`));
    const timer = setTimeout(() => failed('The server did not start within a minute.'), 60_000);
    const heard = (chunk: Buffer) => {
      printed += chunk.toString('utf8').replace(/\r\n/g, '\n');
      // The last thing it always prints when it is up: whether accounts are on.
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
  return {
    port,
    origin: `http://127.0.0.1:${port}`,
    child,
    printed: () => printed,
    ended,
    kill: () => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      return ended;
    },
  };
}

/** An address of this machine that other machines use for it, when it has one. */
export const outsideAddress = (): string | undefined =>
  Object.values(networkInterfaces())
    .flat()
    .find((address) => address && !address.internal && address.family === 'IPv4')?.address;

/**
 * The status a server answers with at an address of this machine, or undefined when nothing answers there. It asks
 * with node:http and not with fetch: the tests' fetch only lets through the names of this machine
 * (test/setup/network.ts), and the address asked here can be the one other machines use for it.
 */
export function statusAt(host: string, port: number, path: string): Promise<number | undefined> {
  return new Promise((done) => {
    const req = request({ host, port, path, timeout: 3000 }, (res) => {
      res.resume();
      res.on('end', () => done(res.statusCode));
    });
    req.on('timeout', () => req.destroy(new Error('no answer')));
    req.on('error', () => done(undefined));
    req.end();
  });
}
