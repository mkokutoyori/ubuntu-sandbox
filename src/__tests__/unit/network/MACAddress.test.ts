/**
 * Unit tests for MACAddress value object
 * Following TDD approach - tests written first
 */

import { describe, it, expect } from 'vitest';
import { MACAddress } from '@/domain/network/value-objects/MACAddress';

describe('MACAddress', () => {
  describe('constructor', () => {
    it('should create valid MAC address', () => {
      const mac = new MACAddress('AA:BB:CC:DD:EE:FF');
      expect(mac.toString()).toBe('AA:BB:CC:DD:EE:FF');
    });

    it('should accept lowercase MAC address', () => {
      const mac = new MACAddress('aa:bb:cc:dd:ee:ff');
      expect(mac.toString()).toBe('AA:BB:CC:DD:EE:FF');
    });

    it('should accept MAC address with dashes', () => {
      const mac = new MACAddress('AA-BB-CC-DD-EE-FF');
      expect(mac.toString()).toBe('AA:BB:CC:DD:EE:FF');
    });

    it('should throw error for invalid MAC address format', () => {
      expect(() => new MACAddress('invalid')).toThrow('Invalid MAC address format');
      expect(() => new MACAddress('AA:BB:CC:DD:EE')).toThrow('Invalid MAC address format');
      expect(() => new MACAddress('ZZ:BB:CC:DD:EE:FF')).toThrow('Invalid MAC address format');
    });

    it('should throw error for empty MAC address', () => {
      expect(() => new MACAddress('')).toThrow('Invalid MAC address format');
    });
  });

  describe('isBroadcast', () => {
    it('should return true for broadcast MAC address', () => {
      const mac = new MACAddress('FF:FF:FF:FF:FF:FF');
      expect(mac.isBroadcast()).toBe(true);
    });

    it('should return false for non-broadcast MAC address', () => {
      const mac = new MACAddress('AA:BB:CC:DD:EE:FF');
      expect(mac.isBroadcast()).toBe(false);
    });
  });

  describe('isMulticast', () => {
    it('should return true for multicast MAC address (LSB of first octet is 1)', () => {
      const mac = new MACAddress('01:00:5E:00:00:01');
      expect(mac.isMulticast()).toBe(true);
    });

    it('should return false for unicast MAC address (LSB of first octet is 0)', () => {
      const mac = new MACAddress('00:11:22:33:44:55');
      expect(mac.isMulticast()).toBe(false);
    });
  });

  describe('equals', () => {
    it('should return true for equal MAC addresses', () => {
      const mac1 = new MACAddress('AA:BB:CC:DD:EE:FF');
      const mac2 = new MACAddress('AA:BB:CC:DD:EE:FF');
      expect(mac1.equals(mac2)).toBe(true);
    });

    it('should return true for equal MAC addresses with different formats', () => {
      const mac1 = new MACAddress('AA:BB:CC:DD:EE:FF');
      const mac2 = new MACAddress('aa-bb-cc-dd-ee-ff');
      expect(mac1.equals(mac2)).toBe(true);
    });

    it('should return false for different MAC addresses', () => {
      const mac1 = new MACAddress('AA:BB:CC:DD:EE:FF');
      const mac2 = new MACAddress('11:22:33:44:55:66');
      expect(mac1.equals(mac2)).toBe(false);
    });
  });

  describe('toBytes', () => {
    it('should return byte array representation', () => {
      const mac = new MACAddress('AA:BB:CC:DD:EE:FF');
      const bytes = mac.toBytes();
      expect(bytes).toEqual([0xAA, 0xBB, 0xCC, 0xDD, 0xEE, 0xFF]);
    });
  });

  describe('static fromBytes', () => {
    it('should create MAC address from byte array', () => {
      const bytes = [0xAA, 0xBB, 0xCC, 0xDD, 0xEE, 0xFF];
      const mac = MACAddress.fromBytes(bytes);
      expect(mac.toString()).toBe('AA:BB:CC:DD:EE:FF');
    });

    it('should throw error for invalid byte array length', () => {
      expect(() => MACAddress.fromBytes([0xAA, 0xBB])).toThrow('MAC address must be 6 bytes');
    });

    it('should throw error for invalid byte values', () => {
      expect(() => MACAddress.fromBytes([0xAA, 0xBB, 0xCC, 0xDD, 0xEE, 256])).toThrow(
        'Invalid byte value'
      );
    });
  });

  describe('static BROADCAST', () => {
    it('should provide broadcast MAC address constant', () => {
      expect(MACAddress.BROADCAST.toString()).toBe('FF:FF:FF:FF:FF:FF');
      expect(MACAddress.BROADCAST.isBroadcast()).toBe(true);
    });
  });

  describe('static ZERO', () => {
    it('should provide zero MAC address constant', () => {
      expect(MACAddress.ZERO.toString()).toBe('00:00:00:00:00:00');
    });
  });
});
