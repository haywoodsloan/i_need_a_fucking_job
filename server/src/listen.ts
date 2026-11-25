/**
 * Which network connections the server answers on.
 *
 * Left alone, it answers this computer only: http://localhost:8787 works here and nowhere else. A program on
 * another computer of the same network cannot reach the server at all, so it cannot run searches that spend the
 * owner's search plan, and cannot get near the applications kept here
 * (docs/decisions/0022-the-server-answers-its-own-computer-unless-told-otherwise.md).
 *
 * A hosted copy has to answer other computers. It says so with HOST=0.0.0.0, which server/Dockerfile sets.
 *
 * "This computer only" means both of its own addresses, 127.0.0.1 and ::1, because the name "localhost" can mean
 * either one, and programs differ in which they try.
 */
import { createServer, type RequestListener, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

type Env = Record<string, string | undefined>;

export interface ListenPlan {
  /** The addresses to listen on. None means every network connection, the way Node listens when given no address. */
  hosts: string[];
  /** Only this computer can reach the server. */
  local: boolean;
}

const OWN = ['127.0.0.1', '::1'];

/** What HOST asks for. */
export function listenPlan(env: Env): ListenPlan {
  const host = (env.HOST ?? '').trim().toLowerCase().replace(/^\[(.*)\]$/, '$1');
  if (!host || host === 'localhost') return { hosts: OWN, local: true };
  if (OWN.includes(host)) return { hosts: [host], local: true };
  if (host === '0.0.0.0' || host === '::' || host === '*') return { hosts: [], local: false };
  return { hosts: [host], local: false };
}

/** The plan in a few words, for the server's log. */
export function describePlan(plan: ListenPlan): string {
  if (plan.local) return 'this computer only (set HOST=0.0.0.0 to answer other computers too)';
  return plan.hosts.length ? `${plan.hosts.join(' and ')}, which other computers can reach` : 'every network connection, so other computers can reach it';
}

export interface Listening {
  servers: Server[];
  port: number;
  close(): Promise<void>;
}

const closeServer = (server: Server) =>
  new Promise<void>((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  });

/** Starts answering. With port 0 the system picks a free port, and every address gets that same one. */
export async function listen(handler: RequestListener, plan: ListenPlan, port: number): Promise<Listening> {
  const servers: Server[] = [];
  const open = (onPort: number, host?: string) =>
    new Promise<Server>((resolve, reject) => {
      const server = createServer(handler);
      server.once('error', reject);
      server.listen({ port: onPort, host, ipv6Only: host === '::1' }, () => {
        server.off('error', reject);
        resolve(server);
      });
    });
  const portOf = (server: Server) => (server.address() as AddressInfo).port;
  try {
    if (!plan.hosts.length) servers.push(await open(port));
    for (const host of plan.hosts) {
      try {
        servers.push(await open(servers.length ? portOf(servers[0]) : port, host));
      } catch (e) {
        // A computer with no IPv6 has no ::1. Its other own address is enough.
        const code = (e as NodeJS.ErrnoException).code;
        if (host === '::1' && servers.length && (code === 'EADDRNOTAVAIL' || code === 'EAFNOSUPPORT')) continue;
        throw e;
      }
    }
  } catch (e) {
    await Promise.all(servers.map(closeServer));
    throw e;
  }
  return { servers, port: portOf(servers[0]), close: async () => void (await Promise.all(servers.map(closeServer))) };
}
