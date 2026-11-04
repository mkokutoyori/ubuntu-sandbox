/*
 * host against the real tool (bind9-host of BIND 9.18.39, Ubuntu 24.04): scripts/oracle/record_host.py started the lab of labs/dns-agence-bancaire (root, com, the two name servers of banquehorizon.com, the
 * resolver 10.20.20.53) and ran the real host on 43 questions, each twice: with the resolver named on the command line (host prints the `Using domain server:` block) and through /etc/resolv.conf (no block).
 * The replay builds the lab, asks the same questions from PC-CONSEILLER and compares what host prints, line by line, the order of the lines inside a block not being compared (the resolver rotates the
 * records of a set). Measured: without `-t` host asks A, AAAA and MX and prints what the three answers hold, an alias once, and nothing at all for a name that holds none of the three; with `-t` it asks that
 * type, in any case, and says `has no TYPE record` for an empty answer (a CNAME alone is an answer); an address makes it a PTR question whatever `-t` says, on the nibbles of ip6.arpa for IPv6; the targets
 * of CNAME, MX, NS, PTR, SOA and SRV records end with a dot, the owner never does; a refusal is `Host NAME not found: 3(NXDOMAIN)` where NAME is the name as typed, or the arpa name with its final dot for an
 * address; an unknown type is `host: invalid type: X` and no name prints the usage.
 * What is left out: `com NS` (in the real lab the TLD is a BIND, in this one a Windows DNS server) and the dead server (the real host says `network unreachable` in the namespace where it was recorded, the
 * simulator times out), which stay in the fixture.
 * Measured before the change (git stash push -- src/network): the replay of 85 questions fails with 72 of them different (the 13 that agree are the forward A questions of a name with one address asked without
 * a server, whose single line the old code already printed); the WITNESS passes either way, it only counts the fixture.
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

interface Case {
  readonly question: readonly string[];
  readonly server: boolean | string;
  readonly rc: number;
  readonly stdout: string;
  readonly stderr: string;
}

const fixture = JSON.parse(readFileSync(new URL('../../support/oracle/host-9.18.json', import.meta.url), 'utf8')) as { readonly cases: readonly Case[] };

const SET_ASIDE = new Set(['-t NS com']);
const asked = (entry: Case): string => entry.question.join(' ');
const normalised = (text: string): string[] => text.split('\n').map((line) => line.trimEnd()).filter((line) => line !== '').sort();

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  EquipmentRegistry.resetInstance();
  Logger.reset();
  useNetworkStore.getState().clearAll();
});

describe('host against the real tool', () => {
  it('WITNESS: the fixture holds every question with and without a server, the usage and the dead server', () => {
    const questions = new Set(fixture.cases.filter((entry) => entry.server === true).map(asked));
    expect(questions.size).toBe(43);
    expect(fixture.cases.filter((entry) => entry.server === false)).toHaveLength(44);
    expect(fixture.cases.filter((entry) => entry.server === 'dead')).toHaveLength(1);
  });

  it('every question prints what the real host prints', async () => {
    const lab = await buildDnsAgenceBancaire();
    const devices = new Map<string, Equipment>([...useNetworkStore.getState().deviceInstances.values()].map((device) => [device.getName(), device]));
    const client = devices.get('PC-CONSEILLER')!;
    const differing: string[] = [];
    let replayed = 0;
    for (const entry of fixture.cases) {
      if (entry.server === 'dead' || SET_ASIDE.has(asked(entry))) continue;
      const command = ['host', ...entry.question, ...(entry.server === true ? ['10.20.20.53'] : [])].join(' ');
      const text = await lab.bench.shell(client, command);
      replayed++;
      if (JSON.stringify(normalised(text)) !== JSON.stringify(normalised(`${entry.stdout}${entry.stderr}`))) differing.push(command);
    }
    expect(replayed).toBe(85);
    expect(differing).toEqual([]);
  });
});
