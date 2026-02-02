/**
 * Unit tests for ConsoleConnection
 * TDD approach - tests written first
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { ConsoleConnection } from '@/domain/connections/ConsoleConnection';

describe('ConsoleConnection', () => {
  let conn: ConsoleConnection;

  const config = {
    id: 'console-1',
    sourceDeviceId: 'pc1',
    sourceInterfaceId: 'console',
    targetDeviceId: 'r1',
    targetInterfaceId: 'console'
  };

  beforeEach(() => {
    conn = new ConsoleConnection(config);
  });

  describe('construction', () => {
    it('should have console type', () => {
      expect(conn.getType()).toBe('console');
    });

    it('should default to 9600 baud', () => {
      expect(conn.getBaudRate()).toBe(9600);
    });
  });

  describe('baud rate', () => {
    it('should set valid baud rate', () => {
      conn.setBaudRate(115200);
      expect(conn.getBaudRate()).toBe(115200);
    });

    it('should reject invalid baud rate', () => {
      expect(() => conn.setBaudRate(0)).toThrow();
      expect(() => conn.setBaudRate(999999)).toThrow();
    });
  });

  describe('bandwidth', () => {
    it('should have very low bandwidth', () => {
      expect(conn.getBandwidth()).toBeLessThan(1);
    });

    it('should have high latency', () => {
      expect(conn.getLatency()).toBe(10);
    });
  });
});
