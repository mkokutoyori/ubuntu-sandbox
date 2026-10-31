/*
 * Probe — a parent zone does not answer the NS set of a delegated child, it refers.
 *
 * Measured first (BIND 9.18 root server hosting "." with `example.com. NS ns1.example.com.` and glue):
 * `dig @root example.com NS +norecurse` came back `flags: qr aa`, ANSWER: 1, AUTHORITY: 0 — the parent
 * claimed authority over a record that RFC 1034 4.2.1 says is not part of its zone ("Since the cuts are
 * between nodes, these RRs are NOT part of the authoritative data of the zone") and RFC 2181 6.1 gives
 * to the child ("The NS records that indicate a zone cut are the property of the child zone created";
 * a server "should not return authoritative answers for queries related to names in another zone, which
 * includes the NS ... records at a zone cut, unless it also happens to be a server for the other zone").
 * The same happened on a Windows DNS server hosting "com". A recursive resolver asked for the NS set of
 * a delegated name therefore stopped at the parent and never reached the child that owns the answer.
 *
 * Discrimination (git stash of Zone.ts): 4 of the 9 cases fall before the change (the store referral, the
 * BIND9 root, the Windows DNS TLD and the recursive resolver). Five pass either way:
 *  - "answers the apex NS set authoritatively" — WITNESS of the other side of the rule: at the apex the
 *    server IS the child, it must keep answering.
 *  - "answers a DS query at the cut from the parent" — NON-REGRESSION: DS is the one type the parent owns
 *    at a cut (RFC 4035 3.1.4.1) and the exception must survive.
 *  - "refers an address query at the cut" — NON-REGRESSION: the referral for every other type was already
 *    right, only NS was exempted.
 *  - "lets the child server answer the NS set authoritatively" and "resolves an address through the tree" —
 *    WITNESSES: they prove the lab itself is sound, so a failing case accuses the referral rule and not the
 *    topology.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { IPAddress, SubnetMask, resetCounters } from '@/network/core/types';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { WindowsServer } from '@/network/devices/WindowsServer';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { PowerShellSubShell } from '@/terminal/subshells/PowerShellSubShell';
import { ZoneStore } from '@/network/dns/zone/ZoneStore';
import { parseZoneFile } from '@/network/dns/zone/ZoneFile';
import { RRType, DnsClass } from '@/network/dns/wire/RRType';
import { DnsRcode } from '@/network/dns/wire/DnsHeaderFlags';
import type { VirtualFileSystem } from '@/network/devices/linux/VirtualFileSystem';

const ROOT_IP = '10.0.0.1';
const AUTH_IP = '10.0.0.10';
const RESOLVER_IP = '10.0.0.53';
const TLD_IP = '10.0.0.2';
const PC_IP = '10.0.0.100';

const PARENT_ZONE = [
  '$ORIGIN example.com.',
  '$TTL 3600',
  '@ IN SOA ns1.example.com. admin.example.com. ( 1 3600 900 604800 300 )',
  '  IN NS ns1.example.com.',
  'ns1 IN A 10.0.0.10',
  'child IN NS ns1.child.example.com.',
  'ns1.child IN A 10.0.0.77',
  '',
].join('\n');

const ROOT_ZONE = [
  '$TTL 3600',
  '. IN SOA a.root-servers.net. hostmaster.root-servers.net. ( 1 3600 900 604800 300 )',
  '. IN NS a.root-servers.net.',
  'a.root-servers.net. IN A 10.0.0.1',
  'example.com. IN NS ns1.example.com.',
  'ns1.example.com. IN A 10.0.0.10',
  '',
].join('\n');

const AUTH_ZONE = [
  '$ORIGIN example.com.',
  '$TTL 3600',
  '@ IN SOA ns1.example.com. admin.example.com. ( 1 3600 900 604800 300 )',
  '  IN NS ns1.example.com.',
  'ns1 IN A 10.0.0.10',
  'www IN A 10.0.0.80',
  '',
].join('\n');

const HINTS = [
  '. 3600000 IN NS a.root-servers.net.',
  'a.root-servers.net. 3600000 IN A 10.0.0.1',
  '',
].join('\n');

function vfsOf(server: LinuxServer): VirtualFileSystem {
  return (server as unknown as { executor: { vfs: VirtualFileSystem } }).executor.vfs;
}

function put(server: LinuxServer, path: string, content: string): void {
  vfsOf(server).writeFile(path, content, 0, 0, 0o022);
}

const powershell = async (server: WindowsServer, line: string): Promise<string> =>
  (await PowerShellSubShell.create(server).subShell.processLine(line)).output.join('\n');

async function buildLab() {
  const sw = new GenericSwitch('switch-generic', 'SW', 8, 0, 0);
  const root = new LinuxServer('linux-server', 'ROOT');
  const auth = new LinuxServer('linux-server', 'AUTH');
  const resolver = new LinuxServer('linux-server', 'RESOLVER');
  const tld = new WindowsServer('TLD');
  const pc = new LinuxPC('linux-pc', 'PC');
  const mask = new SubnetMask('255.255.0.0');
  [root, auth, resolver, tld, pc].forEach((device, index) => {
    new Cable(`c${index}`).connect(device.getPorts()[0], sw.getPorts()[index]);
    device.getPorts()[0].configureIP(new IPAddress([ROOT_IP, AUTH_IP, RESOLVER_IP, TLD_IP, PC_IP][index]), mask);
  });

  put(root, '/etc/bind/named.conf', 'options { directory "/var/cache/bind"; recursion no; };\nzone "." { type primary; file "/etc/bind/db.root"; };\n');
  put(root, '/etc/bind/db.root', ROOT_ZONE);
  await root.executeCommand('systemctl start named');

  put(auth, '/etc/bind/named.conf', 'options { directory "/var/cache/bind"; recursion no; };\nzone "example.com" { type primary; file "/etc/bind/db.example.com"; };\n');
  put(auth, '/etc/bind/db.example.com', AUTH_ZONE);
  await auth.executeCommand('systemctl start named');
  await auth.executeCommand('rndc querylog on');

  put(resolver, '/etc/bind/named.conf', 'options { directory "/var/cache/bind"; recursion yes; allow-recursion { any; }; dnssec-validation no; };\nzone "." { type hint; file "/etc/bind/db.hints"; };\n');
  put(resolver, '/etc/bind/db.hints', HINTS);
  await resolver.executeCommand('systemctl start named');

  tld.setCurrentUser('Administrator');
  await powershell(tld, 'Install-WindowsFeature DNS');
  await powershell(tld, 'Add-DnsServerPrimaryZone -Name com');
  await powershell(tld, 'Add-DnsServerResourceRecord -NS -ZoneName com -Name example -NameServer ns1.example.com');
  await powershell(tld, `Add-DnsServerResourceRecordA -ZoneName com -Name ns1.example -IPv4Address ${AUTH_IP}`);
  return { root, auth, resolver, tld, pc };
}

function flagsOf(output: string): string[] {
  const line = output.split('\n').find((candidate) => candidate.startsWith(';; flags:')) ?? '';
  return (line.match(/^;; flags: ([a-z ]*);/)?.[1] ?? '').split(' ').filter(Boolean);
}

function sectionCount(output: string, section: 'ANSWER' | 'AUTHORITY' | 'ADDITIONAL'): number {
  return Number(output.match(new RegExp(`${section}: (\\d+)`))?.[1] ?? NaN);
}

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.clear();
});

describe('a parent zone refers the NS set of a delegated child', () => {
  it('answers a name-server query at a delegation point with a referral, not an answer', () => {
    const store = new ZoneStore();
    store.addZone(parseZoneFile(PARENT_ZONE));
    const reply = store.answer({ qname: 'child.example.com', qtype: RRType.NS, qclass: DnsClass.IN });
    expect(reply.aa).toBe(false);
    expect(reply.rcode).toBe(DnsRcode.NOERROR);
    expect(reply.answers).toHaveLength(0);
    expect(reply.authority.map((rr) => rr.data.type)).toEqual([RRType.NS]);
    expect(reply.additional.map((rr) => rr.name)).toEqual(['ns1.child.example.com']);
  });

  it('answers the apex NS set authoritatively', () => {
    const store = new ZoneStore();
    store.addZone(parseZoneFile(PARENT_ZONE));
    const reply = store.answer({ qname: 'example.com', qtype: RRType.NS, qclass: DnsClass.IN });
    expect(reply.aa).toBe(true);
    expect(reply.answers.map((rr) => rr.data.type)).toEqual([RRType.NS]);
  });

  it('answers a DS query at the cut from the parent', () => {
    const store = new ZoneStore();
    store.addZone(parseZoneFile(PARENT_ZONE));
    const reply = store.answer({ qname: 'child.example.com', qtype: RRType.DS, qclass: DnsClass.IN });
    expect(reply.aa).toBe(true);
    expect(reply.rcode).toBe(DnsRcode.NOERROR);
    expect(reply.answers).toHaveLength(0);
  });

  it('refers an address query at the cut as it always did', () => {
    const store = new ZoneStore();
    store.addZone(parseZoneFile(PARENT_ZONE));
    const reply = store.answer({ qname: 'child.example.com', qtype: RRType.A, qclass: DnsClass.IN });
    expect(reply.aa).toBe(false);
    expect(reply.authority.map((rr) => rr.data.type)).toEqual([RRType.NS]);
  });

  it('makes a BIND9 root server refer example.com NS with the glue in the additional section', async () => {
    const { pc } = await buildLab();
    const out = await pc.executeCommand(`dig @${ROOT_IP} example.com NS +norecurse`);
    expect(flagsOf(out)).not.toContain('aa');
    expect(sectionCount(out, 'ANSWER')).toBe(0);
    expect(sectionCount(out, 'AUTHORITY')).toBe(1);
    expect(out).toMatch(/example\.com\.\s+\d+\s+IN\s+NS\s+ns1\.example\.com\./);
    expect(out).toMatch(/ns1\.example\.com\.\s+\d+\s+IN\s+A\s+10\.0\.0\.10/);
  });

  it('makes a Windows DNS server hosting com refer example.com NS the same way', async () => {
    const { pc } = await buildLab();
    const out = await pc.executeCommand(`dig @${TLD_IP} example.com NS +norecurse`);
    expect(flagsOf(out)).not.toContain('aa');
    expect(sectionCount(out, 'ANSWER')).toBe(0);
    expect(out).toMatch(/example\.com\.\s+\d+\s+IN\s+NS\s+ns1\.example\.com\./);
  });

  it('lets the child server answer the NS set authoritatively', async () => {
    const { pc } = await buildLab();
    const out = await pc.executeCommand(`dig @${AUTH_IP} example.com NS +norecurse`);
    expect(flagsOf(out)).toContain('aa');
    expect(sectionCount(out, 'ANSWER')).toBe(1);
  });

  it('resolves an address through the tree', async () => {
    const { pc } = await buildLab();
    const out = await pc.executeCommand(`dig @${RESOLVER_IP} www.example.com A`);
    expect(out).toMatch(/www\.example\.com\.\s+\d+\s+IN\s+A\s+10\.0\.0\.80/);
  });

  it('makes a recursive resolver follow the referral to the child that owns the NS set', async () => {
    const { pc, auth } = await buildLab();
    const out = await pc.executeCommand(`dig @${RESOLVER_IP} example.com NS`);
    expect(out).toMatch(/example\.com\.\s+\d+\s+IN\s+NS\s+ns1\.example\.com\./);
    const queryLog = await auth.executeCommand('cat /var/log/named/query.log');
    expect(queryLog).toMatch(/query: example\.com IN NS/);
  });
});
