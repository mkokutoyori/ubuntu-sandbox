/**
 * Tests for PropertiesPanel connection details logic
 *
 * Tests the functions that compute connection details for the properties panel:
 * - Connection bandwidth, latency display
 * - Source/target interface names and device info
 */

import { describe, it, expect } from 'vitest';
import {
  getConnectionDetails,
  formatBandwidth,
  formatLatency
} from '@/components/network/properties-panel-logic';
import { Cable } from '@/network';
import type { Connection } from '@/store/networkStore';

function makeConnection(overrides: Partial<Connection> & { id: string; type: Connection['type'] }): Connection {
  return {
    sourceDeviceId: 'dev-1',
    sourceInterfaceId: 'eth0',
    targetDeviceId: 'dev-2',
    targetInterfaceId: 'eth0',
    isActive: true,
    cable: new Cable('cable-' + overrides.id),
    ...overrides,
  };
}

describe('properties-panel-logic', () => {
  // ── formatBandwidth ─────────────────────────────────────────────────

  describe('formatBandwidth', () => {
    it('should format 1000 Mbps as "1 Gbps"', () => {
      expect(formatBandwidth(1000)).toBe('1 Gbps');
    });

    it('should format 100 Mbps as "100 Mbps"', () => {
      expect(formatBandwidth(100)).toBe('100 Mbps');
    });

    it('should format 10 Mbps as "10 Mbps"', () => {
      expect(formatBandwidth(10)).toBe('10 Mbps');
    });

    it('should format 1.544 Mbps as "1.544 Mbps"', () => {
      expect(formatBandwidth(1.544)).toBe('1.544 Mbps');
    });

    it('should format 0 as "N/A"', () => {
      expect(formatBandwidth(0)).toBe('N/A');
    });
  });

  // ── formatLatency ──────────────────────────────────────────────────

  describe('formatLatency', () => {
    it('should format 0.1 ms', () => {
      expect(formatLatency(0.1)).toBe('0.1 ms');
    });

    it('should format 5 ms', () => {
      expect(formatLatency(5)).toBe('5 ms');
    });

    it('should format 0 ms as "< 0.1 ms"', () => {
      expect(formatLatency(0)).toBe('< 0.1 ms');
    });
  });

  // ── getConnectionDetails ────────────────────────────────────────────

  describe('getConnectionDetails', () => {
    it('should return ethernet connection details with bandwidth', () => {
      const connection = makeConnection({
        id: 'conn-1', type: 'ethernet',
        sourceInterfaceId: 'Ethernet0',
        targetInterfaceId: 'Ethernet0',
      });

      const details = getConnectionDetails(connection);
      expect(details.type).toBe('ethernet');
      expect(details.typeLabel).toBe('Ethernet');
      expect(details.bandwidth).toBe('1 Gbps');
      expect(details.latency).toBe('0.1 ms');
      expect(details.sourceInterface).toBe('Ethernet0');
      expect(details.targetInterface).toBe('Ethernet0');
      expect(details.isActive).toBe(true);
    });

    it('should return serial connection details', () => {
      const connection = makeConnection({
        id: 'conn-2', type: 'serial',
        sourceInterfaceId: 'serial0/0',
        targetInterfaceId: 'serial0/0',
      });

      const details = getConnectionDetails(connection);
      expect(details.type).toBe('serial');
      expect(details.typeLabel).toBe('Serial');
      expect(details.bandwidth).toBe('1.544 Mbps');
      expect(details.latency).toBe('5 ms');
      expect(details.sourceInterface).toBe('serial0/0');
      expect(details.targetInterface).toBe('serial0/0');
    });

    it('should return console connection details', () => {
      const connection = makeConnection({
        id: 'conn-3', type: 'console',
        sourceInterfaceId: 'console0',
        targetInterfaceId: 'console0',
      });

      const details = getConnectionDetails(connection);
      expect(details.type).toBe('console');
      expect(details.typeLabel).toBe('Console');
      expect(details.bandwidth).toBe('N/A');
      expect(details.latency).toBe('N/A');
    });

    it('should handle inactive connection', () => {
      const connection = makeConnection({
        id: 'conn-4', type: 'ethernet',
        isActive: false,
      });

      const details = getConnectionDetails(connection);
      expect(details.type).toBe('ethernet');
      expect(details.isActive).toBe(false);
      expect(details.bandwidth).toBe('1 Gbps');
    });
  });
});
