/**
 * PRD-Nslookup-Dig-Rndc-Runas.md §1.3 gap #6 / §2.1.5 / P5 — `dig` gained
 * two real `dig(1)` behaviors it previously lacked entirely:
 *   - `-f <file>`: batch mode, one query per non-empty/non-comment line.
 *   - multiple `name [type]` pairs on a single invocation
 *     (`dig www.example.com MX mail.example.com A` == two lookups).
 */
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
  '      IN MX  10 mail.example.com.',
  'ns1   IN A   10.0.1.10',
  'mail  IN A   10.0.1.25',
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

async function buildLab() {
  const pc = new LinuxPC('linux-pc', 'PC1');
  const srv = new LinuxServer('NS1');

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

describe('dig multi-query (PRD-Nslookup-Dig-Rndc-Runas.md P5)', () => {
  it('resolves two name/type pairs given on one invocation', async () => {
    const { pc } = await buildLab();

    const out = await pc.executeCommand(`dig @${NS1_IP} www.example.com A example.com MX`);

    expect(out).toContain('www.example.com.');
    expect(out).toContain('10.0.1.80');
    expect(out).toContain('mail.example.com.');
    expect(out).toContain('10 mail.example.com.');
    // Two separate dig-style header blocks, one per query.
    expect(out.match(/<<>> DiG <<>>/g)?.length).toBe(2);
  });

  it('+short concatenates each query answer on its own line, not blank-line separated', async () => {
    const { pc } = await buildLab();

    const out = await pc.executeCommand(`dig @${NS1_IP} +short www.example.com A mail.example.com A`);

    expect(out.split('\n').filter((l) => l.length > 0)).toEqual(['10.0.1.80', '10.0.1.25']);
  });

  it('a single query (no extra name args) behaves exactly as before', async () => {
    const { pc } = await buildLab();

    const out = await pc.executeCommand(`dig @${NS1_IP} www.example.com`);

    expect(out).toContain('status: NOERROR');
    expect(out).toContain('10.0.1.80');
    expect(out.match(/<<>> DiG <<>>/g)?.length).toBe(1);
  });
});

describe('dig -f <file> batch mode (PRD-Nslookup-Dig-Rndc-Runas.md P5)', () => {
  it('runs one query per non-empty, non-comment line in the batch file', async () => {
    const { pc } = await buildLab();
    await pc.executeCommand(
      `bash -c 'printf "; a comment\\nwww.example.com A\\n\\nexample.com MX\\n" > /tmp/batch.txt'`,
    );

    const out = await pc.executeCommand(`dig @${NS1_IP} -f /tmp/batch.txt`);

    expect(out).toContain('10.0.1.80');
    expect(out).toContain('10 mail.example.com.');
    expect(out.match(/<<>> DiG <<>>/g)?.length).toBe(2);
  });

  it('reports an error for a missing batch file instead of crashing', async () => {
    const { pc } = await buildLab();

    const out = await pc.executeCommand(`dig @${NS1_IP} -f /tmp/does-not-exist.txt`);

    expect(out).toContain("couldn't open /tmp/does-not-exist.txt");
  });
});
