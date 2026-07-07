import { describe, it, expect, beforeEach } from 'vitest';
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

function namedConf(): string {
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

async function buildDnsLab(): Promise<{ pc: LinuxPC; srv: LinuxServer }> {
  const pc = new LinuxPC('linux-pc', 'PC1');
  const srv = new LinuxServer('linux-server', 'NS1');
  pc.configureInterface('eth0', new IPAddress('10.0.1.2'), new SubnetMask('255.255.255.0'));
  srv.configureInterface('eth0', new IPAddress(NS1_IP), new SubnetMask('255.255.255.0'));
  new Cable('c1').connect(pc.getPort('eth0')!, srv.getPort('eth0')!);
  writeRoot(srv, '/etc/bind/named.conf', namedConf());
  writeRoot(srv, '/etc/bind/db.example.com', ZONE_DB);
  await srv.executeCommand('systemctl start named');
  return { pc, srv };
}

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.clear();
});

describe('tcpdump IP fragmentation flags + minimal DNS summary (PRD-tcpdump.md P7)', () => {
  it('a real DNS query/response pair prints a real one-line summary, not a bare UDP line', async () => {
    const { pc } = await buildDnsLab();
    const pending = pc.executeCommand('tcpdump -c 2 -nn udp port 53');
    await new Promise((resolve) => setTimeout(resolve, 30));
    await pc.executeCommand(`dig @${NS1_IP} www.example.com`);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const output = await pending;

    expect(output).toMatch(/1\+ A\? www\.example\.com \(\d+\)/);
    expect(output).toMatch(/1 1\/0\/0 A 10\.0\.1\.80 \(\d+\)/);
    expect(output).not.toContain('UDP, length');
  }, 20000);

  it('-v shows the real Don\'t Fragment flag instead of a hardcoded flags [none]', async () => {
    const { pc } = await buildDnsLab();
    const pending = pc.executeCommand('tcpdump -c 1 -nn -v udp port 53');
    await new Promise((resolve) => setTimeout(resolve, 30));
    await pc.executeCommand(`dig @${NS1_IP} www.example.com`);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const output = await pending;

    expect(output).toContain('flags [DF]');
    expect(output).not.toContain('flags [none]');
  }, 20000);
});
