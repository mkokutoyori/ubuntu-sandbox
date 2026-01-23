/**
 * Unit tests for Switch device
 * Following TDD approach - tests written first
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { Switch } from '@/domain/devices/Switch';
import { MACAddress } from '@/domain/network/value-objects/MACAddress';
import { EthernetFrame, EtherType } from '@/domain/network/entities/EthernetFrame';

describe('Switch', () => {
  let sw: Switch;

  beforeEach(() => {
    sw = new Switch('sw1', 'Switch 1', 4); // 4-port switch
  });

  describe('construction', () => {
    it('should create switch with id, name, and ports', () => {
      expect(sw.getId()).toBe('sw1');
      expect(sw.getName()).toBe('Switch 1');
      expect(sw.getType()).toBe('switch');
    });

    it('should have specified number of ports', () => {
      const ports = sw.getPorts();
      expect(ports).toHaveLength(4);
      expect(ports).toContain('eth0');
      expect(ports).toContain('eth1');
      expect(ports).toContain('eth2');
      expect(ports).toContain('eth3');
    });

    it('should create 8-port switch by default', () => {
      const sw8 = new Switch('sw2', 'Switch 2');
      expect(sw8.getPorts()).toHaveLength(8);
    });
  });

  describe('power management', () => {
    it('should power on switch', () => {
      sw.powerOn();

      expect(sw.getStatus()).toBe('online');
      expect(sw.isOnline()).toBe(true);
    });

    it('should power off switch', () => {
      sw.powerOn();
      sw.powerOff();

      expect(sw.getStatus()).toBe('offline');
    });

    it('should reset switch', () => {
      sw.powerOn();
      sw.reset();

      expect(sw.getStatus()).toBe('online');
    });

    it('should clear MAC table on reset', () => {
      sw.powerOn();

      // Learn a MAC
      const frame = new EthernetFrame({
        sourceMAC: new MACAddress('AA:BB:CC:DD:EE:FF'),
        destinationMAC: new MACAddress('00:11:22:33:44:55'),
        etherType: EtherType.IPv4,
        payload: Buffer.alloc(46)
      });

      sw.receiveFrame('eth0', frame);

      sw.reset();

      const macTable = sw.getMACTable();
      expect(macTable.getStatistics().tableSize).toBe(0);
    });
  });

  describe('MAC learning', () => {
    beforeEach(() => {
      sw.powerOn();
    });

    it('should learn source MAC on port', () => {
      const srcMAC = new MACAddress('AA:BB:CC:DD:EE:FF');

      const frame = new EthernetFrame({
        sourceMAC: srcMAC,
        destinationMAC: new MACAddress('00:11:22:33:44:55'),
        etherType: EtherType.IPv4,
        payload: Buffer.alloc(46)
      });

      sw.receiveFrame('eth0', frame);

      const macTable = sw.getMACTable();
      expect(macTable.lookup(srcMAC)).toBe('eth0');
    });

    it('should learn multiple MACs', () => {
      const mac1 = new MACAddress('AA:BB:CC:DD:EE:01');
      const mac2 = new MACAddress('AA:BB:CC:DD:EE:02');
      const mac3 = new MACAddress('AA:BB:CC:DD:EE:03');

      const frame1 = new EthernetFrame({
        sourceMAC: mac1,
        destinationMAC: MACAddress.BROADCAST,
        etherType: EtherType.ARP,
        payload: Buffer.alloc(46)
      });

      const frame2 = new EthernetFrame({
        sourceMAC: mac2,
        destinationMAC: MACAddress.BROADCAST,
        etherType: EtherType.ARP,
        payload: Buffer.alloc(46)
      });

      const frame3 = new EthernetFrame({
        sourceMAC: mac3,
        destinationMAC: MACAddress.BROADCAST,
        etherType: EtherType.ARP,
        payload: Buffer.alloc(46)
      });

      sw.receiveFrame('eth0', frame1);
      sw.receiveFrame('eth1', frame2);
      sw.receiveFrame('eth2', frame3);

      const macTable = sw.getMACTable();
      expect(macTable.lookup(mac1)).toBe('eth0');
      expect(macTable.lookup(mac2)).toBe('eth1');
      expect(macTable.lookup(mac3)).toBe('eth2');
    });

    it('should update MAC location when it moves', () => {
      const mac = new MACAddress('AA:BB:CC:DD:EE:FF');

      const frame1 = new EthernetFrame({
        sourceMAC: mac,
        destinationMAC: new MACAddress('00:11:22:33:44:55'),
        etherType: EtherType.IPv4,
        payload: Buffer.alloc(46)
      });

      sw.receiveFrame('eth0', frame1);

      const frame2 = new EthernetFrame({
        sourceMAC: mac,
        destinationMAC: new MACAddress('00:11:22:33:44:55'),
        etherType: EtherType.IPv4,
        payload: Buffer.alloc(46)
      });

      sw.receiveFrame('eth1', frame2);

      const macTable = sw.getMACTable();
      expect(macTable.lookup(mac)).toBe('eth1');
    });
  });

  describe('frame forwarding', () => {
    beforeEach(() => {
      sw.powerOn();
    });

    it('should forward unicast frame to known port', () => {
      const srcMAC = new MACAddress('AA:BB:CC:DD:EE:FF');
      const dstMAC = new MACAddress('00:11:22:33:44:55');

      // Learn destination MAC on eth1
      const learningFrame = new EthernetFrame({
        sourceMAC: dstMAC,
        destinationMAC: srcMAC,
        etherType: EtherType.IPv4,
        payload: Buffer.alloc(46)
      });

      sw.receiveFrame('eth1', learningFrame);

      // Now send frame to learned MAC
      let forwardedPorts: string[] = [];
      sw.onFrameForward((port, frame) => {
        forwardedPorts.push(port);
      });

      const frame = new EthernetFrame({
        sourceMAC: srcMAC,
        destinationMAC: dstMAC,
        etherType: EtherType.IPv4,
        payload: Buffer.alloc(46)
      });

      sw.receiveFrame('eth0', frame);

      expect(forwardedPorts).toEqual(['eth1']);
    });

    it('should flood frame when destination unknown', () => {
      const srcMAC = new MACAddress('AA:BB:CC:DD:EE:FF');
      const dstMAC = new MACAddress('00:11:22:33:44:55');

      let forwardedPorts: string[] = [];
      sw.onFrameForward((port, frame) => {
        forwardedPorts.push(port);
      });

      const frame = new EthernetFrame({
        sourceMAC: srcMAC,
        destinationMAC: dstMAC,
        etherType: EtherType.IPv4,
        payload: Buffer.alloc(46)
      });

      sw.receiveFrame('eth0', frame);

      // Should flood to all ports except eth0
      expect(forwardedPorts).toHaveLength(3);
      expect(forwardedPorts).toContain('eth1');
      expect(forwardedPorts).toContain('eth2');
      expect(forwardedPorts).toContain('eth3');
      expect(forwardedPorts).not.toContain('eth0');
    });

    it('should flood broadcast frames', () => {
      const srcMAC = new MACAddress('AA:BB:CC:DD:EE:FF');

      let forwardedPorts: string[] = [];
      sw.onFrameForward((port, frame) => {
        forwardedPorts.push(port);
      });

      const frame = new EthernetFrame({
        sourceMAC: srcMAC,
        destinationMAC: MACAddress.BROADCAST,
        etherType: EtherType.ARP,
        payload: Buffer.alloc(46)
      });

      sw.receiveFrame('eth0', frame);

      expect(forwardedPorts).toHaveLength(3);
      expect(forwardedPorts).not.toContain('eth0');
    });

    it('should not forward when destination on same port', () => {
      const srcMAC = new MACAddress('AA:BB:CC:DD:EE:FF');
      const dstMAC = new MACAddress('00:11:22:33:44:55');

      // Learn both MACs on eth0
      const frame1 = new EthernetFrame({
        sourceMAC: srcMAC,
        destinationMAC: MACAddress.BROADCAST,
        etherType: EtherType.ARP,
        payload: Buffer.alloc(46)
      });

      const frame2 = new EthernetFrame({
        sourceMAC: dstMAC,
        destinationMAC: MACAddress.BROADCAST,
        etherType: EtherType.ARP,
        payload: Buffer.alloc(46)
      });

      sw.receiveFrame('eth0', frame1);
      sw.receiveFrame('eth0', frame2);

      // Now send frame between them
      let forwardedPorts: string[] = [];
      sw.onFrameForward((port, frame) => {
        forwardedPorts.push(port);
      });

      const frame3 = new EthernetFrame({
        sourceMAC: srcMAC,
        destinationMAC: dstMAC,
        etherType: EtherType.IPv4,
        payload: Buffer.alloc(46)
      });

      sw.receiveFrame('eth0', frame3);

      // Should not forward (filtered)
      expect(forwardedPorts).toHaveLength(0);
    });
  });

  describe('statistics', () => {
    beforeEach(() => {
      sw.powerOn();
    });

    it('should track forwarding statistics', () => {
      const frame = new EthernetFrame({
        sourceMAC: new MACAddress('AA:BB:CC:DD:EE:FF'),
        destinationMAC: MACAddress.BROADCAST,
        etherType: EtherType.ARP,
        payload: Buffer.alloc(46)
      });

      sw.receiveFrame('eth0', frame);

      const stats = sw.getForwardingStatistics();
      expect(stats.totalFrames).toBe(1);
      expect(stats.broadcastFrames).toBe(1);
    });

    it('should track MAC table statistics', () => {
      const frame = new EthernetFrame({
        sourceMAC: new MACAddress('AA:BB:CC:DD:EE:FF'),
        destinationMAC: new MACAddress('00:11:22:33:44:55'),
        etherType: EtherType.IPv4,
        payload: Buffer.alloc(46)
      });

      sw.receiveFrame('eth0', frame);

      const macTableStats = sw.getMACTableStatistics();
      expect(macTableStats.tableSize).toBe(1);
      expect(macTableStats.learningCount).toBe(1);
    });
  });

  describe('port state', () => {
    it('should check if port is enabled', () => {
      expect(sw.isPortEnabled('eth0')).toBe(true);
    });

    it('should disable port', () => {
      sw.powerOn();
      sw.disablePort('eth0');

      expect(sw.isPortEnabled('eth0')).toBe(false);
    });

    it('should enable disabled port', () => {
      sw.powerOn();
      sw.disablePort('eth0');
      sw.enablePort('eth0');

      expect(sw.isPortEnabled('eth0')).toBe(true);
    });

    it('should not forward frames on disabled port', () => {
      sw.powerOn();
      sw.disablePort('eth0');

      let forwardCalled = false;
      sw.onFrameForward(() => {
        forwardCalled = true;
      });

      const frame = new EthernetFrame({
        sourceMAC: new MACAddress('AA:BB:CC:DD:EE:FF'),
        destinationMAC: MACAddress.BROADCAST,
        etherType: EtherType.ARP,
        payload: Buffer.alloc(46)
      });

      sw.receiveFrame('eth0', frame);

      expect(forwardCalled).toBe(false);
    });

    it('should remove MAC entries when port is disabled', () => {
      sw.powerOn();

      const frame = new EthernetFrame({
        sourceMAC: new MACAddress('AA:BB:CC:DD:EE:FF'),
        destinationMAC: new MACAddress('00:11:22:33:44:55'),
        etherType: EtherType.IPv4,
        payload: Buffer.alloc(46)
      });

      sw.receiveFrame('eth0', frame);

      sw.disablePort('eth0');

      const macTable = sw.getMACTable();
      expect(macTable.hasEntry(new MACAddress('AA:BB:CC:DD:EE:FF'))).toBe(false);
    });
  });

  describe('VLAN support', () => {
    it('should set port VLAN', () => {
      sw.setPortVLAN('eth0', 10);

      expect(sw.getPortVLAN('eth0')).toBe(10);
    });

    it('should have VLAN 1 by default', () => {
      expect(sw.getPortVLAN('eth0')).toBe(1);
    });

    it('should isolate traffic between VLANs', () => {
      sw.powerOn();
      sw.setPortVLAN('eth0', 10);
      sw.setPortVLAN('eth1', 10);
      sw.setPortVLAN('eth2', 20);

      let forwardedPorts: string[] = [];
      sw.onFrameForward((port) => {
        forwardedPorts.push(port);
      });

      const frame = new EthernetFrame({
        sourceMAC: new MACAddress('AA:BB:CC:DD:EE:FF'),
        destinationMAC: MACAddress.BROADCAST,
        etherType: EtherType.ARP,
        payload: Buffer.alloc(46)
      });

      sw.receiveFrame('eth0', frame);

      // Should only forward to ports in same VLAN (eth1)
      expect(forwardedPorts).toContain('eth1');
      expect(forwardedPorts).not.toContain('eth2'); // Different VLAN
    });
  });
});
