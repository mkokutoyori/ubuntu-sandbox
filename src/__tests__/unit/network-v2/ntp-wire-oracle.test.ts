/*
 * The NTP packet on the wire, against a real chronyd 4.5 (Ubuntu 24.04).
 *
 * The fixture (scripts/oracle/record_ntp_wire.py) holds the datagrams a real chronyd answered to a matrix of crafted requests:
 * versions 0-5, modes 0-7, poll echo, LI, extension fields, MD5/SHA1/SHA256+ MACs, unknown key, bad MAC, deny, rate limit,
 * unsynchronized, local stratum 1.  Three families of cases:
 *   codec    - every real datagram decodes, and re-encodes to the SAME bytes (the 64-bit timestamps are exact, never milliseconds);
 *   digest   - the MD5 and SHA1 MACs a real chronyd computed verify against the key text of the fixture;
 *   server   - the agent, given the same request bytes under the chrony profile, answers (or stays silent) like chronyd.
 * Measured before the codec and the profile existed (git stash push -u -- src/network): wire.ts is absent, the file cannot load, so
 * none of the 81 cases can run.  The cases where chronyd stays silent (v0, v5, modes 0/2/4/5/6/7, extension field, bad MAC, unknown
 * key, SHA256+ MAC, deny) are the ones a lenient agent would answer, hence the strict `toBeNull`; the silent cases are their own
 * witnesses because the same lab makes the neighbouring requests (v4 client, md5-ok) produce an answer.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { EventBus } from '@/events/EventBus';
import { VirtualTimeScheduler } from '@/events/Scheduler';
import { IPAddress } from '@/network/core/types';
import { NtpAgent, type NtpHost } from '@/network/ntp/NtpAgent';
import { decodeNtpPacket, encodeNtpPacket } from '@/network/ntp/wire';
import { calculerMacNtp } from '@/network/ntp/auth';
import { installVirtualClock } from '../../support/ntpTime';

interface Case { case: string; config?: string; request?: string; reply?: string | null; keys?: string; packets?: unknown }
const fixture = JSON.parse(readFileSync(new URL('../../support/oracle/ntp-chrony-4.5.json', import.meta.url), 'utf8')) as { cases: Case[] };
const serverCases = fixture.cases.filter((c) => c.request !== undefined);
const bytes = (hex: string): Uint8Array => new Uint8Array(hex.match(/../g)?.map((h) => parseInt(h, 16)) ?? []);
const hex = (data: Uint8Array): string => [...data].map((b) => b.toString(16).padStart(2, '0')).join('');

let clock: VirtualTimeScheduler;
beforeEach(() => { clock = installVirtualClock(); });

describe('codec: what a real chronyd sent decodes and re-encodes byte for byte', () => {
  const replies = serverCases.filter((c) => c.reply);
  it('the fixture carries real replies', () => {
    expect(replies.length).toBeGreaterThan(20);
  });
  for (const c of replies) {
    it(`${c.case}`, () => {
      const wire = bytes(c.reply as string);
      const decoded = decodeNtpPacket(wire);
      expect('reason' in decoded).toBe(false);
      if ('reason' in decoded) return;
      expect(hex(encodeNtpPacket(decoded.packet))).toBe(hex(wire));
    });
  }
});

describe('digest: the MD5 and SHA1 MACs of a real chronyd verify', () => {
  const keyed = serverCases.filter((c) => c.keys !== undefined && c.reply && c.reply.length > 96);
  const table = new Map<number, { algo: string; key: string }>();
  for (const line of (serverCases.find((c) => c.keys)?.keys ?? '').split('\n')) {
    const [id, algo, key] = line.split(/\s+/);
    if (id) table.set(Number(id), { algo, key: key.startsWith('ASCII:') ? key.slice(6) : key });
  }
  it('the key file of the fixture was read', () => {
    expect(table.size).toBeGreaterThanOrEqual(3);
  });
  for (const c of keyed) {
    it(`${c.case}`, () => {
      const decoded = decodeNtpPacket(bytes(c.reply as string));
      if ('reason' in decoded) throw new Error(decoded.reason);
      const key = table.get(decoded.packet.keyId as number) as { algo: string; key: string };
      expect(calculerMacNtp(key.key, decoded.packet, key.algo)).toBe(decoded.packet.mac);
    });
  }
});

interface Sent { destination: string; payload: Uint8Array }

function serverUnderTest(config: string, keys?: string): { agent: NtpAgent; ask: (request: Uint8Array) => Uint8Array | null; sent: Sent[] } {
  const sent: Sent[] = [];
  const port = { getIPAddress: () => new IPAddress('127.0.0.1'), getName: () => 'eth0' };
  const host = {
    id: 'oracle', name: 'oracle', getHostname: () => 'oracle',
    getPort: () => port, getPorts: () => [port], sendFrame: () => undefined,
    sendUdpDatagram: (request: { destination: IPAddress; payload: unknown }) => {
      sent.push({ destination: request.destination.toString(), payload: request.payload as Uint8Array });
      return true;
    },
  } as unknown as NtpHost;
  const agent = new NtpAgent(host, () => new EventBus(), () => clock);
  agent.setProfile({
    respondsWhenUnsynchronized: true, unsynchronizedRootBoundMs: 1000, silentOnBadAuthentication: true,
    acceptsExtensionFields: false, statelessSymmetricReply: true, localReferenceIsAddress: true,
  });
  const local = /local stratum (\d+)/.exec(config);
  if (local) { agent.setServerMode(true); agent.setLocalStratum(Number(local[1])); }
  for (const line of (keys ?? '').split('\n')) {
    const [id, algo, key] = line.split(/\s+/);
    if (!id || !['MD5', 'SHA1'].includes(algo)) continue;
    agent.addAuthKey(Number(id), algo, key.startsWith('ASCII:') ? key.slice(6) : key);
    agent.addTrustedKey(Number(id));
  }
  agent.start();
  return {
    agent, sent,
    ask: (request) => {
      sent.length = 0;
      agent.handleUdp('eth0', new IPAddress('127.0.0.1'), { sourcePort: 123, destinationPort: 123, payload: request } as never);
      return sent.length > 0 ? sent[0].payload : null;
    },
  };
}

describe('server: the agent answers like chronyd, or stays silent like chronyd', () => {
  const comparable = serverCases.filter((c) => /^(local5|unsync|local1|keys):/.test(c.case));
  for (const c of comparable) {
    it(c.case, () => {
      const { ask } = serverUnderTest(c.config ?? '', c.keys);
      const mine = ask(bytes(c.request as string));
      if (c.reply === null || c.reply === undefined) {
        expect(mine).toBeNull();
        return;
      }
      expect(mine).not.toBeNull();
      const real = decodeNtpPacket(bytes(c.reply));
      const got = decodeNtpPacket(mine as Uint8Array);
      if ('reason' in real || 'reason' in got) throw new Error('undecodable');
      const r = real.packet; const g = got.packet;
      expect(g.leapIndicator).toBe(r.leapIndicator);
      expect(g.version).toBe(r.version);
      expect(g.mode).toBe(r.mode);
      expect(g.stratum).toBe(r.stratum);
      expect(g.poll).toBe(r.poll);
      expect(g.refIdentifier).toBe(r.refIdentifier);
      expect(g.rootDelay).toBeCloseTo(r.rootDelay, 3);
      expect(g.rootDispersion).toBeCloseTo(r.rootDispersion, 3);
      expect(g.keyId).toBe(r.keyId);
      expect(g.mac === undefined).toBe(r.mac === undefined);
      const request = decodeNtpPacket(bytes(c.request as string));
      if ('reason' in request) throw new Error('request undecodable');
      expect(g.origTimestamp).toBe(request.packet.txTimestamp);
    });
  }
});
