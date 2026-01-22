/**
 * Unit tests for MACTableService
 * Following TDD approach - tests written first
 *
 * MAC Address Table (CAM Table)
 * Used by switches for Layer 2 forwarding decisions
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { MACTableService } from '@/domain/network/services/MACTableService';
import { MACAddress } from '@/domain/network/value-objects/MACAddress';

describe('MACTableService', () => {
  let macTable: MACTableService;

  beforeEach(() => {
    macTable = new MACTableService();
  });

  describe('learning', () => {
    it('should learn MAC address on port', () => {
      const mac = new MACAddress('AA:BB:CC:DD:EE:FF');
      const port = 'eth0';

      macTable.learn(mac, port);

      expect(macTable.hasEntry(mac)).toBe(true);
    });

    it('should return port for learned MAC', () => {
      const mac = new MACAddress('AA:BB:CC:DD:EE:FF');
      const port = 'eth0';

      macTable.learn(mac, port);

      const learnedPort = macTable.lookup(mac);
      expect(learnedPort).toBe('eth0');
    });

    it('should return undefined for unknown MAC', () => {
      const mac = new MACAddress('AA:BB:CC:DD:EE:FF');

      const port = macTable.lookup(mac);
      expect(port).toBeUndefined();
    });

    it('should update port if MAC moves', () => {
      const mac = new MACAddress('AA:BB:CC:DD:EE:FF');

      macTable.learn(mac, 'eth0');
      macTable.learn(mac, 'eth1');

      const port = macTable.lookup(mac);
      expect(port).toBe('eth1');
    });

    it('should not learn broadcast MAC', () => {
      const broadcastMAC = MACAddress.BROADCAST;

      macTable.learn(broadcastMAC, 'eth0');

      expect(macTable.hasEntry(broadcastMAC)).toBe(false);
    });

    it('should not learn multicast MAC', () => {
      const multicastMAC = new MACAddress('01:00:5E:00:00:01');

      macTable.learn(multicastMAC, 'eth0');

      expect(macTable.hasEntry(multicastMAC)).toBe(false);
    });
  });

  describe('removal', () => {
    it('should remove MAC entry', () => {
      const mac = new MACAddress('AA:BB:CC:DD:EE:FF');

      macTable.learn(mac, 'eth0');
      macTable.remove(mac);

      expect(macTable.hasEntry(mac)).toBe(false);
    });

    it('should clear all entries', () => {
      const mac1 = new MACAddress('AA:BB:CC:DD:EE:FF');
      const mac2 = new MACAddress('11:22:33:44:55:66');

      macTable.learn(mac1, 'eth0');
      macTable.learn(mac2, 'eth1');

      macTable.clear();

      expect(macTable.hasEntry(mac1)).toBe(false);
      expect(macTable.hasEntry(mac2)).toBe(false);
    });

    it('should remove all entries on specific port', () => {
      const mac1 = new MACAddress('AA:BB:CC:DD:EE:FF');
      const mac2 = new MACAddress('11:22:33:44:55:66');
      const mac3 = new MACAddress('22:33:44:55:66:77');

      macTable.learn(mac1, 'eth0');
      macTable.learn(mac2, 'eth0');
      macTable.learn(mac3, 'eth1');

      macTable.removePort('eth0');

      expect(macTable.hasEntry(mac1)).toBe(false);
      expect(macTable.hasEntry(mac2)).toBe(false);
      expect(macTable.hasEntry(mac3)).toBe(true);
    });
  });

  describe('aging', () => {
    it('should create entry with default aging time', () => {
      const mac = new MACAddress('AA:BB:CC:DD:EE:FF');

      macTable.learn(mac, 'eth0');

      const entry = macTable.getEntry(mac);
      expect(entry).toBeDefined();
      expect(entry?.agingTime).toBeGreaterThan(0);
    });

    it('should create entry with custom aging time', () => {
      const mac = new MACAddress('AA:BB:CC:DD:EE:FF');
      const customAging = 600; // 10 minutes

      macTable.learn(mac, 'eth0', customAging);

      const entry = macTable.getEntry(mac);
      expect(entry?.agingTime).toBe(customAging);
    });

    it('should expire old entries', () => {
      const mac = new MACAddress('AA:BB:CC:DD:EE:FF');

      // Learn with very short aging time (1 second)
      macTable.learn(mac, 'eth0', 1);

      // Wait for expiration
      vi.useFakeTimers();
      vi.advanceTimersByTime(2000); // 2 seconds

      macTable.cleanExpired();

      expect(macTable.hasEntry(mac)).toBe(false);

      vi.useRealTimers();
    });

    it('should not expire fresh entries', () => {
      const mac = new MACAddress('AA:BB:CC:DD:EE:FF');

      macTable.learn(mac, 'eth0', 300);

      vi.useFakeTimers();
      vi.advanceTimersByTime(1000); // 1 second

      macTable.cleanExpired();

      expect(macTable.hasEntry(mac)).toBe(true);

      vi.useRealTimers();
    });

    it('should refresh aging timer on re-learn', () => {
      const mac = new MACAddress('AA:BB:CC:DD:EE:FF');

      macTable.learn(mac, 'eth0', 5);

      vi.useFakeTimers();
      vi.advanceTimersByTime(3000); // 3 seconds

      // Re-learn (refreshes timer)
      macTable.learn(mac, 'eth0', 5);

      vi.advanceTimersByTime(3000); // Another 3 seconds (total 6, but timer refreshed)

      macTable.cleanExpired();

      // Should still exist because timer was refreshed
      expect(macTable.hasEntry(mac)).toBe(true);

      vi.useRealTimers();
    });
  });

  describe('port queries', () => {
    it('should return all MACs on port', () => {
      const mac1 = new MACAddress('AA:BB:CC:DD:EE:FF');
      const mac2 = new MACAddress('00:11:22:33:44:55'); // Unicast (LSB=0)
      const mac3 = new MACAddress('22:33:44:55:66:77');

      macTable.learn(mac1, 'eth0');
      macTable.learn(mac2, 'eth0');
      macTable.learn(mac3, 'eth1');

      const macsOnEth0 = macTable.getPortMACs('eth0');

      expect(macsOnEth0).toHaveLength(2);
      expect(macsOnEth0.map(m => m.toString())).toContain('AA:BB:CC:DD:EE:FF');
      expect(macsOnEth0.map(m => m.toString())).toContain('00:11:22:33:44:55');
    });

    it('should return empty array for port with no MACs', () => {
      const macs = macTable.getPortMACs('eth0');
      expect(macs).toEqual([]);
    });

    it('should return all ports', () => {
      const mac1 = new MACAddress('AA:BB:CC:DD:EE:FF');
      const mac2 = new MACAddress('00:11:22:33:44:55'); // Unicast (LSB=0)

      macTable.learn(mac1, 'eth0');
      macTable.learn(mac2, 'eth1');

      const ports = macTable.getAllPorts();

      expect(ports).toHaveLength(2);
      expect(ports).toContain('eth0');
      expect(ports).toContain('eth1');
    });
  });

  describe('statistics', () => {
    it('should track table size', () => {
      const mac1 = new MACAddress('AA:BB:CC:DD:EE:FF');
      const mac2 = new MACAddress('00:11:22:33:44:55'); // Unicast (LSB=0)

      macTable.learn(mac1, 'eth0');
      macTable.learn(mac2, 'eth1');

      const stats = macTable.getStatistics();
      expect(stats.tableSize).toBe(2);
    });

    it('should track learning count', () => {
      const mac = new MACAddress('AA:BB:CC:DD:EE:FF');

      macTable.learn(mac, 'eth0');
      macTable.learn(mac, 'eth1'); // Re-learn (move)

      const stats = macTable.getStatistics();
      expect(stats.learningCount).toBe(2);
    });

    it('should track moves', () => {
      const mac = new MACAddress('AA:BB:CC:DD:EE:FF');

      macTable.learn(mac, 'eth0');
      macTable.learn(mac, 'eth1'); // Move

      const stats = macTable.getStatistics();
      expect(stats.moves).toBe(1);
    });

    it('should track lookups', () => {
      const mac = new MACAddress('AA:BB:CC:DD:EE:FF');

      macTable.learn(mac, 'eth0');
      macTable.lookup(mac);
      macTable.lookup(mac);

      const stats = macTable.getStatistics();
      expect(stats.lookups).toBe(2);
    });

    it('should track hits and misses', () => {
      const mac1 = new MACAddress('AA:BB:CC:DD:EE:FF');
      const mac2 = new MACAddress('11:22:33:44:55:66');

      macTable.learn(mac1, 'eth0');

      macTable.lookup(mac1); // Hit
      macTable.lookup(mac2); // Miss

      const stats = macTable.getStatistics();
      expect(stats.hits).toBe(1);
      expect(stats.misses).toBe(1);
    });

    it('should reset statistics', () => {
      const mac = new MACAddress('AA:BB:CC:DD:EE:FF');

      macTable.learn(mac, 'eth0');
      macTable.lookup(mac);

      macTable.resetStatistics();

      const stats = macTable.getStatistics();
      expect(stats.learningCount).toBe(0);
      expect(stats.lookups).toBe(0);
      expect(stats.hits).toBe(0);
      expect(stats.misses).toBe(0);
      // Table size should remain
      expect(stats.tableSize).toBe(1);
    });
  });

  describe('capacity management', () => {
    it('should respect maximum table size', () => {
      const maxSize = 10;
      const limitedTable = new MACTableService({ maxSize });

      // Learn maxSize entries
      for (let i = 0; i < maxSize; i++) {
        const mac = new MACAddress(`00:00:00:00:00:${i.toString(16).padStart(2, '0')}`);
        limitedTable.learn(mac, 'eth0');
      }

      // Try to learn one more
      const extraMAC = new MACAddress('FF:FF:FF:FF:FF:FF');
      const result = limitedTable.learn(extraMAC, 'eth0');

      // Should fail or remove oldest
      const stats = limitedTable.getStatistics();
      expect(stats.tableSize).toBeLessThanOrEqual(maxSize);
    });

    it('should remove oldest entry when table is full', () => {
      const maxSize = 3;
      const limitedTable = new MACTableService({ maxSize });

      const mac1 = new MACAddress('00:00:00:00:00:01');
      const mac2 = new MACAddress('00:00:00:00:00:02');
      const mac3 = new MACAddress('00:00:00:00:00:03');
      const mac4 = new MACAddress('00:00:00:00:00:04');

      limitedTable.learn(mac1, 'eth0');
      limitedTable.learn(mac2, 'eth0');
      limitedTable.learn(mac3, 'eth0');

      // This should evict the oldest (mac1)
      limitedTable.learn(mac4, 'eth0');

      expect(limitedTable.hasEntry(mac1)).toBe(false);
      expect(limitedTable.hasEntry(mac4)).toBe(true);
    });
  });

  describe('export/import', () => {
    it('should export table to JSON', () => {
      const mac1 = new MACAddress('AA:BB:CC:DD:EE:FF');
      const mac2 = new MACAddress('00:11:22:33:44:55'); // Unicast (LSB=0)

      macTable.learn(mac1, 'eth0');
      macTable.learn(mac2, 'eth1');

      const exported = macTable.export();

      expect(exported).toHaveLength(2);
      expect(exported[0].mac).toBeDefined();
      expect(exported[0].port).toBeDefined();
    });

    it('should import table from JSON', () => {
      const data = [
        { mac: 'AA:BB:CC:DD:EE:FF', port: 'eth0', timestamp: Date.now(), agingTime: 300 },
        { mac: '00:11:22:33:44:55', port: 'eth1', timestamp: Date.now(), agingTime: 300 }
      ];

      macTable.import(data);

      expect(macTable.hasEntry(new MACAddress('AA:BB:CC:DD:EE:FF'))).toBe(true);
      expect(macTable.hasEntry(new MACAddress('00:11:22:33:44:55'))).toBe(true);
    });
  });
});
