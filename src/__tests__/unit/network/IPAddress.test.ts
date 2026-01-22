/**
 * Unit tests for IPAddress value object
 * Following TDD approach - tests written first
 */

import { describe, it, expect } from 'vitest';
import { IPAddress } from '@/domain/network/value-objects/IPAddress';

describe('IPAddress', () => {
  describe('constructor', () => {
    it('should create valid IPv4 address', () => {
      const ip = new IPAddress('192.168.1.1');
      expect(ip.toString()).toBe('192.168.1.1');
    });

    it('should throw error for invalid IPv4 format', () => {
      expect(() => new IPAddress('invalid')).toThrow('Invalid IPv4 address format');
      expect(() => new IPAddress('192.168.1')).toThrow('Invalid IPv4 address format');
      expect(() => new IPAddress('192.168.1.1.1')).toThrow('Invalid IPv4 address format');
    });

    it('should throw error for out-of-range octets', () => {
      expect(() => new IPAddress('256.168.1.1')).toThrow('Invalid IPv4 address format');
      expect(() => new IPAddress('192.256.1.1')).toThrow('Invalid IPv4 address format');
      expect(() => new IPAddress('192.168.256.1')).toThrow('Invalid IPv4 address format');
      expect(() => new IPAddress('192.168.1.256')).toThrow('Invalid IPv4 address format');
    });

    it('should throw error for negative octets', () => {
      expect(() => new IPAddress('-1.168.1.1')).toThrow('Invalid IPv4 address format');
    });

    it('should throw error for empty address', () => {
      expect(() => new IPAddress('')).toThrow('Invalid IPv4 address format');
    });
  });

  describe('isPrivate', () => {
    it('should return true for 10.0.0.0/8 range', () => {
      expect(new IPAddress('10.0.0.1').isPrivate()).toBe(true);
      expect(new IPAddress('10.255.255.255').isPrivate()).toBe(true);
    });

    it('should return true for 172.16.0.0/12 range', () => {
      expect(new IPAddress('172.16.0.1').isPrivate()).toBe(true);
      expect(new IPAddress('172.31.255.255').isPrivate()).toBe(true);
    });

    it('should return true for 192.168.0.0/16 range', () => {
      expect(new IPAddress('192.168.0.1').isPrivate()).toBe(true);
      expect(new IPAddress('192.168.255.255').isPrivate()).toBe(true);
    });

    it('should return false for public addresses', () => {
      expect(new IPAddress('8.8.8.8').isPrivate()).toBe(false);
      expect(new IPAddress('1.1.1.1').isPrivate()).toBe(false);
      expect(new IPAddress('172.15.0.1').isPrivate()).toBe(false);
      expect(new IPAddress('172.32.0.1').isPrivate()).toBe(false);
    });
  });

  describe('isLoopback', () => {
    it('should return true for 127.0.0.0/8 range', () => {
      expect(new IPAddress('127.0.0.1').isLoopback()).toBe(true);
      expect(new IPAddress('127.0.0.0').isLoopback()).toBe(true);
      expect(new IPAddress('127.255.255.255').isLoopback()).toBe(true);
    });

    it('should return false for non-loopback addresses', () => {
      expect(new IPAddress('192.168.1.1').isLoopback()).toBe(false);
      expect(new IPAddress('8.8.8.8').isLoopback()).toBe(false);
    });
  });

  describe('isBroadcast', () => {
    it('should return true for 255.255.255.255', () => {
      expect(new IPAddress('255.255.255.255').isBroadcast()).toBe(true);
    });

    it('should return false for other addresses', () => {
      expect(new IPAddress('192.168.1.255').isBroadcast()).toBe(false);
      expect(new IPAddress('0.0.0.0').isBroadcast()).toBe(false);
    });
  });

  describe('isMulticast', () => {
    it('should return true for 224.0.0.0/4 range', () => {
      expect(new IPAddress('224.0.0.0').isMulticast()).toBe(true);
      expect(new IPAddress('239.255.255.255').isMulticast()).toBe(true);
      expect(new IPAddress('230.1.2.3').isMulticast()).toBe(true);
    });

    it('should return false for non-multicast addresses', () => {
      expect(new IPAddress('192.168.1.1').isMulticast()).toBe(false);
      expect(new IPAddress('223.255.255.255').isMulticast()).toBe(false);
      expect(new IPAddress('240.0.0.0').isMulticast()).toBe(false);
    });
  });

  describe('equals', () => {
    it('should return true for equal IP addresses', () => {
      const ip1 = new IPAddress('192.168.1.1');
      const ip2 = new IPAddress('192.168.1.1');
      expect(ip1.equals(ip2)).toBe(true);
    });

    it('should return false for different IP addresses', () => {
      const ip1 = new IPAddress('192.168.1.1');
      const ip2 = new IPAddress('192.168.1.2');
      expect(ip1.equals(ip2)).toBe(false);
    });
  });

  describe('toBytes', () => {
    it('should return byte array representation', () => {
      const ip = new IPAddress('192.168.1.1');
      expect(ip.toBytes()).toEqual([192, 168, 1, 1]);
    });

    it('should handle edge case addresses', () => {
      expect(new IPAddress('0.0.0.0').toBytes()).toEqual([0, 0, 0, 0]);
      expect(new IPAddress('255.255.255.255').toBytes()).toEqual([255, 255, 255, 255]);
    });
  });

  describe('toNumber', () => {
    it('should return numeric representation', () => {
      const ip = new IPAddress('192.168.1.1');
      // 192 * 256^3 + 168 * 256^2 + 1 * 256 + 1 = 3232235777
      expect(ip.toNumber()).toBe(3232235777);
    });

    it('should handle edge cases', () => {
      expect(new IPAddress('0.0.0.0').toNumber()).toBe(0);
      expect(new IPAddress('255.255.255.255').toNumber()).toBe(4294967295);
    });
  });

  describe('static fromBytes', () => {
    it('should create IP address from byte array', () => {
      const ip = IPAddress.fromBytes([192, 168, 1, 1]);
      expect(ip.toString()).toBe('192.168.1.1');
    });

    it('should throw error for invalid byte array length', () => {
      expect(() => IPAddress.fromBytes([192, 168, 1])).toThrow('IPv4 address must be 4 bytes');
    });

    it('should throw error for invalid byte values', () => {
      expect(() => IPAddress.fromBytes([256, 168, 1, 1])).toThrow('Invalid byte value');
      expect(() => IPAddress.fromBytes([-1, 168, 1, 1])).toThrow('Invalid byte value');
    });
  });

  describe('static fromNumber', () => {
    it('should create IP address from number', () => {
      const ip = IPAddress.fromNumber(3232235777);
      expect(ip.toString()).toBe('192.168.1.1');
    });

    it('should handle edge cases', () => {
      expect(IPAddress.fromNumber(0).toString()).toBe('0.0.0.0');
      expect(IPAddress.fromNumber(4294967295).toString()).toBe('255.255.255.255');
    });

    it('should throw error for invalid numbers', () => {
      expect(() => IPAddress.fromNumber(-1)).toThrow('Invalid number');
      expect(() => IPAddress.fromNumber(4294967296)).toThrow('Invalid number');
    });
  });

  describe('isInSubnet', () => {
    it('should check if IP is in subnet', () => {
      const ip = new IPAddress('192.168.1.100');
      expect(ip.isInSubnet('192.168.1.0', '255.255.255.0')).toBe(true);
      expect(ip.isInSubnet('192.168.0.0', '255.255.0.0')).toBe(true);
      expect(ip.isInSubnet('192.0.0.0', '255.0.0.0')).toBe(true);
    });

    it('should return false if IP is not in subnet', () => {
      const ip = new IPAddress('192.168.1.100');
      expect(ip.isInSubnet('192.168.2.0', '255.255.255.0')).toBe(false);
      expect(ip.isInSubnet('10.0.0.0', '255.0.0.0')).toBe(false);
    });
  });
});
