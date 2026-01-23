/**
 * Integration tests for devices
 * Tests interaction between PC and Switch
 *
 * Scenarios covered:
 * 1. PC-to-PC communication through switch
 * 2. ARP resolution through switch
 * 3. Switch MAC learning and forwarding
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { PC } from '@/domain/devices/PC';
import { Switch } from '@/domain/devices/Switch';
import { IPAddress } from '@/domain/network/value-objects/IPAddress';
import { SubnetMask } from '@/domain/network/value-objects/SubnetMask';
import { MACAddress } from '@/domain/network/value-objects/MACAddress';
import { EthernetFrame, EtherType } from '@/domain/network/entities/EthernetFrame';

describe('Devices Integration Tests', () => {
  describe('Scenario 1: PC-to-PC communication through switch', () => {
    let pc1: PC;
    let pc2: PC;
    let sw: Switch;

    beforeEach(() => {
      pc1 = new PC('pc1', 'PC 1');
      pc2 = new PC('pc2', 'PC 2');
      sw = new Switch('sw1', 'Switch 1', 4);

      // Configure IP addresses
      pc1.setIPAddress('eth0', new IPAddress('192.168.1.10'), new SubnetMask('/24'));
      pc2.setIPAddress('eth0', new IPAddress('192.168.1.20'), new SubnetMask('/24'));

      // Power on all devices
      pc1.powerOn();
      pc2.powerOn();
      sw.powerOn();

      // Connect PC1 -> Switch port 0
      pc1.onFrameTransmit((frame) => {
        sw.receiveFrame('eth0', frame);
      });

      // Connect PC2 -> Switch port 1
      pc2.onFrameTransmit((frame) => {
        sw.receiveFrame('eth1', frame);
      });

      // Connect Switch -> PCs
      sw.onFrameForward((port, frame) => {
        if (port === 'eth0') {
          pc1.receiveFrame('eth0', frame);
        } else if (port === 'eth1') {
          pc2.receiveFrame('eth0', frame);
        }
      });
    });

    it('should learn MAC addresses on switch', () => {
      // PC1 sends broadcast
      const broadcastFrame = new EthernetFrame({
        sourceMAC: pc1.getInterface('eth0')!.getMAC(),
        destinationMAC: MACAddress.BROADCAST,
        etherType: EtherType.ARP,
        payload: Buffer.alloc(46)
      });

      pc1.sendFrame('eth0', broadcastFrame);

      // Switch should have learned PC1's MAC on port 0
      const macTable = sw.getMACTable();
      expect(macTable.lookup(pc1.getInterface('eth0')!.getMAC())).toBe('eth0');
    });

    it('should forward unicast frame after learning', () => {
      // PC1 sends broadcast (learns MAC)
      const broadcastFrame = new EthernetFrame({
        sourceMAC: pc1.getInterface('eth0')!.getMAC(),
        destinationMAC: MACAddress.BROADCAST,
        etherType: EtherType.ARP,
        payload: Buffer.alloc(46)
      });

      pc1.sendFrame('eth0', broadcastFrame);

      // PC2 sends broadcast (learns MAC)
      const broadcastFrame2 = new EthernetFrame({
        sourceMAC: pc2.getInterface('eth0')!.getMAC(),
        destinationMAC: MACAddress.BROADCAST,
        etherType: EtherType.ARP,
        payload: Buffer.alloc(46)
      });

      pc2.sendFrame('eth0', broadcastFrame2);

      // Now PC1 sends unicast to PC2
      let pc2Received = false;
      pc2.onFrameReceive(() => {
        pc2Received = true;
      });

      const unicastFrame = new EthernetFrame({
        sourceMAC: pc1.getInterface('eth0')!.getMAC(),
        destinationMAC: pc2.getInterface('eth0')!.getMAC(),
        etherType: EtherType.IPv4,
        payload: Buffer.alloc(46)
      });

      pc1.sendFrame('eth0', unicastFrame);

      expect(pc2Received).toBe(true);

      // Check switch stats
      const stats = sw.getForwardingStatistics();
      expect(stats.totalFrames).toBe(3); // 2 broadcasts + 1 unicast
      expect(stats.broadcastFrames).toBe(2);
      expect(stats.unicastFrames).toBe(1);
    });

    it('should not forward when both PCs on same port', () => {
      // Reconfigure: both PCs on port 0
      pc1.onFrameTransmit((frame) => {
        sw.receiveFrame('eth0', frame);
      });

      pc2.onFrameTransmit((frame) => {
        sw.receiveFrame('eth0', frame);
      });

      // Learn both MACs
      const frame1 = new EthernetFrame({
        sourceMAC: pc1.getInterface('eth0')!.getMAC(),
        destinationMAC: MACAddress.BROADCAST,
        etherType: EtherType.ARP,
        payload: Buffer.alloc(46)
      });

      const frame2 = new EthernetFrame({
        sourceMAC: pc2.getInterface('eth0')!.getMAC(),
        destinationMAC: MACAddress.BROADCAST,
        etherType: EtherType.ARP,
        payload: Buffer.alloc(46)
      });

      pc1.sendFrame('eth0', frame1);
      pc2.sendFrame('eth0', frame2);

      // PC1 sends to PC2
      let forwardCount = 0;
      sw.onFrameForward(() => {
        forwardCount++;
      });

      const unicastFrame = new EthernetFrame({
        sourceMAC: pc1.getInterface('eth0')!.getMAC(),
        destinationMAC: pc2.getInterface('eth0')!.getMAC(),
        etherType: EtherType.IPv4,
        payload: Buffer.alloc(46)
      });

      pc1.sendFrame('eth0', unicastFrame);

      // Should not forward (same segment)
      expect(forwardCount).toBe(0);
    });
  });

  describe('Scenario 2: ARP resolution through switch', () => {
    let pc1: PC;
    let pc2: PC;
    let sw: Switch;

    beforeEach(() => {
      pc1 = new PC('pc1', 'PC 1');
      pc2 = new PC('pc2', 'PC 2');
      sw = new Switch('sw1', 'Switch 1', 4);

      // Configure IP addresses
      pc1.setIPAddress('eth0', new IPAddress('192.168.1.10'), new SubnetMask('/24'));
      pc2.setIPAddress('eth0', new IPAddress('192.168.1.20'), new SubnetMask('/24'));

      // Power on all devices
      pc1.powerOn();
      pc2.powerOn();
      sw.powerOn();

      // Connect topology
      pc1.onFrameTransmit((frame) => {
        sw.receiveFrame('eth0', frame);
      });

      pc2.onFrameTransmit((frame) => {
        sw.receiveFrame('eth1', frame);
      });

      sw.onFrameForward((port, frame) => {
        if (port === 'eth0') {
          pc1.receiveFrame('eth0', frame);
        } else if (port === 'eth1') {
          pc2.receiveFrame('eth0', frame);
        }
      });
    });

    it('should perform complete ARP resolution', () => {
      // Initial state: PC1 doesn't know PC2's MAC
      const pc2IP = new IPAddress('192.168.1.20');
      expect(pc1.resolveMAC(pc2IP)).toBeUndefined();

      // PC1 creates ARP request
      const arpRequest = pc1.createARPRequest(pc2IP);
      const arpService = pc1.getARPService();
      const arpBytes = arpService.serializePacket(arpRequest);
      const paddedPayload = Buffer.concat([
        arpBytes,
        Buffer.alloc(Math.max(0, 46 - arpBytes.length))
      ]);

      // PC1 sends ARP request (broadcast)
      const arpRequestFrame = new EthernetFrame({
        sourceMAC: pc1.getInterface('eth0')!.getMAC(),
        destinationMAC: MACAddress.BROADCAST,
        etherType: EtherType.ARP,
        payload: paddedPayload
      });

      pc1.sendFrame('eth0', arpRequestFrame);

      // PC2 should receive ARP request and its cache should have PC1's entry
      expect(pc2.resolveMAC(new IPAddress('192.168.1.10'))).toBeDefined();

      // PC2 should have automatically sent ARP reply (handled internally)
      // Check that PC1 now has PC2's MAC in cache
      const resolvedMAC = pc1.resolveMAC(pc2IP);
      expect(resolvedMAC).toBeDefined();
      expect(resolvedMAC!.equals(pc2.getInterface('eth0')!.getMAC())).toBe(true);
    });

    it('should update ARP cache on both sides', () => {
      // Send frame from PC1 to trigger learning
      const frame1 = new EthernetFrame({
        sourceMAC: pc1.getInterface('eth0')!.getMAC(),
        destinationMAC: MACAddress.BROADCAST,
        etherType: EtherType.ARP,
        payload: Buffer.alloc(46)
      });

      pc1.sendFrame('eth0', frame1);

      // Send frame from PC2
      const frame2 = new EthernetFrame({
        sourceMAC: pc2.getInterface('eth0')!.getMAC(),
        destinationMAC: MACAddress.BROADCAST,
        etherType: EtherType.ARP,
        payload: Buffer.alloc(46)
      });

      pc2.sendFrame('eth0', frame2);

      // Both PCs' MACs should be in switch MAC table
      const macTable = sw.getMACTable();
      expect(macTable.hasEntry(pc1.getInterface('eth0')!.getMAC())).toBe(true);
      expect(macTable.hasEntry(pc2.getInterface('eth0')!.getMAC())).toBe(true);
    });
  });

  describe('Scenario 3: VLAN isolation', () => {
    let pc1: PC;
    let pc2: PC;
    let pc3: PC;
    let sw: Switch;

    beforeEach(() => {
      pc1 = new PC('pc1', 'PC 1');
      pc2 = new PC('pc2', 'PC 2');
      pc3 = new PC('pc3', 'PC 3');
      sw = new Switch('sw1', 'Switch 1', 4);

      // Configure IP addresses
      pc1.setIPAddress('eth0', new IPAddress('192.168.1.10'), new SubnetMask('/24'));
      pc2.setIPAddress('eth0', new IPAddress('192.168.1.20'), new SubnetMask('/24'));
      pc3.setIPAddress('eth0', new IPAddress('192.168.2.10'), new SubnetMask('/24'));

      // Configure VLANs
      sw.setPortVLAN('eth0', 10); // PC1
      sw.setPortVLAN('eth1', 10); // PC2
      sw.setPortVLAN('eth2', 20); // PC3 (different VLAN)

      // Power on
      pc1.powerOn();
      pc2.powerOn();
      pc3.powerOn();
      sw.powerOn();

      // Connect topology
      pc1.onFrameTransmit((frame) => sw.receiveFrame('eth0', frame));
      pc2.onFrameTransmit((frame) => sw.receiveFrame('eth1', frame));
      pc3.onFrameTransmit((frame) => sw.receiveFrame('eth2', frame));

      sw.onFrameForward((port, frame) => {
        if (port === 'eth0') pc1.receiveFrame('eth0', frame);
        if (port === 'eth1') pc2.receiveFrame('eth0', frame);
        if (port === 'eth2') pc3.receiveFrame('eth0', frame);
      });
    });

    it('should isolate traffic between VLANs', () => {
      let pc2Received = false;
      let pc3Received = false;

      pc2.onFrameReceive(() => {
        pc2Received = true;
      });

      pc3.onFrameReceive(() => {
        pc3Received = true;
      });

      // PC1 sends broadcast
      const broadcastFrame = new EthernetFrame({
        sourceMAC: pc1.getInterface('eth0')!.getMAC(),
        destinationMAC: MACAddress.BROADCAST,
        etherType: EtherType.ARP,
        payload: Buffer.alloc(46)
      });

      pc1.sendFrame('eth0', broadcastFrame);

      // PC2 (same VLAN) should receive
      expect(pc2Received).toBe(true);

      // PC3 (different VLAN) should NOT receive
      expect(pc3Received).toBe(false);
    });

    it('should allow communication within same VLAN', () => {
      // Learn MACs
      const frame1 = new EthernetFrame({
        sourceMAC: pc1.getInterface('eth0')!.getMAC(),
        destinationMAC: MACAddress.BROADCAST,
        etherType: EtherType.ARP,
        payload: Buffer.alloc(46)
      });

      const frame2 = new EthernetFrame({
        sourceMAC: pc2.getInterface('eth0')!.getMAC(),
        destinationMAC: MACAddress.BROADCAST,
        etherType: EtherType.ARP,
        payload: Buffer.alloc(46)
      });

      pc1.sendFrame('eth0', frame1);
      pc2.sendFrame('eth0', frame2);

      // PC1 -> PC2 (same VLAN)
      let pc2Received = false;
      pc2.onFrameReceive(() => {
        pc2Received = true;
      });

      const unicastFrame = new EthernetFrame({
        sourceMAC: pc1.getInterface('eth0')!.getMAC(),
        destinationMAC: pc2.getInterface('eth0')!.getMAC(),
        etherType: EtherType.IPv4,
        payload: Buffer.alloc(46)
      });

      pc1.sendFrame('eth0', unicastFrame);

      expect(pc2Received).toBe(true);
    });
  });

  describe('Scenario 4: Multiple switches', () => {
    let pc1: PC;
    let pc2: PC;
    let sw1: Switch;
    let sw2: Switch;

    beforeEach(() => {
      pc1 = new PC('pc1', 'PC 1');
      pc2 = new PC('pc2', 'PC 2');
      sw1 = new Switch('sw1', 'Switch 1', 4);
      sw2 = new Switch('sw2', 'Switch 2', 4);

      // Configure
      pc1.setIPAddress('eth0', new IPAddress('192.168.1.10'), new SubnetMask('/24'));
      pc2.setIPAddress('eth0', new IPAddress('192.168.1.20'), new SubnetMask('/24'));

      // Power on
      pc1.powerOn();
      pc2.powerOn();
      sw1.powerOn();
      sw2.powerOn();

      // Topology: PC1 -> SW1 -> SW2 -> PC2
      pc1.onFrameTransmit((frame) => sw1.receiveFrame('eth0', frame));

      sw1.onFrameForward((port, frame) => {
        if (port === 'eth0') pc1.receiveFrame('eth0', frame);
        if (port === 'eth1') sw2.receiveFrame('eth0', frame); // Inter-switch link
      });

      sw2.onFrameForward((port, frame) => {
        if (port === 'eth0') sw1.receiveFrame('eth1', frame); // Inter-switch link
        if (port === 'eth1') pc2.receiveFrame('eth0', frame);
      });

      pc2.onFrameTransmit((frame) => sw2.receiveFrame('eth1', frame));
    });

    it('should forward through multiple switches', () => {
      let pc2Received = false;

      pc2.onFrameReceive(() => {
        pc2Received = true;
      });

      // PC1 sends broadcast
      const broadcastFrame = new EthernetFrame({
        sourceMAC: pc1.getInterface('eth0')!.getMAC(),
        destinationMAC: MACAddress.BROADCAST,
        etherType: EtherType.ARP,
        payload: Buffer.alloc(46)
      });

      pc1.sendFrame('eth0', broadcastFrame);

      // PC2 should receive through both switches
      expect(pc2Received).toBe(true);

      // Both switches should have learned PC1's MAC
      expect(sw1.getMACTable().hasEntry(pc1.getInterface('eth0')!.getMAC())).toBe(true);
      expect(sw2.getMACTable().hasEntry(pc1.getInterface('eth0')!.getMAC())).toBe(true);
    });
  });
});
