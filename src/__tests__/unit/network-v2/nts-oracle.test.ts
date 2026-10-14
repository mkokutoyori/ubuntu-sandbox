/**
 * NTS (RFC 8915) codecs compared with a real chronyd 4.5 acting as NTS-KE
 * and NTS-NTP server (scripts/oracle/record_chrony_nts.py).
 *
 * The script played the client: a TLS 1.3 session (ALPN ntske/1) whose
 * plaintext request and response records were saved; the exporter keys,
 * derived there by an independent HKDF; an authenticated NTP request with
 * cookie placeholders, which the real server ACCEPTED (so the keys, the
 * associated data and the padding are right) and answered with eight fresh
 * cookies; a second request spending one of those cookies; and a request with
 * a corrupted cookie, answered with an NTS NAK.
 *
 * What is compared, byte for byte: our NTS-KE request is the recorded one;
 * the recorded response parses to the AEAD, the port and the eight cookies;
 * our exporter gives the recorded C2S and S2C keys from the recorded exporter
 * secret (SHA-384 transcript); our client builds the recorded NTP requests
 * from the same header, identifier, nonce and cookies; our client accepts the
 * recorded replies and extracts the recorded cookies, and flags the NAK; our
 * server parses the recorded request, decrypts its authenticator and builds
 * the recorded reply (same length, same padding) and the recorded NAK.
 *
 * Measured against nothing: the NTS modules did not exist, so every case falls
 * without them. The first case (record layout) is the witness for the shared
 * helpers.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { exportKeyingMaterial } from '@/network/tls/keySchedule';
import {
  buildClientRequest, decodeRecords, parseServerResponse, exporterContext, NKE_EXPORTER_LABEL,
} from '@/network/nts/NtsKeRecords';
import { NtsClient } from '@/network/nts/NtsClient';
import { NtsServerKeys } from '@/network/nts/NtsServerKeys';
import { systemRandom } from '@/crypto/random';
import {
  EF, buildNakResponse, buildServerResponse, countEncryptedPlaceholders, decryptAuthField, parseServerRequest,
} from '@/network/nts/NtsNtp';

interface Reply { uid: string; nonce: string; request: string; reply: string; cookie?: string; decoded: { cookies: string[]; nonce: string; uidMatches?: boolean } }
const fixture = JSON.parse(readFileSync(new URL('../../support/oracle/chrony-nts-4.5.json', import.meta.url), 'utf8')) as {
  ke: { request: string; response: string; records: { critical: boolean; type: number; body: string }[] };
  ntskeys: string; exporterSecret: string; hash: 'sha256' | 'sha384'; c2s: string; s2c: string;
  first: Reply; second: Reply; nak: Omit<Reply, 'decoded'> & { decoded: { stratum: number; refid: string; kinds: number[]; length: number } };
};
const bytes = (hex: string): Uint8Array => Uint8Array.from(hex.match(/../g) ?? [], (h) => parseInt(h, 16));
const hex = (b: Uint8Array): string => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
const sequence = (...chunks: Uint8Array[]): ((n: number) => Uint8Array) => {
  let i = 0;
  return (n) => { const c = chunks[i++]; expect(c.length).toBe(n); return c; };
};

describe('NTS-KE records', () => {
  it('our request is the recorded one', () => {
    expect(hex(buildClientRequest())).toBe(fixture.ke.request);
  });
  it('the recorded response parses: AEAD 15, the NTP port, eight cookies of 96 bytes', () => {
    const records = decodeRecords(bytes(fixture.ke.response))!;
    expect(records.map((r) => ({ critical: r.critical, type: r.type, body: hex(r.body) }))).toEqual(fixture.ke.records);
    const parsed = parseServerResponse(records);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.response.aead).toBe(15);
      expect(parsed.response.port).toBe(12311);
      expect(parsed.response.cookies).toHaveLength(8);
      expect(parsed.response.cookies.every((c) => c.length === 96)).toBe(true);
    }
  });
});

describe('TLS exporter keys', () => {
  it('C2S and S2C keys from the recorded exporter secret', () => {
    expect(hex(exportKeyingMaterial(fixture.exporterSecret, NKE_EXPORTER_LABEL, exporterContext(15, 'c2s'), 32, fixture.hash))).toBe(fixture.c2s);
    expect(hex(exportKeyingMaterial(fixture.exporterSecret, NKE_EXPORTER_LABEL, exporterContext(15, 's2c'), 32, fixture.hash))).toBe(fixture.s2c);
  });
});

function clientFor(reply: Reply, cookies: Uint8Array[]): NtsClient {
  const client = new NtsClient(sequence(bytes(reply.uid), bytes(reply.nonce)), 1e12);
  client.install({ aead: 15, c2s: bytes(fixture.c2s), s2c: bytes(fixture.s2c) }, cookies, 0);
  client.prepareForAuth();
  client.markReady();
  return client;
}

describe('NTS-NTP client', () => {
  it('builds the recorded first request (one cookie left, seven placeholders)', () => {
    const client = clientFor(fixture.first, [bytes(fixture.first.cookie ?? '')]);
    const header = bytes(fixture.first.request).slice(0, 48);
    expect(hex(client.appendRequestFields(header)!)).toBe(fixture.first.request);
  });
  it('accepts the recorded reply and keeps the eight fresh cookies', () => {
    const client = clientFor(fixture.first, [bytes(fixture.first.cookie ?? '')]);
    client.appendRequestFields(bytes(fixture.first.request).slice(0, 48));
    expect(client.checkResponse(bytes(fixture.first.reply))).toBe(true);
    const report = client.report(0);
    expect(report.cookies).toBe(8);
    expect(report.cookieLength).toBe(96);
  });
  it('builds the recorded second request and takes the single cookie it asked for', () => {
    const spare = Array.from({ length: 7 }, () => new Uint8Array(96));
    const client = clientFor(fixture.second, [bytes(fixture.second.cookie ?? ''), ...spare]);
    expect(hex(client.appendRequestFields(bytes(fixture.second.request).slice(0, 48))!)).toBe(fixture.second.request);
    expect(client.checkResponse(bytes(fixture.second.reply))).toBe(true);
    expect(client.report(0).cookies).toBe(8);
  });
  it('flags the recorded NAK and refuses a reply with another identifier', () => {
    const client = clientFor(fixture.nak, [bytes(fixture.first.cookie ?? '')]);
    client.appendRequestFields(bytes(fixture.nak.request).slice(0, 48));
    expect(client.checkResponse(bytes(fixture.nak.reply))).toBe(false);
    expect(client.report(0).nak).toBe(true);
    const other = clientFor(fixture.first, [bytes(fixture.first.cookie ?? '')]);
    other.appendRequestFields(bytes(fixture.first.request).slice(0, 48));
    const tampered = bytes(fixture.first.reply);
    tampered[48 + 8] ^= 1;
    expect(other.checkResponse(tampered)).toBe(false);
  });
});

describe('NTS-NTP server', () => {
  const request = bytes(fixture.first.request);
  it('parses the recorded request and decrypts its authenticator', () => {
    const parsed = parseServerRequest(request)!;
    expect(hex(parsed.uniqueIdentifier)).toBe(fixture.first.uid);
    expect(hex(parsed.cookie)).toBe(fixture.first.cookie);
    expect(parsed.requestedCookies).toBe(8);
    expect(parsed.cookieLength).toBe(96);
    const plaintext = decryptAuthField(request, parsed.authField, bytes(fixture.c2s))!;
    expect(plaintext).toHaveLength(0);
    expect(countEncryptedPlaceholders(plaintext, 96)).toBe(0);
    expect(decryptAuthField(request, parsed.authField, bytes(fixture.s2c))).toBeNull();
  });
  it('builds the recorded reply: same header, same cookies, same length', () => {
    const parsed = parseServerRequest(request)!;
    const reply = bytes(fixture.first.reply);
    const built = buildServerResponse(reply.slice(0, 48), parsed, request.length, bytes(fixture.s2c), bytes(fixture.first.decoded.nonce),
      fixture.first.decoded.cookies.map(bytes));
    expect(hex(built)).toBe(fixture.first.reply);
  });
  it('builds the recorded NAK', () => {
    const parsed = parseServerRequest(bytes(fixture.nak.request))!;
    const nak = bytes(fixture.nak.reply);
    expect(hex(buildNakResponse(nak.slice(0, 48), parsed))).toBe(fixture.nak.reply);
    expect(parsed.fields.some((f) => f.type === EF.COOKIE)).toBe(true);
  });
});

describe('server key file (ntsdumpdir/ntskeys) against the file the real chronyd 4.5 wrote', () => {
  const real = fixture.ntskeys as string;
  const keys = (text: string): string[] => text.trim().split('\n').slice(2);

  it('the real file has the header, the key age and one line per slot: ID, key, algorithm', () => {
    expect(real.split('\n')[0]).toBe('NKS1');
    expect(real.split('\n')[1]).toMatch(/^\d+\.\d$/);
    expect(keys(real)).toHaveLength(4);
    for (const line of keys(real)) expect(line).toMatch(/^[0-9A-F]{8} [0-9A-F]+ \d+$/);
  });

  it('our dump has the same line shapes, with the algorithm of AES-SIV-CMAC-256 (15)', () => {
    const ours = new NtsServerKeys(systemRandom, 0).dumpText(1500);
    expect(ours.split('\n')[1]).toBe('1.5');
    expect(keys(ours)).toHaveLength(4);
    for (const line of keys(ours)) expect(line).toMatch(/^[0-9A-F]{8} [0-9A-F]{64} 15$/);
  });

  it('a dump restores into a ring that decodes the cookies it issued before, and the ids are unsigned', () => {
    const first = new NtsServerKeys(systemRandom, 0);
    const cookie = first.generateCookie({ aead: 15, c2s: new Uint8Array(32).fill(1), s2c: new Uint8Array(32).fill(2) });
    const second = new NtsServerKeys(systemRandom, 5000);
    expect(second.restoreText(first.dumpText(0), 10_000)).toBe(true);
    expect(second.decodeCookie(cookie)?.c2s).toEqual(new Uint8Array(32).fill(1));
    expect(second.currentKeyId()).toBe(first.currentKeyId());
    for (let i = 0; i < 200; i++) {
      const keys = new NtsServerKeys(systemRandom, 0);
      expect(keys.currentKeyId()).toBeGreaterThanOrEqual(0);
      expect(keys.decodeCookie(keys.generateCookie({ aead: 15, c2s: new Uint8Array(32), s2c: new Uint8Array(32) }))).not.toBeNull();
    }
  });

  it('a file with a gap in the ids is refused, as chronyd refuses it', () => {
    const ours = new NtsServerKeys(systemRandom, 0).dumpText(0).split('\n');
    const swapped = [ours[0], ours[1], ours[3], ours[2], ours[4], ours[5]].join('\n');
    expect(new NtsServerKeys(systemRandom, 0).restoreText(swapped, 0)).toBe(false);
  });
});
