/**
 * The answer a BIND resolver gives its own clients, against a real BIND 9.18 (9.18.39, Ubuntu 24.04): scripts/oracle/record_bind_recursive_response.py started the lab of labs/dns-agence-bancaire
 * (root, com, the two name servers of banquehorizon.com, the resolver 10.20.20.53) once per `minimal-responses` value (no, yes, no-auth, no-auth-recursive), flushed the resolver cache before each of
 * thirteen questions and had the real dig ask it five ways: cold without recursion (empty cache), cold (the resolver walks the tree), warm (answered from the cache), warm without recursion and
 * warm without EDNS, printing the header comments and the three record sections. The replay builds the lab, gives DNS-RES the same option, flushes it with `rndc flush`, asks the same questions from
 * PC-CONSEILLER and compares the flags line (the counts), the OPT pseudo-section and the records of each section; the order of the records inside a section is not compared and TTLs are rounded up to
 * the zone's own values (the real resolver answered a second or two later).
 * Measured: the authority section of a positive answer is the NS set of the closest enclosing zone the cache holds and the additional section holds the addresses of the targets of the answer (NS, MX,
 * SRV) then of those name servers, except the names the answer already carries; an NS answer has no authority and keeps its addresses; a negative answer keeps its SOA and nothing else; the OPT of
 * the question is echoed (1232 bytes) and nothing is added when the question has none; cold, warm and warm without recursion say the same thing; `yes` keeps only the answer (and the addresses of an
 * NS answer), `no-auth` drops the authority and keeps the addresses the answer needs, `no-auth-recursive` does that when the question asks for recursion and nothing otherwise; asked without
 * recursion with an empty cache, the resolver answers with the root hints in the authority section, the OPT alone in the additional section, and no answer even for `. NS`.
 * What is left out: the questions `com NS`, `a.nic.com A` and `. NS` (in the real lab the TLD is a BIND, in this one it is a Windows DNS server whose answers carry other TTLs and no glue), which stay in the
 * fixture for the day the TLD is the same server.
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

interface Case {
  readonly setting: string;
  readonly question: readonly string[];
  readonly mode: string;
  readonly output: string;
}

const fixture = JSON.parse(readFileSync(new URL('../../support/oracle/bind-recursive-response-9.18.json', import.meta.url), 'utf8')) as { readonly cases: readonly Case[] };

const SETTINGS = ['no', 'yes', 'no-auth', 'no-auth-recursive'];
const FLAGS: Readonly<Record<string, string>> = {
  'cold-norecurse': '+norecurse',
  cold: '+recurse',
  warm: '+recurse',
  'warm-norecurse': '+norecurse',
  'warm-noedns': '+recurse +noedns',
};
const SET_ASIDE = new Set(['com NS', 'a.nic.com A', '. NS']);
const TTL_LADDER = [3600, 10800, 86400, 3600000];
const NOISE = /^(;; ->>HEADER<<-|; COOKIE:)/;
const RECORD_HEAD = /^(\S*)(\s+)(\d+)(\s+)(?=(?:IN )?[A-Z]+\s)/;

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  EquipmentRegistry.resetInstance();
  Logger.reset();
  useNetworkStore.getState().clearAll();
});

function normalised(output: string): string[] {
  const lines: string[] = [];
  let records: string[] = [];
  const flush = () => { lines.push(...records.sort()); records = []; };
  for (const line of output.split('\n')) {
    if (NOISE.test(line) || line.trim() === '') continue;
    if (line.startsWith(';')) { flush(); lines.push(line); continue; }
    const rounded = line.replace(RECORD_HEAD, (_whole, owner: string, _gap: string, ttl: string, _after: string) =>
      `${owner} ${TTL_LADDER.find((candidate) => Number(ttl) <= candidate) ?? ttl} `);
    records.push(rounded.replace(/\s+/g, ' '));
  }
  flush();
  return lines;
}

const questionText = (question: readonly string[]): string => question.join(' ');

describe('the answer of a BIND resolver to its clients against the real BIND', () => {
  it('WITNESS: the fixture holds the four values, five ways of asking and thirteen questions', () => {
    expect(new Set(fixture.cases.map((entry) => entry.setting))).toEqual(new Set(SETTINGS));
    expect(new Set(fixture.cases.map((entry) => entry.mode))).toEqual(new Set(Object.keys(FLAGS)));
    expect(fixture.cases).toHaveLength(SETTINGS.length * 13 * 5);
  });

  it('WITNESS: the real resolver wrote an authority and glue next to a cached answer and echoed the OPT', () => {
    const warm = fixture.cases.find((entry) => entry.setting === 'no' && entry.mode === 'warm' && questionText(entry.question) === 'www.banquehorizon.com A')!;
    expect(warm.output).toContain('AUTHORITY: 2, ADDITIONAL: 3');
    expect(warm.output).toMatch(/; EDNS: version: 0, flags:; udp: 1232/);
  });

  for (const setting of SETTINGS) {
    it(`minimal-responses ${setting}: every question gets the sections the real resolver writes`, async () => {
      const lab = await buildDnsAgenceBancaire();
      const devices = new Map<string, Equipment>([...useNetworkStore.getState().deviceInstances.values()].map((device) => [device.getName(), device]));
      const client = devices.get('PC-CONSEILLER')!;
      const resolver = devices.get('DNS-RES')!;
      await lab.bench.writeFile(resolver, '/etc/bind/named.conf', RESOLVER_NAMED_CONF.replace('    empty-zones-enable no;', `    empty-zones-enable no;\n    minimal-responses ${setting};`));
      await lab.bench.shell(resolver, 'sudo systemctl restart named');
      const questions = fixture.cases.filter((entry) => entry.setting === setting && entry.mode === 'cold-norecurse').map((entry) => entry.question);
      for (const question of questions) {
        if (SET_ASIDE.has(questionText(question))) continue;
        await resolver.executeCommand('sudo rndc flush');
        for (const entry of fixture.cases.filter((candidate) => candidate.setting === setting && questionText(candidate.question) === questionText(question))) {
          const asked = `dig @10.20.20.53 ${questionText(question)} +noall +comments +answer +authority +additional ${FLAGS[entry.mode]}`;
          const text = await client.executeCommand(asked);
          expect(normalised(text), `${entry.mode}: ${asked}`).toEqual(normalised(entry.output));
        }
      }
    });
  }
});
