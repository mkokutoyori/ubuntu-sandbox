/**
 * Unit tests for FrameForwardingService
 * Following TDD approach - tests written first
 *
 * Frame forwarding logic for Layer 2 switches
 * Implements unicast forwarding, broadcast/multicast flooding
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { FrameForwardingService, ForwardingDecision } from '@/domain/network/services/FrameForwardingService';
import { MACTableService } from '@/domain/network/services/MACTableService';
import { EthernetFrame, EtherType } from '@/domain/network/entities/EthernetFrame';
import { MACAddress } from '@/domain/network/value-objects/MACAddress';

describe('FrameForwardingService', () => {
  let forwardingService: FrameForwardingService;
  let macTable: MACTableService;

  beforeEach(() => {
    macTable = new MACTableService();
    forwardingService = new FrameForwardingService(macTable);
  });

  describe('unicast forwarding', () => {
    it('should forward to specific port when MAC is known', () => {
      const srcMAC = new MACAddress('AA:BB:CC:DD:EE:FF');
      const dstMAC = new MACAddress('00:11:22:33:44:55');

      // Learn destination MAC on eth1
      macTable.learn(dstMAC, 'eth1');

      const frame = new EthernetFrame({
        sourceMAC: srcMAC,
        destinationMAC: dstMAC,
        etherType: EtherType.IPv4,
        payload: Buffer.alloc(46)
      });

      const decision = forwardingService.forward(frame, 'eth0');

      expect(decision.action).toBe('forward');
      expect(decision.ports).toEqual(['eth1']);
    });

    it('should not forward back to source port', () => {
      const srcMAC = new MACAddress('AA:BB:CC:DD:EE:FF');
      const dstMAC = new MACAddress('00:11:22:33:44:55');

      // Learn destination MAC on same port as source
      macTable.learn(dstMAC, 'eth0');

      const frame = new EthernetFrame({
        sourceMAC: srcMAC,
        destinationMAC: dstMAC,
        etherType: EtherType.IPv4,
        payload: Buffer.alloc(46)
      });

      const decision = forwardingService.forward(frame, 'eth0');

      expect(decision.action).toBe('filter');
      expect(decision.ports).toEqual([]);
    });

    it('should flood when destination MAC is unknown', () => {
      const srcMAC = new MACAddress('AA:BB:CC:DD:EE:FF');
      const dstMAC = new MACAddress('00:11:22:33:44:55');

      // Configure available ports
      forwardingService.setPorts(['eth0', 'eth1', 'eth2']);

      const frame = new EthernetFrame({
        sourceMAC: srcMAC,
        destinationMAC: dstMAC,
        etherType: EtherType.IPv4,
        payload: Buffer.alloc(46)
      });

      const decision = forwardingService.forward(frame, 'eth0');

      expect(decision.action).toBe('flood');
      expect(decision.ports).toHaveLength(2); // All ports except source
      expect(decision.ports).toContain('eth1');
      expect(decision.ports).toContain('eth2');
      expect(decision.ports).not.toContain('eth0'); // Source port excluded
    });
  });

  describe('broadcast forwarding', () => {
    it('should flood broadcast frames to all ports except source', () => {
      const srcMAC = new MACAddress('AA:BB:CC:DD:EE:FF');

      forwardingService.setPorts(['eth0', 'eth1', 'eth2', 'eth3']);

      const frame = new EthernetFrame({
        sourceMAC: srcMAC,
        destinationMAC: MACAddress.BROADCAST,
        etherType: EtherType.ARP,
        payload: Buffer.alloc(46)
      });

      const decision = forwardingService.forward(frame, 'eth0');

      expect(decision.action).toBe('flood');
      expect(decision.ports).toHaveLength(3);
      expect(decision.ports).not.toContain('eth0');
    });
  });

  describe('multicast forwarding', () => {
    it('should flood multicast frames to all ports except source', () => {
      const srcMAC = new MACAddress('AA:BB:CC:DD:EE:FF');
      const multicastMAC = new MACAddress('01:00:5E:00:00:01');

      forwardingService.setPorts(['eth0', 'eth1', 'eth2']);

      const frame = new EthernetFrame({
        sourceMAC: srcMAC,
        destinationMAC: multicastMAC,
        etherType: EtherType.IPv4,
        payload: Buffer.alloc(46)
      });

      const decision = forwardingService.forward(frame, 'eth0');

      expect(decision.action).toBe('flood');
      expect(decision.ports).toHaveLength(2);
      expect(decision.ports).not.toContain('eth0');
    });
  });

  describe('source MAC learning', () => {
    it('should learn source MAC on ingress port', () => {
      const srcMAC = new MACAddress('AA:BB:CC:DD:EE:FF');
      const dstMAC = new MACAddress('00:11:22:33:44:55');

      forwardingService.setPorts(['eth0', 'eth1']);

      const frame = new EthernetFrame({
        sourceMAC: srcMAC,
        destinationMAC: dstMAC,
        etherType: EtherType.IPv4,
        payload: Buffer.alloc(46)
      });

      forwardingService.forward(frame, 'eth0');

      // Check that source MAC was learned
      expect(macTable.lookup(srcMAC)).toBe('eth0');
    });

    it('should update MAC location if it moves', () => {
      const srcMAC = new MACAddress('AA:BB:CC:DD:EE:FF');
      const dstMAC = new MACAddress('00:11:22:33:44:55');

      forwardingService.setPorts(['eth0', 'eth1']);

      const frame1 = new EthernetFrame({
        sourceMAC: srcMAC,
        destinationMAC: dstMAC,
        etherType: EtherType.IPv4,
        payload: Buffer.alloc(46)
      });

      forwardingService.forward(frame1, 'eth0');
      expect(macTable.lookup(srcMAC)).toBe('eth0');

      const frame2 = new EthernetFrame({
        sourceMAC: srcMAC,
        destinationMAC: dstMAC,
        etherType: EtherType.IPv4,
        payload: Buffer.alloc(46)
      });

      forwardingService.forward(frame2, 'eth1');
      expect(macTable.lookup(srcMAC)).toBe('eth1');
    });

    it('should not learn broadcast source MAC', () => {
      const dstMAC = new MACAddress('00:11:22:33:44:55');

      forwardingService.setPorts(['eth0', 'eth1']);

      const frame = new EthernetFrame({
        sourceMAC: MACAddress.BROADCAST,
        destinationMAC: dstMAC,
        etherType: EtherType.IPv4,
        payload: Buffer.alloc(46)
      });

      forwardingService.forward(frame, 'eth0');

      // Broadcast should not be learned
      expect(macTable.hasEntry(MACAddress.BROADCAST)).toBe(false);
    });
  });

  describe('port management', () => {
    it('should initialize with empty port list', () => {
      const ports = forwardingService.getPorts();
      expect(ports).toEqual([]);
    });

    it('should set ports', () => {
      forwardingService.setPorts(['eth0', 'eth1', 'eth2']);

      const ports = forwardingService.getPorts();
      expect(ports).toHaveLength(3);
      expect(ports).toContain('eth0');
      expect(ports).toContain('eth1');
      expect(ports).toContain('eth2');
    });

    it('should add port', () => {
      forwardingService.setPorts(['eth0', 'eth1']);
      forwardingService.addPort('eth2');

      const ports = forwardingService.getPorts();
      expect(ports).toHaveLength(3);
      expect(ports).toContain('eth2');
    });

    it('should remove port', () => {
      forwardingService.setPorts(['eth0', 'eth1', 'eth2']);
      forwardingService.removePort('eth1');

      const ports = forwardingService.getPorts();
      expect(ports).toHaveLength(2);
      expect(ports).not.toContain('eth1');
    });

    it('should remove MAC entries when port is removed', () => {
      const mac = new MACAddress('AA:BB:CC:DD:EE:FF');

      forwardingService.setPorts(['eth0', 'eth1']);

      // Learn MAC on eth1
      const frame = new EthernetFrame({
        sourceMAC: mac,
        destinationMAC: new MACAddress('00:11:22:33:44:55'),
        etherType: EtherType.IPv4,
        payload: Buffer.alloc(46)
      });

      forwardingService.forward(frame, 'eth1');
      expect(macTable.lookup(mac)).toBe('eth1');

      // Remove port
      forwardingService.removePort('eth1');

      // MAC should be removed
      expect(macTable.hasEntry(mac)).toBe(false);
    });
  });

  describe('statistics', () => {
    it('should track forwarding statistics', () => {
      const srcMAC = new MACAddress('AA:BB:CC:DD:EE:FF');
      const dstMAC = new MACAddress('00:11:22:33:44:55');

      forwardingService.setPorts(['eth0', 'eth1']);
      macTable.learn(dstMAC, 'eth1');

      const frame = new EthernetFrame({
        sourceMAC: srcMAC,
        destinationMAC: dstMAC,
        etherType: EtherType.IPv4,
        payload: Buffer.alloc(46)
      });

      forwardingService.forward(frame, 'eth0');

      const stats = forwardingService.getStatistics();
      expect(stats.totalFrames).toBe(1);
      expect(stats.unicastFrames).toBe(1);
    });

    it('should track broadcast count', () => {
      const srcMAC = new MACAddress('AA:BB:CC:DD:EE:FF');

      forwardingService.setPorts(['eth0', 'eth1']);

      const frame = new EthernetFrame({
        sourceMAC: srcMAC,
        destinationMAC: MACAddress.BROADCAST,
        etherType: EtherType.ARP,
        payload: Buffer.alloc(46)
      });

      forwardingService.forward(frame, 'eth0');

      const stats = forwardingService.getStatistics();
      expect(stats.broadcastFrames).toBe(1);
    });

    it('should track multicast count', () => {
      const srcMAC = new MACAddress('AA:BB:CC:DD:EE:FF');
      const multicastMAC = new MACAddress('01:00:5E:00:00:01');

      forwardingService.setPorts(['eth0', 'eth1']);

      const frame = new EthernetFrame({
        sourceMAC: srcMAC,
        destinationMAC: multicastMAC,
        etherType: EtherType.IPv4,
        payload: Buffer.alloc(46)
      });

      forwardingService.forward(frame, 'eth0');

      const stats = forwardingService.getStatistics();
      expect(stats.multicastFrames).toBe(1);
    });

    it('should track flooded frames', () => {
      const srcMAC = new MACAddress('AA:BB:CC:DD:EE:FF');
      const unknownMAC = new MACAddress('00:11:22:33:44:55');

      forwardingService.setPorts(['eth0', 'eth1', 'eth2']);

      const frame = new EthernetFrame({
        sourceMAC: srcMAC,
        destinationMAC: unknownMAC,
        etherType: EtherType.IPv4,
        payload: Buffer.alloc(46)
      });

      forwardingService.forward(frame, 'eth0');

      const stats = forwardingService.getStatistics();
      expect(stats.floodedFrames).toBe(1);
    });

    it('should track filtered frames', () => {
      const srcMAC = new MACAddress('AA:BB:CC:DD:EE:FF');
      const dstMAC = new MACAddress('00:11:22:33:44:55');

      forwardingService.setPorts(['eth0', 'eth1']);
      macTable.learn(dstMAC, 'eth0'); // Same port as source

      const frame = new EthernetFrame({
        sourceMAC: srcMAC,
        destinationMAC: dstMAC,
        etherType: EtherType.IPv4,
        payload: Buffer.alloc(46)
      });

      forwardingService.forward(frame, 'eth0');

      const stats = forwardingService.getStatistics();
      expect(stats.filteredFrames).toBe(1);
    });

    it('should reset statistics', () => {
      const srcMAC = new MACAddress('AA:BB:CC:DD:EE:FF');

      forwardingService.setPorts(['eth0', 'eth1']);

      const frame = new EthernetFrame({
        sourceMAC: srcMAC,
        destinationMAC: MACAddress.BROADCAST,
        etherType: EtherType.ARP,
        payload: Buffer.alloc(46)
      });

      forwardingService.forward(frame, 'eth0');

      forwardingService.resetStatistics();

      const stats = forwardingService.getStatistics();
      expect(stats.totalFrames).toBe(0);
      expect(stats.broadcastFrames).toBe(0);
    });
  });

  describe('decision details', () => {
    it('should provide reason for forwarding decision', () => {
      const srcMAC = new MACAddress('AA:BB:CC:DD:EE:FF');
      const dstMAC = new MACAddress('00:11:22:33:44:55');

      forwardingService.setPorts(['eth0', 'eth1']);
      macTable.learn(dstMAC, 'eth1');

      const frame = new EthernetFrame({
        sourceMAC: srcMAC,
        destinationMAC: dstMAC,
        etherType: EtherType.IPv4,
        payload: Buffer.alloc(46)
      });

      const decision = forwardingService.forward(frame, 'eth0');

      expect(decision.reason).toBeDefined();
      expect(decision.reason).toContain('MAC known');
    });

    it('should explain filtering decision', () => {
      const srcMAC = new MACAddress('AA:BB:CC:DD:EE:FF');
      const dstMAC = new MACAddress('00:11:22:33:44:55');

      forwardingService.setPorts(['eth0', 'eth1']);
      macTable.learn(dstMAC, 'eth0');

      const frame = new EthernetFrame({
        sourceMAC: srcMAC,
        destinationMAC: dstMAC,
        etherType: EtherType.IPv4,
        payload: Buffer.alloc(46)
      });

      const decision = forwardingService.forward(frame, 'eth0');

      expect(decision.action).toBe('filter');
      expect(decision.reason).toContain('same port');
    });
  });
});
