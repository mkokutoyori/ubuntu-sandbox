/**
 * PRD-Nslookup-Dig-Rndc-Runas.md §1.3 gap #2 / §2.1.2 / P2 — `nslookup`/`dig`
 * previously only recognized IPv4 literals (`IPV4_LITERAL`), so an IPv6
 * `@server` or an IPv6 reverse-lookup target silently failed. This covers:
 *   - `isIpLiteral`/`ptrQName` (DnsWireCompat.ts) recognizing and correctly
 *     nibble-reversing IPv6 addresses into `ip6.arpa` (RFC 3596 §2.5).
 *   - `dig`/`nslookup` actually reaching an IPv6 DNS server end-to-end
 *     (EndHost.queryDnsServer/queryDnsServerSync now accept IPv6Address and
 *     send over `sendUdpDatagramTo`, not the IPv4-only `sendUdpDatagram`).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { IPv6Address, resetCounters } from '@/network/core/types';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { Cable } from '@/network/hardware/Cable';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { isIpLiteral, isIPv6Literal, ptrQName } from '@/network/dns/compat/DnsWireCompat';
import type { VirtualFileSystem } from '@/network/devices/linux/VirtualFileSystem';

const NS1_IP6 = '2001:db8::53';
const PC_IP6 = '2001:db8::10';

const ZONE_DB = [
  '$ORIGIN example.com.',
  '$TTL 3600',
  '@     IN SOA ns1.example.com. admin.example.com. ( 2024010101 3600 900 604800 300 )',
  '      IN NS  ns1.example.com.',
  'ns1   IN A   10.0.1.10',
  'www   IN AAAA 2001:db8::abcd',
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
  const srv = new LinuxServer('linux-server', 'NS1');

  pc.configureIPv6Interface('eth0', new IPv6Address(PC_IP6), 64);
  srv.configureIPv6Interface('eth0', new IPv6Address(NS1_IP6), 64);
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

describe('DnsWireCompat — IPv6 literal detection and ip6.arpa (RFC 3596 §2.5)', () => {
  it('isIPv6Literal recognizes compressed and full forms, rejects hostnames', () => {
    expect(isIPv6Literal('2001:db8::1')).toBe(true);
    expect(isIPv6Literal('::1')).toBe(true);
    expect(isIPv6Literal('fe80::1%eth0')).toBe(true);
    expect(isIPv6Literal('www.example.com')).toBe(false);
    expect(isIPv6Literal('10.0.1.10')).toBe(false);
  });

  it('isIpLiteral is true for both IPv4 and IPv6 literals', () => {
    expect(isIpLiteral('10.0.1.10')).toBe(true);
    expect(isIpLiteral('2001:db8::1')).toBe(true);
    expect(isIpLiteral('example.com')).toBe(false);
  });

  it('ptrQName nibble-reverses a full IPv6 address into ip6.arpa (RFC 3596 example)', () => {
    expect(ptrQName('4321:0:1:2:3:4:567:89ab')).toBe(
      'b.a.9.8.7.6.5.0.4.0.0.0.3.0.0.0.2.0.0.0.1.0.0.0.0.0.0.0.1.2.3.4.ip6.arpa',
    );
  });

  it('ptrQName leaves plain hostnames untouched', () => {
    expect(ptrQName('www.example.com')).toBe('www.example.com');
  });
});

describe('dig/nslookup over an IPv6 DNS server (PRD-Nslookup-Dig-Rndc-Runas.md P2)', () => {
  it('dig @<IPv6> resolves an AAAA record from a real BIND9 lab', async () => {
    const { pc } = await buildLab();

    const out = await pc.executeCommand(`dig @${NS1_IP6} www.example.com AAAA`);

    expect(out).toContain('status: NOERROR');
    expect(out).toContain('2001:db8::abcd');
  });

  it('nslookup www.example.com <IPv6 server> resolves via the IPv6 transport', async () => {
    const { pc } = await buildLab();

    const out = await pc.executeCommand(`nslookup -type=AAAA www.example.com ${NS1_IP6}`);

    expect(out).toContain('2001:db8::abcd');
  });

  it('nslookup treats a bare IPv6 target as a reverse lookup (correctly formatted ip6.arpa qname)', async () => {
    const { pc } = await buildLab();

    // No ip6.arpa zone is configured on this authoritative-only server, so the
    // real, correct answer is REFUSED (outside any zone this server is authoritative
    // for) — the point of this test is the qname shape, not the rcode.
    const out = await pc.executeCommand(`nslookup 2001:db8::9999 ${NS1_IP6}`);

    expect(out).toContain("** server can't find 9.9.9.9.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.8.b.d.0.1.0.0.2.ip6.arpa: REFUSED");
  });
});
