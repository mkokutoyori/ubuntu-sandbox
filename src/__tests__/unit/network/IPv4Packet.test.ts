/**
 * Unit tests for IPv4Packet entity
 * Following TDD approach - tests written first
 */

import { describe, it, expect } from 'vitest';
import { IPv4Packet, IPProtocol } from '@/domain/network/entities/IPv4Packet';
import { IPAddress } from '@/domain/network/value-objects/IPAddress';

describe('IPv4Packet', () => {
  describe('constructor', () => {
    it('should create valid IPv4 packet', () => {
      const packet = new IPv4Packet({
        sourceIP: new IPAddress('192.168.1.1'),
        destinationIP: new IPAddress('192.168.1.2'),
        protocol: IPProtocol.TCP,
        ttl: 64,
        payload: Buffer.from([0x00, 0x01, 0x02, 0x03])
      });

      expect(packet.getSourceIP().toString()).toBe('192.168.1.1');
      expect(packet.getDestinationIP().toString()).toBe('192.168.1.2');
      expect(packet.getProtocol()).toBe(IPProtocol.TCP);
      expect(packet.getTTL()).toBe(64);
    });

    it('should use default TTL of 64 if not specified', () => {
      const packet = new IPv4Packet({
        sourceIP: new IPAddress('192.168.1.1'),
        destinationIP: new IPAddress('192.168.1.2'),
        protocol: IPProtocol.ICMP,
        payload: Buffer.from([0x00, 0x01])
      });

      expect(packet.getTTL()).toBe(64);
    });

    it('should throw error for invalid TTL', () => {
      expect(() => new IPv4Packet({
        sourceIP: new IPAddress('192.168.1.1'),
        destinationIP: new IPAddress('192.168.1.2'),
        protocol: IPProtocol.TCP,
        ttl: 256,
        payload: Buffer.from([0x00])
      })).toThrow('Invalid TTL');

      expect(() => new IPv4Packet({
        sourceIP: new IPAddress('192.168.1.1'),
        destinationIP: new IPAddress('192.168.1.2'),
        protocol: IPProtocol.TCP,
        ttl: -1,
        payload: Buffer.from([0x00])
      })).toThrow('Invalid TTL');
    });

    it('should throw error for payload too large', () => {
      const largePayload = Buffer.alloc(65516); // Max is 65515 (65535 - 20 header)
      expect(() => new IPv4Packet({
        sourceIP: new IPAddress('192.168.1.1'),
        destinationIP: new IPAddress('192.168.1.2'),
        protocol: IPProtocol.TCP,
        ttl: 64,
        payload: largePayload
      })).toThrow('Payload too large');
    });
  });

  describe('getVersion', () => {
    it('should return version 4', () => {
      const packet = new IPv4Packet({
        sourceIP: new IPAddress('10.0.0.1'),
        destinationIP: new IPAddress('10.0.0.2'),
        protocol: IPProtocol.UDP,
        payload: Buffer.from([0x00])
      });

      expect(packet.getVersion()).toBe(4);
    });
  });

  describe('getHeaderLength', () => {
    it('should return 20 for standard header without options', () => {
      const packet = new IPv4Packet({
        sourceIP: new IPAddress('10.0.0.1'),
        destinationIP: new IPAddress('10.0.0.2'),
        protocol: IPProtocol.TCP,
        payload: Buffer.from([0x00])
      });

      expect(packet.getHeaderLength()).toBe(20);
    });
  });

  describe('getTotalLength', () => {
    it('should return header length + payload length', () => {
      const payload = Buffer.from([0x01, 0x02, 0x03, 0x04, 0x05]);
      const packet = new IPv4Packet({
        sourceIP: new IPAddress('10.0.0.1'),
        destinationIP: new IPAddress('10.0.0.2'),
        protocol: IPProtocol.TCP,
        payload
      });

      expect(packet.getTotalLength()).toBe(25); // 20 header + 5 payload
    });
  });

  describe('decrementTTL', () => {
    it('should decrement TTL by 1', () => {
      const packet = new IPv4Packet({
        sourceIP: new IPAddress('192.168.1.1'),
        destinationIP: new IPAddress('192.168.1.2'),
        protocol: IPProtocol.TCP,
        ttl: 64,
        payload: Buffer.from([0x00])
      });

      const newPacket = packet.decrementTTL();

      expect(newPacket.getTTL()).toBe(63);
      expect(packet.getTTL()).toBe(64); // Original unchanged
    });

    it('should throw error if TTL reaches 0', () => {
      const packet = new IPv4Packet({
        sourceIP: new IPAddress('192.168.1.1'),
        destinationIP: new IPAddress('192.168.1.2'),
        protocol: IPProtocol.TCP,
        ttl: 1,
        payload: Buffer.from([0x00])
      });

      expect(() => packet.decrementTTL()).toThrow('TTL expired');
    });
  });

  describe('toBytes', () => {
    it('should serialize packet to bytes', () => {
      const payload = Buffer.from([0xAA, 0xBB, 0xCC, 0xDD]);
      const packet = new IPv4Packet({
        sourceIP: new IPAddress('192.168.1.1'),
        destinationIP: new IPAddress('192.168.1.2'),
        protocol: IPProtocol.TCP,
        ttl: 64,
        payload
      });

      const bytes = packet.toBytes();

      // Check version and IHL (first byte)
      const versionIHL = bytes[0];
      const version = (versionIHL >> 4) & 0x0F;
      const ihl = versionIHL & 0x0F;
      expect(version).toBe(4);
      expect(ihl).toBe(5); // 5 * 4 = 20 bytes

      // Check total length (bytes 2-3)
      const totalLength = bytes.readUInt16BE(2);
      expect(totalLength).toBe(24); // 20 header + 4 payload

      // Check TTL (byte 8)
      expect(bytes[8]).toBe(64);

      // Check protocol (byte 9)
      expect(bytes[9]).toBe(IPProtocol.TCP);

      // Check source IP (bytes 12-15)
      expect(bytes.slice(12, 16)).toEqual(Buffer.from([192, 168, 1, 1]));

      // Check destination IP (bytes 16-19)
      expect(bytes.slice(16, 20)).toEqual(Buffer.from([192, 168, 1, 2]));

      // Check payload (bytes 20+)
      expect(bytes.slice(20)).toEqual(payload);
    });
  });

  describe('static fromBytes', () => {
    it('should deserialize packet from bytes', () => {
      const packetData = Buffer.alloc(24); // 20 header + 4 payload

      // Version (4) and IHL (5)
      packetData[0] = 0x45;

      // Total length
      packetData.writeUInt16BE(24, 2);

      // TTL
      packetData[8] = 64;

      // Protocol (TCP)
      packetData[9] = IPProtocol.TCP;

      // Source IP: 192.168.1.1
      packetData[12] = 192;
      packetData[13] = 168;
      packetData[14] = 1;
      packetData[15] = 1;

      // Destination IP: 192.168.1.2
      packetData[16] = 192;
      packetData[17] = 168;
      packetData[18] = 1;
      packetData[19] = 2;

      // Payload
      packetData[20] = 0xAA;
      packetData[21] = 0xBB;
      packetData[22] = 0xCC;
      packetData[23] = 0xDD;

      const packet = IPv4Packet.fromBytes(packetData);

      expect(packet.getSourceIP().toString()).toBe('192.168.1.1');
      expect(packet.getDestinationIP().toString()).toBe('192.168.1.2');
      expect(packet.getProtocol()).toBe(IPProtocol.TCP);
      expect(packet.getTTL()).toBe(64);
      expect(packet.getVersion()).toBe(4);
    });

    it('should throw error for invalid version', () => {
      const invalidPacket = Buffer.alloc(20);
      invalidPacket[0] = 0x65; // Version 6, IHL 5

      expect(() => IPv4Packet.fromBytes(invalidPacket)).toThrow('Invalid IP version');
    });

    it('should throw error for packet too small', () => {
      const tooSmall = Buffer.alloc(15);
      expect(() => IPv4Packet.fromBytes(tooSmall)).toThrow('Packet too small');
    });
  });

  describe('IPProtocol constants', () => {
    it('should have correct protocol values', () => {
      expect(IPProtocol.ICMP).toBe(1);
      expect(IPProtocol.TCP).toBe(6);
      expect(IPProtocol.UDP).toBe(17);
    });
  });
});
