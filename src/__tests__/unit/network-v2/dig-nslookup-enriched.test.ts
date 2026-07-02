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
  '      IN TXT "v=spf1 -all"',
  'ns1   IN A   10.0.1.10',
  'mail  IN A   10.0.1.25',
  'www   IN A   10.0.1.80',
  'alias IN CNAME www',
  '',
].join('\n');

function namedConf(extraOptions = '', zoneExtras = ''): string {
  return [
    'options {',
    '  directory "/var/cache/bind";',
    '  recursion no;',
    extraOptions,
    '};',
    'zone "example.com" {',
    '  type primary;',
    '  file "/etc/bind/db.example.com";',
    zoneExtras,
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

async function buildLab(options: { conf?: string; zoneDb?: string | null } = {}) {
  const pc = new LinuxPC('linux-pc', 'PC1');
  const srv = new LinuxServer('NS1');

  pc.configureInterface('eth0', new IPAddress('10.0.1.2'), new SubnetMask('255.255.255.0'));
  srv.configureInterface('eth0', new IPAddress(NS1_IP), new SubnetMask('255.255.255.0'));
  new Cable('c1').connect(pc.getPort('eth0')!, srv.getPort('eth0')!);

  writeRoot(srv, '/etc/bind/named.conf', options.conf ?? namedConf());
  const zoneDb = options.zoneDb === undefined ? ZONE_DB : options.zoneDb;
  if (zoneDb !== null) writeRoot(srv, '/etc/bind/db.example.com', zoneDb);

  await srv.executeCommand('systemctl start named');
  return { pc, srv };
}

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.clear();
});

describe('dig — enriched header and flags', () => {
  it('reflects the real AA flag and section counts of the response', async () => {
    const { pc } = await buildLab();

    const out = await pc.executeCommand(`dig @${NS1_IP} www.example.com`);

    expect(out).toContain('status: NOERROR');
    expect(out).toMatch(/flags: qr aa rd;/);
    expect(out).toContain('QUERY: 1, ANSWER: 1, AUTHORITY: 0, ADDITIONAL: 0');
    expect(out).toContain('www.example.com.\t3600\tIN\tA\t10.0.1.80');
  }, 20000);

  it('warns when recursion is requested but not available', async () => {
    const { pc } = await buildLab();

    const out = await pc.executeCommand(`dig @${NS1_IP} www.example.com`);

    expect(out).toContain(';; WARNING: recursion requested but not available');
  }, 20000);

  it('drops the rd flag and the warning with +norecurse', async () => {
    const { pc } = await buildLab();

    const out = await pc.executeCommand(`dig @${NS1_IP} www.example.com +norecurse`);

    expect(out).toMatch(/flags: qr aa;/);
    expect(out).not.toContain('WARNING: recursion requested');
  }, 20000);

  it('shows NXDOMAIN with the SOA in the AUTHORITY SECTION', async () => {
    const { pc } = await buildLab();

    const out = await pc.executeCommand(`dig @${NS1_IP} missing.example.com`);

    expect(out).toContain('status: NXDOMAIN');
    expect(out).toContain(';; AUTHORITY SECTION:');
    expect(out).toContain('SOA');
    expect(out).toContain('ns1.example.com. admin.example.com. 2024010101');
  }, 20000);

  it('reports the real encoded message size', async () => {
    const { pc } = await buildLab();

    const out = await pc.executeCommand(`dig @${NS1_IP} www.example.com +norecurse`);

    const size = Number(/MSG SIZE {2}rcvd: (\d+)/.exec(out)?.[1]);
    expect(size).toBeGreaterThan(12);
    expect(size).toBeLessThan(200);
  }, 20000);
});

describe('dig — transports and EDNS', () => {
  it('answers over TCP with +tcp', async () => {
    const { pc } = await buildLab();

    const out = await pc.executeCommand(`dig @${NS1_IP} www.example.com +tcp`);

    expect(out).toContain('status: NOERROR');
    expect(out).toContain('10.0.1.80');
  }, 20000);

  it('shows the OPT pseudosection with +dnssec +bufsize', async () => {
    const { pc } = await buildLab();

    const out = await pc.executeCommand(`dig @${NS1_IP} www.example.com +dnssec +bufsize=4096`);

    expect(out).toContain(';; OPT PSEUDOSECTION:');
    expect(out).toMatch(/; EDNS: version: 0, flags: do; udp: \d+/);
  }, 20000);
});

describe('dig — argument handling', () => {
  it('accepts -t to select the query type', async () => {
    const { pc } = await buildLab();

    const out = await pc.executeCommand(`dig @${NS1_IP} -t MX example.com`);

    expect(out).toContain('example.com.\t3600\tIN\tMX\t10 mail.example.com.');
  }, 20000);

  it('resolves single-label names without a dot', async () => {
    const { pc } = await buildLab({
      zoneDb: [
        '$ORIGIN lan.',
        '$TTL 3600',
        '@   IN SOA ns1.lan. admin.lan. ( 1 3600 900 604800 300 )',
        '    IN NS  ns1.lan.',
        'ns1 IN A   10.0.1.10',
        '',
      ].join('\n'),
      conf: namedConf().replace('"example.com"', '"lan"').replace('db.example.com', 'db.example.com'),
    });

    const out = await pc.executeCommand(`dig @${NS1_IP} lan SOA`);

    expect(out).toContain('status: NOERROR');
    expect(out).toContain('lan.\t3600\tIN\tSOA\tns1.lan.');
  }, 20000);

  it('formats SOA and TXT rdata like real dig', async () => {
    const { pc } = await buildLab();

    const soa = await pc.executeCommand(`dig @${NS1_IP} example.com SOA +short`);
    expect(soa.trim()).toBe('ns1.example.com. admin.example.com. 2024010101 3600 900 604800 300');

    const txt = await pc.executeCommand(`dig @${NS1_IP} example.com TXT +short`);
    expect(txt.trim()).toBe('"v=spf1 -all"');
  }, 20000);
});

describe('dig — zone transfer (AXFR)', () => {
  it('lists the full zone with SOA first and last', async () => {
    const { pc } = await buildLab();

    const out = await pc.executeCommand(`dig @${NS1_IP} example.com AXFR`);

    const dataLines = out.split('\n').filter((line) => line.includes('\tIN\t'));
    expect(dataLines.length).toBeGreaterThan(4);
    expect(dataLines[0]).toContain('SOA');
    expect(dataLines[dataLines.length - 1]).toContain('SOA');
    expect(out).toContain('www.example.com.');
    expect(out).toMatch(/;; XFR size: \d+ records/);
  }, 20000);

  it('prints Transfer failed when the transfer is refused', async () => {
    const { pc } = await buildLab({ conf: namedConf('', '  allow-transfer { none; };') });

    const out = await pc.executeCommand(`dig @${NS1_IP} example.com AXFR`);

    expect(out).toContain('; Transfer failed.');
  }, 20000);
});

describe('nslookup — enriched answers', () => {
  it('omits the Non-authoritative header for an authoritative answer', async () => {
    const { pc } = await buildLab();

    const out = await pc.executeCommand(`nslookup www.example.com ${NS1_IP}`);

    expect(out).not.toContain('Non-authoritative answer:');
    expect(out).toContain('Name:\twww.example.com');
    expect(out).toContain('Address: 10.0.1.80');
  }, 20000);

  it('reports NXDOMAIN from the response code', async () => {
    const { pc } = await buildLab();

    const out = await pc.executeCommand(`nslookup missing.example.com ${NS1_IP}`);

    expect(out).toContain(`** server can't find missing.example.com: NXDOMAIN`);
  }, 20000);

  it('reports SERVFAIL when the zone is broken on the server', async () => {
    const { pc } = await buildLab({ zoneDb: null });

    const out = await pc.executeCommand(`nslookup www.example.com ${NS1_IP}`);

    expect(out).toContain(`** server can't find www.example.com: SERVFAIL`);
  }, 20000);

  it('reports REFUSED when the server denies the query', async () => {
    const { pc } = await buildLab({ conf: namedConf('  allow-query { none; };') });

    const out = await pc.executeCommand(`nslookup www.example.com ${NS1_IP}`);

    expect(out).toContain(`** server can't find www.example.com: REFUSED`);
  }, 20000);

  it('shows the canonical name chain for a CNAME', async () => {
    const { pc } = await buildLab();

    const out = await pc.executeCommand(`nslookup alias.example.com ${NS1_IP}`);

    expect(out).toContain('alias.example.com\tcanonical name = www.example.com.');
    expect(out).toContain('Address: 10.0.1.80');
  }, 20000);

  it('formats NS records', async () => {
    const { pc } = await buildLab();

    const out = await pc.executeCommand(`nslookup -type=NS example.com ${NS1_IP}`);

    expect(out).toContain('example.com\tnameserver = ns1.example.com.');
  }, 20000);

  it('formats TXT records', async () => {
    const { pc } = await buildLab();

    const out = await pc.executeCommand(`nslookup -type=TXT example.com ${NS1_IP}`);

    expect(out).toContain('example.com\ttext = "v=spf1 -all"');
  }, 20000);

  it('formats the SOA record field by field', async () => {
    const { pc } = await buildLab();

    const out = await pc.executeCommand(`nslookup -type=SOA example.com ${NS1_IP}`);

    expect(out).toContain('origin = ns1.example.com');
    expect(out).toContain('mail addr = admin.example.com');
    expect(out).toContain('serial = 2024010101');
    expect(out).toContain('expire = 604800');
  }, 20000);
});
