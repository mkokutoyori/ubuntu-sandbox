/**
 * Unit tests for EthernetFrame entity
 * Following TDD approach - tests written first
 */

import { describe, it, expect } from 'vitest';
import { EthernetFrame, EtherType } from '@/domain/network/entities/EthernetFrame';
import { MACAddress } from '@/domain/network/value-objects/MACAddress';

describe('EthernetFrame', () => {
  describe('constructor', () => {
    it('should create valid Ethernet frame', () => {
      const payload = Buffer.alloc(46); // Minimum payload size
      payload[0] = 0x45;
      payload[1] = 0x00;

      const frame = new EthernetFrame({
        sourceMAC: new MACAddress('AA:BB:CC:DD:EE:FF'),
        destinationMAC: new MACAddress('11:22:33:44:55:66'),
        etherType: EtherType.IPv4,
        payload
      });

      expect(frame.getSourceMAC().toString()).toBe('AA:BB:CC:DD:EE:FF');
      expect(frame.getDestinationMAC().toString()).toBe('11:22:33:44:55:66');
      expect(frame.getEtherType()).toBe(EtherType.IPv4);
    });

    it('should throw error for payload too large', () => {
      const largePayload = Buffer.alloc(1501); // Max is 1500
      expect(() => new EthernetFrame({
        sourceMAC: new MACAddress('AA:BB:CC:DD:EE:FF'),
        destinationMAC: new MACAddress('11:22:33:44:55:66'),
        etherType: EtherType.IPv4,
        payload: largePayload
      })).toThrow('Payload size exceeds maximum');
    });

    it('should throw error for payload too small', () => {
      const smallPayload = Buffer.alloc(45); // Min is 46 bytes
      expect(() => new EthernetFrame({
        sourceMAC: new MACAddress('AA:BB:CC:DD:EE:FF'),
        destinationMAC: new MACAddress('11:22:33:44:55:66'),
        etherType: EtherType.IPv4,
        payload: smallPayload
      })).toThrow('Payload size below minimum');
    });
  });

  describe('isBroadcast', () => {
    it('should return true for broadcast frame', () => {
      const frame = new EthernetFrame({
        sourceMAC: new MACAddress('AA:BB:CC:DD:EE:FF'),
        destinationMAC: MACAddress.BROADCAST,
        etherType: EtherType.ARP,
        payload: Buffer.alloc(46)
      });

      expect(frame.isBroadcast()).toBe(true);
    });

    it('should return false for unicast frame', () => {
      const frame = new EthernetFrame({
        sourceMAC: new MACAddress('AA:BB:CC:DD:EE:FF'),
        destinationMAC: new MACAddress('11:22:33:44:55:66'),
        etherType: EtherType.IPv4,
        payload: Buffer.alloc(46)
      });

      expect(frame.isBroadcast()).toBe(false);
    });
  });

  describe('isMulticast', () => {
    it('should return true for multicast frame', () => {
      const frame = new EthernetFrame({
        sourceMAC: new MACAddress('AA:BB:CC:DD:EE:FF'),
        destinationMAC: new MACAddress('01:00:5E:00:00:01'),
        etherType: EtherType.IPv4,
        payload: Buffer.alloc(46)
      });

      expect(frame.isMulticast()).toBe(true);
    });
  });

  describe('getSize', () => {
    it('should return total frame size including header', () => {
      const payload = Buffer.alloc(100);
      const frame = new EthernetFrame({
        sourceMAC: new MACAddress('AA:BB:CC:DD:EE:FF'),
        destinationMAC: new MACAddress('11:22:33:44:55:66'),
        etherType: EtherType.IPv4,
        payload
      });

      // Header (14 bytes) + Payload (100 bytes) = 114 bytes
      expect(frame.getSize()).toBe(114);
    });
  });

  describe('toBytes', () => {
    it('should serialize frame to bytes', () => {
      const payload = Buffer.from([0x45, 0x00]);
      const frame = new EthernetFrame({
        sourceMAC: new MACAddress('AA:BB:CC:DD:EE:FF'),
        destinationMAC: new MACAddress('11:22:33:44:55:66'),
        etherType: EtherType.IPv4,
        payload: Buffer.concat([payload, Buffer.alloc(44)]) // Pad to minimum
      });

      const bytes = frame.toBytes();
      expect(bytes.length).toBeGreaterThanOrEqual(60); // Minimum frame size

      // Check destination MAC (first 6 bytes)
      expect(bytes.slice(0, 6)).toEqual(Buffer.from([0x11, 0x22, 0x33, 0x44, 0x55, 0x66]));

      // Check source MAC (next 6 bytes)
      expect(bytes.slice(6, 12)).toEqual(Buffer.from([0xAA, 0xBB, 0xCC, 0xDD, 0xEE, 0xFF]));

      // Check EtherType (next 2 bytes) - IPv4 is 0x0800
      expect(bytes.readUInt16BE(12)).toBe(0x0800);
    });
  });

  describe('static fromBytes', () => {
    it('should deserialize frame from bytes', () => {
      // Create minimum frame: 14 header + 46 payload + 4 padding = 64 bytes
      const frameData = Buffer.concat([
        Buffer.from([0x11, 0x22, 0x33, 0x44, 0x55, 0x66]), // Dest MAC (6 bytes)
        Buffer.from([0xAA, 0xBB, 0xCC, 0xDD, 0xEE, 0xFF]), // Source MAC (6 bytes)
        Buffer.from([0x08, 0x00]), // EtherType (2 bytes)
        Buffer.alloc(50) // Payload + padding to reach 64 bytes total
      ]);

      const frame = EthernetFrame.fromBytes(frameData);

      expect(frame.getDestinationMAC().toString()).toBe('11:22:33:44:55:66');
      expect(frame.getSourceMAC().toString()).toBe('AA:BB:CC:DD:EE:FF');
      expect(frame.getEtherType()).toBe(EtherType.IPv4);
    });

    it('should throw error for invalid frame size', () => {
      const tooSmall = Buffer.alloc(50);
      expect(() => EthernetFrame.fromBytes(tooSmall)).toThrow('Invalid frame size');
    });
  });

  describe('EtherType constants', () => {
    it('should have correct EtherType values', () => {
      expect(EtherType.IPv4).toBe(0x0800);
      expect(EtherType.ARP).toBe(0x0806);
      expect(EtherType.IPv6).toBe(0x86DD);
    });
  });
});
