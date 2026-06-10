/**
 * ESP confidentiality: when an SA negotiates a real AES transform, the inner
 * packet is genuinely encrypted (AES-CBC) and sealed in transit — the
 * cleartext addresses/payload are gone — and decryption rebuilds the original.
 */

import { describe, it, expect } from 'vitest';
import { sealAndSignEsp, openEsp } from '@/network/ipsec/IPSecEngine';
import type { SACryptoKeys } from '@/network/ipsec/IPSecTypes';
import {
  IPAddress, createIPv4Packet, IP_PROTO_ICMP, type ESPPacket, type IPv4Packet,
} from '@/network/core/types';

function aesKeys(): SACryptoKeys {
  return {
    espEncAlgorithm: 'aes-cbc-256', espEncKey: 'ab'.repeat(32), espEncKeyLength: 256,
    espAuthAlgorithm: 'hmac-sha-256', espAuthKey: 'cd'.repeat(32), espAuthKeyLength: 256,
    ahAuthAlgorithm: 'none', ahAuthKey: '', ahAuthKeyLength: 0,
  };
}
function nullKeys(): SACryptoKeys {
  return { ...aesKeys(), espEncAlgorithm: 'null', espEncKey: '', espEncKeyLength: 0 };
}
function innerPacket(): IPv4Packet {
  return createIPv4Packet(
    new IPAddress('10.1.1.1'), new IPAddress('10.2.2.2'), IP_PROTO_ICMP, 64,
    { type: 'icmp', icmpType: 8, data: 'secret-payload' }, 84,
  );
}
function esp(): ESPPacket {
  return { type: 'esp', spi: 0x1234, sequenceNumber: 5, innerPacket: innerPacket() };
}

describe('ESP confidentiality (AES-CBC)', () => {
  it('seals the inner packet: cleartext addresses/payload are gone in transit', () => {
    const pkt = esp();
    sealAndSignEsp(aesKeys(), pkt);
    expect(pkt.ciphertext).toMatch(/^[0-9a-f]+$/);
    // The transit inner packet is opaque — no cleartext src/dst or payload.
    expect(pkt.innerPacket.sourceIP.toString()).toBe('0.0.0.0');
    expect(pkt.innerPacket.destinationIP.toString()).toBe('0.0.0.0');
    expect(JSON.stringify(pkt.innerPacket)).not.toContain('10.1.1.1');
    expect(JSON.stringify(pkt.innerPacket)).not.toContain('secret-payload');
    expect(pkt.icv).toBeDefined();
  });

  it('decryption rebuilds the original inner packet', () => {
    const pkt = esp();
    sealAndSignEsp(aesKeys(), pkt);
    const out = openEsp(aesKeys(), pkt);
    expect(out).not.toBeNull();
    expect(out!.sourceIP).toBeInstanceOf(IPAddress);
    expect(out!.sourceIP.toString()).toBe('10.1.1.1');
    expect(out!.destinationIP.toString()).toBe('10.2.2.2');
    expect(out!.payload).toMatchObject({ type: 'icmp', data: 'secret-payload' });
  });

  it('a wrong key fails to decrypt (returns null)', () => {
    const pkt = esp();
    sealAndSignEsp(aesKeys(), pkt);
    const wrong: SACryptoKeys = { ...aesKeys(), espEncKey: '00'.repeat(32) };
    expect(openEsp(wrong, pkt)).toBeNull();
  });

  it('tampering with the ciphertext is detected by the ICV / decryption', () => {
    const pkt = esp();
    sealAndSignEsp(aesKeys(), pkt);
    const tampered: ESPPacket = { ...pkt, ciphertext: pkt.ciphertext!.replace(/.$/, (c) => (c === '0' ? '1' : '0')) };
    // Either decryption fails or it no longer yields the original packet.
    const out = openEsp(aesKeys(), tampered);
    expect(out === null || out.sourceIP.toString() !== '10.1.1.1').toBe(true);
  });

  it('a null transform leaves the inner packet in cleartext (no ciphertext)', () => {
    const pkt = esp();
    sealAndSignEsp(nullKeys(), pkt);
    expect(pkt.ciphertext).toBeUndefined();
    expect(pkt.innerPacket.sourceIP.toString()).toBe('10.1.1.1');
    expect(openEsp(nullKeys(), pkt)!.sourceIP.toString()).toBe('10.1.1.1');
  });
});
