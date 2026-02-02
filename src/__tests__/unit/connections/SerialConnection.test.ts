/**
 * Unit tests for SerialConnection
 * TDD approach - tests written first
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { SerialConnection, COMMON_CLOCK_RATES } from '@/domain/connections/SerialConnection';
import { EthernetFrame, EtherType } from '@/domain/network/entities/EthernetFrame';
import { MACAddress } from '@/domain/network/value-objects/MACAddress';

describe('SerialConnection', () => {
  let conn: SerialConnection;

  const config = {
    id: 'serial-1',
    sourceDeviceId: 'r1',
    sourceInterfaceId: 'serial0/0',
    targetDeviceId: 'r2',
    targetInterfaceId: 'serial0/0'
  };

  beforeEach(() => {
    conn = new SerialConnection(config);
  });

  describe('construction', () => {
    it('should create connection with serial type', () => {
      expect(conn.getType()).toBe('serial');
    });

    it('should default to T1 clock rate', () => {
      expect(conn.getClockRate()).toBe(COMMON_CLOCK_RATES.T1);
    });

    it('should default to HDLC encapsulation', () => {
      expect(conn.getEncapsulation()).toBe('hdlc');
    });

    it('should default source role to DCE', () => {
      expect(conn.getSourceRole()).toBe('dce');
    });
  });

  describe('clock rate', () => {
    it('should set valid clock rate', () => {
      conn.setClockRate(COMMON_CLOCK_RATES['64K']);
      expect(conn.getClockRate()).toBe(64000);
    });

    it('should reject clock rate too low', () => {
      expect(() => conn.setClockRate(100)).toThrow();
    });

    it('should reject clock rate too high', () => {
      expect(() => conn.setClockRate(100_000_000)).toThrow();
    });
  });

  describe('bandwidth', () => {
    it('should calculate bandwidth from clock rate', () => {
      conn.setClockRate(COMMON_CLOCK_RATES.T1); // 1.544 Mbps
      expect(conn.getBandwidth()).toBeCloseTo(1.544, 2);
    });

    it('should have higher latency than ethernet', () => {
      expect(conn.getLatency()).toBeGreaterThanOrEqual(1);
    });
  });

  describe('DCE/DTE roles', () => {
    it('should set source as DCE', () => {
      conn.setSourceRole('dce');
      expect(conn.getDeviceRole('r1')).toBe('dce');
      expect(conn.getDeviceRole('r2')).toBe('dte');
    });

    it('should set source as DTE', () => {
      conn.setSourceRole('dte');
      expect(conn.getDeviceRole('r1')).toBe('dte');
      expect(conn.getDeviceRole('r2')).toBe('dce');
    });

    it('should return null for unknown device', () => {
      expect(conn.getDeviceRole('unknown')).toBeNull();
    });
  });

  describe('encapsulation', () => {
    it('should set PPP encapsulation', () => {
      conn.setEncapsulation('ppp');
      expect(conn.getEncapsulation()).toBe('ppp');
    });
  });

  describe('frame transmission', () => {
    function createTestFrame(): EthernetFrame {
      return new EthernetFrame({
        sourceMAC: new MACAddress('AA:BB:CC:DD:EE:01'),
        destinationMAC: new MACAddress('AA:BB:CC:DD:EE:02'),
        etherType: EtherType.IPv4,
        payload: Buffer.alloc(46)
      });
    }

    it('should deliver frame between routers', () => {
      let deliveredTo = '';

      conn.onFrameDelivery((targetDeviceId) => {
        deliveredTo = targetDeviceId;
      });

      const result = conn.transmitFrame('r1', createTestFrame());
      expect(result).toBe(true);
      expect(deliveredTo).toBe('r2');
    });

    it('should be bidirectional', () => {
      let deliveredTo = '';

      conn.onFrameDelivery((targetDeviceId) => {
        deliveredTo = targetDeviceId;
      });

      conn.transmitFrame('r2', createTestFrame());
      expect(deliveredTo).toBe('r1');
    });
  });
});
