/**
 * `rndc dumpdb -cache` against a real BIND 9.18 (9.18.39, Ubuntu 24.04): scripts/oracle/record_bind_cache_dump.py started six named on loopback aliases that carry the addresses of
 * labs/dns-agence-bancaire (root 198.51.100.1, com 198.51.100.2, the two name servers of banquehorizon.com 203.0.113.10 and .11, the resolver 10.20.20.53, plus 203.0.113.99 where nothing listens) in a
 * network namespace, asked the resolver the eleven questions of its STEPS (the CNAME www, an NXDOMAIN, a NODATA, MX, TXT, SOA, a PTR, an SRV, the CNAME ebanking, an NXDOMAIN of the root, a name under a
 * delegation whose server is silent) and kept the file the resolver wrote after the first, the fourth, the ninth and the last. A second resolver, started with `max-cache-ttl 600; max-ncache-ttl 120;`, answered three
 * questions and was dumped once (the `caps` entry).
 * The replay builds the lab, gives DNS-RES `servfail-ttl 30`, delegates broken.com to a silent address on the TLD server, asks DNS-RES the same questions from PC-CONSEILLER with dig, runs
 * `sudo rndc dumpdb -cache` at the same points and reads /var/cache/bind/named_dump.db.
 * What is compared, block by block and in order: the header up to `$DATE`, every cached rdataset with its trust line (`; authanswer`, `; authauthority`, `; answer`, `; glue`, `; additional`), the owner name kept or
 * left blank, the TTL, class and type columns the way masterdump lays them out (tabs to column 24, 32 and 40, a single space after a name of 24 characters or more, the class printed once), the SOA over several
 * lines with its comments, the NS rdatasets the resolver learns from the authority section of an authoritative answer, the glue that outranks the additional section, the priming answer of the root (`. NS`), the
 * negative entries (`\-ANY ;-$NXDOMAIN`, `\-AAAA ;-$NXRRSET`) with the SOA summary under them and their ceiling (`max-ncache-ttl` 10800 by default, 120 when set), the positive ceiling (`max-cache-ttl`), the order
 * of the nodes (canonical DNS order) and of the sets inside a node (SOA, NS, then by type), and the sections after the cache (address database header, bad cache, SERVFAIL cache with its `name/TYPE [ttl ms]` lines)
 * and the empty `_bind` view. TTLs are rounded up to the zone's own values (the real resolver answered a second or two later).
 * What is left out, because the simulator does not do it and says so in TODO.md: the minimised questions of BIND 9.18 (its `\-NS` entries for `_tcp.banquehorizon.com`, `arpa.`...) and the address database
 * entries (round-trip times, cookies).
 * Measured before the change (git stash push -- src/network): 2 of the 5 tests fall, the replay of the four checkpoints (no authauthority NS, no additional sets, no priming, no SERVFAIL line) and the replay with
 * the ceilings (600 and 120 not applied); the 3 WITNESSes pass either way (the fixture holds the records, the lab answers the questions, the real resolver wrote what the replay expects to find).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'fs';
import { useNetworkStore } from '@/store/networkStore';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import type { Equipment } from '@/network';
import { buildDnsAgenceBancaire } from '@/labs/dnsAgenceBancaire/build';
import { RESOLVER_NAMED_CONF } from '@/labs/dnsAgenceBancaire/dnsData';

interface Step {
  readonly label: string;
  readonly arguments: readonly string[];
}

interface Fixture {
  readonly named: string;
  readonly steps: readonly Step[];
  readonly dumps: Readonly<Record<string, string>>;
  readonly caps: { readonly options: string; readonly steps: readonly Step[]; readonly dump: string };
}

const fixture = JSON.parse(readFileSync(new URL('../../support/oracle/bind-cache-dump-9.18.json', import.meta.url), 'utf8')) as Fixture;
const CHECKPOINTS = Object.keys(fixture.dumps);
const TRUST_LINE = /^; (authanswer|authauthority|glue|answer|additional|pending|secure)$/;
const ZONE_TTLS = [3600, 10800, 86400, 604800];
const CAPPED_TTLS = [120, 600];
const RECORD_HEAD = /^(\S*)([\t ]+)(\d+)([\t ]+)(?=(?:IN )?\\?-?[A-Z]+[\t ])/;
const RESOLVER_OPTIONS = 'servfail-ttl 30;';
const SERVFAIL_LINE = /^(; \S+\/[A-Z]+ \[ttl )\d+(\])$/;

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  EquipmentRegistry.resetInstance();
  Logger.reset();
  useNetworkStore.getState().clearAll();
});

function roundedUp(ttl: number, ladder: readonly number[]): number {
  return ladder.find((candidate) => ttl <= candidate) ?? ttl;
}

function normalisedLine(line: string, ladder: readonly number[]): string {
  return line.replace(RECORD_HEAD, (_whole, owner: string, gap: string, ttl: string, after: string) => `${owner}${gap}${roundedUp(Number(ttl), ladder)}${after}`);
}

interface Parts {
  readonly head: string[];
  readonly blocks: string[];
  readonly tail: string[];
}

function partsOf(dump: string, ladder: readonly number[] = ZONE_TTLS): Parts {
  const lines = dump.split('\n').filter((line, index, all) => index < all.length - 1 || line !== '');
  const dateAt = lines.findIndex((line) => line.startsWith('$DATE '));
  const adbAt = lines.findIndex((line) => line === '; Address database dump') - 1;
  const head = lines.slice(0, dateAt + 1).map((line) => (line.startsWith('$DATE ') ? '$DATE' : line));
  const tail = lines.slice(adbAt)
    .filter((line) => !/^; \S+ \[v4 TTL/.test(line) && !/^;\t\S+ \[srtt/.test(line))
    .map((line) => (line.startsWith('$DATE ') ? '$DATE' : line.replace(SERVFAIL_LINE, '$1…$2')));
  const blocks: string[] = [];
  for (const line of lines.slice(dateAt + 1, adbAt)) {
    if (TRUST_LINE.test(line)) blocks.push(line);
    else blocks[blocks.length - 1] += `\n${normalisedLine(line, ladder)}`;
  }
  return { head, blocks, tail };
}

function compared(blocks: readonly string[]): string[] {
  return blocks.filter((block) => !block.includes('\\-NS\t'));
}

async function replay(resolverOptions: string, steps: readonly Step[], checkpoints: readonly string[]): Promise<Record<string, string>> {
  const lab = await buildDnsAgenceBancaire();
  const devices = new Map<string, Equipment>([...useNetworkStore.getState().deviceInstances.values()].map((device) => [device.getName(), device]));
  const client = devices.get('PC-CONSEILLER')!;
  const resolver = devices.get('DNS-RES')!;
  await lab.bench.writeFile(resolver, '/etc/bind/named.conf', RESOLVER_NAMED_CONF.replace('    empty-zones-enable no;', `    empty-zones-enable no;\n    ${resolverOptions}`));
  await lab.bench.shell(resolver, 'sudo systemctl restart named');
  await lab.bench.powershell(
    devices.get('TLD-NS')!,
    'Add-DnsServerZoneDelegation -Name com -ChildZoneName broken -NameServer ns.broken.com -IPAddress 203.0.113.99',
  );
  const dumps: Record<string, string> = {};
  for (const step of steps) {
    await client.executeCommand(`dig @10.20.20.53 ${step.arguments.join(' ')} +noall`);
    if (checkpoints.includes(step.label)) {
      await resolver.executeCommand('sudo rndc dumpdb -cache');
      dumps[step.label] = `${await resolver.executeCommand('cat /var/cache/bind/named_dump.db')}\n`;
    }
  }
  return dumps;
}

describe('rndc dumpdb -cache against the real BIND', () => {
  it('WITNESS: the fixture holds the CNAME and the negative answers the questions produce', () => {
    const last = fixture.dumps['ebanking'];
    expect(last).toContain('www.banquehorizon.com.\t');
    expect(last).toMatch(/\\-ANY\t;-\$NXDOMAIN/);
    expect(last).toMatch(/\\-AAAA\t;-\$NXRRSET/);
  });

  it('WITNESS: the lab answers the questions through its resolver', async () => {
    await buildDnsAgenceBancaire();
    const devices = new Map<string, Equipment>([...useNetworkStore.getState().deviceInstances.values()].map((device) => [device.getName(), device]));
    const text = await devices.get('PC-CONSEILLER')!.executeCommand('dig @10.20.20.53 www.banquehorizon.com +short');
    expect(text).toContain('203.0.113.20');
  });

  it('WITNESS: the real resolver wrote what the replay expects to find (priming, authauthority, additional, SERVFAIL line, ceiling)', () => {
    const last = fixture.dumps['broken'];
    expect(last).toMatch(/; authanswer\n\.\t+\d+\tIN NS\ta\.root-servers\.net\./);
    expect(last).toMatch(/; authauthority\n\t+\d+\tNS\tns1\.banquehorizon\.com\./);
    expect(last).toContain('; additional\nmail.banquehorizon.com.');
    expect(last).toMatch(/; SERVFAIL cache\n;\n; www\.broken\.com\/A \[ttl \d+\]/);
    expect(last).toMatch(/nosuchtld\.\t+10800\t\\-ANY/);
  });

  it('the cache the resolver dumps is the cache the real resolver dumps', async () => {
    const dumps = await replay(RESOLVER_OPTIONS, fixture.steps, CHECKPOINTS);
    for (const label of CHECKPOINTS) {
      const real = partsOf(fixture.dumps[label]);
      const here = partsOf(dumps[label]);
      expect(compared(real.blocks).length, `${label}: the real dump holds comparable blocks`).toBeGreaterThanOrEqual(label === 'www' ? 8 : 12);
      expect(here.head, `${label}: header`).toEqual(real.head);
      expect(compared(here.blocks), `${label}: blocks`).toEqual(compared(real.blocks));
      expect(here.tail, `${label}: sections after the cache`).toEqual(real.tail);
    }
  });

  it('max-cache-ttl and max-ncache-ttl bound what the resolver keeps, as in the real one', async () => {
    const label = fixture.caps.steps[fixture.caps.steps.length - 1].label;
    const dumps = await replay(fixture.caps.options, fixture.caps.steps, [label]);
    const real = partsOf(fixture.caps.dump, CAPPED_TTLS);
    const here = partsOf(dumps[label], CAPPED_TTLS);
    expect(compared(real.blocks).length).toBeGreaterThanOrEqual(8);
    expect(compared(here.blocks)).toEqual(compared(real.blocks));
    expect(here.tail).toEqual(real.tail);
  });
});
