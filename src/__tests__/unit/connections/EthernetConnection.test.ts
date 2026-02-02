/**
 * Unit tests for EthernetConnection
 * TDD approach - tests written first
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { EthernetConnection } from '@/domain/connections/EthernetConnection';
import { EthernetFrame, EtherType } from '@/domain/network/entities/EthernetFrame';
import { MACAddress } from '@/domain/network/value-objects/MACAddress';

describe('EthernetConnection', () => {
  let conn: EthernetConnection;

  const config = {
    id: 'eth-conn-1',
    sourceDeviceId: 'pc1',
    sourceInterfaceId: 'eth0',
    targetDeviceId: 'sw1',
    targetInterfaceId: 'eth0'
  };

  beforeEach(() => {
    conn = new EthernetConnection(config);
  });

  describe('construction', () => {
    it('should create connection with correct id', () => {
      expect(conn.getId()).toBe('eth-conn-1');
    });

    it('should have ethernet type', () => {
      expect(conn.getType()).toBe('ethernet');
    });

    it('should have correct source endpoint', () => {
      const source = conn.getSource();
      expect(source.deviceId).toBe('pc1');
      expect(source.interfaceId).toBe('eth0');
    });

    it('should have correct target endpoint', () => {
      const target = conn.getTarget();
      expect(target.deviceId).toBe('sw1');
      expect(target.interfaceId).toBe('eth0');
    });

    it('should be active by default', () => {
      expect(conn.isActive()).toBe(true);
      expect(conn.getStatus()).toBe('up');
    });

    it('should default to 1000base-t standard', () => {
      expect(conn.getStandard()).toBe('1000base-t');
    });

    it('should default to full duplex', () => {
      expect(conn.getDuplex()).toBe('full');
    });

    it('should default to auto cable type', () => {
      expect(conn.getCableType()).toBe('auto');
    });
  });

  describe('bandwidth and latency', () => {
    it('should return 1000 Mbps for gigabit', () => {
      conn.setStandard('1000base-t');
      expect(conn.getBandwidth()).toBe(1000);
    });

    it('should return 100 Mbps for fast ethernet', () => {
      conn.setStandard('100base-tx');
      expect(conn.getBandwidth()).toBe(100);
    });

    it('should return 10 Mbps for 10base-t', () => {
      conn.setStandard('10base-t');
      expect(conn.getBandwidth()).toBe(10);
    });

    it('should have low latency for gigabit', () => {
      conn.setStandard('1000base-t');
      expect(conn.getLatency()).toBeLessThan(1);
    });

    it('should have higher latency for 10base-t', () => {
      conn.setStandard('1000base-t');
      const gigabitLatency = conn.getLatency();
      conn.setStandard('10base-t');
      const slowLatency = conn.getLatency();
      expect(slowLatency).toBeGreaterThan(gigabitLatency);
    });
  });

  describe('link status', () => {
    it('should bring link down', () => {
      conn.down();
      expect(conn.isActive()).toBe(false);
      expect(conn.getStatus()).toBe('down');
    });

    it('should bring link back up', () => {
      conn.down();
      conn.up();
      expect(conn.isActive()).toBe(true);
    });
  });

  describe('frame transmission', () => {
    function createTestFrame(): EthernetFrame {
      return new EthernetFrame({
        sourceMAC: new MACAddress('AA:BB:CC:DD:EE:01'),
        destinationMAC: new MACAddress('AA:BB:CC:DD:EE:02'),
        etherType: EtherType.IPv4,
        payload: Buffer.alloc(46) // Minimum payload
      });
    }

    it('should deliver frame from source to target', () => {
      let deliveredDeviceId = '';
      let deliveredInterfaceId = '';

      conn.onFrameDelivery((targetDeviceId, targetInterfaceId, _frame) => {
        deliveredDeviceId = targetDeviceId;
        deliveredInterfaceId = targetInterfaceId;
      });

      const frame = createTestFrame();
      const result = conn.transmitFrame('pc1', frame);

      expect(result).toBe(true);
      expect(deliveredDeviceId).toBe('sw1');
      expect(deliveredInterfaceId).toBe('eth0');
    });

    it('should deliver frame from target to source (bidirectional)', () => {
      let deliveredDeviceId = '';

      conn.onFrameDelivery((targetDeviceId, _targetInterfaceId, _frame) => {
        deliveredDeviceId = targetDeviceId;
      });

      const frame = createTestFrame();
      conn.transmitFrame('sw1', frame);

      expect(deliveredDeviceId).toBe('pc1');
    });

    it('should drop frame when link is down', () => {
      conn.down();

      const frame = createTestFrame();
      const result = conn.transmitFrame('pc1', frame);

      expect(result).toBe(false);
    });

    it('should fail for unknown device', () => {
      const frame = createTestFrame();
      const result = conn.transmitFrame('unknown-device', frame);

      expect(result).toBe(false);
    });

    it('should update statistics on successful transmission', () => {
      conn.onFrameDelivery(() => {}); // Register callback

      const frame = createTestFrame();
      conn.transmitFrame('pc1', frame);
      conn.transmitFrame('sw1', frame);

      const stats = conn.getStatistics();
      expect(stats.txFrames).toBe(2);
      expect(stats.rxFrames).toBe(2);
      expect(stats.txBytes).toBeGreaterThan(0);
    });

    it('should track dropped frames when link is down', () => {
      conn.down();

      const frame = createTestFrame();
      conn.transmitFrame('pc1', frame);

      const stats = conn.getStatistics();
      expect(stats.droppedFrames).toBe(1);
    });

    it('should reset statistics', () => {
      conn.onFrameDelivery(() => {});

      const frame = createTestFrame();
      conn.transmitFrame('pc1', frame);

      conn.resetStatistics();
      const stats = conn.getStatistics();
      expect(stats.txFrames).toBe(0);
      expect(stats.rxFrames).toBe(0);
    });
  });

  describe('endpoint queries', () => {
    it('should return remote device id', () => {
      expect(conn.getRemoteDeviceId('pc1')).toBe('sw1');
      expect(conn.getRemoteDeviceId('sw1')).toBe('pc1');
      expect(conn.getRemoteDeviceId('unknown')).toBeNull();
    });

    it('should return remote interface id', () => {
      expect(conn.getRemoteInterfaceId('pc1')).toBe('eth0');
      expect(conn.getRemoteInterfaceId('sw1')).toBe('eth0');
      expect(conn.getRemoteInterfaceId('unknown')).toBeNull();
    });

    it('should check device involvement', () => {
      expect(conn.involvesDevice('pc1')).toBe(true);
      expect(conn.involvesDevice('sw1')).toBe(true);
      expect(conn.involvesDevice('pc3')).toBe(false);
    });
  });

  describe('configuration', () => {
    it('should set ethernet standard', () => {
      conn.setStandard('100base-tx');
      expect(conn.getStandard()).toBe('100base-tx');
    });

    it('should set duplex mode', () => {
      conn.setDuplex('half');
      expect(conn.getDuplex()).toBe('half');
    });

    it('should set cable type', () => {
      conn.setCableType('crossover');
      expect(conn.getCableType()).toBe('crossover');
    });

    it('should enable jumbo frames', () => {
      conn.setJumboFrames(true);
      expect(conn.isJumboFramesEnabled()).toBe(true);
    });
  });

  describe('serialization', () => {
    it('should serialize to JSON', () => {
      const json = conn.toJSON();

      expect(json.id).toBe('eth-conn-1');
      expect(json.type).toBe('ethernet');
      expect(json.sourceDeviceId).toBe('pc1');
      expect(json.sourceInterfaceId).toBe('eth0');
      expect(json.targetDeviceId).toBe('sw1');
      expect(json.targetInterfaceId).toBe('eth0');
      expect(json.isActive).toBe(true);
    });
  });
});
