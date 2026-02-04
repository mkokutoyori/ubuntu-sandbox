/**
 * Tests for core types: MACAddress, IPAddress, SubnetMask, EthernetFrame
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { MACAddress, IPAddress, SubnetMask } from '@/network/core/types';

describe('MACAddress', () => {
  beforeEach(() => {
    MACAddress.resetCounter();
  });

  it('should parse a valid MAC address string', () => {
    const mac = new MACAddress('aa:bb:cc:dd:ee:ff');
    expect(mac.toString()).toBe('aa:bb:cc:dd:ee:ff');
  });

  it('should parse dash-separated MAC', () => {
    const mac = new MACAddress('AA-BB-CC-DD-EE-FF');
    expect(mac.toString()).toBe('aa:bb:cc:dd:ee:ff');
  });

  it('should generate unique MACs', () => {
    const mac1 = MACAddress.generate();
    const mac2 = MACAddress.generate();
    expect(mac1.equals(mac2)).toBe(false);
  });

  it('should detect broadcast', () => {
    const bc = MACAddress.broadcast();
    expect(bc.isBroadcast()).toBe(true);
    expect(bc.toString()).toBe('ff:ff:ff:ff:ff:ff');
  });

  it('should compare equality', () => {
    const a = new MACAddress('02:00:00:00:00:01');
    const b = new MACAddress('02:00:00:00:00:01');
    expect(a.equals(b)).toBe(true);
  });

  it('should reject invalid MAC', () => {
    expect(() => new MACAddress('invalid')).toThrow();
  });
});

describe('IPAddress', () => {
  it('should parse a valid IP', () => {
    const ip = new IPAddress('192.168.1.10');
    expect(ip.toString()).toBe('192.168.1.10');
  });

  it('should compare equality', () => {
    const a = new IPAddress('10.0.0.1');
    const b = new IPAddress('10.0.0.1');
    expect(a.equals(b)).toBe(true);
  });

  it('should detect same subnet', () => {
    const a = new IPAddress('192.168.1.10');
    const b = new IPAddress('192.168.1.20');
    const mask = new SubnetMask('255.255.255.0');
    expect(a.isInSameSubnet(b, mask)).toBe(true);
  });

  it('should detect different subnet', () => {
    const a = new IPAddress('192.168.1.10');
    const b = new IPAddress('192.168.2.20');
    const mask = new SubnetMask('255.255.255.0');
    expect(a.isInSameSubnet(b, mask)).toBe(false);
  });

  it('should reject invalid IP', () => {
    expect(() => new IPAddress('999.0.0.1')).toThrow();
  });
});

describe('SubnetMask', () => {
  it('should parse mask string', () => {
    const mask = new SubnetMask('255.255.255.0');
    expect(mask.toString()).toBe('255.255.255.0');
  });

  it('should create from CIDR', () => {
    const mask = SubnetMask.fromCIDR(24);
    expect(mask.toString()).toBe('255.255.255.0');
  });

  it('should convert to CIDR', () => {
    const mask = new SubnetMask('255.255.255.0');
    expect(mask.toCIDR()).toBe(24);
  });
});
