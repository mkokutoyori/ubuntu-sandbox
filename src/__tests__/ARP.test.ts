/**
 * ARP Service Unit Tests
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ARPService } from '../core/network/arp';
import {
  ARPPacket,
  ARPOpcode,
  Packet,
  createARPRequest,
  createARPReply
} from '../core/network/packet';

describe('ARPService', () => {
  let arpService: ARPService;

  beforeEach(() => {
    arpService = new ARPService({
      timeout: 300,
      maxRetries: 3,
      retryInterval: 1000,
      proxyARP: false
    });
  });

  describe('Static Entries', () => {
    it('should add static ARP entry', () => {
      arpService.addStaticEntry('192.168.1.1', '00:11:22:33:44:55', 'eth0');

      const entry = arpService.getEntry('192.168.1.1');
      expect(entry).toBeDefined();
      expect(entry?.macAddress).toBe('00:11:22:33:44:55');
      expect(entry?.type).toBe('static');
      expect(entry?.state).toBe('reachable');
    });

    it('should normalize MAC address to uppercase', () => {
      arpService.addStaticEntry('192.168.1.1', 'aa:bb:cc:dd:ee:ff', 'eth0');

      const entry = arpService.getEntry('192.168.1.1');
      expect(entry?.macAddress).toBe('AA:BB:CC:DD:EE:FF');
    });
  });

  describe('Dynamic Entries', () => {
    it('should add dynamic ARP entry', () => {
      arpService.addDynamicEntry('192.168.1.1', '00:11:22:33:44:55', 'eth0');

      const entry = arpService.getEntry('192.168.1.1');
      expect(entry).toBeDefined();
      expect(entry?.type).toBe('dynamic');
    });

    it('should not overwrite static entry with dynamic', () => {
      arpService.addStaticEntry('192.168.1.1', '00:11:22:33:44:55', 'eth0');
      arpService.addDynamicEntry('192.168.1.1', 'AA:BB:CC:DD:EE:FF', 'eth0');

      const entry = arpService.getEntry('192.168.1.1');
      expect(entry?.macAddress).toBe('00:11:22:33:44:55');
      expect(entry?.type).toBe('static');
    });

    it('should update dynamic entry', () => {
      arpService.addDynamicEntry('192.168.1.1', '00:11:22:33:44:55', 'eth0');
      arpService.addDynamicEntry('192.168.1.1', 'AA:BB:CC:DD:EE:FF', 'eth0');

      const entry = arpService.getEntry('192.168.1.1');
      expect(entry?.macAddress).toBe('AA:BB:CC:DD:EE:FF');
    });
  });

  describe('Lookup', () => {
    it('should return MAC for known IP', () => {
      arpService.addStaticEntry('192.168.1.1', '00:11:22:33:44:55', 'eth0');

      const mac = arpService.lookup('192.168.1.1');
      expect(mac).toBe('00:11:22:33:44:55');
    });

    it('should return undefined for unknown IP', () => {
      const mac = arpService.lookup('192.168.1.1');
      expect(mac).toBeUndefined();
    });

    it('should update lastUsed on lookup', async () => {
      arpService.addStaticEntry('192.168.1.1', '00:11:22:33:44:55', 'eth0');

      const entryBefore = arpService.getEntry('192.168.1.1');
      const lastUsedBefore = entryBefore?.lastUsed;

      // Small delay to ensure timestamp difference
      await new Promise(resolve => setTimeout(resolve, 10));

      arpService.lookup('192.168.1.1');
      const entryAfter = arpService.getEntry('192.168.1.1');

      expect(entryAfter?.lastUsed).toBeGreaterThanOrEqual(lastUsedBefore!);
    });
  });

  describe('Entry Removal', () => {
    it('should remove entry', () => {
      arpService.addStaticEntry('192.168.1.1', '00:11:22:33:44:55', 'eth0');

      const removed = arpService.removeEntry('192.168.1.1');
      expect(removed).toBe(true);
      expect(arpService.getEntry('192.168.1.1')).toBeUndefined();
    });

    it('should return false when removing non-existent entry', () => {
      const removed = arpService.removeEntry('192.168.1.1');
      expect(removed).toBe(false);
    });

    it('should clear only dynamic entries', () => {
      arpService.addStaticEntry('192.168.1.1', '00:11:22:33:44:55', 'eth0');
      arpService.addDynamicEntry('192.168.1.2', 'AA:BB:CC:DD:EE:FF', 'eth0');

      arpService.clearDynamic();

      expect(arpService.getEntry('192.168.1.1')).toBeDefined();
      expect(arpService.getEntry('192.168.1.2')).toBeUndefined();
    });

    it('should clear all entries', () => {
      arpService.addStaticEntry('192.168.1.1', '00:11:22:33:44:55', 'eth0');
      arpService.addDynamicEntry('192.168.1.2', 'AA:BB:CC:DD:EE:FF', 'eth0');

      arpService.clearAll();

      expect(arpService.getTable()).toHaveLength(0);
    });
  });

  describe('ARP Packet Processing', () => {
    it('should learn sender MAC from ARP request', () => {
      const arpRequest: ARPPacket = createARPRequest(
        '00:11:22:33:44:55',
        '192.168.1.1',
        '192.168.1.100'
      );

      arpService.processPacket(arpRequest, 'eth0', '192.168.1.100', 'AA:BB:CC:DD:EE:FF');

      const entry = arpService.getEntry('192.168.1.1');
      expect(entry).toBeDefined();
      expect(entry?.macAddress).toBe('00:11:22:33:44:55');
    });

    it('should generate ARP reply when request is for local IP', () => {
      const arpRequest: ARPPacket = createARPRequest(
        '00:11:22:33:44:55',
        '192.168.1.1',
        '192.168.1.100'
      );

      const reply = arpService.processPacket(
        arpRequest,
        'eth0',
        '192.168.1.100',
        'AA:BB:CC:DD:EE:FF'
      );

      expect(reply).not.toBeNull();
      expect(reply?.frame.destinationMAC).toBe('00:11:22:33:44:55');
      expect(reply?.frame.sourceMAC).toBe('AA:BB:CC:DD:EE:FF');
    });

    it('should not generate reply when request is not for local IP', () => {
      const arpRequest: ARPPacket = createARPRequest(
        '00:11:22:33:44:55',
        '192.168.1.1',
        '192.168.1.200'  // Different target IP
      );

      const reply = arpService.processPacket(
        arpRequest,
        'eth0',
        '192.168.1.100',  // Our IP
        'AA:BB:CC:DD:EE:FF'
      );

      expect(reply).toBeNull();
    });

    it('should learn from ARP reply', () => {
      const arpReply: ARPPacket = createARPReply(
        '00:11:22:33:44:55',
        '192.168.1.1',
        'AA:BB:CC:DD:EE:FF',
        '192.168.1.100'
      );

      arpService.processPacket(arpReply, 'eth0', '192.168.1.100', 'AA:BB:CC:DD:EE:FF');

      const entry = arpService.getEntry('192.168.1.1');
      expect(entry).toBeDefined();
      expect(entry?.macAddress).toBe('00:11:22:33:44:55');
    });
  });

  describe('Table Formatting', () => {
    it('should format empty table', () => {
      const output = arpService.formatTable();
      expect(output).toBe('ARP cache is empty');
    });

    it('should format table with entries', () => {
      arpService.addStaticEntry('192.168.1.1', '00:11:22:33:44:55', 'eth0');
      arpService.addDynamicEntry('192.168.1.2', 'AA:BB:CC:DD:EE:FF', 'eth0');

      const output = arpService.formatTable();
      expect(output).toContain('192.168.1.1');
      expect(output).toContain('00:11:22:33:44:55');
      expect(output).toContain('192.168.1.2');
    });
  });
});

describe('ARP Packet Creation', () => {
  it('should create valid ARP request', () => {
    const request = createARPRequest(
      '00:11:22:33:44:55',
      '192.168.1.1',
      '192.168.1.100'
    );

    expect(request.opcode).toBe(ARPOpcode.REQUEST);
    expect(request.senderMAC).toBe('00:11:22:33:44:55');
    expect(request.senderIP).toBe('192.168.1.1');
    expect(request.targetMAC).toBe('00:00:00:00:00:00');
    expect(request.targetIP).toBe('192.168.1.100');
    expect(request.hardwareType).toBe(1);
    expect(request.protocolType).toBe(0x0800);
  });

  it('should create valid ARP reply', () => {
    const reply = createARPReply(
      '00:11:22:33:44:55',
      '192.168.1.100',
      'AA:BB:CC:DD:EE:FF',
      '192.168.1.1'
    );

    expect(reply.opcode).toBe(ARPOpcode.REPLY);
    expect(reply.senderMAC).toBe('00:11:22:33:44:55');
    expect(reply.senderIP).toBe('192.168.1.100');
    expect(reply.targetMAC).toBe('AA:BB:CC:DD:EE:FF');
    expect(reply.targetIP).toBe('192.168.1.1');
  });
});
