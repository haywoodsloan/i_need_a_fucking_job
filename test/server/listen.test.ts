/**
 * Which network connections the server answers on (server/src/listen.ts), and whether a server keeps applications
 * at all (server/src/applications/index.ts). The two belong together: the tracker has no sign-in, so it is only on
 * where nobody but the computer's own user can reach the server.
 */
import { createServer, request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { networkInterfaces } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_APPLICATIONS_DIR, readApplicationsConfig } from '../../server/src/applications/index';
import { describePlan, listen, listenPlan, type Listening } from '../../server/src/listen';

const open: Listening[] = [];
const others: Server[] = [];

afterEach(async () => {
  for (const l of open.splice(0)) await l.close();
  for (const s of others.splice(0)) await new Promise((done) => s.close(done));
});

async function start(env: Record<string, string | undefined>, port = 0): Promise<Listening> {
  const listening = await listen((_req, res) => void res.end('here'), listenPlan(env), port);
  open.push(listening);
  return listening;
}

/**
 * Whether the server answers at an address. It asks with node:http and not with fetch, because the tests' fetch
 * only lets through the names of this computer (test/setup/network.ts), and one of the addresses asked here is the
 * one other computers use for this computer.
 */
function answers(host: string, port: number): Promise<boolean> {
  return new Promise((done) => {
    const req = request({ host, port, path: '/', timeout: 3000 }, (res) => {
      let body = '';
      res.on('data', (chunk: Buffer) => (body += chunk.toString('utf8')));
      res.on('end', () => done(body === 'here'));
    });
    req.on('timeout', () => req.destroy(new Error('no answer')));
    req.on('error', () => done(false));
    req.end();
  });
}

/** An address of this computer that other computers use for it, when it has one. */
const outside = Object.values(networkInterfaces())
  .flat()
  .find((address) => address && !address.internal && address.family === 'IPv4')?.address;

describe('what HOST asks for', () => {
  it('is this computer only when nothing is set', () => {
    for (const HOST of [undefined, '', '  ', 'localhost', 'LOCALHOST']) expect(listenPlan({ HOST }), String(HOST)).toEqual({ hosts: ['127.0.0.1', '::1'], local: true });
    expect(listenPlan({ HOST: '127.0.0.1' })).toEqual({ hosts: ['127.0.0.1'], local: true });
    expect(listenPlan({ HOST: '::1' })).toEqual({ hosts: ['::1'], local: true });
    expect(listenPlan({ HOST: '[::1]' })).toEqual({ hosts: ['::1'], local: true });
  });

  it('is every network connection for the address that means all of them', () => {
    for (const HOST of ['0.0.0.0', '::', '[::]', '*']) expect(listenPlan({ HOST }), HOST).toEqual({ hosts: [], local: false });
  });

  it('is one address others can reach when it names one', () => {
    expect(listenPlan({ HOST: '192.168.1.20' })).toEqual({ hosts: ['192.168.1.20'], local: false });
    expect(listenPlan({ HOST: 'my-pc.lan' })).toEqual({ hosts: ['my-pc.lan'], local: false });
    // Only the two addresses that are always this computer count as local.
    expect(listenPlan({ HOST: '127.0.0.2' }).local).toBe(false);
  });

  it('is said in the server’s log', () => {
    expect(describePlan(listenPlan({}))).toBe('this computer only (set HOST=0.0.0.0 to answer other computers too)');
    expect(describePlan(listenPlan({ HOST: '0.0.0.0' }))).toBe('every network connection, so other computers can reach it');
    expect(describePlan(listenPlan({ HOST: '192.168.1.20' }))).toBe('192.168.1.20, which other computers can reach');
  });
});

describe('listening', () => {
  it('answers on this computer’s own addresses, on one port, and on no address other computers use', async () => {
    const { port, servers } = await start({});
    expect(port).toBeGreaterThan(0);
    expect(await answers('127.0.0.1', port)).toBe(true);
    // A computer with no IPv6 has one server, and that is fine. Every other computer has both.
    if (servers.length === 2) expect(await answers('::1', port)).toBe(true);
    expect(servers.map((s) => (s.address() as AddressInfo).port)).toEqual(servers.map(() => port));
    if (outside) expect(await answers(outside, port)).toBe(false);
  });

  it('answers other computers when HOST says so', async () => {
    const { port, servers } = await start({ HOST: '0.0.0.0' });
    expect(servers).toHaveLength(1);
    expect(await answers('127.0.0.1', port)).toBe(true);
    if (outside) expect(await answers(outside, port)).toBe(true);
  });

  it('can be told to use one of this computer’s own addresses alone', async () => {
    const { port, servers } = await start({ HOST: '127.0.0.1' });
    expect(servers).toHaveLength(1);
    expect(await answers('127.0.0.1', port)).toBe(true);
    expect(await answers('::1', port)).toBe(false);
  });

  it('fails, and leaves nothing listening, when the port is taken', async () => {
    const other = createServer();
    others.push(other);
    await new Promise<void>((done) => other.listen(0, '127.0.0.1', done));
    const { port } = other.address() as AddressInfo;
    await expect(listen(() => {}, listenPlan({}), port)).rejects.toMatchObject({ code: 'EADDRINUSE' });
    // The same when only the second of its own addresses is taken: the first is let go again.
    const second = createServer();
    others.push(second);
    const free = await start({ HOST: '127.0.0.1' });
    const taken = free.port;
    await free.close();
    open.length = 0;
    const hasIpv6 = await new Promise<boolean>((done) => {
      second.once('error', () => done(false));
      second.listen({ port: taken, host: '::1', ipv6Only: true }, () => done(true));
    });
    if (hasIpv6) {
      await expect(listen(() => {}, listenPlan({}), taken)).rejects.toMatchObject({ code: 'EADDRINUSE' });
      expect(await answers('127.0.0.1', taken)).toBe(false);
    }
  });

  it('stops answering when closed', async () => {
    const listening = await start({});
    await listening.close();
    open.length = 0;
    expect(await answers('127.0.0.1', listening.port)).toBe(false);
  });
});

describe('whether a server keeps applications', () => {
  it('does, in its own data folder, when it answers this computer only', () => {
    expect(readApplicationsConfig({}, true)).toEqual({ on: true, dir: DEFAULT_APPLICATIONS_DIR });
    expect(DEFAULT_APPLICATIONS_DIR.replace(/\\/g, '/')).toMatch(/\/server\/\.data\/applications$/);
    expect(readApplicationsConfig({ APPLICATIONS: '1', TRUST_PROXY: '0', NODE_ENV: 'development' }, true)).toEqual({ on: true, dir: DEFAULT_APPLICATIONS_DIR });
  });

  it('keeps them in the folder it is given', () => {
    expect(readApplicationsConfig({ APPLICATIONS_DIR: 'somewhere/else' }, true)).toEqual({ on: true, dir: resolve('somewhere/else') });
  });

  it('does not when other computers can reach it, whatever else is set', () => {
    expect(readApplicationsConfig({ APPLICATIONS: '1' }, false)).toEqual({ on: false, why: 'HOST lets other computers reach this server, and applications have no sign-in' });
  });

  it('does not when a proxy passes requests on to it, or when it is marked as a hosted copy', () => {
    expect(readApplicationsConfig({ TRUST_PROXY: '1' }, true)).toEqual({ on: false, why: 'TRUST_PROXY says a proxy passes requests on to this server, and applications have no sign-in' });
    expect(readApplicationsConfig({ NODE_ENV: 'production' }, true)).toEqual({ on: false, why: 'NODE_ENV=production marks this as a hosted copy, and applications have no sign-in' });
  });

  it('does not when it is switched off', () => {
    for (const APPLICATIONS of ['0', 'off', 'OFF', 'false', 'no', ' 0 ']) expect(readApplicationsConfig({ APPLICATIONS }, true), APPLICATIONS).toEqual({ on: false, why: 'APPLICATIONS=0 switches them off' });
  });
});
