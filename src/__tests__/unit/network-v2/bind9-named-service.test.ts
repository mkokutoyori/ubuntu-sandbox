import { describe, it, expect, beforeEach } from 'vitest';
import { IPAddress, SubnetMask, resetCounters } from '@/network/core/types';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
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

const SERVER_IP = '10.0.1.10';
const QUERY_TIMEOUT_MS = 300;

const NAMED_CONF = [
  'options {',
  '  directory "/var/cache/bind";',
  '  recursion no;',
  '};',
  'zone "example.com" {',
  '  type primary;',
  '  file "/etc/bind/db.example";',
  '};',
  '',
].join('\n');

const ZONE_DB = [
  '$ORIGIN example.com.',
  '$TTL 3600',
  '@   IN SOA ns1.example.com. admin.example.com. ( 2024010101 3600 900 604800 300 )',
  '    IN NS  ns1.example.com.',
  'ns1 IN A   10.0.1.10',
  'www IN A   10.0.1.80',
  '',
].join('\n');

function vfsOf(server: LinuxServer): VirtualFileSystem {
  return (server as unknown as { executor: { vfs: VirtualFileSystem } }).executor.vfs;
}

function writeRoot(server: LinuxServer, path: string, content: string): void {
  vfsOf(server).writeFile(path, content, 0, 0, 0o022);
}

function buildLab(options: { conf?: string; zoneDb?: string | null } = {}) {
  const pc = new LinuxPC('linux-pc', 'PC1');
  const srv = new LinuxServer('NS1');

  pc.configureInterface('eth0', new IPAddress('10.0.1.2'), new SubnetMask('255.255.255.0'));
  srv.configureInterface('eth0', new IPAddress(SERVER_IP), new SubnetMask('255.255.255.0'));
  new Cable('c1').connect(pc.getPort('eth0')!, srv.getPort('eth0')!);

  writeRoot(srv, '/etc/bind/named.conf', options.conf ?? NAMED_CONF);
  const zoneDb = options.zoneDb === undefined ? ZONE_DB : options.zoneDb;
  if (zoneDb !== null) writeRoot(srv, '/etc/bind/db.example', zoneDb);

  return { pc, srv };
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

function ask(pc: LinuxPC, qname: string): Promise<DnsMessage | null> {
  return queryDnsOverUdp(pc, new IPAddress(SERVER_IP), makeQuery(qname), 53, QUERY_TIMEOUT_MS);
}

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.clear();
});

describe('named — systemd lifecycle and wire serving', () => {
  it('does not answer before the service is started', async () => {
    const { pc } = buildLab();

    const response = await ask(pc, 'www.example.com');

    expect(response).toBeNull();
  }, 15000);

  it('serves its zone with AA=1 over real UDP after systemctl start', async () => {
    const { pc, srv } = buildLab();

    const out = await srv.executeCommand('systemctl start named');
    expect(out.trim()).toBe('');

    const response = await ask(pc, 'www.example.com');
    expect(response).not.toBeNull();
    expect(response!.flags.aa).toBe(true);
    expect(response!.flags.rcode).toBe(DnsRcode.NOERROR);
    expect((response!.answers[0].data as ARecordData).address.toString()).toBe('10.0.1.80');
  }, 15000);

  it('serves the same answers over TCP/53', async () => {
    const { pc, srv } = buildLab();
    await srv.executeCommand('systemctl start named');

    const response = await queryDnsOverTcp(
      pc, new IPAddress(SERVER_IP), makeQuery('www.example.com'), 53, QUERY_TIMEOUT_MS,
    );

    expect(response).not.toBeNull();
    expect(response!.flags.aa).toBe(true);
    expect((response!.answers[0].data as ARecordData).address.toString()).toBe('10.0.1.80');
  }, 15000);

  it('reports active (running) in systemctl status', async () => {
    const { srv } = buildLab();
    await srv.executeCommand('systemctl start named');

    const out = await srv.executeCommand('systemctl status named');

    expect(out).toContain('named.service - BIND Domain Name Server');
    expect(out).toContain('active (running)');
  }, 15000);

  it('closes port 53 on systemctl stop', async () => {
    const { pc, srv } = buildLab();
    await srv.executeCommand('systemctl start named');
    expect(await ask(pc, 'www.example.com')).not.toBeNull();

    await srv.executeCommand('systemctl stop named');

    expect(await ask(pc, 'www.example.com')).toBeNull();
  }, 15000);

  it('refuses to start on a broken configuration and leaves the unit failed', async () => {
    const { pc, srv } = buildLab({ conf: 'options {\n  recursion no\n};' });

    const out = await srv.executeCommand('systemctl start named');

    expect(out).toContain('Failed to start named.service');
    expect(out).toContain("/etc/bind/named.conf:3: missing ';' before '}'");
    const status = await srv.executeCommand('systemctl status named');
    expect(status).not.toContain('active (running)');
    expect(await ask(pc, 'www.example.com')).toBeNull();
  }, 15000);

  it('answers SERVFAIL for a configured zone whose file is missing', async () => {
    const { pc, srv } = buildLab({ zoneDb: null });
    await srv.executeCommand('systemctl start named');

    const response = await ask(pc, 'www.example.com');

    expect(response).not.toBeNull();
    expect(response!.flags.rcode).toBe(DnsRcode.SERVFAIL);
  }, 15000);

  it('resolves a relative zone file against the directory option', async () => {
    const conf = NAMED_CONF.replace('file "/etc/bind/db.example";', 'file "db.example";');
    const { pc, srv } = buildLab({ conf, zoneDb: null });
    writeRoot(srv, '/var/cache/bind/db.example', ZONE_DB);
    await srv.executeCommand('systemctl start named');

    const response = await ask(pc, 'www.example.com');

    expect(response).not.toBeNull();
    expect((response!.answers[0].data as ARecordData).address.toString()).toBe('10.0.1.80');
  }, 15000);

  it('fails to start while dnsmasq already holds port 53', async () => {
    const { pc, srv } = buildLab();
    srv.dnsService.addRecord({ name: 'other', type: 'A', value: '10.0.1.99', ttl: 3600 });
    srv.dnsService.start();

    await srv.executeCommand('systemctl start named');

    const status = await srv.executeCommand('systemctl status named');
    expect(status).not.toContain('active (running)');
    const response = await ask(pc, 'www.example.com');
    expect(response === null || response.flags.aa === false).toBe(true);
  }, 15000);

  it('rejects a reload when the on-disk configuration is broken and keeps serving', async () => {
    const { pc, srv } = buildLab();
    await srv.executeCommand('systemctl start named');
    writeRoot(srv, '/etc/bind/named.conf', 'optionz { };');

    const out = await srv.executeCommand('systemctl reload named');

    expect(out).toContain("unknown option 'optionz'");
    expect(await ask(pc, 'www.example.com')).not.toBeNull();
  }, 15000);

  it('picks up zone changes on systemctl restart', async () => {
    const { pc, srv } = buildLab();
    await srv.executeCommand('systemctl start named');
    writeRoot(srv, '/etc/bind/db.example', ZONE_DB.replace('10.0.1.80', '10.0.1.81'));

    await srv.executeCommand('systemctl restart named');

    const response = await ask(pc, 'www.example.com');
    expect((response!.answers[0].data as ARecordData).address.toString()).toBe('10.0.1.81');
  }, 15000);
});
