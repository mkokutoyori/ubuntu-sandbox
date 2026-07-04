/**
 * ESP-GCM (RFC 4106): AES-GCM is an AEAD transform — encryption and
 * authentication happen together in one primitive, so there is no separate
 * HMAC. Previously `espEncrypts()`/`espIcvHash()` didn't recognize GCM at
 * all, so a "configured" esp-gcm SA silently carried the inner packet in
 * cleartext with no integrity check whatsoever — while `show crypto ipsec
 * transform-set` still claimed esp-gcm-256 was active. This also covers the
 * Cisco CLI's space-form transform string ('esp-gcm 256'), which the crypto
 * derivation table previously failed to match (only the hyphen form did).
 */
import { describe, it, expect } from 'vitest';
import { sealAndSignEsp, openEsp } from '@/network/ipsec/IPSecEngine';
import type { SACryptoKeys } from '@/network/ipsec/IPSecTypes';
import {
  IPAddress, createIPv4Packet, IP_PROTO_ICMP, type ESPPacket, type IPv4Packet,
} from '@/network/core/types';

function gcmKeys(): SACryptoKeys {
  return {
    espEncAlgorithm: 'aes-gcm-256', espEncKey: 'ab'.repeat(32), espEncKeyLength: 256,
    espAuthAlgorithm: 'aes-gcm', espAuthKey: '', espAuthKeyLength: 0,
    espEncSalt: 'deadbeef',
    ahAuthAlgorithm: 'none', ahAuthKey: '', ahAuthKeyLength: 0,
  };
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

describe('ESP-GCM (AEAD) — real encryption and authentication, not a silent no-op', () => {
  it('seals the inner packet: cleartext addresses/payload are gone in transit', () => {
    const pkt = esp();
    sealAndSignEsp(gcmKeys(), pkt);
    expect(pkt.ciphertext).toMatch(/^[0-9a-f]+$/);
    expect(pkt.innerPacket.sourceIP.toString()).toBe('0.0.0.0');
    expect(pkt.innerPacket.destinationIP.toString()).toBe('0.0.0.0');
    expect(JSON.stringify(pkt.innerPacket)).not.toContain('10.1.1.1');
    expect(JSON.stringify(pkt.innerPacket)).not.toContain('secret-payload');
    expect(pkt.icv).toBeDefined();
    expect(pkt.icv).toMatch(/^[0-9a-f]{32}$/); // 16-byte GCM tag
  });

  it('decryption rebuilds the original inner packet', () => {
    const pkt = esp();
    sealAndSignEsp(gcmKeys(), pkt);
    const out = openEsp(gcmKeys(), pkt);
    expect(out).not.toBeNull();
    expect(out!.sourceIP.toString()).toBe('10.1.1.1');
    expect(out!.destinationIP.toString()).toBe('10.2.2.2');
    expect(out!.payload).toMatchObject({ type: 'icmp', data: 'secret-payload' });
  });

  it('a wrong key fails to decrypt (returns null) — this used to silently "succeed" as esp-null', () => {
    const pkt = esp();
    sealAndSignEsp(gcmKeys(), pkt);
    const wrong: SACryptoKeys = { ...gcmKeys(), espEncKey: '00'.repeat(32) };
    expect(openEsp(wrong, pkt)).toBeNull();
  });

  it('tampering with the ciphertext is caught by the GCM tag — no separate ICV needed', () => {
    const pkt = esp();
    sealAndSignEsp(gcmKeys(), pkt);
    const tampered: ESPPacket = { ...pkt, ciphertext: pkt.ciphertext!.replace(/.$/, (c) => (c === '0' ? '1' : '0')) };
    expect(openEsp(gcmKeys(), tampered)).toBeNull();
  });

  it('tampering with the tag alone is caught (previously there was no tag check at all)', () => {
    const pkt = esp();
    sealAndSignEsp(gcmKeys(), pkt);
    const tampered: ESPPacket = { ...pkt, icv: pkt.icv!.replace(/.$/, (c) => (c === '0' ? '1' : '0')) };
    expect(openEsp(gcmKeys(), tampered)).toBeNull();
  });

  it('a mismatched SPI/sequence (AAD) invalidates the tag — real RFC 4106 AAD binding', () => {
    const pkt = esp();
    sealAndSignEsp(gcmKeys(), pkt);
    const relabeled: ESPPacket = { ...pkt, sequenceNumber: pkt.sequenceNumber + 1 };
    expect(openEsp(gcmKeys(), relabeled)).toBeNull();
  });

  it('esp-gcm-128 (shorter key) also produces real ciphertext and round-trips', () => {
    const keys128: SACryptoKeys = { ...gcmKeys(), espEncAlgorithm: 'aes-gcm-128', espEncKey: 'ab'.repeat(16), espEncKeyLength: 128 };
    const pkt = esp();
    sealAndSignEsp(keys128, pkt);
    expect(pkt.ciphertext).toMatch(/^[0-9a-f]+$/);
    const out = openEsp(keys128, pkt);
    expect(out!.sourceIP.toString()).toBe('10.1.1.1');
  });
});
