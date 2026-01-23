/**
 * Unit tests for Hub device
 * Following TDD approach - tests written first
 *
 * Hub is a Layer 1 (Physical Layer) device:
 * - No MAC learning
 * - No frame filtering
 * - Simply repeats all frames to all ports except ingress
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { Hub } from '@/domain/devices/Hub';
import { MACAddress } from '@/domain/network/value-objects/MACAddress';
import { EthernetFrame, EtherType } from '@/domain/network/entities/EthernetFrame';

describe('Hub', () => {
  let hub: Hub;

  beforeEach(() => {
    hub = new Hub('hub1', 'Hub 1', 4); // 4-port hub
  });

  describe('construction', () => {
    it('should create hub with id, name, and ports', () => {
      expect(hub.getId()).toBe('hub1');
      expect(hub.getName()).toBe('Hub 1');
      expect(hub.getType()).toBe('hub');
    });

    it('should have specified number of ports', () => {
      const ports = hub.getPorts();
      expect(ports).toHaveLength(4);
      expect(ports).toContain('eth0');
      expect(ports).toContain('eth1');
      expect(ports).toContain('eth2');
      expect(ports).toContain('eth3');
    });

    it('should create 8-port hub by default', () => {
      const hub8 = new Hub('hub2', 'Hub 2');
      expect(hub8.getPorts()).toHaveLength(8);
    });
  });

  describe('power management', () => {
    it('should power on hub', () => {
      hub.powerOn();

      expect(hub.getStatus()).toBe('online');
      expect(hub.isOnline()).toBe(true);
    });

    it('should power off hub', () => {
      hub.powerOn();
      hub.powerOff();

      expect(hub.getStatus()).toBe('offline');
    });

    it('should reset hub', () => {
      hub.powerOn();
      hub.reset();

      expect(hub.getStatus()).toBe('online');
    });

    it('should not forward frames when offline', () => {
      hub.powerOff();

      let forwardCount = 0;
      hub.onFrameForward(() => {
        forwardCount++;
      });

      const frame = new EthernetFrame({
        sourceMAC: new MACAddress('AA:BB:CC:DD:EE:FF'),
        destinationMAC: new MACAddress('00:11:22:33:44:55'),
        etherType: EtherType.IPv4,
        payload: Buffer.alloc(46)
      });

      hub.receiveFrame('eth0', frame);

      expect(forwardCount).toBe(0);
    });
  });

  describe('frame forwarding', () => {
    beforeEach(() => {
      hub.powerOn();
    });

    it('should forward frame to all ports except ingress', () => {
      let forwardedPorts: string[] = [];
      hub.onFrameForward((port, frame) => {
        forwardedPorts.push(port);
      });

      const frame = new EthernetFrame({
        sourceMAC: new MACAddress('AA:BB:CC:DD:EE:FF'),
        destinationMAC: new MACAddress('00:11:22:33:44:55'),
        etherType: EtherType.IPv4,
        payload: Buffer.alloc(46)
      });

      hub.receiveFrame('eth0', frame);

      // Should forward to all ports except eth0
      expect(forwardedPorts).toHaveLength(3);
      expect(forwardedPorts).toContain('eth1');
      expect(forwardedPorts).toContain('eth2');
      expect(forwardedPorts).toContain('eth3');
      expect(forwardedPorts).not.toContain('eth0');
    });

    it('should forward broadcast frames to all ports', () => {
      let forwardedPorts: string[] = [];
      hub.onFrameForward((port) => {
        forwardedPorts.push(port);
      });

      const frame = new EthernetFrame({
        sourceMAC: new MACAddress('AA:BB:CC:DD:EE:FF'),
        destinationMAC: MACAddress.BROADCAST,
        etherType: EtherType.ARP,
        payload: Buffer.alloc(46)
      });

      hub.receiveFrame('eth1', frame);

      expect(forwardedPorts).toHaveLength(3);
      expect(forwardedPorts).not.toContain('eth1');
    });

    it('should forward unicast frames to all ports (no MAC learning)', () => {
      let forwardedPorts: string[] = [];
      hub.onFrameForward((port) => {
        forwardedPorts.push(port);
      });

      // First frame
      const frame1 = new EthernetFrame({
        sourceMAC: new MACAddress('AA:BB:CC:DD:EE:FF'),
        destinationMAC: new MACAddress('00:11:22:33:44:55'),
        etherType: EtherType.IPv4,
        payload: Buffer.alloc(46)
      });

      hub.receiveFrame('eth0', frame1);

      // Second frame - even though destination was seen, hub still floods
      forwardedPorts = [];
      const frame2 = new EthernetFrame({
        sourceMAC: new MACAddress('00:11:22:33:44:55'),
        destinationMAC: new MACAddress('AA:BB:CC:DD:EE:FF'),
        etherType: EtherType.IPv4,
        payload: Buffer.alloc(46)
      });

      hub.receiveFrame('eth1', frame2);

      // Hub doesn't learn, so still floods to all except ingress
      expect(forwardedPorts).toHaveLength(3);
      expect(forwardedPorts).not.toContain('eth1');
      expect(forwardedPorts).toContain('eth0'); // Unlike switch, hub floods even if it "saw" this MAC
    });

    it('should forward same frame to multiple ports', () => {
      const frames: EthernetFrame[] = [];
      hub.onFrameForward((port, frame) => {
        frames.push(frame);
      });

      const payload = Buffer.alloc(46);
      Buffer.from('test payload').copy(payload);

      const originalFrame = new EthernetFrame({
        sourceMAC: new MACAddress('AA:BB:CC:DD:EE:FF'),
        destinationMAC: new MACAddress('00:11:22:33:44:55'),
        etherType: EtherType.IPv4,
        payload: payload
      });

      hub.receiveFrame('eth0', originalFrame);

      // Should forward same frame to 3 ports
      expect(frames).toHaveLength(3);

      // All frames should be the same reference
      frames.forEach(frame => {
        expect(frame).toBe(originalFrame);
      });
    });
  });

  describe('statistics', () => {
    beforeEach(() => {
      hub.powerOn();
    });

    it('should track total frames received', () => {
      const frame = new EthernetFrame({
        sourceMAC: new MACAddress('AA:BB:CC:DD:EE:FF'),
        destinationMAC: new MACAddress('00:11:22:33:44:55'),
        etherType: EtherType.IPv4,
        payload: Buffer.alloc(46)
      });

      hub.receiveFrame('eth0', frame);
      hub.receiveFrame('eth1', frame);
      hub.receiveFrame('eth2', frame);

      const stats = hub.getStatistics();
      expect(stats.totalFrames).toBe(3);
    });

    it('should reset statistics on reset', () => {
      const frame = new EthernetFrame({
        sourceMAC: new MACAddress('AA:BB:CC:DD:EE:FF'),
        destinationMAC: new MACAddress('00:11:22:33:44:55'),
        etherType: EtherType.IPv4,
        payload: Buffer.alloc(46)
      });

      hub.receiveFrame('eth0', frame);
      hub.receiveFrame('eth1', frame);

      hub.reset();

      const stats = hub.getStatistics();
      expect(stats.totalFrames).toBe(0);
    });
  });

  describe('port state', () => {
    it('should check if port is enabled', () => {
      expect(hub.isPortEnabled('eth0')).toBe(true);
    });

    it('should disable port', () => {
      hub.powerOn();
      hub.disablePort('eth0');

      expect(hub.isPortEnabled('eth0')).toBe(false);
    });

    it('should enable disabled port', () => {
      hub.powerOn();
      hub.disablePort('eth0');
      hub.enablePort('eth0');

      expect(hub.isPortEnabled('eth0')).toBe(true);
    });

    it('should not receive frames on disabled port', () => {
      hub.powerOn();
      hub.disablePort('eth0');

      let forwardCount = 0;
      hub.onFrameForward(() => {
        forwardCount++;
      });

      const frame = new EthernetFrame({
        sourceMAC: new MACAddress('AA:BB:CC:DD:EE:FF'),
        destinationMAC: new MACAddress('00:11:22:33:44:55'),
        etherType: EtherType.IPv4,
        payload: Buffer.alloc(46)
      });

      hub.receiveFrame('eth0', frame);

      expect(forwardCount).toBe(0);
    });

    it('should not forward to disabled ports', () => {
      hub.powerOn();
      hub.disablePort('eth2');

      let forwardedPorts: string[] = [];
      hub.onFrameForward((port) => {
        forwardedPorts.push(port);
      });

      const frame = new EthernetFrame({
        sourceMAC: new MACAddress('AA:BB:CC:DD:EE:FF'),
        destinationMAC: new MACAddress('00:11:22:33:44:55'),
        etherType: EtherType.IPv4,
        payload: Buffer.alloc(46)
      });

      hub.receiveFrame('eth0', frame);

      // Should forward to eth1 and eth3, but not eth2 (disabled)
      expect(forwardedPorts).toHaveLength(2);
      expect(forwardedPorts).toContain('eth1');
      expect(forwardedPorts).toContain('eth3');
      expect(forwardedPorts).not.toContain('eth2');
    });
  });
});
