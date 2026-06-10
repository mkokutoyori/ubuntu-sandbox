/**
 * Address operations that ad-hoc `.split('.')` sites across the codebase
 * reimplement. Centralizing them on IPAddress is the first step of the
 * address-deduplication phase, so there is one canonical representation and
 * one place for IP arithmetic.
 */

import { describe, it, expect } from 'vitest';
import { IPAddress, SubnetMask } from '@/network/core/types';

describe('IPAddress.isValid', () => {
  it.each(['0.0.0.0', '255.255.255.255', '10.0.0.1', '192.168.1.254'])(
    'accepts %s', (s) => expect(IPAddress.isValid(s)).toBe(true),
  );
  it.each(['', 'abc', '1.2.3', '1.2.3.4.5', '256.0.0.1', '1.2.3.-1', '01.02.03.04x'])(
    'rejects %j', (s) => expect(IPAddress.isValid(s)).toBe(false),
  );
});

describe('IPAddress.tryParse', () => {
  it('returns an IPAddress for a valid string', () => {
    const ip = IPAddress.tryParse('10.0.0.1');
    expect(ip).toBeInstanceOf(IPAddress);
    expect(ip?.toString()).toBe('10.0.0.1');
  });
  it('returns null for an invalid string (no throw)', () => {
    expect(IPAddress.tryParse('nope')).toBeNull();
  });
});

describe('IPAddress.networkAddress', () => {
  it('masks host bits to yield the network address', () => {
    expect(new IPAddress('10.0.0.137').networkAddress(new SubnetMask('255.255.255.0')).toString())
      .toBe('10.0.0.0');
    expect(new IPAddress('172.16.5.9').networkAddress(new SubnetMask('255.255.0.0')).toString())
      .toBe('172.16.0.0');
    expect(new IPAddress('192.168.1.130').networkAddress(new SubnetMask('255.255.255.192')).toString())
      .toBe('192.168.1.128');
  });
});
