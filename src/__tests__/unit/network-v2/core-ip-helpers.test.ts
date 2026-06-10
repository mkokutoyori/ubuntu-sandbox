import { describe, it, expect } from 'vitest';
import {
  ipToUint32, tryIpToUint32, uint32ToIp, prefixLengthToMaskUint32,
  networkAddress, inSameSubnet, wildcardMatches,
} from '@/network/core/ip';

describe('ipToUint32 / uint32ToIp', () => {
  it('round-trips boundary addresses', () => {
    for (const ip of ['0.0.0.0', '255.255.255.255', '128.0.0.1', '10.0.0.1', '192.168.255.254']) {
      expect(uint32ToIp(ipToUint32(ip))).toBe(ip);
    }
  });

  it('stays unsigned for first octets above 127', () => {
    expect(ipToUint32('255.0.0.0')).toBe(0xff000000);
    expect(ipToUint32('128.0.0.0')).toBe(0x80000000);
    expect(ipToUint32('224.0.0.18')).toBeGreaterThan(0);
  });
});

describe('tryIpToUint32', () => {
  it('parses well-formed quads', () => {
    expect(tryIpToUint32('10.1.2.3')).toBe(ipToUint32('10.1.2.3'));
    expect(tryIpToUint32('0.0.0.0')).toBe(0);
    expect(tryIpToUint32('255.255.255.255')).toBe(0xffffffff);
  });

  it('rejects malformed input instead of producing garbage', () => {
    expect(tryIpToUint32('10.1.2')).toBeNull();
    expect(tryIpToUint32('10.1.2.3.4')).toBeNull();
    expect(tryIpToUint32('10.1.2.256')).toBeNull();
    expect(tryIpToUint32('10.1.2.-1')).toBeNull();
    expect(tryIpToUint32('a.b.c.d')).toBeNull();
    expect(tryIpToUint32('')).toBeNull();
  });
});

describe('prefixLengthToMaskUint32', () => {
  it('covers the /0 and /32 boundaries', () => {
    expect(prefixLengthToMaskUint32(0)).toBe(0);
    expect(prefixLengthToMaskUint32(32)).toBe(0xffffffff);
    expect(prefixLengthToMaskUint32(24)).toBe(0xffffff00);
    expect(prefixLengthToMaskUint32(8)).toBe(0xff000000);
  });

  it('clamps out-of-range prefixes', () => {
    expect(prefixLengthToMaskUint32(-1)).toBe(0);
    expect(prefixLengthToMaskUint32(33)).toBe(0xffffffff);
  });
});

describe('networkAddress / inSameSubnet', () => {
  it('masks to the network address', () => {
    expect(networkAddress('192.168.1.42', '255.255.255.0')).toBe('192.168.1.0');
    expect(networkAddress('10.5.6.7', '255.0.0.0')).toBe('10.0.0.0');
    expect(networkAddress('172.16.31.9', '255.255.0.0')).toBe('172.16.0.0');
  });

  it('detects shared and distinct subnets', () => {
    expect(inSameSubnet('10.0.0.1', '10.0.0.200', '255.255.255.0')).toBe(true);
    expect(inSameSubnet('10.0.0.1', '10.0.1.1', '255.255.255.0')).toBe(false);
    expect(inSameSubnet('1.2.3.4', '200.100.50.25', '0.0.0.0')).toBe(true);
  });
});

describe('wildcardMatches (Cisco inverse mask)', () => {
  it('matches network statements like OSPF/EIGRP `network` commands', () => {
    expect(wildcardMatches('10.0.0.1', '10.0.0.0', '0.0.0.255')).toBe(true);
    expect(wildcardMatches('10.0.1.1', '10.0.0.0', '0.0.0.255')).toBe(false);
    expect(wildcardMatches('10.0.1.1', '10.0.0.0', '0.0.255.255')).toBe(true);
  });

  it('0.0.0.0 wildcard requires an exact host match', () => {
    expect(wildcardMatches('10.0.0.1', '10.0.0.1', '0.0.0.0')).toBe(true);
    expect(wildcardMatches('10.0.0.2', '10.0.0.1', '0.0.0.0')).toBe(false);
  });

  it('255.255.255.255 wildcard matches anything', () => {
    expect(wildcardMatches('1.2.3.4', '99.99.99.99', '255.255.255.255')).toBe(true);
  });
});
