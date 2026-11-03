/*
 * Oracle - the stub of systemd-resolved (127.0.0.53) of PC-CONSEILLER, replayed against what a real systemd-resolved 255.4 answered over the same tree.
 * scripts/oracle/record_resolved_stub.py starts the five named of the lab labs/dns-agence-bancaire (root, com, the two name servers of banquehorizon.com, the recursive resolver) on
 * loopback aliases that carry the lab's addresses, starts systemd-resolved with DNS=10.20.20.53 inside `unshare -n -m` and asks the stub 24 questions with `dig @127.0.0.53`, waiting
 * 5 seconds before every question asked a second time. The fixture src/__tests__/support/oracle/resolved-stub-255.json holds each reply parsed: status, header flags, the EDNS payload
 * size, the three sections.
 *
 * What is compared, step by step: the status; the header flags (`qr rd ra` for a forwarded answer, `qr aa rd ra ad` for one synthesised from /etc/hosts); the EDNS payload size the stub
 * announces (65494); the set of answer records by type and data (the order is the upstream's: BIND rotates the MX records); for a negative answer the SOA of the authority section; and the
 * TTLs: an answer asked a second time carries its first TTL minus the wait, a record kept above two hours comes back capped at 7200 minus the wait, a record synthesised from /etc/hosts
 * has TTL 0. The recorded waits themselves are checked (5 to 7 seconds) so that the fixture cannot drift from the delay the replay uses.
 * The replay asks with `+bufsize=1232`, which is what dig 9.18 does by default (an OPT record in every query); the simulated dig sends no OPT unless asked, and the stub answers EDNS only to a query that carried it (TODO.md).
 * Not compared, and named: the NS records the real stub copies into the authority section of a positive answer and the glue it copies into the additional section (resolved composes the
 * reply from its cache and the delegation it learned; the simulated stub forwards the answer section only), and the order of the records inside one answer, and the single TTL the real stub gives to every record of an answer served from its cache
 * (the smallest of the message it cached, authority and glue included: all 3573 in mx-again whereas the first reply showed 3600 and 3579; the simulated stub lets each record decay on its own).
 *
 * Measured first (git stash push -- src/network src/powershell, this file and dns-agence-bancaire-linux-cache.test.ts together, 18 tests): 15 fall. The 3 that pass either way: the WITNESS on the recording (it
 * reads the fixture only), the WITNESS on the replay lab (the lab's own upstream answers a direct dig, so a failure of the replay is the stub's and not the lab's), and the localhost / hosts-name
 * test of the Linux probe (answered from /etc/hosts without leaving the machine). Before the change the stub held no server, answered A and AAAA only, and gave an A record owned by the asked
 * name with TTL 60 whatever the upstream sent.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { bench, resetWorld } from '../labs/_dnsLabBench';

interface Row { readonly name: string; readonly ttl: number; readonly type: string; readonly rdata: string }
interface Reply {
  readonly status: string | null;
  readonly flags: readonly string[];
  readonly edns: { readonly udp: number } | null;
  readonly answer: readonly Row[];
  readonly authority: readonly Row[];
  readonly additional: readonly Row[];
}
interface Step { readonly label: string; readonly delay: number; readonly arguments: readonly string[]; readonly reply: Reply }
interface Fixture { readonly resolved: string; readonly delay: number; readonly steps: readonly Step[] }

const fixture: Fixture = JSON.parse(readFileSync(new URL('../../support/oracle/resolved-stub-255.json', import.meta.url), 'utf8'));
const ROW = /^(\S+)\s+(\d+)\s+IN\s+(\S+)\s+(.*)$/;
const ASK = 'PC-CONSEILLER';
const WAIT = fixture.delay;
const FIRST_TTL_MARGIN = 40;
const RESOLVED_CAP = 7200;

function parseDig(output: string): Reply {
  let status: string | null = null;
  let flags: string[] = [];
  let edns: { udp: number } | null = null;
  const sections: Record<string, Row[]> = { answer: [], authority: [], additional: [] };
  let section: string | null = null;
  for (const line of output.split('\n')) {
    const header = /status: (\w+)/.exec(line);
    if (header) status = header[1];
    const flagLine = /^;; flags: ([a-z ]*);/.exec(line);
    if (flagLine) flags = flagLine[1].split(' ').filter((flag) => flag !== '');
    const option = /^; EDNS: version: \d+, flags:[a-z ]*; udp: (\d+)/.exec(line);
    if (option) edns = { udp: Number(option[1]) };
    const marker = /^;; (ANSWER|AUTHORITY|ADDITIONAL) SECTION:/.exec(line);
    if (marker) { section = marker[1].toLowerCase(); continue; }
    if (line.trim() === '' || line.startsWith(';')) continue;
    const row = ROW.exec(line);
    if (row && section) sections[section].push({ name: row[1], ttl: Number(row[2]), type: row[3], rdata: row[4].trim() });
  }
  return { status, flags, edns, answer: sections.answer, authority: sections.authority, additional: sections.additional };
}

function answerSet(reply: Reply): string[] {
  return reply.answer.map((row) => `${row.type} ${row.rdata}`).sort();
}

function negativeSoa(reply: Reply): boolean {
  return reply.authority.some((row) => row.type === 'SOA');
}

function minTtl(reply: Reply): number {
  return Math.min(...[...reply.answer, ...reply.authority, ...reply.additional].map((row) => row.ttl));
}

function ttlOf(reply: Reply): number {
  return (negativeSoa(reply) ? reply.authority.find((row) => row.type === 'SOA')! : reply.answer[0]).ttl;
}

const argumentsOf = (step: Step): string => step.arguments.join(' ');

describe('Oracle - the stub of systemd-resolved 255 against the simulated stub of PC-CONSEILLER', () => {
  beforeEach(resetWorld);

  it('WITNESS: the recording holds the 24 questions, with a wait of 5 seconds before a repeated one and a measured decay of 5 to 7 seconds of the smallest TTL of the message', () => {
    expect(fixture.steps).toHaveLength(24);
    expect(fixture.resolved).toContain('systemd 255');
    for (const step of fixture.steps.filter((candidate) => candidate.label.endsWith('-again'))) {
      const first = fixture.steps.find((candidate) => candidate.label === step.label.replace('-again', ''))!;
      expect(step.delay).toBe(WAIT);
      if (step.label === 'long-ttl-again') {
        expect(RESOLVED_CAP - minTtl(step.reply)).toBeGreaterThanOrEqual(WAIT);
        expect(RESOLVED_CAP - minTtl(step.reply)).toBeLessThanOrEqual(WAIT + 2);
      } else {
        expect(minTtl(first.reply) - minTtl(step.reply)).toBeGreaterThanOrEqual(WAIT);
        expect(minTtl(first.reply) - minTtl(step.reply)).toBeLessThanOrEqual(WAIT + 2);
      }
    }
  });

  it('WITNESS: the replay lab reaches the upstream of the stub, a direct dig to the server of the lease answers', async () => {
    const lab = await bench();
    const direct = await lab.asked(ASK, 'sh', 'dig @10.20.20.10 www.banquehorizon.com +short');
    expect(direct.output).toContain('203.0.113.20');
  });

  it('resolved took the servers of the lease of PC-CONSEILLER', async () => {
    const lab = await bench();
    const status = await lab.asked(ASK, 'sh', 'resolvectl status');
    expect(status.output).toMatch(/DNS Servers:\s+10\.20\.20\.10 10\.20\.20\.53/);
  });

  it('every step of the recording, replayed on the lab in the same order with the same waits, answers with the same status, flags, EDNS size, records and TTL arithmetic', async () => {
    const lab = await bench();
    await lab.asked(ASK, 'sh', "echo '10.20.20.99 printer.horizon.local printer' | sudo tee -a /etc/hosts");
    const replies = new Map<string, Reply>();
    const differences: string[] = [];
    for (const step of fixture.steps) {
      if (step.delay > 0) await lab.asked(ASK, 'sh', `sleep ${step.delay}`);
      const line = `dig @127.0.0.53 ${argumentsOf(step)} +bufsize=1232`;
      const got = parseDig((await lab.asked(ASK, 'sh', line)).output);
      replies.set(step.label, got);
      const want = step.reply;
      const note = (what: string, expected: unknown, actual: unknown) => differences.push(`${step.label}: ${what} expected ${JSON.stringify(expected)} got ${JSON.stringify(actual)}`);
      if (got.status !== want.status) note('status', want.status, got.status);
      if ([...got.flags].sort().join(' ') !== [...want.flags].sort().join(' ')) note('flags', want.flags, got.flags);
      if (got.edns?.udp !== want.edns?.udp) note('EDNS udp', want.edns?.udp, got.edns?.udp);
      if (JSON.stringify(answerSet(got)) !== JSON.stringify(answerSet(want))) note('answer', answerSet(want), answerSet(got));
      if (want.answer.length === 0 && negativeSoa(got) !== negativeSoa(want)) note('SOA in authority', negativeSoa(want), negativeSoa(got));
      const held = step.label.replace('-again', '');
      if (got.answer.length === 0 && !negativeSoa(got)) continue;
      const ttl = ttlOf(got);
      if (step.label.endsWith('-again')) {
        const expected = step.label === 'long-ttl-again' ? RESOLVED_CAP - WAIT : ttlOf(replies.get(held)!) - WAIT;
        if (ttl !== expected) note('TTL after the wait', expected, ttl);
      } else if (want.flags.includes('aa')) {
        for (const row of got.answer) if (row.ttl !== 0) note('synthetic TTL', 0, row.ttl);
      } else {
        const ceiling = step.label === 'long-ttl' ? 86400 : 3600;
        if (ttlOf(want) <= ceiling && !(ttl <= ceiling && ttl > ceiling - FIRST_TTL_MARGIN)) note(`first TTL under ${ceiling}`, `${ceiling} minus a few seconds at most`, ttl);
      }
    }
    expect(differences).toEqual([]);
  });
});
