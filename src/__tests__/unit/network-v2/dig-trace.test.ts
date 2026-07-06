/**
 * PRD-Nslookup-Dig-Rndc-Runas.md §1.3 gap #4 / §2.1.4 / P4 — `dig +trace`
 * previously didn't exist at all. This walks a real two-hop delegation
 * chain (root -> example.com's authoritative server) the same way real
 * `dig +trace` does: a non-recursive query at each hop, following NS
 * referrals down until an authoritative answer is reached.
 *
 * Topology: PC1 -- ROOT (10.0.2.1, authoritative for ".") -- NS1 (10.0.1.10,
 * authoritative for "example.com", delegated to by ROOT's root zone).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { IPAddress, SubnetMask, resetCounters } from '@/network/core/types';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { Cable } from '@/network/hardware/Cable';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import type { VirtualFileSystem } from '@/network/devices/linux/VirtualFileSystem';

const ROOT_IP = '10.0.2.1';
const NS1_IP = '10.0.1.10';

const ROOT_ZONE_DB = [
  '$ORIGIN .',
  '$TTL 3600',
  '@             IN SOA root. admin.root. ( 2024010101 3600 900 604800 300 )',
  '@             IN NS  root.',
  'root.         IN A   10.0.2.1',
  'example.com.  IN NS  ns1.example.com.',
  'ns1.example.com. IN A 10.0.1.10',
  '',
].join('\n');

const EXAMPLE_ZONE_DB = [
  '$ORIGIN example.com.',
  '$TTL 3600',
  '@     IN SOA ns1.example.com. admin.example.com. ( 2024010101 3600 900 604800 300 )',
  '      IN NS  ns1.example.com.',
  'ns1   IN A   10.0.1.10',
  'www   IN A   10.0.1.80',
  '',
].join('\n');

function rootNamedConf(): string {
  return [
    'options {',
    '  directory "/var/cache/bind";',
    '  recursion no;',
    '};',
    'zone "." {',
    '  type primary;',
    '  file "/etc/bind/db.root";',
    '};',
    '',
  ].join('\n');
}

function exampleNamedConf(): string {
  return [
    'options {',
    '  directory "/var/cache/bind";',
    '  recursion no;',
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

async function buildLab() {
  const pc = new LinuxPC('linux-pc', 'PC1');
  const root = new LinuxServer('ROOT');
  const ns1 = new LinuxServer('NS1');
  const sw = new GenericSwitch('switch-generic', 'SW');

  pc.configureInterface('eth0', new IPAddress('10.0.1.2'), new SubnetMask('255.255.0.0'));
  root.configureInterface('eth0', new IPAddress(ROOT_IP), new SubnetMask('255.255.0.0'));
  ns1.configureInterface('eth0', new IPAddress(NS1_IP), new SubnetMask('255.255.0.0'));

  new Cable('c1').connect(pc.getPort('eth0')!, sw.getPorts()[0]);
  new Cable('c2').connect(root.getPort('eth0')!, sw.getPorts()[1]);
  new Cable('c3').connect(ns1.getPort('eth0')!, sw.getPorts()[2]);

  writeRoot(root, '/etc/bind/named.conf', rootNamedConf());
  writeRoot(root, '/etc/bind/db.root', ROOT_ZONE_DB);
  await root.executeCommand('systemctl start named');

  writeRoot(ns1, '/etc/bind/named.conf', exampleNamedConf());
  writeRoot(ns1, '/etc/bind/db.example.com', EXAMPLE_ZONE_DB);
  await ns1.executeCommand('systemctl start named');

  return { pc, root, ns1 };
}

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.clear();
});

describe('dig +trace (PRD-Nslookup-Dig-Rndc-Runas.md P4)', () => {
  it('walks root -> example.com delegation -> final answer, printing each hop', async () => {
    const { pc } = await buildLab();

    const out = await pc.executeCommand(`dig @${ROOT_IP} www.example.com +trace`);

    // Hop 1: the root NS set.
    expect(out).toMatch(/\.\s+3600\s+IN\s+NS\s+root\./);
    // Hop 2: the delegation to ns1.example.com, with glue.
    expect(out).toMatch(/example\.com\.\s+3600\s+IN\s+NS\s+ns1\.example\.com\./);
    expect(out).toMatch(/ns1\.example\.com\.\s+3600\s+IN\s+A\s+10\.0\.1\.10/);
    // Hop 3: the final authoritative answer from ns1.
    expect(out).toMatch(/www\.example\.com\.\s+3600\s+IN\s+A\s+10\.0\.1\.80/);
    // Each hop reports which server answered it.
    expect(out).toContain(`Received`);
    expect(out).toContain(`from ${ROOT_IP}#53(${ROOT_IP})`);
    expect(out).toContain(`from ${NS1_IP}#53(${NS1_IP})`);
  });

  it('+trace disables recursion desired regardless of other flags', async () => {
    const { pc } = await buildLab();

    const out = await pc.executeCommand(`dig @${ROOT_IP} www.example.com +recurse +trace`);

    expect(out).toContain('10.0.1.80');
  });

  it('reports a timeout if the starting server is unreachable', async () => {
    const { pc } = await buildLab();

    const out = await pc.executeCommand('dig @10.0.9.9 www.example.com +trace +tries=1 +time=1');

    expect(out).toContain(';; connection timed out; no servers could be reached');
  }, 8000);
});
