/**
 * Unit tests for ARPService
 * Following TDD approach - tests written first
 *
 * ARP (Address Resolution Protocol) - RFC 826
 * Maps IP addresses to MAC addresses at Layer 2
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ARPService } from '@/domain/network/services/ARPService';
import { IPAddress } from '@/domain/network/value-objects/IPAddress';
import { MACAddress } from '@/domain/network/value-objects/MACAddress';

describe('ARPService', () => {
  let arpService: ARPService;

  beforeEach(() => {
    arpService = new ARPService();
  });

  describe('cache management', () => {
    it('should add entry to cache', () => {
      const ip = new IPAddress('192.168.1.1');
      const mac = new MACAddress('AA:BB:CC:DD:EE:FF');

      arpService.addEntry(ip, mac);

      expect(arpService.hasEntry(ip)).toBe(true);
    });

    it('should retrieve MAC address from cache', () => {
      const ip = new IPAddress('192.168.1.1');
      const mac = new MACAddress('AA:BB:CC:DD:EE:FF');

      arpService.addEntry(ip, mac);

      const cachedMAC = arpService.resolve(ip);
      expect(cachedMAC?.toString()).toBe('AA:BB:CC:DD:EE:FF');
    });

    it('should return undefined for non-existent entry', () => {
      const ip = new IPAddress('192.168.1.1');

      const cachedMAC = arpService.resolve(ip);
      expect(cachedMAC).toBeUndefined();
    });

    it('should update existing entry', () => {
      const ip = new IPAddress('192.168.1.1');
      const mac1 = new MACAddress('AA:BB:CC:DD:EE:FF');
      const mac2 = new MACAddress('11:22:33:44:55:66');

      arpService.addEntry(ip, mac1);
      arpService.addEntry(ip, mac2);

      const cachedMAC = arpService.resolve(ip);
      expect(cachedMAC?.toString()).toBe('11:22:33:44:55:66');
    });

    it('should remove entry from cache', () => {
      const ip = new IPAddress('192.168.1.1');
      const mac = new MACAddress('AA:BB:CC:DD:EE:FF');

      arpService.addEntry(ip, mac);
      arpService.removeEntry(ip);

      expect(arpService.hasEntry(ip)).toBe(false);
    });

    it('should clear all entries', () => {
      const ip1 = new IPAddress('192.168.1.1');
      const ip2 = new IPAddress('192.168.1.2');
      const mac = new MACAddress('AA:BB:CC:DD:EE:FF');

      arpService.addEntry(ip1, mac);
      arpService.addEntry(ip2, mac);

      arpService.clear();

      expect(arpService.hasEntry(ip1)).toBe(false);
      expect(arpService.hasEntry(ip2)).toBe(false);
    });
  });

  describe('TTL and expiration', () => {
    it('should create entry with default TTL', () => {
      const ip = new IPAddress('192.168.1.1');
      const mac = new MACAddress('AA:BB:CC:DD:EE:FF');

      arpService.addEntry(ip, mac);

      const entry = arpService.getEntry(ip);
      expect(entry).toBeDefined();
      expect(entry?.ttl).toBeGreaterThan(0);
    });

    it('should create entry with custom TTL', () => {
      const ip = new IPAddress('192.168.1.1');
      const mac = new MACAddress('AA:BB:CC:DD:EE:FF');
      const customTTL = 120; // 2 minutes

      arpService.addEntry(ip, mac, customTTL);

      const entry = arpService.getEntry(ip);
      expect(entry?.ttl).toBe(customTTL);
    });

    it('should expire old entries', () => {
      const ip = new IPAddress('192.168.1.1');
      const mac = new MACAddress('AA:BB:CC:DD:EE:FF');

      // Add entry with very short TTL (1 second)
      arpService.addEntry(ip, mac, 1);

      // Wait for expiration
      vi.useFakeTimers();
      vi.advanceTimersByTime(2000); // 2 seconds

      arpService.cleanExpired();

      expect(arpService.hasEntry(ip)).toBe(false);

      vi.useRealTimers();
    });

    it('should not expire fresh entries', () => {
      const ip = new IPAddress('192.168.1.1');
      const mac = new MACAddress('AA:BB:CC:DD:EE:FF');

      arpService.addEntry(ip, mac, 300); // 5 minutes

      vi.useFakeTimers();
      vi.advanceTimersByTime(1000); // 1 second

      arpService.cleanExpired();

      expect(arpService.hasEntry(ip)).toBe(true);

      vi.useRealTimers();
    });

    it('should automatically clean expired entries on resolve', () => {
      const ip1 = new IPAddress('192.168.1.1');
      const ip2 = new IPAddress('192.168.1.2');
      const mac = new MACAddress('AA:BB:CC:DD:EE:FF');

      arpService.addEntry(ip1, mac, 1); // Expires in 1 second
      arpService.addEntry(ip2, mac, 300); // Expires in 5 minutes

      vi.useFakeTimers();
      vi.advanceTimersByTime(2000); // 2 seconds

      // Resolve should trigger cleanup
      arpService.resolve(ip2);

      expect(arpService.hasEntry(ip1)).toBe(false);
      expect(arpService.hasEntry(ip2)).toBe(true);

      vi.useRealTimers();
    });
  });

  describe('ARP request creation', () => {
    it('should create ARP request packet', () => {
      const senderIP = new IPAddress('192.168.1.1');
      const senderMAC = new MACAddress('AA:BB:CC:DD:EE:FF');
      const targetIP = new IPAddress('192.168.1.2');

      const arpRequest = arpService.createRequest(senderIP, senderMAC, targetIP);

      expect(arpRequest).toBeDefined();
      expect(arpRequest.operation).toBe('request');
      expect(arpRequest.senderIP.toString()).toBe('192.168.1.1');
      expect(arpRequest.senderMAC.toString()).toBe('AA:BB:CC:DD:EE:FF');
      expect(arpRequest.targetIP.toString()).toBe('192.168.1.2');
      expect(arpRequest.targetMAC.toString()).toBe('00:00:00:00:00:00');
    });
  });

  describe('ARP reply creation', () => {
    it('should create ARP reply packet', () => {
      const senderIP = new IPAddress('192.168.1.2');
      const senderMAC = new MACAddress('11:22:33:44:55:66');
      const targetIP = new IPAddress('192.168.1.1');
      const targetMAC = new MACAddress('AA:BB:CC:DD:EE:FF');

      const arpReply = arpService.createReply(senderIP, senderMAC, targetIP, targetMAC);

      expect(arpReply).toBeDefined();
      expect(arpReply.operation).toBe('reply');
      expect(arpReply.senderIP.toString()).toBe('192.168.1.2');
      expect(arpReply.senderMAC.toString()).toBe('11:22:33:44:55:66');
      expect(arpReply.targetIP.toString()).toBe('192.168.1.1');
      expect(arpReply.targetMAC.toString()).toBe('AA:BB:CC:DD:EE:FF');
    });
  });

  describe('ARP packet processing', () => {
    it('should process ARP request and add to cache', () => {
      const request = {
        operation: 'request' as const,
        senderIP: new IPAddress('192.168.1.1'),
        senderMAC: new MACAddress('AA:BB:CC:DD:EE:FF'),
        targetIP: new IPAddress('192.168.1.2'),
        targetMAC: MACAddress.ZERO
      };

      arpService.processPacket(request);

      // Sender should be in cache
      expect(arpService.hasEntry(request.senderIP)).toBe(true);
      expect(arpService.resolve(request.senderIP)?.toString()).toBe('AA:BB:CC:DD:EE:FF');
    });

    it('should process ARP reply and add to cache', () => {
      const reply = {
        operation: 'reply' as const,
        senderIP: new IPAddress('192.168.1.2'),
        senderMAC: new MACAddress('11:22:33:44:55:66'),
        targetIP: new IPAddress('192.168.1.1'),
        targetMAC: new MACAddress('AA:BB:CC:DD:EE:FF')
      };

      arpService.processPacket(reply);

      // Sender should be in cache
      expect(arpService.hasEntry(reply.senderIP)).toBe(true);
      expect(arpService.resolve(reply.senderIP)?.toString()).toBe('11:22:33:44:55:66');
    });
  });

  describe('gratuitous ARP', () => {
    it('should create gratuitous ARP announcement', () => {
      const ip = new IPAddress('192.168.1.1');
      const mac = new MACAddress('AA:BB:CC:DD:EE:FF');

      const gratuitousARP = arpService.createGratuitousARP(ip, mac);

      expect(gratuitousARP.operation).toBe('request');
      expect(gratuitousARP.senderIP.equals(ip)).toBe(true);
      expect(gratuitousARP.targetIP.equals(ip)).toBe(true);
      expect(gratuitousARP.senderMAC.equals(mac)).toBe(true);
    });

    it('should detect gratuitous ARP', () => {
      const ip = new IPAddress('192.168.1.1');
      const mac = new MACAddress('AA:BB:CC:DD:EE:FF');

      const gratuitousARP = arpService.createGratuitousARP(ip, mac);

      expect(arpService.isGratuitousARP(gratuitousARP)).toBe(true);
    });

    it('should not detect regular ARP as gratuitous', () => {
      const request = {
        operation: 'request' as const,
        senderIP: new IPAddress('192.168.1.1'),
        senderMAC: new MACAddress('AA:BB:CC:DD:EE:FF'),
        targetIP: new IPAddress('192.168.1.2'),
        targetMAC: MACAddress.ZERO
      };

      expect(arpService.isGratuitousARP(request)).toBe(false);
    });
  });

  describe('statistics', () => {
    it('should track cache size', () => {
      const ip1 = new IPAddress('192.168.1.1');
      const ip2 = new IPAddress('192.168.1.2');
      const mac = new MACAddress('AA:BB:CC:DD:EE:FF');

      arpService.addEntry(ip1, mac);
      arpService.addEntry(ip2, mac);

      const stats = arpService.getStatistics();
      expect(stats.cacheSize).toBe(2);
    });

    it('should track request count', () => {
      const senderIP = new IPAddress('192.168.1.1');
      const senderMAC = new MACAddress('AA:BB:CC:DD:EE:FF');
      const targetIP = new IPAddress('192.168.1.2');

      arpService.createRequest(senderIP, senderMAC, targetIP);
      arpService.createRequest(senderIP, senderMAC, targetIP);

      const stats = arpService.getStatistics();
      expect(stats.requestsSent).toBe(2);
    });

    it('should track reply count', () => {
      const senderIP = new IPAddress('192.168.1.2');
      const senderMAC = new MACAddress('11:22:33:44:55:66');
      const targetIP = new IPAddress('192.168.1.1');
      const targetMAC = new MACAddress('AA:BB:CC:DD:EE:FF');

      arpService.createReply(senderIP, senderMAC, targetIP, targetMAC);

      const stats = arpService.getStatistics();
      expect(stats.repliesSent).toBe(1);
    });

    it('should reset statistics', () => {
      const ip = new IPAddress('192.168.1.1');
      const mac = new MACAddress('AA:BB:CC:DD:EE:FF');

      arpService.addEntry(ip, mac);
      arpService.createRequest(ip, mac, new IPAddress('192.168.1.2'));

      arpService.resetStatistics();

      const stats = arpService.getStatistics();
      expect(stats.requestsSent).toBe(0);
      expect(stats.repliesSent).toBe(0);
      // Cache should not be cleared
      expect(stats.cacheSize).toBe(1);
    });
  });

  describe('serialization', () => {
    it('should serialize ARP packet to bytes', () => {
      const request = {
        operation: 'request' as const,
        senderIP: new IPAddress('192.168.1.1'),
        senderMAC: new MACAddress('AA:BB:CC:DD:EE:FF'),
        targetIP: new IPAddress('192.168.1.2'),
        targetMAC: MACAddress.ZERO
      };

      const bytes = arpService.serializePacket(request);

      expect(bytes).toBeInstanceOf(Uint8Array);
      expect(bytes.length).toBe(28); // ARP packet size

      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

      // Check hardware type (Ethernet = 1)
      expect(view.getUint16(0)).toBe(1);

      // Check protocol type (IPv4 = 0x0800)
      expect(view.getUint16(2)).toBe(0x0800);

      // Check operation (request = 1)
      expect(view.getUint16(6)).toBe(1);
    });

    it('should deserialize ARP packet from bytes', () => {
      const request = {
        operation: 'request' as const,
        senderIP: new IPAddress('192.168.1.1'),
        senderMAC: new MACAddress('AA:BB:CC:DD:EE:FF'),
        targetIP: new IPAddress('192.168.1.2'),
        targetMAC: MACAddress.ZERO
      };

      const bytes = arpService.serializePacket(request);
      const deserialized = arpService.deserializePacket(bytes);

      expect(deserialized.operation).toBe('request');
      expect(deserialized.senderIP.toString()).toBe('192.168.1.1');
      expect(deserialized.senderMAC.toString()).toBe('AA:BB:CC:DD:EE:FF');
      expect(deserialized.targetIP.toString()).toBe('192.168.1.2');
    });
  });
});
