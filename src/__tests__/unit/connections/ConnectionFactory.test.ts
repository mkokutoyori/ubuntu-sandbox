/**
 * Unit tests for ConnectionFactory
 * TDD approach - tests written first
 */

import { describe, it, expect } from 'vitest';
import { ConnectionFactory } from '@/domain/connections/ConnectionFactory';
import { EthernetConnection } from '@/domain/connections/EthernetConnection';
import { SerialConnection } from '@/domain/connections/SerialConnection';
import { ConsoleConnection } from '@/domain/connections/ConsoleConnection';

describe('ConnectionFactory', () => {
  const baseConfig = {
    id: 'conn-1',
    sourceDeviceId: 'dev1',
    sourceInterfaceId: 'eth0',
    targetDeviceId: 'dev2',
    targetInterfaceId: 'eth0'
  };

  describe('create', () => {
    it('should create EthernetConnection for ethernet type', () => {
      const conn = ConnectionFactory.create('ethernet', baseConfig);
      expect(conn).toBeInstanceOf(EthernetConnection);
      expect(conn.getType()).toBe('ethernet');
    });

    it('should create SerialConnection for serial type', () => {
      const conn = ConnectionFactory.create('serial', baseConfig);
      expect(conn).toBeInstanceOf(SerialConnection);
      expect(conn.getType()).toBe('serial');
    });

    it('should create ConsoleConnection for console type', () => {
      const conn = ConnectionFactory.create('console', baseConfig);
      expect(conn).toBeInstanceOf(ConsoleConnection);
      expect(conn.getType()).toBe('console');
    });

    it('should preserve config in created connections', () => {
      const conn = ConnectionFactory.create('ethernet', baseConfig);
      expect(conn.getId()).toBe('conn-1');
      expect(conn.getSource().deviceId).toBe('dev1');
      expect(conn.getTarget().deviceId).toBe('dev2');
    });
  });

  describe('typed factory methods', () => {
    it('should create EthernetConnection via createEthernet', () => {
      const conn = ConnectionFactory.createEthernet(baseConfig);
      expect(conn).toBeInstanceOf(EthernetConnection);
      expect(conn.getStandard()).toBe('1000base-t');
    });

    it('should create SerialConnection via createSerial', () => {
      const conn = ConnectionFactory.createSerial(baseConfig);
      expect(conn).toBeInstanceOf(SerialConnection);
      expect(conn.getEncapsulation()).toBe('hdlc');
    });

    it('should create ConsoleConnection via createConsole', () => {
      const conn = ConnectionFactory.createConsole(baseConfig);
      expect(conn).toBeInstanceOf(ConsoleConnection);
      expect(conn.getBaudRate()).toBe(9600);
    });
  });
});
