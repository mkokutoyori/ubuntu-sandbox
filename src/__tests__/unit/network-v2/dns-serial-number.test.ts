import { describe, it, expect } from 'vitest';
import { serialGreaterThan, serialAdd, SerialNumberError } from '@/network/dns/zone/SerialNumber';

describe('SerialNumber — RFC 1982 circular serial arithmetic', () => {
  describe('serialGreaterThan', () => {
    it('says a normal successor is greater than its predecessor', () => {
      expect(serialGreaterThan(2, 1)).toBe(true);
      expect(serialGreaterThan(1, 2)).toBe(false);
    });

    it('treats equal serials as not greater', () => {
      expect(serialGreaterThan(5, 5)).toBe(false);
    });

    it('handles wraparound: 0 is greater than the maximum 32-bit serial', () => {
      expect(serialGreaterThan(0, 0xffffffff)).toBe(true);
      expect(serialGreaterThan(0xffffffff, 0)).toBe(false);
    });

    it('handles wraparound across the halfway point per RFC 1982 §3.2', () => {
      // i1=1, i2=0xFFFFFFFF: i2 - i1 mod 2^32 = 0xFFFFFFFE which is > 2^31,
      // so per the RFC, i2 is considered smaller (i1 is greater).
      expect(serialGreaterThan(1, 0xffffffff)).toBe(true);
    });

    it('throws when the two serials are exactly half the serial space apart (undefined by RFC 1982)', () => {
      expect(() => serialGreaterThan(0, 0x80000000)).toThrow(SerialNumberError);
    });

    it('rejects serials outside the unsigned 32-bit range', () => {
      expect(() => serialGreaterThan(-1, 0)).toThrow(SerialNumberError);
      expect(() => serialGreaterThan(0, 0x100000000)).toThrow(SerialNumberError);
    });
  });

  describe('serialAdd', () => {
    it('adds within range without wrapping', () => {
      expect(serialAdd(10, 5)).toBe(15);
    });

    it('wraps around modulo 2^32', () => {
      expect(serialAdd(0xffffffff, 1)).toBe(0);
      expect(serialAdd(0xfffffffe, 3)).toBe(1);
    });

    it('rejects adding more than half the serial space (undefined by RFC 1982 §3.1)', () => {
      expect(() => serialAdd(0, 0x80000000)).toThrow(SerialNumberError);
    });

    it('rejects a negative addend', () => {
      expect(() => serialAdd(0, -1)).toThrow(SerialNumberError);
    });
  });
});
