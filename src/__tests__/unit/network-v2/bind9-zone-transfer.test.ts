import { describe, it, expect, beforeEach } from 'vitest';
import { IPAddress, SubnetMask, resetCounters } from '@/network/core/types';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { RRType, DnsClass } from '@/network/dns/wire/RRType';
import { DnsOpcode, DnsRcode } from '@/network/dns/wire/DnsHeaderFlags';
import { queryDnsOverUdp } from '@/network/dns/transport/DnsUdpTransport';
import { queryDnsOverTcp } from '@/network/dns/transport/DnsTcpTransport';
import type { DnsMessage } from '@/network/dns/wire/DnsMessage';
import type { ARecordData } from '@/network/dns/wire/ResourceRecord';
import type { VirtualFileSystem } from '@/network/devices/linux/VirtualFileSystem';

const PRIMARY_IP = '10.0.1.10';
const SECONDARY_IP = '10.0.1.20';
const PC1_IP = '10.0.1.2';

function zoneDb(serial: number, wwwAddress: string): string {
  return [
    '$ORIGIN example.com.',
    '$TTL 3600',
    `@   IN SOA ns1.example.com. admin.example.com. ( ${serial} 3600 900 604800 300 )`,
    '    IN NS  ns1.example.com.',
    '    IN NS  ns2.example.com.',
    'ns1 IN A   10.0.1.10',
    'ns2 IN A   10.0.1.20',
    `www IN A   ${wwwAddress}`,
    '',
  ].join('\n');
}

function vfsOf(server: LinuxServer): VirtualFileSystem {
  return (server as unknown as { executor: { vfs: VirtualFileSystem } }).executor.vfs;
}

function writeRoot(server: LinuxServer, path: string, content: string): void {
  vfsOf(server).writeFile(path, content, 0, 0, 0o022);
}

interface Lab {
  pc1: LinuxPC;
  primary: LinuxServer;
  secondary: LinuxServer;
}

function buildLab(options: { alsoNotify?: boolean } = {}): Lab {
  const sw = new GenericSwitch('switch-generic', 'sw1', 8, 0, 0);
  const primary = new LinuxServer('NS1');
  const secondary = new LinuxServer('NS2');
  const pc1 = new LinuxPC('linux-pc', 'PC1');

  const mask = new SubnetMask('255.255.255.0');
  [primary, secondary, pc1].forEach((device, i) => {
    new Cable(`c${i}`).connect(device.getPorts()[0], sw.getPorts()[i]);
  });
  primary.getPorts()[0].configureIP(new IPAddress(PRIMARY_IP), mask);
  secondary.getPorts()[0].configureIP(new IPAddress(SECONDARY_IP), mask);
  pc1.getPorts()[0].configureIP(new IPAddress(PC1_IP), mask);

  const notify = options.alsoNotify === false ? '' : `  also-notify { ${SECONDARY_IP}; };\n`;
  writeRoot(primary, '/etc/bind/named.conf', [
    'options { recursion no; };',
    'zone "example.com" {',
    '  type primary;',
    '  file "/etc/bind/db.example.com";',
    notify + `  allow-transfer { ${SECONDARY_IP}; };`,
    '};',
    '',
  ].join('\n'));
  writeRoot(primary, '/etc/bind/db.example.com', zoneDb(2024010101, '10.0.1.80'));

  writeRoot(secondary, '/etc/bind/named.conf', [
    'options { recursion no; };',
    'zone "example.com" {',
    '  type secondary;',
    `  primaries { ${PRIMARY_IP}; };`,
    '  file "db.example.com";',
    '};',
    '',
  ].join('\n'));

  return { pc1, primary, secondary };
}

let nextId = 1;

function makeQuery(qname: string, qtype: number = RRType.A): DnsMessage {
  return {
    id: nextId++,
    flags: {
      qr: false, opcode: DnsOpcode.QUERY, aa: false, tc: false,
      rd: false, ra: false, ad: false, cd: false, rcode: DnsRcode.NOERROR,
    },
    questions: [{ qname, qtype, qclass: DnsClass.IN }],
    answers: [],
    authorities: [],
    additionals: [],
  };
}

function askSecondary(from: LinuxPC, qname: string): Promise<DnsMessage | null> {
  return queryDnsOverUdp(from, new IPAddress(SECONDARY_IP), makeQuery(qname), 53, 400);
}

async function waitForAnswer(
  from: LinuxPC,
  qname: string,
  expectedAddress: string,
  timeoutMs = 6000,
): Promise<DnsMessage> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const response = await askSecondary(from, qname);
    const address = response?.answers[0]?.data as ARecordData | undefined;
    if (response && address && String(address.address) === expectedAddress) return response;
    if (Date.now() > deadline) {
      throw new Error(`no answer ${expectedAddress} for ${qname} within ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.clear();
});

describe('named — secondary zones (config-driven AXFR)', () => {
  it('transfers the zone at startup and serves it authoritatively', async () => {
    const { pc1, primary, secondary } = buildLab();
    await primary.executeCommand('systemctl start named');
    await secondary.executeCommand('systemctl start named');

    const response = await waitForAnswer(pc1, 'www.example.com', '10.0.1.80');

    expect(response.flags.aa).toBe(true);
    expect(response.flags.rcode).toBe(DnsRcode.NOERROR);
  }, 25000);

  it('answers SERVFAIL before the first transfer completes', async () => {
    const { pc1, secondary } = buildLab();
    await secondary.executeCommand('systemctl start named');

    const response = await askSecondary(pc1, 'www.example.com');

    expect(response).not.toBeNull();
    expect(response!.flags.rcode).toBe(DnsRcode.SERVFAIL);
  }, 25000);

  it('propagates a zone edit to the secondary via NOTIFY after rndc reload', async () => {
    const { pc1, primary, secondary } = buildLab();
    await primary.executeCommand('systemctl start named');
    await secondary.executeCommand('systemctl start named');
    await waitForAnswer(pc1, 'www.example.com', '10.0.1.80');

    writeRoot(primary, '/etc/bind/db.example.com', zoneDb(2024010102, '10.0.1.90'));
    const out = await primary.executeCommand('rndc reload example.com');
    expect(out).toContain('zone reload successful');

    await waitForAnswer(pc1, 'www.example.com', '10.0.1.90');
  }, 25000);

  it('rndc retransfer forces a pull without any NOTIFY', async () => {
    const { pc1, primary, secondary } = buildLab({ alsoNotify: false });
    await primary.executeCommand('systemctl start named');
    await secondary.executeCommand('systemctl start named');
    await waitForAnswer(pc1, 'www.example.com', '10.0.1.80');

    writeRoot(primary, '/etc/bind/db.example.com', zoneDb(2024010103, '10.0.1.91'));
    await primary.executeCommand('rndc reload example.com');
    await secondary.executeCommand('rndc retransfer example.com');

    await waitForAnswer(pc1, 'www.example.com', '10.0.1.91');
  }, 25000);

  it('refuses AXFR over TCP from a host outside allow-transfer', async () => {
    const { pc1, primary } = buildLab();
    await primary.executeCommand('systemctl start named');

    const response = await queryDnsOverTcp(
      pc1, new IPAddress(PRIMARY_IP), makeQuery('example.com', RRType.AXFR), 53, 1000,
    );

    expect(response).not.toBeNull();
    expect(response!.flags.rcode).toBe(DnsRcode.REFUSED);
    expect(response!.answers).toHaveLength(0);
  }, 25000);

  it('serves a full AXFR over TCP to a host allowed by allow-transfer', async () => {
    const { pc1, primary } = buildLab();
    writeRoot(primary, '/etc/bind/named.conf', [
      'options { recursion no; };',
      'zone "example.com" {',
      '  type primary;',
      '  file "/etc/bind/db.example.com";',
      `  allow-transfer { ${PC1_IP}; };`,
      '};',
      '',
    ].join('\n'));
    await primary.executeCommand('systemctl start named');

    const response = await queryDnsOverTcp(
      pc1, new IPAddress(PRIMARY_IP), makeQuery('example.com', RRType.AXFR), 53, 1000,
    );

    expect(response).not.toBeNull();
    expect(response!.answers.length).toBeGreaterThan(2);
    expect(response!.answers[0].data.type).toBe(RRType.SOA);
    expect(response!.answers[response!.answers.length - 1].data.type).toBe(RRType.SOA);
  }, 25000);
});
