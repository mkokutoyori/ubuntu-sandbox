/**
 * PRD-Nslookup-Dig-Rndc-Runas.md §2.1.4/P9 — the `rndc` CLI's real-protocol
 * path: `-s`/`-p`/`-k`/`-c`/`-y` flag parsing, key discovery from a
 * `/etc/rndc.key`-style file, and a genuinely HMAC-authenticated round trip
 * — locally (127.0.0.1, via Bind9Service.dispatchRndcLocally since this
 * simulator's TcpStack has no loopback delivery) or remotely (`-s <ip>` to
 * another host on the same segment, over the real RndcClient/RndcServer TCP
 * wire). The pre-existing keyless/flagless invocation (bind9-rndc.test.ts)
 * is untouched — this only covers the new, opt-in behavior.
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

const NS1_IP = '10.0.6.10';
const PC1_IP = '10.0.6.2';
const RNDC_KEY_FILE = [
  'key "rndc-key" { algorithm hmac-sha256; secret "c2VjcmV0"; };',
  '',
].join('\n');

const ZONE_DB = [
  '$ORIGIN example.com.',
  '$TTL 3600',
  '@   IN SOA ns1.example.com. admin.example.com. ( 2024010101 3600 900 604800 300 )',
  '    IN NS  ns1.example.com.',
  'ns1 IN A   10.0.6.10',
  '',
].join('\n');

function namedConf(): string {
  return [
    'key "rndc-key" { algorithm hmac-sha256; secret "c2VjcmV0"; };',
    'controls {',
    `  inet 127.0.0.1 port 953 allow { 127.0.0.1; } keys { "rndc-key"; };`,
    `  inet ${NS1_IP} port 953 allow { ${PC1_IP}; } keys { "rndc-key"; };`,
    '};',
    'options { directory "/var/cache/bind"; recursion no; };',
    'zone "example.com" { type primary; file "/etc/bind/db.example.com"; };',
    '',
  ].join('\n');
}

function vfsOf(device: LinuxServer | LinuxPC): VirtualFileSystem {
  return (device as unknown as { executor: { vfs: VirtualFileSystem } }).executor.vfs;
}

function writeRoot(device: LinuxServer | LinuxPC, path: string, content: string): void {
  vfsOf(device).writeFile(path, content, 0, 0, 0o022);
}

async function buildLab() {
  const pc = new LinuxPC('linux-pc', 'PC1');
  const outsider = new LinuxPC('linux-pc', 'OUTSIDER');
  const srv = new LinuxServer('NS1');
  const sw = new GenericSwitch('switch-generic', 'SW');

  pc.configureInterface('eth0', new IPAddress(PC1_IP), new SubnetMask('255.255.255.0'));
  outsider.configureInterface('eth0', new IPAddress('10.0.6.99'), new SubnetMask('255.255.255.0'));
  srv.configureInterface('eth0', new IPAddress(NS1_IP), new SubnetMask('255.255.255.0'));
  new Cable('c1').connect(pc.getPort('eth0')!, sw.getPorts()[0]);
  new Cable('c2').connect(srv.getPort('eth0')!, sw.getPorts()[1]);
  new Cable('c3').connect(outsider.getPort('eth0')!, sw.getPorts()[2]);

  writeRoot(srv, '/etc/bind/named.conf', namedConf());
  writeRoot(srv, '/etc/bind/db.example.com', ZONE_DB);
  writeRoot(srv, '/etc/rndc.key', RNDC_KEY_FILE);
  writeRoot(pc, '/etc/rndc.key', RNDC_KEY_FILE);
  writeRoot(outsider, '/etc/rndc.key', RNDC_KEY_FILE);
  await srv.executeCommand('systemctl start named');

  return { pc, srv, outsider };
}

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.clear();
});

describe('rndc real protocol — local (127.0.0.1) via -k (PRD P9)', () => {
  it('a correctly keyed local command succeeds through the real HMAC-checked loopback path', async () => {
    const { srv } = await buildLab();

    const out = await srv.executeCommand('rndc -k /etc/rndc.key status');

    expect(out).toContain('server is up and running');
  });

  it('a wrong key locally is rejected: not authenticated', async () => {
    const { srv } = await buildLab();
    writeRoot(srv, '/etc/wrong.key', 'key "rndc-key" { algorithm hmac-sha256; secret "d3Jvbmc="; };\n');

    const out = await srv.executeCommand('rndc -k /etc/wrong.key status');

    expect(out).toBe('not authenticated');
  });

  it('reports the real error when neither rndc.conf nor rndc.key exists and no -k/-c is given but -s is', async () => {
    const pc = new LinuxPC('linux-pc', 'PC1');
    const srv = new LinuxServer('NS1');
    pc.configureInterface('eth0', new IPAddress(PC1_IP), new SubnetMask('255.255.255.0'));
    srv.configureInterface('eth0', new IPAddress(NS1_IP), new SubnetMask('255.255.255.0'));
    new Cable('c1').connect(pc.getPort('eth0')!, srv.getPort('eth0')!);
    writeRoot(srv, '/etc/bind/named.conf', namedConf());
    writeRoot(srv, '/etc/bind/db.example.com', ZONE_DB);
    await srv.executeCommand('systemctl start named');

    const out = await srv.executeCommand(`rndc -s ${NS1_IP} status`);

    expect(out).toBe('rndc: neither /etc/rndc.conf nor /etc/rndc.key was found');
  });

  it('reports a specific error when an explicit -k path does not exist', async () => {
    const { srv } = await buildLab();

    const out = await srv.executeCommand('rndc -k /etc/nope.key status');

    expect(out).toContain("couldn't open file '/etc/nope.key'");
  });

  it('-y selects a specific key by name among several in the same file', async () => {
    const { srv } = await buildLab();
    writeRoot(srv, '/etc/rndc.key', [
      'key "rndc-key" { algorithm hmac-sha256; secret "c2VjcmV0"; };',
      'key "other-key" { algorithm hmac-md5; secret "b3RoZXI="; };',
      '',
    ].join('\n'));

    const out = await srv.executeCommand('rndc -k /etc/rndc.key -y rndc-key status');

    expect(out).toContain('server is up and running');
  });

  it("reports 'no key definition' for an unknown -y name", async () => {
    const { srv } = await buildLab();

    const out = await srv.executeCommand('rndc -k /etc/rndc.key -y nope status');

    expect(out).toBe("rndc: no key definition for 'nope'");
  });
});

describe('rndc real protocol — remote (-s <ip>) over real TCP (PRD P9)', () => {
  it('a correctly keyed remote command from another host succeeds over real TCP', async () => {
    const { pc } = await buildLab();

    const out = await pc.executeCommand(`rndc -s ${NS1_IP} -k /etc/rndc.key status`);

    expect(out).toContain('server is up and running');
  });

  it('a wrong key over the real remote TCP channel is rejected', async () => {
    const { pc } = await buildLab();
    writeRoot(pc, '/etc/wrong.key', 'key "rndc-key" { algorithm hmac-sha256; secret "d3Jvbmc="; };\n');

    const out = await pc.executeCommand(`rndc -s ${NS1_IP} -k /etc/wrong.key status`);

    expect(out).toBe('not authenticated');
  });

  it('a remote host outside the allow{} ACL for that inet clause is refused', async () => {
    const { outsider } = await buildLab();

    const out = await outsider.executeCommand(`rndc -s ${NS1_IP} -k /etc/rndc.key status`);

    expect(out).toContain('rndc:');
  }, 8000);

  it('executes a real command through the unchanged RndcChannel over the remote channel (reload)', async () => {
    const { pc } = await buildLab();

    const out = await pc.executeCommand(`rndc -s ${NS1_IP} -k /etc/rndc.key reload`);

    expect(out).toContain('server reload successful');
  });
});
