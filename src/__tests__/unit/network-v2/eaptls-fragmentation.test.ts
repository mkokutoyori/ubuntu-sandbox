import { describe, it, expect } from 'vitest';
import { fragmentFlight, FragmentSender, EapTlsReassembler } from '@/network/radius/eaptls/EapTlsFragmentation';
import { utf8ToBytes, bytesToUtf8 } from '@/crypto/encoding';

describe('fragmentFlight', () => {
  it('returns a single unflagged fragment when the flight fits under the MTU', () => {
    const data = utf8ToBytes('hello');
    const frags = fragmentFlight(data, 1000);
    expect(frags).toHaveLength(1);
    expect(frags[0].tlsFlags).toEqual({ length: false, more: false, start: false });
    expect(frags[0].tlsMessageLength).toBeUndefined();
  });

  it('splits an oversized flight into multiple fragments with the Length field on the first and M unset only on the last', () => {
    const data = utf8ToBytes('x'.repeat(25));
    const frags = fragmentFlight(data, 10);
    expect(frags).toHaveLength(3);
    expect(frags[0].tlsFlags).toEqual({ length: true, more: true, start: false });
    expect(frags[0].tlsMessageLength).toBe(25);
    expect(frags[1].tlsFlags).toEqual({ length: false, more: true, start: false });
    expect(frags[2].tlsFlags).toEqual({ length: false, more: false, start: false });
  });
});

describe('FragmentSender + EapTlsReassembler round-trip', () => {
  it('reassembles a single-fragment flight', () => {
    const original = 'a short flight';
    const sender = FragmentSender.forFlight(utf8ToBytes(original), 1000);
    const reassembler = new EapTlsReassembler();
    expect(sender.isLastFragment()).toBe(true);
    const result = reassembler.feed(sender.current());
    expect(result).not.toBeNull();
    expect(bytesToUtf8(result!)).toBe(original);
  });

  it('reassembles a multi-fragment flight via the ACK-driven advance loop', () => {
    const original = 'y'.repeat(97);
    const sender = FragmentSender.forFlight(utf8ToBytes(original), 20);
    const reassembler = new EapTlsReassembler();

    let result: Uint8Array | null = null;
    let fragmentCount = 0;
    for (;;) {
      fragmentCount++;
      result = reassembler.feed(sender.current());
      if (sender.isLastFragment()) break;
      expect(result).toBeNull();
      expect(reassembler.awaitingMore).toBe(true);
      sender.advance();
    }

    expect(fragmentCount).toBeGreaterThan(1);
    expect(result).not.toBeNull();
    expect(bytesToUtf8(result!)).toBe(original);
  });
});
