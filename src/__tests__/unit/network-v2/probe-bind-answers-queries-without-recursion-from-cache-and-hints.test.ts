/*
 * Probe — a BIND resolver answers a query that does not ask for recursion from its cache, and refers the
 * rest to the root hints, instead of refusing it.
 *
 * Measured first (BIND 9.18 resolver with `recursion yes`, `allow-recursion { any; }` and a `type hint` zone, in
 * front of a root that delegates corp.test to a live server):
 * - `dig +norecurse . NS @resolver` answered REFUSED, so `dig +trace @resolver name` stopped after its first
 *   line ("Received 31 bytes ...") and never walked a delegation: the most used DNS teaching command ran on
 *   nothing but a one-line summary;
 * - `dig +norecurse name @resolver` answered REFUSED even for a name the resolver had just resolved, so the
 *   classic cache-snooping probe could not tell a warm cache from a cold one.
 * A real resolver answers RD=0 queries from its cache (positive and negative) and, on a miss, answers NOERROR
 * with the closest delegation it knows in the authority section (the root hints when nothing else is cached),
 * recursion-available flag set, authoritative flag clear. A client that `allow-recursion` excludes is still
 * REFUSED: the cache is not an open book.
 *
 * Two defects sat beside it: the hint file was read for addresses with a regular expression on each line (a
 * second, looser parser of the master file format), and the master file parser could only be reached through a
 * function that insists on an SOA record, which a hint file has none of. The record-level parser is now
 * exposed and the hint file goes through it.
 *
 * Discrimination (git stash of the source files): 6 of the 9 cases fall before the change. Three pass either way:
 *  - "reads a hint file in the named.root layout" — NON-REGRESSION: the regular expression also found the
 *    addresses; the case guards the move to the record parser (upper case names, comments, an AAAA line).
 *  - "keeps refusing a client that allow-recursion excludes" — NON-REGRESSION on the security side.
 *  - "an authoritative-only server still refuses names outside its zones" — NON-REGRESSION.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { IPAddress, SubnetMask, resetCounters } from '@/network/core/types';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import type { VirtualFileSystem } from '@/network/devices/linux/VirtualFileSystem';

const ROOT_IP = '10.0.0.1';
const CORP_IP = '10.0.0.20';
const RESOLVER_IP = '10.0.0.53';
const PC_IP = '10.0.0.100';
const OUTSIDER_IP = '10.0.0.101';

const ROOT_ZONE = [
  '$TTL 3600',
  '. IN SOA a.root-servers.net. hostmaster.root-servers.net. ( 1 3600 900 604800 300 )',
  '. IN NS a.root-servers.net.',
  `a.root-servers.net. IN A ${ROOT_IP}`,
  'corp.test. IN NS ns.corp.test.',
  `ns.corp.test. IN A ${CORP_IP}`,
  '',
].join('\n');

const CORP_ZONE = [
  '$TTL 3600',
  '$ORIGIN corp.test.',
  '@ IN SOA ns.corp.test. hostmaster.corp.test. ( 1 3600 900 604800 300 )',
  '@ IN NS ns.corp.test.',
  `ns IN A ${CORP_IP}`,
  'www IN A 10.0.0.80',
  '',
].join('\n');

const HINTS = [
  '; root hints, named.root layout',
  `.                        3600000      NS    A.ROOT-SERVERS.NET.`,
  `A.ROOT-SERVERS.NET.      3600000      A     ${ROOT_IP}`,
  'A.ROOT-SERVERS.NET.      3600000      AAAA  2001:503:ba3e::2:30',
  '',
].join('\n');

const vfsOf = (server: LinuxServer): VirtualFileSystem =>
  (server as unknown as { executor: { vfs: VirtualFileSystem } }).executor.vfs;

const put = (server: LinuxServer, path: string, content: string): void => {
  vfsOf(server).writeFile(path, content, 0, 0, 0o022);
};

const conf = (recursionAcl: string, recursion = true): string =>
  `options { directory "/var/cache/bind"; recursion ${recursion ? 'yes' : 'no'}; allow-recursion { ${recursionAcl} }; dnssec-validation no; };\n`
  + 'zone "." { type hint; file "/etc/bind/db.hints"; };\n';

async function lab(resolverConf = conf('any;')) {
  const sw = new GenericSwitch('switch-generic', 'SW', 8, 0, 0);
  const root = new LinuxServer('linux-server', 'ROOT');
  const corp = new LinuxServer('linux-server', 'CORP');
  const resolver = new LinuxServer('linux-server', 'RESOLVER');
  const pc = new LinuxPC('linux-pc', 'PC');
  const outsider = new LinuxPC('linux-pc', 'OUTSIDER');
  const mask = new SubnetMask('255.255.255.0');
  const addresses = [ROOT_IP, CORP_IP, RESOLVER_IP, PC_IP, OUTSIDER_IP];
  [root, corp, resolver, pc, outsider].forEach((device, index) => {
    new Cable(`c${index}`).connect(device.getPorts()[0], sw.getPorts()[index]);
    device.getPorts()[0].configureIP(new IPAddress(addresses[index]), mask);
  });

  put(root, '/etc/bind/named.conf', 'options { directory "/var/cache/bind"; recursion no; };\nzone "." { type primary; file "/etc/bind/db.root"; };\n');
  put(root, '/etc/bind/db.root', ROOT_ZONE);
  await root.executeCommand('systemctl start named');

  put(corp, '/etc/bind/named.conf', 'options { directory "/var/cache/bind"; recursion no; };\nzone "corp.test" { type primary; file "/etc/bind/db.corp"; };\n');
  put(corp, '/etc/bind/db.corp', CORP_ZONE);
  await corp.executeCommand('systemctl start named');

  put(resolver, '/etc/bind/named.conf', resolverConf);
  put(resolver, '/etc/bind/db.hints', HINTS);
  await resolver.executeCommand('systemctl start named');
  return { pc, outsider, corp, resolver };
}

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.clear();
});

describe('BIND answers a query without recursion', () => {
  it('answers the priming query for the root name servers from the hints', async () => {
    const { pc } = await lab();
    const out = await pc.executeCommand(`dig +norecurse . NS @${RESOLVER_IP}`);
    expect(out).toContain('status: NOERROR');
    expect(out).toMatch(/flags: qr ra;/);
    expect(out).toMatch(/ANSWER: 1,/);
    expect(out).toMatch(/^\.\s+3600000\s+IN\s+NS\s+A\.ROOT-SERVERS\.NET\.$/m);
    expect(out).toMatch(/^A\.ROOT-SERVERS\.NET\.\s+3600000\s+IN\s+A\s+10\.0\.0\.1$/m);
  });

  it('refers a name it has never seen to the root hints', async () => {
    const { pc } = await lab();
    const out = await pc.executeCommand(`dig +norecurse www.corp.test @${RESOLVER_IP}`);
    expect(out).toContain('status: NOERROR');
    expect(out).toMatch(/ANSWER: 0, AUTHORITY: 1,/);
    expect(out).toMatch(/AUTHORITY SECTION:\n\.\s+3600000\s+IN\s+NS\s+A\.ROOT-SERVERS\.NET\./);
    expect(out).not.toMatch(/flags:[^;]*\baa\b/);
  });

  it('answers from the cache once the name has been resolved', async () => {
    const { pc } = await lab();
    await pc.executeCommand(`dig www.corp.test @${RESOLVER_IP}`);
    const out = await pc.executeCommand(`dig +norecurse www.corp.test @${RESOLVER_IP}`);
    expect(out).toContain('status: NOERROR');
    expect(out).toMatch(/flags: qr ra;/);
    expect(out).toMatch(/^www\.corp\.test\.\s+\d+\s+IN\s+A\s+10\.0\.0\.80$/m);
  });

  it('answers a cached non-existence from the cache', async () => {
    const { pc } = await lab();
    expect(await pc.executeCommand(`dig nothere.corp.test @${RESOLVER_IP}`)).toContain('status: NXDOMAIN');
    const out = await pc.executeCommand(`dig +norecurse nothere.corp.test @${RESOLVER_IP}`);
    expect(out).toContain('status: NXDOMAIN');
  });

  it('lets dig +trace walk from the root hints to the answer through the resolver', async () => {
    const { pc } = await lab();
    const out = await pc.executeCommand(`dig +trace @${RESOLVER_IP} www.corp.test`);
    expect(out).toMatch(/^\.\s+3600000\s+IN\s+NS\s+A\.ROOT-SERVERS\.NET\.$/m);
    expect(out).toMatch(/^corp\.test\.\s+3600\s+IN\s+NS\s+ns\.corp\.test\.$/m);
    expect(out).toMatch(/^www\.corp\.test\.\s+3600\s+IN\s+A\s+10\.0\.0\.80$/m);
    expect((out.match(/;; Received \d+ bytes from/g) ?? []).length).toBe(3);
  });

  it('reads a hint file in the named.root layout with comments and an AAAA line', async () => {
    const { pc } = await lab();
    expect(await pc.executeCommand(`dig www.corp.test @${RESOLVER_IP} +short`)).toContain('10.0.0.80');
  });

  it('gives the resolver the glue of the hint file in the additional section', async () => {
    const { pc } = await lab();
    const out = await pc.executeCommand(`dig +norecurse www.corp.test @${RESOLVER_IP}`);
    expect(out).toMatch(/ADDITIONAL SECTION:\nA\.ROOT-SERVERS\.NET\.\s+3600000\s+IN\s+A\s+10\.0\.0\.1\n/);
  });

  it('keeps refusing a client that allow-recursion excludes', async () => {
    const { outsider } = await lab(conf(`${PC_IP};`));
    const out = await outsider.executeCommand(`dig +norecurse www.corp.test @${RESOLVER_IP}`);
    expect(out).toContain('status: REFUSED');
  });

  it('an authoritative-only server still refuses names outside its zones', async () => {
    const { pc } = await lab();
    const out = await pc.executeCommand(`dig +norecurse www.other.test @${CORP_IP}`);
    expect(out).toContain('status: REFUSED');
  });
});
