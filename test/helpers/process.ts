/**
 * For the few tests that run the server's own commands as separate processes, the way a person does
 * (test/integration/admin-cli.test.ts and server-start.test.ts).
 *
 * A process started here reads server/.env like any other run of that command. A setting the test passes always
 * wins over the file, so every setting that matters to the test is passed, and none is left to the file. Most
 * important: AUTH_PEPPER is always given. Without one, `npm run admin -- setup` would write a new secret into
 * server/.env, which a test must never do.
 */
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
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
