/**
 * Unit tests for SubnetMask value object
 * Following TDD approach - tests written first
 */

import { describe, it, expect } from 'vitest';
import { SubnetMask } from '@/domain/network/value-objects/SubnetMask';

describe('SubnetMask', () => {
  describe('constructor', () => {
    it('should create valid subnet mask', () => {
      const mask = new SubnetMask('255.255.255.0');
      expect(mask.toString()).toBe('255.255.255.0');
    });

    it('should accept CIDR notation', () => {
      const mask = new SubnetMask('/24');
      expect(mask.toString()).toBe('255.255.255.0');
      expect(mask.getCIDR()).toBe(24);
    });

    it('should throw error for invalid subnet mask', () => {
      expect(() => new SubnetMask('255.255.255.1')).toThrow('Invalid subnet mask');
      expect(() => new SubnetMask('255.255.128.255')).toThrow('Invalid subnet mask');
    });

    it('should throw error for invalid CIDR', () => {
      expect(() => new SubnetMask('/33')).toThrow('Invalid CIDR notation');
      expect(() => new SubnetMask('/-1')).toThrow('Invalid CIDR notation');
    });
  });

  describe('getCIDR', () => {
    it('should return correct CIDR notation', () => {
      expect(new SubnetMask('255.255.255.255').getCIDR()).toBe(32);
      expect(new SubnetMask('255.255.255.0').getCIDR()).toBe(24);
      expect(new SubnetMask('255.255.0.0').getCIDR()).toBe(16);
      expect(new SubnetMask('255.0.0.0').getCIDR()).toBe(8);
      expect(new SubnetMask('0.0.0.0').getCIDR()).toBe(0);
    });
  });

  describe('getHostCount', () => {
    it('should return number of usable host addresses', () => {
      expect(new SubnetMask('255.255.255.252').getHostCount()).toBe(2); // /30
      expect(new SubnetMask('255.255.255.0').getHostCount()).toBe(254); // /24
      expect(new SubnetMask('255.255.0.0').getHostCount()).toBe(65534); // /16
    });

    it('should return 0 for /32 mask', () => {
      expect(new SubnetMask('255.255.255.255').getHostCount()).toBe(0);
    });
  });

  describe('static fromCIDR', () => {
    it('should create subnet mask from CIDR', () => {
      expect(SubnetMask.fromCIDR(24).toString()).toBe('255.255.255.0');
      expect(SubnetMask.fromCIDR(16).toString()).toBe('255.255.0.0');
      expect(SubnetMask.fromCIDR(8).toString()).toBe('255.0.0.0');
      expect(SubnetMask.fromCIDR(32).toString()).toBe('255.255.255.255');
      expect(SubnetMask.fromCIDR(0).toString()).toBe('0.0.0.0');
    });
  });
});
