/**
 * Integration tests for network components
 * Tests interaction between multiple services
 *
 * Scenarios covered:
 * 1. Two devices exchanging frames
 * 2. ARP resolution between devices
 * 3. MAC learning on switch
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { NetworkSimulator } from '@/domain/network/NetworkSimulator';
import { ARPService } from '@/domain/network/services/ARPService';
import { MACTableService } from '@/domain/network/services/MACTableService';
import { FrameForwardingService } from '@/domain/network/services/FrameForwardingService';
import { EthernetFrame, EtherType } from '@/domain/network/entities/EthernetFrame';
import { IPv4Packet, IPProtocol } from '@/domain/network/entities/IPv4Packet';
import { IPAddress } from '@/domain/network/value-objects/IPAddress';
import { MACAddress } from '@/domain/network/value-objects/MACAddress';

describe('Network Integration Tests', () => {
  describe('Scenario 1: Two devices exchanging frames', () => {
    let simulator: NetworkSimulator;
    let device1MAC: MACAddress;
    let device2MAC: MACAddress;

    beforeEach(() => {
      simulator = new NetworkSimulator();

      device1MAC = new MACAddress('AA:BB:CC:DD:EE:01');
      device2MAC = new MACAddress('AA:BB:CC:DD:EE:02');

      // Register two devices
      simulator.registerDevice('pc1', device1MAC);
      simulator.registerDevice('pc2', device2MAC);

      // Connect them
      simulator.connectDevices('pc1', 'eth0', 'pc2', 'eth0');
    });

    it('should deliver unicast frame from device1 to device2', () => {
      const receivedFrames: EthernetFrame[] = [];

      simulator.on('frameReceived', (event: { deviceId: string; frame: EthernetFrame }) => {
        if (event.deviceId === 'pc2') {
          receivedFrames.push(event.frame);
        }
      });

      // Create IPv4 packet
      const packet = new IPv4Packet({
        sourceIP: new IPAddress('192.168.1.1'),
        destinationIP: new IPAddress('192.168.1.2'),
        protocol: IPProtocol.ICMP,
        ttl: 64,
        payload: Buffer.from([0x08, 0x00]) // ICMP Echo Request
      });

      // Encapsulate in Ethernet frame
      const payload = packet.toBytes();
      const paddedPayload = Buffer.concat([payload, Buffer.alloc(Math.max(0, 46 - payload.length))]);

      const frame = new EthernetFrame({
        sourceMAC: device1MAC,
        destinationMAC: device2MAC,
        etherType: EtherType.IPv4,
        payload: paddedPayload
      });

      // Send frame from device1
      simulator.sendFrame('pc1', 'eth0', frame);

      // Verify frame was received
      expect(receivedFrames).toHaveLength(1);
      expect(receivedFrames[0].getSourceMAC().equals(device1MAC)).toBe(true);
      expect(receivedFrames[0].getDestinationMAC().equals(device2MAC)).toBe(true);
    });

    it('should broadcast ARP request to all devices', () => {
      const receivedFrames: EthernetFrame[] = [];

      simulator.on('frameReceived', (event: { deviceId: string; frame: EthernetFrame }) => {
        receivedFrames.push(event.frame);
      });

      // Create ARP request frame
      const frame = new EthernetFrame({
        sourceMAC: device1MAC,
        destinationMAC: MACAddress.BROADCAST,
        etherType: EtherType.ARP,
        payload: Buffer.alloc(46)
      });

      simulator.sendFrame('pc1', 'eth0', frame);

      // Verify broadcast was received by device2
      expect(receivedFrames).toHaveLength(1);
      expect(receivedFrames[0].isBroadcast()).toBe(true);
    });

    it('should track statistics correctly', () => {
      const frame = new EthernetFrame({
        sourceMAC: device1MAC,
        destinationMAC: device2MAC,
        etherType: EtherType.IPv4,
        payload: Buffer.alloc(46)
      });

      simulator.sendFrame('pc1', 'eth0', frame);
      simulator.sendFrame('pc1', 'eth0', frame);

      const stats = simulator.getStatistics();
      expect(stats.totalFrames).toBe(2);
      expect(stats.unicastFrames).toBe(2);
    });
  });

  describe('Scenario 2: ARP resolution between devices', () => {
    let arpService: ARPService;
    let device1IP: IPAddress;
    let device1MAC: MACAddress;
    let device2IP: IPAddress;
    let device2MAC: MACAddress;

    beforeEach(() => {
      arpService = new ARPService();

      device1IP = new IPAddress('192.168.1.1');
      device1MAC = new MACAddress('AA:BB:CC:DD:EE:01');

      device2IP = new IPAddress('192.168.1.2');
      device2MAC = new MACAddress('AA:BB:CC:DD:EE:02');
    });

    it('should perform complete ARP resolution flow', () => {
      // Device1 wants to communicate with Device2
      // Step 1: Device1 checks ARP cache - miss
      expect(arpService.resolve(device2IP)).toBeUndefined();

      // Step 2: Device1 creates ARP request
      const arpRequest = arpService.createRequest(device1IP, device1MAC, device2IP);

      expect(arpRequest.operation).toBe('request');
      expect(arpRequest.senderIP.equals(device1IP)).toBe(true);
      expect(arpRequest.senderMAC.equals(device1MAC)).toBe(true);
      expect(arpRequest.targetIP.equals(device2IP)).toBe(true);

      // Step 3: Device2 receives request and learns Device1's mapping
      arpService.processPacket(arpRequest);
      expect(arpService.resolve(device1IP)?.toString()).toBe(device1MAC.toString());

      // Step 4: Device2 creates ARP reply
      const arpReply = arpService.createReply(device2IP, device2MAC, device1IP, device1MAC);

      expect(arpReply.operation).toBe('reply');
      expect(arpReply.senderIP.equals(device2IP)).toBe(true);
      expect(arpReply.senderMAC.equals(device2MAC)).toBe(true);

      // Step 5: Device1 receives reply and learns Device2's mapping
      arpService.processPacket(arpReply);
      expect(arpService.resolve(device2IP)?.toString()).toBe(device2MAC.toString());

      // Step 6: Now Device1 can communicate directly (cache hit)
      const resolvedMAC = arpService.resolve(device2IP);
      expect(resolvedMAC).toBeDefined();
      expect(resolvedMAC?.equals(device2MAC)).toBe(true);
    });

    it('should handle ARP packet serialization/deserialization', () => {
      // Create ARP request
      const request = arpService.createRequest(device1IP, device1MAC, device2IP);

      // Serialize to bytes
      const bytes = arpService.serializePacket(request);
      expect(bytes).toBeInstanceOf(Buffer);
      expect(bytes.length).toBe(28);

      // Deserialize back
      const deserialized = arpService.deserializePacket(bytes);

      expect(deserialized.operation).toBe('request');
      expect(deserialized.senderIP.equals(device1IP)).toBe(true);
      expect(deserialized.senderMAC.equals(device1MAC)).toBe(true);
      expect(deserialized.targetIP.equals(device2IP)).toBe(true);
    });

    it('should handle gratuitous ARP for address announcement', () => {
      // Device1 announces its IP/MAC mapping
      const gratuitous = arpService.createGratuitousARP(device1IP, device1MAC);

      expect(arpService.isGratuitousARP(gratuitous)).toBe(true);
      expect(gratuitous.senderIP.equals(gratuitous.targetIP)).toBe(true);

      // Other devices process it
      arpService.processPacket(gratuitous);

      // Mapping should be cached
      expect(arpService.resolve(device1IP)?.equals(device1MAC)).toBe(true);
    });
  });

  describe('Scenario 3: MAC learning on switch', () => {
    let macTable: MACTableService;
    let forwarding: FrameForwardingService;
    let device1MAC: MACAddress;
    let device2MAC: MACAddress;
    let device3MAC: MACAddress;

    beforeEach(() => {
      macTable = new MACTableService();
      forwarding = new FrameForwardingService(macTable);

      device1MAC = new MACAddress('AA:BB:CC:DD:EE:01');
      device2MAC = new MACAddress('AA:BB:CC:DD:EE:02');
      device3MAC = new MACAddress('AA:BB:CC:DD:EE:03');

      // Configure switch with 3 ports
      forwarding.setPorts(['eth0', 'eth1', 'eth2']);
    });

    it('should learn MAC addresses as frames arrive', () => {
      // Initially, MAC table is empty
      expect(macTable.hasEntry(device1MAC)).toBe(false);

      // Frame arrives from Device1 on eth0
      const frame1 = new EthernetFrame({
        sourceMAC: device1MAC,
        destinationMAC: device2MAC,
        etherType: EtherType.IPv4,
        payload: Buffer.alloc(46)
      });

      const decision1 = forwarding.forward(frame1, 'eth0');

      // Device1's MAC should be learned on eth0
      expect(macTable.hasEntry(device1MAC)).toBe(true);
      expect(macTable.lookup(device1MAC)).toBe('eth0');

      // Device2 unknown - should flood
      expect(decision1.action).toBe('flood');
      expect(decision1.ports).toHaveLength(2); // eth1, eth2
    });

    it('should forward based on learned MACs', () => {
      // Frame from Device1 (eth0) to Device2 (unknown)
      const frame1 = new EthernetFrame({
        sourceMAC: device1MAC,
        destinationMAC: device2MAC,
        etherType: EtherType.IPv4,
        payload: Buffer.alloc(46)
      });

      forwarding.forward(frame1, 'eth0');

      // Frame from Device2 (eth1) back to Device1
      const frame2 = new EthernetFrame({
        sourceMAC: device2MAC,
        destinationMAC: device1MAC,
        etherType: EtherType.IPv4,
        payload: Buffer.alloc(46)
      });

      const decision2 = forwarding.forward(frame2, 'eth1');

      // Device2's MAC should be learned on eth1
      expect(macTable.lookup(device2MAC)).toBe('eth1');

      // Device1's MAC is known on eth0 - should forward directly
      expect(decision2.action).toBe('forward');
      expect(decision2.ports).toEqual(['eth0']);
    });

    it('should handle MAC address mobility (port change)', () => {
      // Device1 initially on eth0
      const frame1 = new EthernetFrame({
        sourceMAC: device1MAC,
        destinationMAC: device2MAC,
        etherType: EtherType.IPv4,
        payload: Buffer.alloc(46)
      });

      forwarding.forward(frame1, 'eth0');
      expect(macTable.lookup(device1MAC)).toBe('eth0');

      // Device1 moves to eth1
      const frame2 = new EthernetFrame({
        sourceMAC: device1MAC,
        destinationMAC: device2MAC,
        etherType: EtherType.IPv4,
        payload: Buffer.alloc(46)
      });

      forwarding.forward(frame2, 'eth1');
      expect(macTable.lookup(device1MAC)).toBe('eth1');

      // Statistics should track the move
      const macTableStats = macTable.getStatistics();
      expect(macTableStats.moves).toBe(1);
    });

    it('should filter frames when source and destination on same port', () => {
      // Learn both MACs on eth0
      macTable.learn(device1MAC, 'eth0');
      macTable.learn(device2MAC, 'eth0');

      // Frame from Device1 to Device2 (both on eth0)
      const frame = new EthernetFrame({
        sourceMAC: device1MAC,
        destinationMAC: device2MAC,
        etherType: EtherType.IPv4,
        payload: Buffer.alloc(46)
      });

      const decision = forwarding.forward(frame, 'eth0');

      // Should not forward (same segment)
      expect(decision.action).toBe('filter');
      expect(decision.ports).toEqual([]);
    });

    it('should flood broadcast and multicast frames', () => {
      // Broadcast frame
      const broadcast = new EthernetFrame({
        sourceMAC: device1MAC,
        destinationMAC: MACAddress.BROADCAST,
        etherType: EtherType.ARP,
        payload: Buffer.alloc(46)
      });

      const decision1 = forwarding.forward(broadcast, 'eth0');

      expect(decision1.action).toBe('flood');
      expect(decision1.ports).toHaveLength(2); // All ports except eth0

      // Multicast frame
      const multicast = new EthernetFrame({
        sourceMAC: device1MAC,
        destinationMAC: new MACAddress('01:00:5E:00:00:01'),
        etherType: EtherType.IPv4,
        payload: Buffer.alloc(46)
      });

      const decision2 = forwarding.forward(multicast, 'eth0');

      expect(decision2.action).toBe('flood');
      expect(decision2.ports).toHaveLength(2);
    });

    it('should track comprehensive statistics', () => {
      // Unicast frame
      const unicast = new EthernetFrame({
        sourceMAC: device1MAC,
        destinationMAC: device2MAC,
        etherType: EtherType.IPv4,
        payload: Buffer.alloc(46)
      });

      forwarding.forward(unicast, 'eth0');

      // Broadcast frame
      const broadcast = new EthernetFrame({
        sourceMAC: device1MAC,
        destinationMAC: MACAddress.BROADCAST,
        etherType: EtherType.ARP,
        payload: Buffer.alloc(46)
      });

      forwarding.forward(broadcast, 'eth0');

      // Multicast frame
      const multicast = new EthernetFrame({
        sourceMAC: device1MAC,
        destinationMAC: new MACAddress('01:00:5E:00:00:01'),
        etherType: EtherType.IPv4,
        payload: Buffer.alloc(46)
      });

      forwarding.forward(multicast, 'eth0');

      const forwardingStats = forwarding.getStatistics();
      expect(forwardingStats.totalFrames).toBe(3);
      expect(forwardingStats.unicastFrames).toBe(1);
      expect(forwardingStats.broadcastFrames).toBe(1);
      expect(forwardingStats.multicastFrames).toBe(1);
      expect(forwardingStats.floodedFrames).toBe(3); // Unknown unicast + broadcast + multicast

      const macTableStats = macTable.getStatistics();
      expect(macTableStats.tableSize).toBe(1); // Only device1MAC learned
      expect(macTableStats.learningCount).toBe(3); // Learned 3 times (same MAC)
    });

    it('should handle complete switch operation scenario', () => {
      // Initial state: empty MAC table
      expect(macTable.getStatistics().tableSize).toBe(0);

      // 1. Device1 sends to Device2 (both unknown)
      const frame1 = new EthernetFrame({
        sourceMAC: device1MAC,
        destinationMAC: device2MAC,
        etherType: EtherType.IPv4,
        payload: Buffer.alloc(46)
      });

      const decision1 = forwarding.forward(frame1, 'eth0');

      expect(decision1.action).toBe('flood'); // Device2 unknown
      expect(macTable.lookup(device1MAC)).toBe('eth0'); // Device1 learned

      // 2. Device2 replies to Device1
      const frame2 = new EthernetFrame({
        sourceMAC: device2MAC,
        destinationMAC: device1MAC,
        etherType: EtherType.IPv4,
        payload: Buffer.alloc(46)
      });

      const decision2 = forwarding.forward(frame2, 'eth1');

      expect(decision2.action).toBe('forward'); // Device1 known
      expect(decision2.ports).toEqual(['eth0']);
      expect(macTable.lookup(device2MAC)).toBe('eth1'); // Device2 learned

      // 3. Device1 sends to Device2 again
      const frame3 = new EthernetFrame({
        sourceMAC: device1MAC,
        destinationMAC: device2MAC,
        etherType: EtherType.IPv4,
        payload: Buffer.alloc(46)
      });

      const decision3 = forwarding.forward(frame3, 'eth0');

      expect(decision3.action).toBe('forward'); // Device2 now known
      expect(decision3.ports).toEqual(['eth1']);

      // 4. Device3 sends broadcast
      const frame4 = new EthernetFrame({
        sourceMAC: device3MAC,
        destinationMAC: MACAddress.BROADCAST,
        etherType: EtherType.ARP,
        payload: Buffer.alloc(46)
      });

      const decision4 = forwarding.forward(frame4, 'eth2');

      expect(decision4.action).toBe('flood');
      expect(decision4.ports).toHaveLength(2); // eth0, eth1
      expect(macTable.lookup(device3MAC)).toBe('eth2'); // Device3 learned

      // Final state: all 3 devices learned
      expect(macTable.getStatistics().tableSize).toBe(3);
    });
  });
});
