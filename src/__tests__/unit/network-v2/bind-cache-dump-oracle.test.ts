/**
 * `rndc dumpdb -cache` against a real BIND 9.18 (9.18.39, Ubuntu 24.04): scripts/oracle/record_bind_cache_dump.py started five named on loopback aliases that carry the addresses of
 * labs/dns-agence-bancaire (root 198.51.100.1, com 198.51.100.2, the two name servers of banquehorizon.com 203.0.113.10 and .11, the resolver 10.20.20.53), asked the resolver the nine
 * questions of its STEPS (the CNAME www, an NXDOMAIN, a NODATA, MX, TXT, SOA, a PTR, an SRV, the CNAME ebanking) and kept the file the resolver wrote after the first, the fourth and the last.
 * The replay builds the lab, asks DNS-RES the same nine questions from PC-CONSEILLER with dig, runs `sudo rndc dumpdb -cache` on DNS-RES at the same three points and reads /var/cache/bind/named_dump.db.
 * What is compared, block by block and in order: the header up to `$DATE`, every cached rdataset with its trust line (`; authanswer`, `; answer`, `; glue`), the owner name kept or left blank, the TTL, class and
 * type columns the way masterdump lays them out (tabs to column 24, 32 and 40, a single space after a name of 24 characters or more, the class printed once), the SOA over several lines with its comments,
 * the negative entries (`\-ANY ;-$NXDOMAIN`, `\-AAAA ;-$NXRRSET`) with the SOA summary under them, the order of the nodes (canonical DNS order) and of the sets inside a node (SOA, NS, then by type), and the sections
 * after the cache (address database, bad cache, SERVFAIL cache) and the empty `_bind` view. TTLs are rounded up to the zone's own values (the real resolver answered a second or two later).
 * What is left out, because the simulator does not do it and says so in TODO.md: the NS rdatasets (the real resolver learns them from the authority section of an authoritative answer, `; authauthority`, which the
 * simulator's servers do not send; it holds them as `; glue` from the referral), the priming query of the root (`. NS`), the minimised questions of BIND 9.18 (its `\-NS` entries for `_tcp.banquehorizon.com`, `arpa.`...),
 * the `; additional` sets the real resolver keeps from the additional section, and the address database entries (round-trip times, cookies).
 * Measured before the change (git stash push -- src/network): `rndc dumpdb` wrote the zones the server holds and never its cache, so the replay (3 dumps) falls; the 2 WITNESSes (the fixture holds the records,
 * the lab answers the questions) pass either way.
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

interface Fixture {
  readonly named: string;
  readonly steps: ReadonlyArray<{ readonly label: string; readonly arguments: readonly string[] }>;
  readonly dumps: Readonly<Record<string, string>>;
}

const fixture = JSON.parse(readFileSync(new URL('../../support/oracle/bind-cache-dump-9.18.json', import.meta.url), 'utf8')) as Fixture;
const CHECKPOINTS = Object.keys(fixture.dumps);
const TRUST_LINE = /^; (authanswer|authauthority|glue|answer|additional|pending|secure)$/;
const ZONE_TTLS = [3600, 10800, 86400, 604800];
const RECORD_HEAD = /^(\S*)([\t ]+)(\d+)([\t ]+)(?=(?:IN )?\\?-?[A-Z]+[\t ])/;

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  EquipmentRegistry.resetInstance();
  Logger.reset();
  useNetworkStore.getState().clearAll();
});

function roundedUp(ttl: number): number {
  return ZONE_TTLS.find((candidate) => ttl <= candidate) ?? ttl;
}

function normalisedLine(line: string): string {
  return line.replace(RECORD_HEAD, (_whole, owner: string, gap: string, ttl: string, after: string) => `${owner}${gap}${roundedUp(Number(ttl))}${after}`);
}

interface Parts {
  readonly head: string[];
  readonly blocks: string[];
  readonly tail: string[];
}

function partsOf(dump: string): Parts {
  const lines = dump.split('\n').filter((line, index, all) => index < all.length - 1 || line !== '');
  const dateAt = lines.findIndex((line) => line.startsWith('$DATE '));
  const adbAt = lines.findIndex((line) => line === '; Address database dump') - 1;
  const head = lines.slice(0, dateAt + 1).map((line) => (line.startsWith('$DATE ') ? '$DATE' : line));
  const tail = lines.slice(adbAt)
    .filter((line) => !/^; \S+ \[v4 TTL/.test(line) && !/^;\t\S+ \[srtt/.test(line))
    .map((line) => (line.startsWith('$DATE ') ? '$DATE' : line));
  const blocks: string[] = [];
  for (const line of lines.slice(dateAt + 1, adbAt)) {
    if (TRUST_LINE.test(line)) blocks.push(line);
    else blocks[blocks.length - 1] += `\n${normalisedLine(line)}`;
  }
  return { head, blocks, tail };
}

function compared(blocks: readonly string[]): string[] {
  return blocks.filter((block) => {
    if (block.startsWith('; additional')) return false;
    if (block.includes('\\-NS\t')) return false;
    return !/\n[^\n]*\t(IN )?NS\t/.test(block);
  });
}

async function replay(): Promise<Record<string, string>> {
  await buildDnsAgenceBancaire();
  const devices = new Map<string, Equipment>([...useNetworkStore.getState().deviceInstances.values()].map((device) => [device.getName(), device]));
  const client = devices.get('PC-CONSEILLER')!;
  const resolver = devices.get('DNS-RES')!;
  const dumps: Record<string, string> = {};
  for (const step of fixture.steps) {
    await client.executeCommand(`dig @10.20.20.53 ${step.arguments.join(' ')} +noall`);
    if (CHECKPOINTS.includes(step.label)) {
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

  it('the cache the resolver dumps is the cache the real resolver dumps', async () => {
    const dumps = await replay();
    for (const label of CHECKPOINTS) {
      const real = partsOf(fixture.dumps[label]);
      const here = partsOf(dumps[label]);
      expect(compared(real.blocks).length, `${label}: the real dump holds comparable blocks`).toBeGreaterThanOrEqual(label === 'www' ? 3 : 8);
      expect(here.head, `${label}: header`).toEqual(real.head);
      expect(compared(here.blocks), `${label}: blocks`).toEqual(compared(real.blocks));
      expect(here.tail, `${label}: sections after the cache`).toEqual(real.tail);
    }
  });
});
