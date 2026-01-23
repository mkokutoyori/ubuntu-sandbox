/**
 * Unit tests for ICMPPacket
 * Following TDD approach - tests written first
 *
 * ICMP (Internet Control Message Protocol) - RFC 792
 * Used for diagnostic and control purposes (ping, traceroute)
 *
 * ICMP Message Types:
 * - Type 0: Echo Reply
 * - Type 3: Destination Unreachable
 * - Type 8: Echo Request
 * - Type 11: Time Exceeded
 */

import { describe, it, expect } from 'vitest';
import { ICMPPacket, ICMPType, ICMPCode } from '@/domain/network/entities/ICMPPacket';

describe('ICMPPacket', () => {
  describe('construction', () => {
    it('should create Echo Request packet', () => {
      const packet = new ICMPPacket({
        type: ICMPType.ECHO_REQUEST,
        code: 0,
        identifier: 1234,
        sequenceNumber: 1,
        data: Buffer.from('test data')
      });

      expect(packet.getType()).toBe(ICMPType.ECHO_REQUEST);
      expect(packet.getCode()).toBe(0);
      expect(packet.getIdentifier()).toBe(1234);
      expect(packet.getSequenceNumber()).toBe(1);
      expect(packet.getData().toString()).toBe('test data');
    });

    it('should create Echo Reply packet', () => {
      const packet = new ICMPPacket({
        type: ICMPType.ECHO_REPLY,
        code: 0,
        identifier: 1234,
        sequenceNumber: 1,
        data: Buffer.from('test data')
      });

      expect(packet.getType()).toBe(ICMPType.ECHO_REPLY);
      expect(packet.getCode()).toBe(0);
    });

    it('should create Time Exceeded packet', () => {
      const originalIPHeader = Buffer.alloc(20);

      const packet = new ICMPPacket({
        type: ICMPType.TIME_EXCEEDED,
        code: ICMPCode.TTL_EXCEEDED,
        data: originalIPHeader
      });

      expect(packet.getType()).toBe(ICMPType.TIME_EXCEEDED);
      expect(packet.getCode()).toBe(ICMPCode.TTL_EXCEEDED);
    });

    it('should create Destination Unreachable packet', () => {
      const originalIPHeader = Buffer.alloc(20);

      const packet = new ICMPPacket({
        type: ICMPType.DEST_UNREACHABLE,
        code: ICMPCode.HOST_UNREACHABLE,
        data: originalIPHeader
      });

      expect(packet.getType()).toBe(ICMPType.DEST_UNREACHABLE);
      expect(packet.getCode()).toBe(ICMPCode.HOST_UNREACHABLE);
    });

    it('should default identifier and sequence to 0', () => {
      const packet = new ICMPPacket({
        type: ICMPType.ECHO_REQUEST,
        code: 0,
        data: Buffer.alloc(0)
      });

      expect(packet.getIdentifier()).toBe(0);
      expect(packet.getSequenceNumber()).toBe(0);
    });
  });

  describe('serialization', () => {
    it('should serialize Echo Request to bytes', () => {
      const packet = new ICMPPacket({
        type: ICMPType.ECHO_REQUEST,
        code: 0,
        identifier: 0x1234,
        sequenceNumber: 0x0001,
        data: Buffer.from('hello')
      });

      const bytes = packet.toBytes();

      // ICMP Header: 8 bytes + data
      expect(bytes.length).toBe(8 + 5);

      // Type (1 byte)
      expect(bytes[0]).toBe(ICMPType.ECHO_REQUEST);

      // Code (1 byte)
      expect(bytes[1]).toBe(0);

      // Checksum (2 bytes) - skip for now, tested separately

      // Identifier (2 bytes, big-endian)
      expect(bytes.readUInt16BE(4)).toBe(0x1234);

      // Sequence Number (2 bytes, big-endian)
      expect(bytes.readUInt16BE(6)).toBe(0x0001);

      // Data
      expect(bytes.subarray(8).toString()).toBe('hello');
    });

    it('should calculate correct checksum', () => {
      const packet = new ICMPPacket({
        type: ICMPType.ECHO_REQUEST,
        code: 0,
        identifier: 0x1234,
        sequenceNumber: 0x0001,
        data: Buffer.from('test')
      });

      const bytes = packet.toBytes();
      const checksum = bytes.readUInt16BE(2);

      // Verify checksum is non-zero
      expect(checksum).toBeGreaterThan(0);

      // Verify checksum by recalculating
      // Set checksum to 0 and recalculate
      const testBytes = Buffer.from(bytes);
      testBytes.writeUInt16BE(0, 2);

      let sum = 0;
      for (let i = 0; i < testBytes.length; i += 2) {
        if (i + 1 < testBytes.length) {
          sum += testBytes.readUInt16BE(i);
        } else {
          sum += testBytes[i] << 8;
        }
      }

      while (sum >> 16) {
        sum = (sum & 0xFFFF) + (sum >> 16);
      }

      const calculatedChecksum = ~sum & 0xFFFF;
      expect(checksum).toBe(calculatedChecksum);
    });

    it('should serialize Time Exceeded packet', () => {
      const originalIPHeader = Buffer.alloc(20, 0xAB);

      const packet = new ICMPPacket({
        type: ICMPType.TIME_EXCEEDED,
        code: ICMPCode.TTL_EXCEEDED,
        data: originalIPHeader
      });

      const bytes = packet.toBytes();

      expect(bytes[0]).toBe(ICMPType.TIME_EXCEEDED);
      expect(bytes[1]).toBe(ICMPCode.TTL_EXCEEDED);
      expect(bytes.subarray(8)).toEqual(originalIPHeader);
    });
  });

  describe('deserialization', () => {
    it('should deserialize Echo Request from bytes', () => {
      const bytes = Buffer.alloc(13);
      bytes[0] = ICMPType.ECHO_REQUEST;
      bytes[1] = 0;
      bytes.writeUInt16BE(0x1234, 4); // identifier
      bytes.writeUInt16BE(0x0001, 6); // sequence
      bytes.write('hello', 8);

      // Calculate checksum
      let sum = 0;
      for (let i = 0; i < bytes.length; i += 2) {
        if (i === 2) continue; // skip checksum field
        if (i + 1 < bytes.length) {
          sum += bytes.readUInt16BE(i);
        } else {
          sum += bytes[i] << 8;
        }
      }
      while (sum >> 16) {
        sum = (sum & 0xFFFF) + (sum >> 16);
      }
      bytes.writeUInt16BE(~sum & 0xFFFF, 2);

      const packet = ICMPPacket.fromBytes(bytes);

      expect(packet.getType()).toBe(ICMPType.ECHO_REQUEST);
      expect(packet.getCode()).toBe(0);
      expect(packet.getIdentifier()).toBe(0x1234);
      expect(packet.getSequenceNumber()).toBe(0x0001);
      expect(packet.getData().toString()).toBe('hello');
    });

    it('should verify checksum on deserialization', () => {
      const bytes = Buffer.alloc(13);
      bytes[0] = ICMPType.ECHO_REQUEST;
      bytes[1] = 0;
      bytes.writeUInt16BE(0xFFFF, 2); // invalid checksum
      bytes.writeUInt16BE(0x1234, 4);
      bytes.writeUInt16BE(0x0001, 6);
      bytes.write('hello', 8);

      expect(() => {
        ICMPPacket.fromBytes(bytes);
      }).toThrow('Invalid ICMP checksum');
    });

    it('should round-trip serialize/deserialize', () => {
      const original = new ICMPPacket({
        type: ICMPType.ECHO_REQUEST,
        code: 0,
        identifier: 9999,
        sequenceNumber: 42,
        data: Buffer.from('ping test data')
      });

      const bytes = original.toBytes();
      const restored = ICMPPacket.fromBytes(bytes);

      expect(restored.getType()).toBe(original.getType());
      expect(restored.getCode()).toBe(original.getCode());
      expect(restored.getIdentifier()).toBe(original.getIdentifier());
      expect(restored.getSequenceNumber()).toBe(original.getSequenceNumber());
      expect(restored.getData()).toEqual(original.getData());
    });
  });

  describe('helper methods', () => {
    it('should identify Echo Request', () => {
      const packet = new ICMPPacket({
        type: ICMPType.ECHO_REQUEST,
        code: 0,
        data: Buffer.alloc(0)
      });

      expect(packet.isEchoRequest()).toBe(true);
      expect(packet.isEchoReply()).toBe(false);
      expect(packet.isTimeExceeded()).toBe(false);
      expect(packet.isDestUnreachable()).toBe(false);
    });

    it('should identify Echo Reply', () => {
      const packet = new ICMPPacket({
        type: ICMPType.ECHO_REPLY,
        code: 0,
        data: Buffer.alloc(0)
      });

      expect(packet.isEchoRequest()).toBe(false);
      expect(packet.isEchoReply()).toBe(true);
      expect(packet.isTimeExceeded()).toBe(false);
      expect(packet.isDestUnreachable()).toBe(false);
    });

    it('should identify Time Exceeded', () => {
      const packet = new ICMPPacket({
        type: ICMPType.TIME_EXCEEDED,
        code: ICMPCode.TTL_EXCEEDED,
        data: Buffer.alloc(0)
      });

      expect(packet.isEchoRequest()).toBe(false);
      expect(packet.isEchoReply()).toBe(false);
      expect(packet.isTimeExceeded()).toBe(true);
      expect(packet.isDestUnreachable()).toBe(false);
    });

    it('should identify Destination Unreachable', () => {
      const packet = new ICMPPacket({
        type: ICMPType.DEST_UNREACHABLE,
        code: ICMPCode.HOST_UNREACHABLE,
        data: Buffer.alloc(0)
      });

      expect(packet.isEchoRequest()).toBe(false);
      expect(packet.isEchoReply()).toBe(false);
      expect(packet.isTimeExceeded()).toBe(false);
      expect(packet.isDestUnreachable()).toBe(true);
    });

    it('should get type name', () => {
      expect(new ICMPPacket({
        type: ICMPType.ECHO_REQUEST,
        code: 0,
        data: Buffer.alloc(0)
      }).getTypeName()).toBe('Echo Request');

      expect(new ICMPPacket({
        type: ICMPType.ECHO_REPLY,
        code: 0,
        data: Buffer.alloc(0)
      }).getTypeName()).toBe('Echo Reply');

      expect(new ICMPPacket({
        type: ICMPType.TIME_EXCEEDED,
        code: 0,
        data: Buffer.alloc(0)
      }).getTypeName()).toBe('Time Exceeded');

      expect(new ICMPPacket({
        type: ICMPType.DEST_UNREACHABLE,
        code: 0,
        data: Buffer.alloc(0)
      }).getTypeName()).toBe('Destination Unreachable');
    });
  });

  describe('validation', () => {
    it('should validate ICMP header size', () => {
      const tooSmall = Buffer.alloc(7); // < 8 bytes

      expect(() => {
        ICMPPacket.fromBytes(tooSmall);
      }).toThrow('ICMP packet too small');
    });

    it('should accept minimum valid packet', () => {
      const minimal = Buffer.alloc(8);
      minimal[0] = ICMPType.ECHO_REQUEST;
      minimal[1] = 0;

      // Calculate checksum
      let sum = 0;
      for (let i = 0; i < minimal.length; i += 2) {
        if (i === 2) continue;
        sum += minimal.readUInt16BE(i);
      }
      while (sum >> 16) {
        sum = (sum & 0xFFFF) + (sum >> 16);
      }
      minimal.writeUInt16BE(~sum & 0xFFFF, 2);

      const packet = ICMPPacket.fromBytes(minimal);
      expect(packet.getType()).toBe(ICMPType.ECHO_REQUEST);
    });
  });
});
