/**
 * chronyc's command and monitoring protocol (cmdmon, UDP/323), compared with
 * what a real chronyd 4.5 and a real chronyc 4.5 put on the wire.
 *
 * Fixture: chrony-cmdmon-4.5.json, recorded by
 * scripts/oracle/record_chrony_cmdmon.py. A logging UDP proxy sat between the
 * real chronyc and the real chronyd; every request and reply datagram was
 * captured as hex together with the text chronyc printed. Thirteen raw
 * probes (bad version, short packets, unknown or unsupported commands, wrong
 * packet type, privileged commands) were sent by the script and their
 * replies, or their absence, recorded.
 *
 * Three families of checks:
 * - lengths: the request length of every captured exchange and the reply
 *   length of every captured reply are the ones the tables of pktlength.c
 *   give (the port rebuilds them from the struct sizes of candm.h);
 * - client: a ChronycSession whose transport replays the captured replies,
 *   rewriting only the sequence number, prints exactly the text the real
 *   chronyc printed, with the same requests in the same order, for every
 *   command (open commands decoded from the wire, privileged commands
 *   refused with 501 after the same partial output);
 * - server: ChronyCommandServer answers every raw probe the way chronyd
 *   did (same status or none at all, same reply length).
 *
 * Measured against nothing: the protocol did not exist in the simulator
 * (`chronyc -h <host>` answered 506), so every case falls without it. The
 * null request probe is the witness for the header and padding rules.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { IPAddress } from '@/network/core/types';
import { ChronycSession } from '@/network/devices/linux/time/ChronycClient';
import {
  REQUEST_HEADER_LENGTH, parseReplyHeader, parseRequestHeader, replyLengthForCode, requestLength,
} from '@/network/devices/linux/time/ChronyCmdmon';
import { ChronyCommandServer } from '@/network/devices/linux/time/ChronyCommandServer';
import type { CommandTransport } from '@/network/devices/linux/time/ChronyRemote';
import type { ChronyDaemonView } from '@/network/devices/linux/time/ChronyDaemonView';
import type { LinuxChronyService } from '@/network/devices/linux/time/LinuxChronyService';

interface Exchange { request: string; replies: string[] }
interface Case { args: string[]; stdout: string; stderr: string; code: number; exchanges: Exchange[] }
interface Probe { name: string; request: string; reply: string | null }

const fixture: { cases: Case[]; probes: Probe[] } = JSON.parse(readFileSync(
  new URL('../../support/oracle/chrony-cmdmon-4.5.json', import.meta.url), 'utf8'));

const bytesOf = (hex: string): Uint8Array => Uint8Array.from(hex.match(/../g) ?? [], (h) => parseInt(h, 16));

describe('request and reply lengths match pktlength.c', () => {
  fixture.cases.flatMap((c) => c.exchanges).forEach((exchange, index) => {
    const request = bytesOf(exchange.request);
    const header = parseRequestHeader(request);
    it(`exchange #${index}: command ${header.command}`, () => {
      expect(request.length).toBe(requestLength(header.command, header.version));
      for (const reply of exchange.replies) {
        const bytes = bytesOf(reply);
        const parsed = parseReplyHeader(bytes);
        expect(bytes.length).toBe(Math.max(28, replyLengthForCode(parsed.reply)));
      }
    });
  });
});

function replayTransport(exchanges: Exchange[], sent: number[]): CommandTransport {
  let next = 0;
  return {
    open: (_host, _port, onDatagram) => ({
      send: (payload) => {
        const expected = exchanges[next++];
        sent.push(parseRequestHeader(payload).command);
        expect(parseRequestHeader(payload).command).toBe(parseRequestHeader(bytesOf(expected.request)).command);
        expect(payload.length).toBe(bytesOf(expected.request).length);
        const sequence = parseRequestHeader(payload).sequence;
        for (const reply of expected.replies) {
          const bytes = bytesOf(reply);
          new DataView(bytes.buffer).setUint32(16, sequence);
          onDatagram(bytes);
        }
        return null;
      },
      peekError: () => null,
      close: () => undefined,
    }),
  };
}

describe('ChronycSession over the wire prints what the real chronyc printed', () => {
  for (const recorded of fixture.cases) {
    it(`chronyc -h 127.0.0.1 ${recorded.args.join(' ')}`, async () => {
      const sent: number[] = [];
      const session = new ChronycSession({
        service: null, view: null, privileged: true, programName: 'chronyc', localAddresses: [],
        hostsFile: () => '', wait: async () => undefined,
        transport: replayTransport(recorded.exchanges, sent),
      });
      const result = await session.run(['-h', '127.0.0.1', '-p', '12303', ...recorded.args]);
      expect(result.stdout).toBe(recorded.stdout);
      expect(result.exitCode).toBe(recorded.code);
      expect(sent.length).toBe(recorded.exchanges.length);
    });
  }
});

describe('ChronyCommandServer answers the raw probes the way chronyd 4.5 did', () => {
  const service = { isCommandClientAllowed: () => true, countCommandPacket: () => undefined } as unknown as LinuxChronyService;
  const view = {
    sources: () => [], sourcestats: () => [], activity: () => ({ online: 0, offline: 0, burstOnline: 0, burstOffline: 0, unresolved: 0 }),
    smoothingReport: () => null, findSource: () => undefined,
    tracking: () => ({
      referenceId: 0, referenceName: '', stratum: 0, referenceTime: 0, currentCorrection: 0, lastOffset: 0, rmsOffset: 0,
      frequencyPpm: 0, residualFrequencyPpm: 0, skewPpm: 0, rootDelay: 1, rootDispersion: 1, updateInterval: 0, leap: 3,
    }),
  } as unknown as ChronyDaemonView;
  for (const probe of fixture.probes) {
    it(probe.name, () => {
      const replies: Uint8Array[] = [];
      const server = new ChronyCommandServer(service, () => view, {
        send: (_to, _port, _from, _source, payload) => { replies.push(payload); return true; },
      });
      const request = bytesOf(probe.request);
      server.handle(new IPAddress('127.0.0.1'), 40000, new IPAddress('127.0.0.1'), 323, request);
      if (probe.reply === null) {
        expect(replies).toHaveLength(0);
        return;
      }
      expect(replies).toHaveLength(1);
      const expected = bytesOf(probe.reply);
      expect(replies[0].length).toBe(expected.length);
      const got = parseReplyHeader(replies[0]);
      const want = parseReplyHeader(expected);
      expect(got.status).toBe(want.status);
      expect(got.reply).toBe(want.reply);
      expect(got.command).toBe(want.command);
      expect(got.sequence).toBe(want.sequence);
    });
  }
  it('the header rules rest on a request of at least the header length', () => {
    expect(REQUEST_HEADER_LENGTH).toBe(20);
  });
});
