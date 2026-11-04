/*
 * What the recording of host 9.18 (host-oracle.test.ts) could not reach, read from host.c and dighost.c (BIND 9.18.39) and checked on the machine:
 * - the kernel of the recording has no IPv6 stack: `-6` ends on `can't find IPv6 networking`, and with a resolv.conf without server the fallback list is ::1 then 127.0.0.1 (the real file is empty
 *   there, so only 127.0.0.1 is tried); both are driven here through the port of the tool;
 * - an address with no route: the recorded address had none in its namespace, the lab client has a default route; here a machine with no route says `UDP setup with ... failed: network unreachable.`
 *   and `no servers could be reached` once per try, and the exit status is 1;
 * - the retry rules of recv_done (the try counter is shared by the servers of a lookup, a UDP error retries the same server, a TCP error requeues the whole lookup, a setup error requeues and says
 *   `no servers could be reached` each time), the truncated reply that is asked again over TCP, SERVFAIL and `recursion not available` moving to the next server unless -s, the search list and ndots rules of
 *   next_origin, the AAAA and MX lookups that follow an A answer (each one starts again from the first server), the exit status that stays 0 when an earlier lookup was answered.
 * Measured before the change (git stash push -- src/network src/powershell; the new modules are untracked and stay in place): 4 of the 14 cases fall - the machine with no route (the old command said
 * `;; connection timed out; no servers could be reached`) and the three that need what the change adds to DnsWireCompat (rcodeText, rrClassFromName and the strict IPv4 literal, read by the search, SERVFAIL and
 * option cases). The 10 others pass either way, as WITNESS or non-regression: they drive the new modules through a fake port, so they specify the port and do not measure the old command.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { DnsRcode, DnsOpcode } from '@/network/dns/wire/DnsHeaderFlags';
import { DnsClass, RRType } from '@/network/dns/wire/RRType';
import type { DnsMessage } from '@/network/dns/wire/DnsMessage';
import { makeAaaaRecord, makeARecord, makeSoaRecord } from '@/network/dns/wire/ResourceRecord';
import { runHost } from '@/network/devices/linux/commands/dns/host/HostTool';
import type { ExchangeOutcome, ExchangeRequest, HostPort } from '@/network/devices/linux/commands/dns/host/HostPort';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

const SOA = makeSoaRecord('example', 300, { mname: 'ns.example', rname: 'hostmaster.example', serial: 1, refresh: 7200, retry: 900, expire: 1209600, minimum: 300 });

function replyTo(request: ExchangeRequest, options: { rcode?: number; tc?: boolean; ra?: boolean; answers?: DnsMessage['answers'] } = {}): ExchangeOutcome {
  const message: DnsMessage = {
    id: 7,
    flags: {
      qr: true, opcode: DnsOpcode.QUERY, aa: false, tc: options.tc ?? false, rd: request.recurse, ra: options.ra ?? true, ad: false, cd: false, rcode: options.rcode ?? DnsRcode.NOERROR,
    },
    questions: [{ qname: request.name, qtype: request.type, qclass: DnsClass.IN }],
    answers: options.answers ?? [],
    authorities: (options.answers ?? []).length === 0 && (options.rcode ?? 0) === 0 ? [SOA] : [],
    additionals: [],
  };
  return { outcome: 'reply', message, size: 64, elapsedMs: 3 };
}

interface Script {
  readonly resolv?: string | null;
  readonly ipv6?: boolean;
  readonly names?: Readonly<Record<string, readonly string[]>>;
  readonly answer: (request: ExchangeRequest, sent: readonly ExchangeRequest[]) => ExchangeOutcome;
}

function fakePort(script: Script): { port: HostPort; sent: ExchangeRequest[] } {
  const sent: ExchangeRequest[] = [];
  const port: HostPort = {
    resolvConf: () => (script.resolv === undefined ? 'nameserver 10.0.0.1\n' : script.resolv),
    ipv6Available: () => script.ipv6 ?? false,
    addressesOf: async (name) => script.names?.[name] ?? null,
    exchange: async (request) => {
      sent.push(request);
      return script.answer(request, sent);
    },
    transfer: async () => ({ outcome: 'failed', phase: 'setup', reason: 'connection refused' }),
  };
  return { port, sent };
}

const typeOf = (request: ExchangeRequest): number => request.type;
const addressRecord = (name: string): DnsMessage['answers'] => [makeARecord(name, 60, '192.0.2.1')];

async function host(args: string[], script: Script): Promise<{ text: string; stderr: string; status: number; sent: ExchangeRequest[] }> {
  const { port, sent } = fakePort(script);
  const result = await runHost(args, port);
  return { text: result.stdout, stderr: result.stderr, status: result.exitCode, sent };
}

const timedOut: ExchangeOutcome = { outcome: 'failed', phase: 'exchange', reason: 'timed out' };
const unreachable: ExchangeOutcome = { outcome: 'failed', phase: 'setup', reason: 'network unreachable' };
const answersAddress = (request: ExchangeRequest): ExchangeOutcome => replyTo(request, { answers: typeOf(request) === RRType.A ? addressRecord(request.name) : [] });

describe('host: the engine of dighost.c', () => {
  it('WITNESS: a name with one address prints one line and the exit status is 0', async () => {
    const result = await host(['web.example'], { answer: answersAddress });
    expect(result.text).toBe('web.example has address 192.0.2.1\n');
    expect(result.status).toBe(0);
    expect(result.sent.map(typeOf)).toEqual([RRType.A, RRType.AAAA, RRType.MX]);
  });

  it('-6 says there is no IPv6 networking when the machine has none, and -4 with -6 is refused', async () => {
    expect(await host(['-6', 'web.example'], { answer: answersAddress })).toMatchObject({ stderr: "host: can't find IPv6 networking\n", status: 1, sent: [] });
    expect(await host(['-4', '-6', 'web.example'], { answer: answersAddress })).toMatchObject({ stderr: 'host: only one of -4 and -6 allowed\n', status: 1 });
  });

  it('an empty resolv.conf falls back on ::1 then 127.0.0.1 when IPv6 is there, on 127.0.0.1 alone otherwise', async () => {
    const both = await host(['web.example'], { resolv: '', ipv6: true, answer: () => ({ outcome: 'failed', phase: 'exchange', reason: 'connection refused' }) });
    expect(both.sent.map((request) => request.address)).toEqual(['::1', '::1', '127.0.0.1']);
    expect(both.text).toBe(';; communications error to ::1#53: connection refused\n;; communications error to ::1#53: connection refused\n;; communications error to 127.0.0.1#53: connection refused\n;; no servers could be reached\n');
    expect((await host(['web.example'], { resolv: '', ipv6: false, answer: () => timedOut })).sent.map((request) => request.address)).toEqual(['127.0.0.1', '127.0.0.1']);
  });

  it('a setup error requeues the lookup and says no servers could be reached once per try', async () => {
    const result = await host(['web.example'], { answer: () => unreachable });
    const line = ';; UDP setup with 10.0.0.1#53(10.0.0.1) for web.example failed: network unreachable.\n;; no servers could be reached\n';
    expect(result.text).toBe(line + line);
    expect(result.status).toBe(1);
    expect((await host(['-R', '3', 'web.example'], { answer: () => unreachable })).text).toBe(line.repeat(4));
    expect((await host(['-v', 'web.example'], { answer: () => unreachable })).text).toBe(`Trying "web.example"\n${line}Trying "web.example"\n${line}`);
  });

  it('the try counter is shared by the servers: two errors on the first server, then the second answers, each lookup starting again', async () => {
    const result = await host(['web.example'], {
      resolv: 'nameserver 10.0.0.9\nnameserver 10.0.0.1\n',
      answer: (request) => (request.address === '10.0.0.9' ? timedOut : answersAddress(request)),
    });
    const timeout = ';; communications error to 10.0.0.9#53: timed out\n';
    expect(result.text).toBe(`${timeout}${timeout}web.example has address 192.0.2.1\n${timeout}${timeout}${timeout}${timeout}`);
    expect(result.status).toBe(0);
    expect(result.sent.map((request) => request.address)).toEqual([
      '10.0.0.9', '10.0.0.9', '10.0.0.1', '10.0.0.9', '10.0.0.9', '10.0.0.1', '10.0.0.9', '10.0.0.9', '10.0.0.1',
    ]);
  });

  it('a TCP error requeues the whole lookup without a final line, the last one says no servers could be reached', async () => {
    const result = await host(['-T', 'web.example'], { answer: () => timedOut });
    expect(result.text).toBe(';; communications error to 10.0.0.1#53: timed out\n;; communications error to 10.0.0.1#53: timed out\n;; no servers could be reached\n');
    expect(result.sent.every((request) => request.tcp)).toBe(true);
  });

  it('a truncated reply is asked again over TCP', async () => {
    const result = await host(['-t', 'TXT', 'web.example'], { answer: (request) => (request.tcp ? replyTo(request, { answers: addressRecord(request.name) }) : replyTo(request, { tc: true })) });
    expect(result.sent.map((request) => request.tcp)).toEqual([false, true]);
  });

  it('SERVFAIL moves to the next server unless -s, and a reply without RA does the same when the server is not named', async () => {
    const servers = 'nameserver 10.0.0.1\nnameserver 10.0.0.2\n';
    const failing = (request: ExchangeRequest): ExchangeOutcome => (request.address === '10.0.0.1' ? replyTo(request, { rcode: DnsRcode.SERVFAIL }) : answersAddress(request));
    expect((await host(['-t', 'A', 'web.example'], { resolv: servers, answer: failing })).text).toBe('web.example has address 192.0.2.1\n');
    expect((await host(['-s', '-t', 'A', 'web.example'], { resolv: servers, answer: failing })).text).toBe('Host web.example not found: 2(SERVFAIL)\n');
    const noRecursion = (request: ExchangeRequest): ExchangeOutcome => (request.address === '10.0.0.1' ? replyTo(request, { ra: false, answers: addressRecord('other.example') }) : answersAddress(request));
    expect((await host(['-t', 'A', 'web.example'], { resolv: servers, answer: noRecursion })).text).toBe('web.example has address 192.0.2.1\n');
    expect((await host(['-t', 'A', 'web.example', '10.0.0.1'], { resolv: servers, answer: noRecursion })).text).toContain('Using domain server:');
  });

  it('a name with fewer dots than ndots goes through the search list, then as typed; the exit status follows the last message', async () => {
    const search = 'nameserver 10.0.0.1\nsearch a.example b.example\noptions ndots:2\n';
    const only = (target: string) => (request: ExchangeRequest): ExchangeOutcome =>
      request.name === target ? replyTo(request, { answers: typeOf(request) === RRType.A ? addressRecord(request.name) : [] }) : replyTo(request, { rcode: DnsRcode.NXDOMAIN });
    const found = await host(['-v', 'web'], { resolv: search, answer: only('web.b.example') });
    expect(found.text.split('\n').filter((line) => line.startsWith('Trying'))).toEqual(['Trying "web.a.example"', 'Trying "web.b.example"', 'Trying "web.b.example"', 'Trying "web.b.example"']);
    const missing = await host(['-v', 'web'], { resolv: search, answer: only('nothing') });
    expect(missing.text).toBe('Trying "web.a.example"\nTrying "web.b.example"\nTrying "web"\nHost web not found: 3(NXDOMAIN)\nReceived 64 bytes from 10.0.0.1#53 in 3 ms\n');
    expect(missing.status).toBe(1);
    const absolute = await host(['-v', '-N', '0', 'web'], { resolv: search, answer: only('nothing') });
    expect(absolute.text).toBe('Trying "web"\nHost web not found: 3(NXDOMAIN)\nReceived 64 bytes from 10.0.0.1#53 in 3 ms\nReceived 64 bytes from 10.0.0.1#53 in 3 ms\n');
  });

  it('the AAAA and MX lookups follow the canonical name of the A answer', async () => {
    const alias = (request: ExchangeRequest): ExchangeOutcome => replyTo(request, {
      answers: typeOf(request) === RRType.A && request.name === 'www.example'
        ? [{ ...makeARecord('www.example', 60, '192.0.2.9'), data: { type: RRType.CNAME, cname: 'real.example' } }, makeARecord('real.example', 60, '192.0.2.1')]
        : typeOf(request) === RRType.AAAA && request.name === 'real.example' ? [makeAaaaRecord('real.example', 60, '2001:db8::1')] : [],
    });
    const result = await host(['www.example'], { answer: alias });
    expect(result.sent.map((request) => `${request.name}/${typeOf(request)}`)).toEqual(['www.example/1', 'real.example/28', 'real.example/15']);
    expect(result.text).toBe('www.example is an alias for real.example.\nreal.example has address 192.0.2.1\nreal.example has IPv6 address 2001:db8::1\n');
  });

  it('options are read as isc_commandline_parse does: they stop at the first operand and -- ends them', async () => {
    const named = await host(['web.example', '-t', 'MX'], { answer: answersAddress });
    expect(named.stderr).toBe("host: couldn't get address for '-t': not found\n");
    expect(named.status).toBe(1);
    expect((await host(['--', 'web.example'], { answer: answersAddress })).text).toBe('web.example has address 192.0.2.1\n');
    expect(await host(['-ct', 'MX', 'web.example'], { answer: answersAddress })).toMatchObject({ stderr: 'host: invalid class: t\n\n', status: 2 });
    expect(await host(['-t', 'bogus', 'web.example'], { answer: answersAddress })).toMatchObject({ stderr: 'host: invalid type: bogus\n\n', status: 2 });
    expect(await host(['-l', '-t', 'bogus', 'web.example'], { answer: answersAddress })).toMatchObject({ status: 2 });
    expect(await host(['-l', 'web.example', 'nowhere.example'], { answer: answersAddress })).toMatchObject({ stderr: "host: couldn't get address for 'nowhere.example': not found\n", status: 3 });
    expect(await host(['-q'], { answer: answersAddress })).toMatchObject({ status: 1 });
  });

  it('a resolv.conf line that names no domain cannot be parsed', async () => {
    expect(await host(['web.example'], { resolv: '# nothing\nsearch\n', answer: answersAddress })).toMatchObject({ stderr: 'host: parse of /etc/resolv.conf failed\n', status: 1, sent: [] });
  });

  it('a name that is not a legal name is refused with the reason of dns_name_fromtext', async () => {
    expect((await host(['a..b'], { answer: answersAddress })).stderr).toBe("host: 'a..b' is not a legal name (empty label)\n");
    expect((await host([`${'a'.repeat(64)}.example`], { answer: answersAddress })).stderr).toContain('(label too long)');
    expect((await host(['web.example\\'], { answer: answersAddress })).stderr).toContain('(unexpected end of input)');
    expect((await host([''], { answer: answersAddress })).stderr).toBe("host: '' is not a legal name (unexpected end of input)\n");
  });
});

describe('host: the machine', () => {
  it('an address with no route is a UDP setup error, twice, and the exit status is 1', async () => {
    const machine = new LinuxPC('H', 0, 0);
    await machine.executeCommand('ip addr add 10.1.1.5/24 dev eth0');
    await machine.executeCommand('ip link set eth0 up');
    const text = await machine.executeCommand('host web.example 192.0.2.7; echo "[$?]"');
    const line = ';; UDP setup with 192.0.2.7#53(192.0.2.7) for web.example failed: network unreachable.\n;; no servers could be reached\n';
    expect(text).toBe(`${line}${line}[1]`);
  });
});
