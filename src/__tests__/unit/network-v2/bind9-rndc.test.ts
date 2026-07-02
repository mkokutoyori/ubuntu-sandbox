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

function zoneDb(serial: number, wwwAddress: string): string {
  return [
    '$ORIGIN example.com.',
    '$TTL 3600',
    `@   IN SOA ns1.example.com. admin.example.com. ( ${serial} 3600 900 604800 300 )`,
    '    IN NS  ns1.example.com.',
    'ns1 IN A   10.0.1.10',
    `www IN A   ${wwwAddress}`,
    '',
  ].join('\n');
}

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
  ns1: LinuxServer;
  ns2: LinuxServer;
}

async function buildLab(options: { ns1Extra?: string; started?: boolean } = {}): Promise<Lab> {
  const sw = new GenericSwitch('switch-generic', 'sw1', 8, 0, 0);
  const ns1 = new LinuxServer('NS1');
  const ns2 = new LinuxServer('NS2');
  const pc1 = new LinuxPC('linux-pc', 'PC1');

  const mask = new SubnetMask('255.255.255.0');
  [ns1, ns2, pc1].forEach((device, i) => {
    new Cable(`c${i}`).connect(device.getPorts()[0], sw.getPorts()[i]);
  });
  ns1.getPorts()[0].configureIP(new IPAddress(NS1_IP), mask);
  ns2.getPorts()[0].configureIP(new IPAddress(NS2_IP), mask);
  pc1.getPorts()[0].configureIP(new IPAddress(PC1_IP), mask);

  writeRoot(ns1, '/etc/bind/named.conf', [
    'options {',
    '  recursion yes;',
    `  forwarders { ${NS2_IP}; };`,
    '  allow-recursion { any; };',
    options.ns1Extra ?? '',
    '};',
    'zone "example.com" { type primary; file "/etc/bind/db.example.com"; };',
    '',
  ].join('\n'));
  writeRoot(ns1, '/etc/bind/db.example.com', zoneDb(2024010101, '10.0.1.80'));

  writeRoot(ns2, '/etc/bind/named.conf',
    'options { recursion no; };\nzone "example.org" { type primary; file "/etc/bind/db.example.org"; };\n');
  writeRoot(ns2, '/etc/bind/db.example.org', ORG_ZONE);

  if (options.started !== false) {
    await ns1.executeCommand('systemctl start named');
    await ns2.executeCommand('systemctl start named');
  }

  return { pc1, ns1, ns2 };
}

let nextId = 1;

function makeQuery(qname: string, rd = false): DnsMessage {
  return {
    id: nextId++,
    flags: {
      qr: false, opcode: DnsOpcode.QUERY, aa: false, tc: false,
      rd, ra: false, ad: false, cd: false, rcode: DnsRcode.NOERROR,
    },
    questions: [{ qname, qtype: RRType.A, qclass: DnsClass.IN }],
    answers: [],
    authorities: [],
    additionals: [],
  };
}

function ask(from: LinuxPC, qname: string, rd = false, timeoutMs = 400): Promise<DnsMessage | null> {
  return queryDnsOverUdp(from, new IPAddress(NS1_IP), makeQuery(qname, rd), 53, timeoutMs);
}

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.clear();
});

describe('rndc — control channel', () => {
  it('refuses to talk to a stopped daemon', async () => {
    const { ns1 } = await buildLab({ started: false });

    const out = await ns1.executeCommand('rndc status');

    expect(out).toContain('rndc: connect failed: 127.0.0.1#953: connection refused');
  }, 20000);

  it('reports status of a running daemon', async () => {
    const { ns1 } = await buildLab();

    const out = await ns1.executeCommand('rndc status');

    expect(out).toContain('number of zones: 1');
    expect(out).toContain('query logging is OFF');
    expect(out).toContain('server is up and running');
  }, 20000);

  it('rejects an unknown command', async () => {
    const { ns1 } = await buildLab();

    const out = await ns1.executeCommand('rndc bogus');

    expect(out).toContain("rndc: unknown command 'bogus'");
  }, 20000);
});

describe('rndc reload', () => {
  it('reloads an edited zone file and serves the new serial', async () => {
    const { pc1, ns1 } = await buildLab();
    writeRoot(ns1, '/etc/bind/db.example.com', zoneDb(2024010102, '10.0.1.90'));

    const out = await ns1.executeCommand('rndc reload');

    expect(out).toContain('server reload successful');
    const response = await ask(pc1, 'www.example.com');
    expect((response!.answers[0].data as ARecordData).address.toString()).toBe('10.0.1.90');
  }, 20000);

  it('reports up-to-date for an unchanged single zone', async () => {
    const { ns1 } = await buildLab();

    const out = await ns1.executeCommand('rndc reload example.com');

    expect(out).toContain('zone reload up-to-date');
  }, 20000);

  it('reloads a single changed zone', async () => {
    const { pc1, ns1 } = await buildLab();
    writeRoot(ns1, '/etc/bind/db.example.com', zoneDb(2024010103, '10.0.1.91'));

    const out = await ns1.executeCommand('rndc reload example.com');

    expect(out).toContain('zone reload successful');
    const response = await ask(pc1, 'www.example.com');
    expect((response!.answers[0].data as ARecordData).address.toString()).toBe('10.0.1.91');
  }, 20000);
});

describe('rndc freeze / thaw', () => {
  it('blocks reloading a frozen zone until thaw', async () => {
    const { pc1, ns1 } = await buildLab();
    await ns1.executeCommand('rndc freeze example.com');
    writeRoot(ns1, '/etc/bind/db.example.com', zoneDb(2024010105, '10.0.1.95'));

    const refused = await ns1.executeCommand('rndc reload example.com');
    expect(refused).toContain("rndc: 'reload' failed: frozen");

    const thaw = await ns1.executeCommand('rndc thaw example.com');
    expect(thaw).toContain('The zone reload and thaw was successful.');
    const response = await ask(pc1, 'www.example.com');
    expect((response!.answers[0].data as ARecordData).address.toString()).toBe('10.0.1.95');
  }, 20000);
});

describe('rndc flush', () => {
  it('empties the resolver cache', async () => {
    const { pc1, ns1, ns2 } = await buildLab();

    const first = await ask(pc1, 'www.example.org', true);
    expect(first!.flags.rcode).toBe(DnsRcode.NOERROR);

    await ns2.executeCommand('systemctl stop named');

    const cached = await ask(pc1, 'www.example.org', true);
    expect(cached!.flags.rcode).toBe(DnsRcode.NOERROR);

    await ns1.executeCommand('rndc flush');

    const afterFlush = await ask(pc1, 'www.example.org', true, 4000);
    expect(afterFlush!.flags.rcode).toBe(DnsRcode.SERVFAIL);
  }, 25000);
});

describe('rndc querylog — logging channels', () => {
  it('logs queries to the default query log once enabled', async () => {
    const { pc1, ns1 } = await buildLab();
    await ns1.executeCommand('rndc querylog on');

    await ask(pc1, 'www.example.com');

    const log = vfsOf(ns1).readFile('/var/log/named/query.log') ?? '';
    expect(log).toContain('query: www.example.com IN A');
    expect(log).toContain(PC1_IP);
  }, 20000);

  it('does not log while query logging is off', async () => {
    const { pc1, ns1 } = await buildLab();

    await ask(pc1, 'www.example.com');

    const log = vfsOf(ns1).readFile('/var/log/named/query.log') ?? '';
    expect(log).not.toContain('www.example.com');
  }, 20000);

  it('reflects the toggle in rndc status and querylog off stops logging', async () => {
    const { pc1, ns1 } = await buildLab();
    await ns1.executeCommand('rndc querylog on');
    expect(await ns1.executeCommand('rndc status')).toContain('query logging is ON');

    await ns1.executeCommand('rndc querylog off');
    expect(await ns1.executeCommand('rndc status')).toContain('query logging is OFF');

    await ask(pc1, 'www.example.com');
    const log = vfsOf(ns1).readFile('/var/log/named/query.log') ?? '';
    expect(log).not.toContain('www.example.com');
  }, 20000);

  it('honours a configured logging channel for the queries category', async () => {
    const { pc1, ns1 } = await buildLab({
      ns1Extra: '  querylog yes;',
    });
    writeRoot(ns1, '/etc/bind/named.conf', [
      'options {',
      '  recursion no;',
      '  querylog yes;',
      '};',
      'logging {',
      '  channel query_log { file "/var/log/named/custom-queries.log"; severity info; };',
      '  category queries { query_log; };',
      '};',
      'zone "example.com" { type primary; file "/etc/bind/db.example.com"; };',
      '',
    ].join('\n'));
    await ns1.executeCommand('systemctl restart named');

    await ask(pc1, 'www.example.com');

    const log = vfsOf(ns1).readFile('/var/log/named/custom-queries.log') ?? '';
    expect(log).toContain('query: www.example.com IN A');
  }, 20000);
});
