/**
 * PRD-Nslookup-Dig-Rndc-Runas.md §1.3 gap #5/#3 / §2.1.3 / P3 — `dig` gained
 * three real `dig(1)` behaviors it previously lacked:
 *   - `-p <port>`: query a non-standard port instead of always 53.
 *   - CH-class built-in identification names (`version.bind`/`hostname.bind`,
 *     RFC 4892 §2.1) — previously any query was forced into IN class.
 *   - `+tries=N` — previously parsed then silently discarded; a single dead
 *     query now genuinely retries N times before giving up.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { IPAddress, SubnetMask, resetCounters } from '@/network/core/types';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { Cable } from '@/network/hardware/Cable';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import type { VirtualFileSystem } from '@/network/devices/linux/VirtualFileSystem';

const NS1_IP = '10.0.1.10';

const ZONE_DB = [
  '$ORIGIN example.com.',
  '$TTL 3600',
  '@     IN SOA ns1.example.com. admin.example.com. ( 2024010101 3600 900 604800 300 )',
  '      IN NS  ns1.example.com.',
  'ns1   IN A   10.0.1.10',
  'www   IN A   10.0.1.80',
  '',
].join('\n');

function namedConf(extraOptions = ''): string {
  return [
    'options {',
    '  directory "/var/cache/bind";',
    '  recursion no;',
    extraOptions,
    '};',
    'zone "example.com" {',
    '  type primary;',
    '  file "/etc/bind/db.example.com";',
    '};',
    '',
  ].join('\n');
}

function vfsOf(server: LinuxServer): VirtualFileSystem {
  return (server as unknown as { executor: { vfs: VirtualFileSystem } }).executor.vfs;
}

function writeRoot(server: LinuxServer, path: string, content: string): void {
  vfsOf(server).writeFile(path, content, 0, 0, 0o022);
}

async function buildLab(extraOptions = '') {
  const pc = new LinuxPC('linux-pc', 'PC1');
  const srv = new LinuxServer('NS1');

  pc.configureInterface('eth0', new IPAddress('10.0.1.2'), new SubnetMask('255.255.255.0'));
  srv.configureInterface('eth0', new IPAddress(NS1_IP), new SubnetMask('255.255.255.0'));
  new Cable('c1').connect(pc.getPort('eth0')!, srv.getPort('eth0')!);

  writeRoot(srv, '/etc/bind/named.conf', namedConf(extraOptions));
  writeRoot(srv, '/etc/bind/db.example.com', ZONE_DB);
  await srv.executeCommand('systemctl start named');

  return { pc, srv };
}

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.clear();
});

describe('dig -p <port> (PRD-Nslookup-Dig-Rndc-Runas.md P3)', () => {
  it('queries the named port when the server is configured on a non-standard port', async () => {
    const { pc } = await buildLab('  listen-on port 5300 { any; };');

    const out = await pc.executeCommand(`dig -p 5300 @${NS1_IP} www.example.com`);

    expect(out).toContain('status: NOERROR');
    expect(out).toContain('10.0.1.80');
    expect(out).toContain(`SERVER: ${NS1_IP}#5300`);
  });

  it('times out against the default port 53 when the server only listens on 5300', async () => {
    const { pc } = await buildLab('  listen-on port 5300 { any; };');

    const out = await pc.executeCommand(`dig @${NS1_IP} www.example.com +tries=1`);

    expect(out).toContain('connection timed out; no servers could be reached');
  }, 8000);
});

describe('dig CH-class built-in names (RFC 4892 §2.1, PRD P3)', () => {
  it('dig -c CH version.bind TXT returns the simulated version identifier', async () => {
    const { pc } = await buildLab();

    const out = await pc.executeCommand(`dig @${NS1_IP} -c CH version.bind TXT`);

    expect(out).toContain('status: NOERROR');
    expect(out).toMatch(/version\.bind\.\s+0\s+CH\s+TXT\s+"bind-simulator"/);
  });

  it('bare "chaos" keyword form also selects the CH class', async () => {
    const { pc } = await buildLab();

    const out = await pc.executeCommand(`dig @${NS1_IP} hostname.bind TXT chaos`);

    expect(out).toContain('status: NOERROR');
    expect(out).toContain('"Server"');
  });

  it('CH-class queries for ordinary names outside the built-in set never trigger the chaos identification answer', async () => {
    const { pc } = await buildLab();

    const out = await pc.executeCommand(`dig @${NS1_IP} -c CH www.example.com TXT`);

    expect(out).not.toContain('bind-simulator');
  });
});

describe('dig +tries= is honored (PRD P3)', () => {
  it('retries the configured number of times before giving up', async () => {
    const { pc, srv } = await buildLab();
    const net = (pc as unknown as { net: { queryDns: (...a: unknown[]) => Promise<unknown> } }).net;
    const spy = vi.spyOn(net, 'queryDns');
    await srv.executeCommand('systemctl stop named');

    const out = await pc.executeCommand(`dig @${NS1_IP} www.example.com +tries=2 +time=1`);

    expect(out).toContain('connection timed out; no servers could be reached');
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('defaults to 3 tries when +tries= is not given', async () => {
    const { pc, srv } = await buildLab();
    const net = (pc as unknown as { net: { queryDns: (...a: unknown[]) => Promise<unknown> } }).net;
    const spy = vi.spyOn(net, 'queryDns');
    await srv.executeCommand('systemctl stop named');

    await pc.executeCommand(`dig @${NS1_IP} www.example.com +time=1`);

    expect(spy).toHaveBeenCalledTimes(3);
  }, 15000);

  it('stops retrying as soon as a response is received', async () => {
    const { pc } = await buildLab();
    const net = (pc as unknown as { net: { queryDns: (...a: unknown[]) => Promise<unknown> } }).net;
    const spy = vi.spyOn(net, 'queryDns');

    const out = await pc.executeCommand(`dig @${NS1_IP} www.example.com +tries=5`);

    expect(out).toContain('10.0.1.80');
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
