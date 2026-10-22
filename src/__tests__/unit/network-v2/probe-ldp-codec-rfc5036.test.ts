/**
 * Probe: LDP PDU, message and TLV encodings, byte for byte against the
 * layouts of docs/rfc/mpls/rfc5036.txt §3.1-3.5, §3.8-3.9.
 * New subsystem: every case fails before (module absent). The byte vectors
 * are written out by hand from the figures, not produced by the encoder.
 */
import { describe, it, expect } from 'vitest';
import { IPAddress } from '@/network/core/types';
import { MplsLabel } from '@/network/mpls/MplsLabel';
import { LdpIdentifier } from '@/network/ldp/LdpIdentifier';
import { decodePdu, encodePdu, LdpDecodeError } from '@/network/ldp/LdpCodec';
import { LDP_VERSION, StatusCode, type LdpPdu } from '@/network/ldp/LdpMessages';

const sender = LdpIdentifier.of(new IPAddress('1.1.1.1'), 0);
const pdu = (messages: LdpPdu['messages']): LdpPdu => ({ version: LDP_VERSION, sender, messages });

describe('LDP identifier (§2.2.2)', () => {
  it('is 4 octets of LSR id and 2 octets of label space', () => {
    expect([...sender.encode()]).toEqual([1, 1, 1, 1, 0, 0]);
    expect(LdpIdentifier.tryParse('10.0.0.2:3')!.toString()).toBe('10.0.0.2:3');
    expect(LdpIdentifier.tryParse('10.0.0.2:70000')).toBeNull();
    expect(LdpIdentifier.tryParse('10.0.0.2')).toBeNull();
    expect(sender.isPlatformWide()).toBe(true);
  });
});

describe('KeepAlive (§3.5.4) - the shortest PDU', () => {
  it('encodes to the header, the LDP id and one 8-octet message', () => {
    const bytes = encodePdu(pdu([{ kind: 'keepalive', id: 7 }]));
    expect([...bytes]).toEqual([
      0x00, 0x01, 0x00, 0x0e, 1, 1, 1, 1, 0, 0,
      0x02, 0x01, 0x00, 0x04, 0x00, 0x00, 0x00, 0x07,
    ]);
  });
});

describe('Hello (§3.5.2)', () => {
  it('Common Hello Parameters TLV 0x0400 with hold time and T/R bits, then the transport address TLV 0x0401', () => {
    const bytes = encodePdu(pdu([{
      kind: 'hello', id: 1, holdTimeSeconds: 15, targeted: false, requestTargetedHellos: false,
      transportAddress: new IPAddress('1.1.1.1'),
    }]));
    expect([...bytes.slice(10)]).toEqual([
      0x01, 0x00, 0x00, 0x14, 0x00, 0x00, 0x00, 0x01,
      0x04, 0x00, 0x00, 0x04, 0x00, 0x0f, 0x00, 0x00,
      0x04, 0x01, 0x00, 0x04, 1, 1, 1, 1,
    ]);
  });
  it('round-trips targeted and request flags', () => {
    const decoded = decodePdu(encodePdu(pdu([{ kind: 'hello', id: 2, holdTimeSeconds: 45, targeted: true, requestTargetedHellos: true, configurationSequenceNumber: 9 }])));
    expect(decoded.messages[0]).toEqual({ kind: 'hello', id: 2, holdTimeSeconds: 45, targeted: true, requestTargetedHellos: true, configurationSequenceNumber: 9 });
  });
});

describe('Initialization (§3.5.3)', () => {
  it('Common Session Parameters TLV 0x0500: version, keepalive, A/D bits, PVLim, max PDU, receiver id', () => {
    const bytes = encodePdu(pdu([{
      kind: 'initialization', id: 3, protocolVersion: 1, keepAliveTimeSeconds: 180, advertisementMode: 'unsolicited',
      loopDetection: false, pathVectorLimit: 0, maxPduLength: 4096, receiver: LdpIdentifier.of(new IPAddress('2.2.2.2'), 0),
    }]));
    expect([...bytes.slice(10)]).toEqual([
      0x02, 0x00, 0x00, 0x16, 0x00, 0x00, 0x00, 0x03,
      0x05, 0x00, 0x00, 0x0e, 0x00, 0x01, 0x00, 0xb4, 0x00, 0x00, 0x10, 0x00, 2, 2, 2, 2, 0, 0,
    ]);
  });
  it('on-demand sets A, loop detection sets D', () => {
    const decoded = decodePdu(encodePdu(pdu([{
      kind: 'initialization', id: 4, protocolVersion: 1, keepAliveTimeSeconds: 40, advertisementMode: 'on-demand',
      loopDetection: true, pathVectorLimit: 8, maxPduLength: 1500, receiver: sender,
    }])));
    expect(decoded.messages[0]).toMatchObject({ advertisementMode: 'on-demand', loopDetection: true, pathVectorLimit: 8, maxPduLength: 1500 });
  });
});

describe('Label Mapping (§3.5.7) and FEC (§3.4.1)', () => {
  it('FEC TLV 0x0100 with a Prefix element (type 2, AF, prelen, prefix padded to bytes), Generic Label TLV 0x0200', () => {
    const bytes = encodePdu(pdu([{
      kind: 'label-mapping', id: 5, fec: [{ kind: 'prefix', prefix: new IPAddress('10.1.2.0'), length: 24 }], label: MplsLabel.of(16),
    }]));
    expect([...bytes.slice(10)]).toEqual([
      0x04, 0x00, 0x00, 0x17, 0x00, 0x00, 0x00, 0x05,
      0x01, 0x00, 0x00, 0x07, 0x02, 0x00, 0x01, 0x18, 10, 1, 2,
      0x02, 0x00, 0x00, 0x04, 0x00, 0x01, 0x00, 0x00,
    ]);
  });
  it('a /20 prefix carries three octets, the default route none', () => {
    const odd = decodePdu(encodePdu(pdu([{ kind: 'label-mapping', id: 6, fec: [{ kind: 'prefix', prefix: new IPAddress('172.16.16.0'), length: 20 }], label: MplsLabel.IMPLICIT_NULL }])));
    expect(odd.messages[0]).toMatchObject({ fec: [{ kind: 'prefix', length: 20 }], label: { value: 3 } });
    const none = decodePdu(encodePdu(pdu([{ kind: 'label-request', id: 7, fec: [{ kind: 'prefix', prefix: new IPAddress('0.0.0.0'), length: 0 }] }])));
    expect(none.messages[0]).toMatchObject({ fec: [{ kind: 'prefix', length: 0 }] });
  });
  it('carries request id, hop count and path vector as optional TLVs', () => {
    const decoded = decodePdu(encodePdu(pdu([{
      kind: 'label-mapping', id: 8, fec: [{ kind: 'prefix', prefix: new IPAddress('10.0.0.0'), length: 8 }], label: MplsLabel.of(30),
      requestMessageId: 99, hopCount: 3, pathVector: [new IPAddress('1.1.1.1'), new IPAddress('2.2.2.2')],
    }])));
    const message = decoded.messages[0];
    expect(message).toMatchObject({ requestMessageId: 99, hopCount: 3 });
    expect((message as unknown as { pathVector: IPAddress[] }).pathVector.map(String)).toEqual(['1.1.1.1', '2.2.2.2']);
  });
  it('withdraw and release take an optional label; the wildcard FEC element has no value', () => {
    const decoded = decodePdu(encodePdu(pdu([
      { kind: 'label-withdraw', id: 9, fec: [{ kind: 'wildcard' }] },
      { kind: 'label-release', id: 10, fec: [{ kind: 'prefix', prefix: new IPAddress('10.0.0.0'), length: 8 }], label: MplsLabel.of(40) },
    ])));
    expect(decoded.messages[0]).toEqual({ kind: 'label-withdraw', id: 9, fec: [{ kind: 'wildcard' }] });
    expect(decoded.messages[1]).toMatchObject({ kind: 'label-release', label: { value: 40 } });
  });
});

describe('Address (§3.5.5) and Notification (§3.5.1)', () => {
  it('Address List TLV 0x0101 starts with the address family', () => {
    const bytes = encodePdu(pdu([{ kind: 'address', id: 11, addresses: [new IPAddress('10.0.0.1'), new IPAddress('192.168.1.1')] }]));
    expect([...bytes.slice(10)]).toEqual([
      0x03, 0x00, 0x00, 0x12, 0x00, 0x00, 0x00, 0x0b,
      0x01, 0x01, 0x00, 0x0a, 0x00, 0x01, 10, 0, 0, 1, 192, 168, 1, 1,
    ]);
  });
  it('Status TLV 0x0300: E bit set for fatal codes, message id and type echoed', () => {
    const bytes = encodePdu(pdu([{ kind: 'notification', id: 12, statusCode: StatusCode.Shutdown, forward: false, referencedMessageId: 0, referencedMessageType: 0 }]));
    expect([...bytes.slice(10)]).toEqual([
      0x00, 0x01, 0x00, 0x12, 0x00, 0x00, 0x00, 0x0c,
      0x03, 0x00, 0x00, 0x0a, 0x80, 0x00, 0x00, 0x0a, 0, 0, 0, 0, 0, 0,
    ]);
    const advisory = decodePdu(encodePdu(pdu([{ kind: 'notification', id: 13, statusCode: StatusCode.NoRoute, forward: false, referencedMessageId: 5, referencedMessageType: 0x0401 }])));
    expect(advisory.messages[0]).toMatchObject({ statusCode: StatusCode.NoRoute, referencedMessageId: 5, referencedMessageType: 0x0401 });
    const bytesAdvisory = encodePdu(pdu([{ kind: 'notification', id: 13, statusCode: StatusCode.NoRoute, forward: false, referencedMessageId: 5, referencedMessageType: 0x0401 }]));
    expect(bytesAdvisory[18] & 0x80).toBe(0);
  });
});

describe('malformed input (§3.5.1.2)', () => {
  const ok = encodePdu(pdu([{ kind: 'keepalive', id: 1 }]));
  const refused = (bytes: Uint8Array, code: number) => {
    try { decodePdu(bytes); } catch (error) { expect((error as LdpDecodeError).statusCode).toBe(code); return; }
    throw new Error('accepted');
  };
  it('refuses a wrong version, a PDU length below 14 and a PDU longer than the data', () => {
    refused(Uint8Array.from([0, 2, ...ok.slice(2)]), StatusCode.BadProtocolVersion);
    refused(Uint8Array.from([...ok.slice(0, 2), 0, 13, ...ok.slice(4)]), StatusCode.BadPduLength);
    refused(Uint8Array.from([...ok.slice(0, 2), 0, 0x40, ...ok.slice(4)]), StatusCode.BadPduLength);
  });
  it('refuses a message length that runs past the PDU', () => {
    const broken = Uint8Array.from(ok);
    broken[13] = 0x20;
    refused(broken, StatusCode.BadMessageLength);
  });
  it('reports a missing mandatory TLV as Missing Message Parameters', () => {
    const noFec = Uint8Array.from([0, 1, 0, 0x12, 1, 1, 1, 1, 0, 0, 0x04, 0x01, 0, 4, 0, 0, 0, 1]);
    const sized = Uint8Array.from([...noFec.slice(0, 2), 0, noFec.length - 4, ...noFec.slice(4)]);
    refused(sized, StatusCode.MissingMessageParameters);
  });
  it('keeps an unknown message type as such, with its U bit', () => {
    const unknown = Uint8Array.from([0, 1, 0, 0x0e, 1, 1, 1, 1, 0, 0, 0x8f, 0xff, 0, 4, 0, 0, 0, 3]);
    expect(decodePdu(unknown).messages[0]).toEqual({ kind: 'unknown', id: 3, messageType: 0x0fff, unknownBit: true });
  });
});
