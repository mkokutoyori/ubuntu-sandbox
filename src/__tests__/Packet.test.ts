/**
 * Packet Unit Tests
 */

import { describe, it, expect } from 'vitest';
import {
  ARPOpcode,
  ICMPType,
  ETHER_TYPE,
  IP_PROTOCOL,
  BROADCAST_MAC,
  createARPRequest,
  createARPReply,
  createICMPEchoRequest,
  createICMPEchoReply,
  generatePacketId
} from '../core/network/packet';

describe('Packet Constants', () => {
  it('should have correct ETHER_TYPE values', () => {
    expect(ETHER_TYPE.IPv4).toBe(0x0800);
    expect(ETHER_TYPE.ARP).toBe(0x0806);
    expect(ETHER_TYPE.IPv6).toBe(0x86DD);
    expect(ETHER_TYPE.VLAN).toBe(0x8100);
  });

  it('should have correct IP_PROTOCOL values', () => {
    expect(IP_PROTOCOL.ICMP).toBe(1);
    expect(IP_PROTOCOL.TCP).toBe(6);
    expect(IP_PROTOCOL.UDP).toBe(17);
  });

  it('should have correct BROADCAST_MAC', () => {
    expect(BROADCAST_MAC).toBe('FF:FF:FF:FF:FF:FF');
  });
});

describe('ARPOpcode', () => {
  it('should have correct values', () => {
    expect(ARPOpcode.REQUEST).toBe(1);
    expect(ARPOpcode.REPLY).toBe(2);
  });
});

describe('ICMPType', () => {
  it('should have correct values', () => {
    expect(ICMPType.ECHO_REPLY).toBe(0);
    expect(ICMPType.DESTINATION_UNREACHABLE).toBe(3);
    expect(ICMPType.REDIRECT).toBe(5);
    expect(ICMPType.ECHO_REQUEST).toBe(8);
    expect(ICMPType.TIME_EXCEEDED).toBe(11);
  });
});

describe('ARP Packet Creation', () => {
  describe('createARPRequest', () => {
    it('should create valid ARP request', () => {
      const packet = createARPRequest(
        '00:11:22:33:44:55',
        '192.168.1.100',
        '192.168.1.1'
      );

      expect(packet.hardwareType).toBe(1);
      expect(packet.protocolType).toBe(0x0800);
      expect(packet.hardwareSize).toBe(6);
      expect(packet.protocolSize).toBe(4);
      expect(packet.opcode).toBe(ARPOpcode.REQUEST);
      expect(packet.senderMAC).toBe('00:11:22:33:44:55');
      expect(packet.senderIP).toBe('192.168.1.100');
      expect(packet.targetMAC).toBe('00:00:00:00:00:00');
      expect(packet.targetIP).toBe('192.168.1.1');
    });
  });

  describe('createARPReply', () => {
    it('should create valid ARP reply', () => {
      const packet = createARPReply(
        'AA:BB:CC:DD:EE:FF',
        '192.168.1.1',
        '00:11:22:33:44:55',
        '192.168.1.100'
      );

      expect(packet.opcode).toBe(ARPOpcode.REPLY);
      expect(packet.senderMAC).toBe('AA:BB:CC:DD:EE:FF');
      expect(packet.senderIP).toBe('192.168.1.1');
      expect(packet.targetMAC).toBe('00:11:22:33:44:55');
      expect(packet.targetIP).toBe('192.168.1.100');
    });
  });
});

describe('ICMP Packet Creation', () => {
  describe('createICMPEchoRequest', () => {
    it('should create valid ICMP echo request', () => {
      const packet = createICMPEchoRequest(12345, 1);

      expect(packet.type).toBe(ICMPType.ECHO_REQUEST);
      expect(packet.code).toBe(0);
      expect(packet.identifier).toBe(12345);
      expect(packet.sequenceNumber).toBe(1);
      expect(packet.data).toBeInstanceOf(Uint8Array);
      expect(packet.data.length).toBe(32);
    });

    it('should use custom data if provided', () => {
      const customData = new Uint8Array([1, 2, 3, 4]);
      const packet = createICMPEchoRequest(12345, 1, customData);

      expect(packet.data).toBe(customData);
    });
  });

  describe('createICMPEchoReply', () => {
    it('should create valid ICMP echo reply', () => {
      const request = createICMPEchoRequest(12345, 1);
      const reply = createICMPEchoReply(request);

      expect(reply.type).toBe(ICMPType.ECHO_REPLY);
      expect(reply.code).toBe(0);
      expect(reply.identifier).toBe(request.identifier);
      expect(reply.sequenceNumber).toBe(request.sequenceNumber);
      expect(reply.data).toEqual(request.data);
    });
  });
});

describe('Packet ID Generation', () => {
  it('should generate unique packet IDs', () => {
    const id1 = generatePacketId();
    const id2 = generatePacketId();

    expect(id1).not.toBe(id2);
  });

  it('should start with "pkt-" prefix', () => {
    const id = generatePacketId();
    expect(id).toMatch(/^pkt-/);
  });

  it('should contain timestamp', () => {
    const before = Date.now();
    const id = generatePacketId();
    const after = Date.now();

    const parts = id.split('-');
    const timestamp = parseInt(parts[1]);

    expect(timestamp).toBeGreaterThanOrEqual(before);
    expect(timestamp).toBeLessThanOrEqual(after);
  });
});
