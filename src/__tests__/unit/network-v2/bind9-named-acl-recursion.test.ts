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
import type { DnsMessage } from '@/network/dns/wire/DnsMessage';
import type { ARecordData } from '@/network/dns/wire/ResourceRecord';
import type { VirtualFileSystem } from '@/network/devices/linux/VirtualFileSystem';

const NS1_IP = '10.0.1.10';
const NS2_IP = '10.0.1.20';
const PC1_IP = '10.0.1.2';
const PC2_IP = '10.0.1.3';
const QUERY_TIMEOUT_MS = 400;

const COM_ZONE = [
  '$ORIGIN example.com.',
  '$TTL 3600',
  '@   IN SOA ns1.example.com. admin.example.com. ( 2024010101 3600 900 604800 300 )',
  '    IN NS  ns1.example.com.',
  'ns1 IN A   10.0.1.10',
  'www IN A   10.0.1.80',
  '',
].join('\n');

const ORG_ZONE = [
  '$ORIGIN example.org.',
  '$TTL 3600',
  '@   IN SOA ns2.example.org. admin.example.org. ( 2024010101 3600 900 604800 300 )',
  '    IN NS  ns2.example.org.',
  'ns2 IN A   10.0.1.20',
  'www IN A   10.0.9.1',
  '',
].join('\n');

function vfsOf(server: LinuxServer): VirtualFileSystem {
  return (server as unknown as { executor: { vfs: VirtualFileSystem } }).executor.vfs;
}

function writeRoot(server: LinuxServer, path: string, content: string): void {
  vfsOf(server).writeFile(path, content, 0, 0, 0o022);
}

interface Lab {
  pc1: LinuxPC;
  pc2: LinuxPC;
  ns1: LinuxServer;
  ns2: LinuxServer;
}

async function buildLab(ns1Options: string): Promise<Lab> {
  const sw = new GenericSwitch('switch-generic', 'sw1', 8, 0, 0);
  const ns1 = new LinuxServer('NS1');
  const ns2 = new LinuxServer('NS2');
  const pc1 = new LinuxPC('linux-pc', 'PC1');
  const pc2 = new LinuxPC('linux-pc', 'PC2');

  const mask = new SubnetMask('255.255.255.0');
  [ns1, ns2, pc1, pc2].forEach((device, i) => {
    new Cable(`c${i}`).connect(device.getPorts()[0], sw.getPorts()[i]);
  });
  ns1.getPorts()[0].configureIP(new IPAddress(NS1_IP), mask);
  ns2.getPorts()[0].configureIP(new IPAddress(NS2_IP), mask);
  pc1.getPorts()[0].configureIP(new IPAddress(PC1_IP), mask);
  pc2.getPorts()[0].configureIP(new IPAddress(PC2_IP), mask);

  writeRoot(ns1, '/etc/bind/named.conf', [
    'options {',
    ns1Options,
    '};',
    'zone "example.com" { type primary; file "/etc/bind/db.example.com"; };',
    '',
  ].join('\n'));
  writeRoot(ns1, '/etc/bind/db.example.com', COM_ZONE);

  writeRoot(ns2, '/etc/bind/named.conf',
    'options { recursion no; };\nzone "example.org" { type primary; file "/etc/bind/db.example.org"; };\n');
  writeRoot(ns2, '/etc/bind/db.example.org', ORG_ZONE);

  await ns1.executeCommand('systemctl start named');
  await ns2.executeCommand('systemctl start named');

  return { pc1, pc2, ns1, ns2 };
}

let nextId = 1;

function makeQuery(qname: string, options: { rd?: boolean; qtype?: number } = {}): DnsMessage {
  return {
    id: nextId++,
    flags: {
      qr: false, opcode: DnsOpcode.QUERY, aa: false, tc: false,
      rd: options.rd ?? false, ra: false, ad: false, cd: false, rcode: DnsRcode.NOERROR,
    },
    questions: [{ qname, qtype: options.qtype ?? RRType.A, qclass: DnsClass.IN }],
    answers: [],
    authorities: [],
    additionals: [],
  };
}

function ask(
  from: LinuxPC, qname: string, options: { rd?: boolean; qtype?: number } = {},
): Promise<DnsMessage | null> {
  return queryDnsOverUdp(from, new IPAddress(NS1_IP), makeQuery(qname, options), 53, QUERY_TIMEOUT_MS);
}

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.clear();
});

describe('named — allow-query', () => {
  it('answers a client inside allow-query and refuses one outside', async () => {
    const { pc1, pc2 } = await buildLab(`  recursion no;\n  allow-query { ${PC1_IP}; };`);

    const allowed = await ask(pc1, 'www.example.com');
    expect(allowed!.flags.rcode).toBe(DnsRcode.NOERROR);
    expect((allowed!.answers[0].data as ARecordData).address.toString()).toBe('10.0.1.80');

    const refused = await ask(pc2, 'www.example.com');
    expect(refused!.flags.rcode).toBe(DnsRcode.REFUSED);
    expect(refused!.answers).toHaveLength(0);
  }, 20000);
});

describe('named — recursion and forwarders', () => {
  it('resolves a foreign zone through the forwarder with RA=1 and AA=0', async () => {
    const { pc1 } = await buildLab(`  recursion yes;\n  forwarders { ${NS2_IP}; };\n  allow-recursion { any; };`);

    const response = await ask(pc1, 'www.example.org', { rd: true });

    expect(response).not.toBeNull();
    expect(response!.flags.rcode).toBe(DnsRcode.NOERROR);
    expect(response!.flags.aa).toBe(false);
    expect(response!.flags.ra).toBe(true);
    expect((response!.answers[0].data as ARecordData).address.toString()).toBe('10.0.9.1');
  }, 20000);

  it('still answers its own zone authoritatively with RA=1', async () => {
    const { pc1 } = await buildLab(`  recursion yes;\n  forwarders { ${NS2_IP}; };\n  allow-recursion { any; };`);

    const response = await ask(pc1, 'www.example.com', { rd: true });

    expect(response!.flags.aa).toBe(true);
    expect(response!.flags.ra).toBe(true);
  }, 20000);

  it('refuses foreign names with RA=0 when recursion is disabled', async () => {
    const { pc1 } = await buildLab('  recursion no;');

    const response = await ask(pc1, 'www.example.org', { rd: true });

    expect(response!.flags.rcode).toBe(DnsRcode.REFUSED);
    expect(response!.flags.ra).toBe(false);
  }, 20000);

  it('applies allow-recursion per client while still serving authoritative data', async () => {
    const { pc1, pc2 } = await buildLab(
      `  recursion yes;\n  forwarders { ${NS2_IP}; };\n  allow-recursion { ${PC1_IP}; };`,
    );

    const recursed = await ask(pc1, 'www.example.org', { rd: true });
    expect(recursed!.flags.rcode).toBe(DnsRcode.NOERROR);
    expect(recursed!.flags.ra).toBe(true);

    const denied = await ask(pc2, 'www.example.org', { rd: true });
    expect(denied!.flags.rcode).toBe(DnsRcode.REFUSED);
    expect(denied!.flags.ra).toBe(false);

    const authoritative = await ask(pc2, 'www.example.com', { rd: true });
    expect(authoritative!.flags.rcode).toBe(DnsRcode.NOERROR);
    expect(authoritative!.flags.aa).toBe(true);
    expect(authoritative!.flags.ra).toBe(false);
  }, 20000);

  it('caches forwarded answers and serves them without a second upstream hit', async () => {
    const { pc1, ns2 } = await buildLab(
      `  recursion yes;\n  forwarders { ${NS2_IP}; };\n  allow-recursion { any; };`,
    );

    const first = await ask(pc1, 'www.example.org', { rd: true });
    expect(first!.flags.rcode).toBe(DnsRcode.NOERROR);

    await ns2.executeCommand('systemctl stop named');

    const second = await ask(pc1, 'www.example.org', { rd: true });
    expect(second).not.toBeNull();
    expect(second!.flags.rcode).toBe(DnsRcode.NOERROR);
    expect((second!.answers[0].data as ARecordData).address.toString()).toBe('10.0.9.1');
  }, 20000);
});

describe('named — allow-transfer', () => {
  it('refuses AXFR when allow-transfer is none', async () => {
    const { pc1 } = await buildLab('  recursion no;\n  allow-transfer { none; };');

    const response = await ask(pc1, 'example.com', { qtype: RRType.AXFR });

    expect(response!.flags.rcode).toBe(DnsRcode.REFUSED);
  }, 20000);
});
