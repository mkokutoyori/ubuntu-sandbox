/*
 * rndc on zones and on the cache, and the CHAOS names, against a real BIND 9.18 (9.18.39, Ubuntu 24.04): scripts/oracle/record_bind_rndc.py started NS1-BANK of labs/dns-agence-bancaire alone and the
 * whole resolution tree with its resolver, and recorded what rndc and dig printed.
 * Primary part: `rndc reload banquehorizon.com` says `zone reload up-to-date` while the file is the one already loaded, and `zone reload queued` as soon as it differs, whether the serial was raised or
 * NOT (the record appended without touching the serial is served right after: named compares the file, only the secondaries compare serials); `rndc reload` alone says `server reload successful`; an unknown
 * zone is `rndc: 'reload' failed: not found` then `no matching zone 'nozone.example' in any view`; version.bind is the version `rndc status` prints, hostname.bind the host name.
 * Cache part: the resolver of the lab is asked the four questions of the recording (the CNAME www, the A of mail, the NXDOMAIN nexiste, the PTR of 203.0.113.20); `rndc flushname www.banquehorizon.com`
 * removes the sets of that name only (the A of web stays), a name that is not cached is not an error, `rndc flushtree banquehorizon.com` removes the name and everything below it (the delegation
 * data and the addresses of ns1 and ns2 included) and leaves com, the reverse zone and the root alone, and both commands without argument say `rndc: '<command>' failed: unexpected end of input`.
 * What is compared: the owner names that disappear from the cache dump after each command (the minimised questions of BIND 9.18 and the address database are not reproduced and are in the dump before and
 * after alike).
 * The version option: `version "hidden";` is the text of the answer to version.bind, and `version none;` answers NOERROR with no answer and the SOA of the name (`version.bind. 86400 CH SOA version.bind.
 * hostmaster.version.bind. 0 28800 7200 604800 86400`) in the authority section.
 * Measured before the change (git stash push -- src/network src/powershell): 9 of the 12 tests fall (the changed file was not reloaded without a new serial, the message said `zone reload successful`, a file broken after
 * its load answered `rndc: 'reload' failed` instead of `queued`, flushname and flushtree did not exist, version.bind said `bind-simulator` and the version option was not read); the 3 WITNESSes (what the fixtures hold) pass either way.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'fs';
import { IPAddress, SubnetMask, resetCounters, MACAddress } from '@/network/core/types';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { Cable } from '@/network/hardware/Cable';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { useNetworkStore } from '@/store/networkStore';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import type { Equipment } from '@/network';
import type { VirtualFileSystem } from '@/network/devices/linux/VirtualFileSystem';
import { buildDnsAgenceBancaire } from '@/labs/dnsAgenceBancaire/build';
import { BANK_ZONE } from '@/labs/dnsAgenceBancaire/dnsData';

interface Fixture {
  readonly named: string;
  readonly primary: Readonly<Record<string, string>>;
  readonly 'version-option': Readonly<Record<string, readonly string[]>>;
  readonly cache: Readonly<Record<string, string | readonly string[]>>;
}

const fixture = JSON.parse(readFileSync(new URL('../../support/oracle/bind-rndc-9.18.json', import.meta.url), 'utf8')) as Fixture;
const ZONE_FILE = '/etc/bind/db.banquehorizon.com';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  EquipmentRegistry.resetInstance();
  Logger.reset();
  useNetworkStore.getState().clearAll();
});

function writeRoot(server: LinuxServer, path: string, content: string): void {
  (server as unknown as { executor: { vfs: VirtualFileSystem } }).executor.vfs.writeFile(path, content, 0, 0, 0o022);
}

async function primaryLab(option = ''): Promise<{ pc: LinuxPC; server: LinuxServer }> {
  const pc = new LinuxPC('linux-pc', 'PC1');
  const server = new LinuxServer('linux-server', 'NS1');
  pc.configureInterface('eth0', new IPAddress('10.0.1.2'), new SubnetMask('255.255.255.0'));
  server.configureInterface('eth0', new IPAddress('10.0.1.10'), new SubnetMask('255.255.255.0'));
  new Cable('c1').connect(pc.getPort('eth0')!, server.getPort('eth0')!);
  writeRoot(server, '/etc/bind/named.conf', [
    `options { directory "/var/cache/bind"; recursion no; allow-query { any; }; ${option} };`,
    `zone "banquehorizon.com" { type primary; file "${ZONE_FILE}"; };`,
    '',
  ].join('\n'));
  writeRoot(server, ZONE_FILE, `${BANK_ZONE}\n`);
  await server.executeCommand('systemctl start named');
  return { pc, server };
}

function ownersOf(dump: string): Set<string> {
  const lines = dump.split('\n');
  const start = lines.findIndex((line) => line.startsWith('$DATE '));
  const end = lines.findIndex((line) => line === '; Address database dump');
  const owners = new Set<string>();
  for (const line of lines.slice(start + 1, end)) {
    if (line === '' || line.startsWith(';') || line.startsWith('$') || /^\s/.test(line)) continue;
    owners.add(line.split(/\s+/)[0].toLowerCase());
  }
  return owners;
}

const removed = (before: string, after: string): string[] => {
  const kept = ownersOf(after);
  return [...ownersOf(before)].filter((name) => !kept.has(name)).sort();
};

describe('rndc on a primary zone against the real BIND', () => {
  it('WITNESS: the fixture holds the answers that tell a changed file from an unchanged one', () => {
    expect(fixture.primary['reload-unchanged']).toBe('zone reload up-to-date');
    expect(fixture.primary['reload-without-serial']).toBe('zone reload queued');
    expect(fixture.primary['novelty-after-reload']).toBe('203.0.113.77');
    expect(fixture.primary['reload-broken']).toBe('zone reload queued');
    expect(fixture.primary['served-after-broken-reload']).toBe('203.0.113.25');
  });

  it('a file that did not change is up to date, one that changed is queued, whatever its serial', async () => {
    const { pc, server } = await primaryLab();
    expect(await server.executeCommand('sudo rndc reload banquehorizon.com')).toBe(fixture.primary['reload-unchanged']);
    writeRoot(server, ZONE_FILE, `${BANK_ZONE}\nnovelty IN A 203.0.113.77\n`);
    expect(await server.executeCommand('sudo rndc reload banquehorizon.com')).toBe(fixture.primary['reload-without-serial']);
    expect((await pc.executeCommand('dig @10.0.1.10 novelty.banquehorizon.com +short')).trim()).toBe(fixture.primary['novelty-after-reload']);
    expect(await server.executeCommand('sudo rndc reload banquehorizon.com')).toBe(fixture.primary['reload-again']);
  });

  it('a file broken after it was loaded is queued, the zone already loaded keeps being served, the cause goes to the log, and the repaired file is queued again', async () => {
    const { pc, server } = await primaryLab();
    writeRoot(server, ZONE_FILE, BANK_ZONE.replace('mail IN A 203.0.113.25', 'mail IN A 203.0.113.25 oops'));
    expect(await server.executeCommand('sudo rndc reload banquehorizon.com')).toBe(fixture.primary['reload-broken']);
    expect((await pc.executeCommand('dig @10.0.1.10 mail.banquehorizon.com +short')).trim()).toBe(fixture.primary['served-after-broken-reload']);
    expect(await server.executeCommand('sudo rndc reload banquehorizon.com')).toBe(fixture.primary['reload-broken-again']);
    expect(await server.executeCommand('sudo grep named /var/log/syslog')).toContain('failed: extra input text');
    writeRoot(server, ZONE_FILE, BANK_ZONE);
    expect(await server.executeCommand('sudo rndc reload banquehorizon.com')).toBe(fixture.primary['reload-fixed']);
  });

  it('rndc reload alone and an unknown zone', async () => {
    const { server } = await primaryLab();
    expect(await server.executeCommand('sudo rndc reload')).toBe(fixture.primary['reload-all']);
    expect(await server.executeCommand('sudo rndc reload nozone.example')).toBe(fixture.primary['reload-unknown-zone']);
  });

  it('version.bind is the version rndc status prints, and hostname.bind the host name', async () => {
    const { pc, server } = await primaryLab();
    const shown = /^version: BIND (\S+) \(Extended Support Version\) <id:>$/.exec((await server.executeCommand('sudo rndc status')).split('\n')[0])![1];
    expect(fixture.primary['status-first-line']).toMatch(/^version: BIND \S+ \(Extended Support Version\) <id:>$/);
    expect(fixture.primary['version.bind']).toBe(`"${/^version: BIND (\S+) /.exec(fixture.primary['status-first-line'])![1]}"`);
    expect((await pc.executeCommand('dig @10.0.1.10 version.bind CHAOS TXT +short')).trim()).toBe(`"${shown}"`);
    expect((await pc.executeCommand('dig @10.0.1.10 hostname.bind CHAOS TXT +short')).trim()).toBe('"NS1"');
  });
});

describe('the version option against the real BIND', () => {
  it('WITNESS: the real server answers the text of `version "hidden";` and an empty answer with an SOA for `version none;`', () => {
    expect(fixture['version-option']['string']).toContain('version.bind.\t\t0\tCH\tTXT\t"hidden"');
    expect(fixture['version-option']['none']).toEqual([';; flags: qr aa rd; QUERY: 1, ANSWER: 0, AUTHORITY: 1, ADDITIONAL: 1']);
  });

  it('version "hidden"; is the text of the answer', async () => {
    const { pc } = await primaryLab('version "hidden";');
    expect((await pc.executeCommand('dig @10.0.1.10 version.bind CHAOS TXT +short')).trim()).toBe('"hidden"');
  });

  it('version none; answers nothing, with the SOA of the name in the authority section', async () => {
    const { pc } = await primaryLab('version none;');
    const text = await pc.executeCommand('dig @10.0.1.10 version.bind CHAOS TXT +noall +comments +answer +authority');
    expect(text).toContain('status: NOERROR');
    expect(text).toMatch(/flags: qr aa rd; QUERY: 1, ANSWER: 0, AUTHORITY: 1/);
    expect(text).toMatch(/version\.bind\.\s+86400\s+CH\s+SOA\s+version\.bind\. hostmaster\.version\.bind\. 0 28800 7200 604800 86400/);
  });
});

describe('rndc on the cache of the resolver against the real BIND', () => {
  async function resolverLab() {
    await buildDnsAgenceBancaire();
    const devices = new Map<string, Equipment>([...useNetworkStore.getState().deviceInstances.values()].map((device) => [device.getName(), device]));
    const client = devices.get('PC-CONSEILLER')!;
    const resolver = devices.get('DNS-RES')!;
    for (const question of fixture.cache['questions'] as readonly string[]) await client.executeCommand(`dig @10.20.20.53 ${question} +noall`);
    const dump = async (): Promise<string> => {
      await resolver.executeCommand('sudo rndc dumpdb -cache');
      return resolver.executeCommand('cat /var/cache/bind/named_dump.db');
    };
    return { resolver, dump };
  }

  it('WITNESS: the real resolver cached the four questions and dropped only what was flushed', () => {
    const owners = ownersOf(fixture.cache['dump-before'] as string);
    for (const name of ['www.banquehorizon.com.', 'web.banquehorizon.com.', 'mail.banquehorizon.com.', 'nexiste.banquehorizon.com.']) expect(owners.has(name), name).toBe(true);
    expect(removed(fixture.cache['dump-before'] as string, fixture.cache['dump-after-flushname'] as string)).toEqual(['www.banquehorizon.com.']);
  });

  it('flushname removes the sets of that name and nothing else', async () => {
    const { resolver, dump } = await resolverLab();
    const before = await dump();
    expect(await resolver.executeCommand('sudo rndc flushname www.banquehorizon.com')).toBe(fixture.cache['flushname-result']);
    const after = await dump();
    expect(removed(before, after)).toEqual(removed(fixture.cache['dump-before'] as string, fixture.cache['dump-after-flushname'] as string));
    expect(await resolver.executeCommand('sudo rndc flushname absent.banquehorizon.com')).toBe(fixture.cache['flushname-uncached-result']);
  });

  it('flushtree removes the name and everything below it, the delegation data included', async () => {
    const { resolver, dump } = await resolverLab();
    await resolver.executeCommand('sudo rndc flushname www.banquehorizon.com');
    const before = await dump();
    expect(await resolver.executeCommand('sudo rndc flushtree banquehorizon.com')).toBe(fixture.cache['flushtree-result']);
    const after = await dump();
    expect(removed(before, after)).toEqual(removed(fixture.cache['dump-after-flushname'] as string, fixture.cache['dump-after-flushtree'] as string));
    expect(ownersOf(after).has('com.')).toBe(true);
    expect(ownersOf(after).has('113.0.203.in-addr.arpa.')).toBe(true);
  });

  it('flushname and flushtree without argument', async () => {
    const { resolver } = await resolverLab();
    expect(await resolver.executeCommand('sudo rndc flushname')).toBe(fixture.cache['flushname-without-argument']);
    expect(await resolver.executeCommand('sudo rndc flushtree')).toBe(fixture.cache['flushtree-without-argument']);
  });
});
