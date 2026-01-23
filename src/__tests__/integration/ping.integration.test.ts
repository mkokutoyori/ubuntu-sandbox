/**
 * Integration tests for ICMP ping
 * Tests end-to-end ping functionality across network devices
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { PC } from '@/domain/devices/PC';
import { Router } from '@/domain/devices/Router';
import { IPAddress } from '@/domain/network/value-objects/IPAddress';
import { SubnetMask } from '@/domain/network/value-objects/SubnetMask';
import { ICMPPacket, ICMPType } from '@/domain/network/entities/ICMPPacket';
import { IPv4Packet, IPProtocol } from '@/domain/network/entities/IPv4Packet';
import { EthernetFrame, EtherType } from '@/domain/network/entities/EthernetFrame';

describe('Ping Integration Tests', () => {
  describe('Scenario 1: Ping between two PCs on same network', () => {
    let pc1: PC;
    let pc2: PC;

    beforeEach(() => {
      // Topology: PC1 <---> PC2 (same subnet)
      pc1 = new PC('pc1', 'PC 1');
      pc2 = new PC('pc2', 'PC 2');

      // Configure IPs in same subnet
      pc1.setIPAddress('eth0', new IPAddress('192.168.1.10'), new SubnetMask('/24'));
      pc2.setIPAddress('eth0', new IPAddress('192.168.1.20'), new SubnetMask('/24'));

      // Power on
      pc1.powerOn();
      pc2.powerOn();

      // Setup ARP
      pc1.addARPEntry(new IPAddress('192.168.1.20'), pc2.getInterface('eth0')!.getMAC());
      pc2.addARPEntry(new IPAddress('192.168.1.10'), pc1.getInterface('eth0')!.getMAC());

      // Connect PCs (simulate direct connection)
      pc1.onFrameTransmit((frame) => {
        pc2.receiveFrame('eth0', frame);
      });

      pc2.onFrameTransmit((frame) => {
        pc1.receiveFrame('eth0', frame);
      });
    });

    it('should send Echo Request from PC1 to PC2', () => {
      const icmpService1 = pc1.getICMPService();

      // Create Echo Request
      const request = icmpService1.createEchoRequest(
        new IPAddress('192.168.1.20'),
        Buffer.from('ping data')
      );

      expect(request.isEchoRequest()).toBe(true);
      expect(request.getSequenceNumber()).toBe(1);
    });

    it('should automatically reply to Echo Request', () => {
      let replyReceived = false;
      let replyPacket: ICMPPacket | undefined;

      // Listen for frames on PC1
      pc1.onFrameReceive((frame) => {
        if (frame.getEtherType() === EtherType.IPv4) {
          const ipPacket = IPv4Packet.fromBytes(frame.getPayload());
          if (ipPacket.getProtocol() === IPProtocol.ICMP) {
            const icmp = ICMPPacket.fromBytes(ipPacket.getPayload());
            if (icmp.isEchoReply()) {
              replyReceived = true;
              replyPacket = icmp;
            }
          }
        }
      });

      // PC1 sends Echo Request to PC2
      const icmpService1 = pc1.getICMPService();
      const request = icmpService1.createEchoRequest(
        new IPAddress('192.168.1.20'),
        Buffer.from('ping data')
      );

      // Encapsulate and send
      const icmpBytes = request.toBytes();
      const ipPacket = new IPv4Packet({
        sourceIP: new IPAddress('192.168.1.10'),
        destinationIP: new IPAddress('192.168.1.20'),
        protocol: IPProtocol.ICMP,
        ttl: 64,
        payload: icmpBytes
      });

      const packetBytes = ipPacket.toBytes();
      const paddedPayload = Buffer.concat([
        packetBytes,
        Buffer.alloc(Math.max(0, 46 - packetBytes.length))
      ]);

      const frame = new EthernetFrame({
        sourceMAC: pc1.getInterface('eth0')!.getMAC(),
        destinationMAC: pc2.getInterface('eth0')!.getMAC(),
        etherType: EtherType.IPv4,
        payload: paddedPayload
      });

      pc1.sendFrame('eth0', frame);

      // Verify reply was received
      expect(replyReceived).toBe(true);
      expect(replyPacket).toBeDefined();
      expect(replyPacket!.getSequenceNumber()).toBe(request.getSequenceNumber());
      expect(replyPacket!.getIdentifier()).toBe(request.getIdentifier());
    });

    it('should track ping statistics', () => {
      const icmpService = pc1.getICMPService();

      // Send multiple requests
      icmpService.createEchoRequest(new IPAddress('192.168.1.20'), Buffer.from('ping1'));
      icmpService.createEchoRequest(new IPAddress('192.168.1.20'), Buffer.from('ping2'));
      icmpService.createEchoRequest(new IPAddress('192.168.1.20'), Buffer.from('ping3'));

      const stats = icmpService.getStatistics();
      expect(stats.requestsSent).toBe(3);
    });
  });

  describe('Scenario 2: Ping across router', () => {
    let pc1: PC;
    let pc2: PC;
    let router: Router;

    beforeEach(() => {
      // Topology: PC1 (192.168.1.10) -- Router -- PC2 (192.168.2.10)
      pc1 = new PC('pc1', 'PC 1');
      pc2 = new PC('pc2', 'PC 2');
      router = new Router('r1', 'Router 1', 2);

      // Configure PC1
      pc1.setIPAddress('eth0', new IPAddress('192.168.1.10'), new SubnetMask('/24'));
      pc1.setGateway(new IPAddress('192.168.1.1'));

      // Configure PC2
      pc2.setIPAddress('eth0', new IPAddress('192.168.2.10'), new SubnetMask('/24'));
      pc2.setGateway(new IPAddress('192.168.2.1'));

      // Configure Router
      router.setIPAddress('eth0', new IPAddress('192.168.1.1'), new SubnetMask('/24'));
      router.setIPAddress('eth1', new IPAddress('192.168.2.1'), new SubnetMask('/24'));

      // Power on
      pc1.powerOn();
      pc2.powerOn();
      router.powerOn();

      // Setup ARP
      pc1.addARPEntry(new IPAddress('192.168.1.1'), router.getInterface('eth0')!.getMAC());
      pc2.addARPEntry(new IPAddress('192.168.2.1'), router.getInterface('eth1')!.getMAC());
      router.addARPEntry('eth0', new IPAddress('192.168.1.10'), pc1.getInterface('eth0')!.getMAC());
      router.addARPEntry('eth1', new IPAddress('192.168.2.10'), pc2.getInterface('eth0')!.getMAC());

      // Connect topology
      pc1.onFrameTransmit((frame) => router.receiveFrame('eth0', frame));
      pc2.onFrameTransmit((frame) => router.receiveFrame('eth1', frame));

      router.onFrameTransmit((iface, frame) => {
        if (iface === 'eth0') pc1.receiveFrame('eth0', frame);
        if (iface === 'eth1') pc2.receiveFrame('eth0', frame);
      });
    });

    it('should ping across router with TTL decrement', () => {
      let replyReceived = false;
      let finalTTL = 0;

      // Listen for Echo Reply on PC1
      pc1.onFrameReceive((frame) => {
        if (frame.getEtherType() === EtherType.IPv4) {
          const ipPacket = IPv4Packet.fromBytes(frame.getPayload());
          if (ipPacket.getProtocol() === IPProtocol.ICMP) {
            const icmp = ICMPPacket.fromBytes(ipPacket.getPayload());
            if (icmp.isEchoReply()) {
              replyReceived = true;
              finalTTL = ipPacket.getTTL();
            }
          }
        }
      });

      // PC1 sends Echo Request to PC2 via router
      const request = pc1.getICMPService().createEchoRequest(
        new IPAddress('192.168.2.10'),
        Buffer.from('ping data')
      );

      const icmpBytes = request.toBytes();
      const ipPacket = new IPv4Packet({
        sourceIP: new IPAddress('192.168.1.10'),
        destinationIP: new IPAddress('192.168.2.10'),
        protocol: IPProtocol.ICMP,
        ttl: 64,
        payload: icmpBytes
      });

      const packetBytes = ipPacket.toBytes();
      const paddedPayload = Buffer.concat([
        packetBytes,
        Buffer.alloc(Math.max(0, 46 - packetBytes.length))
      ]);

      const frame = new EthernetFrame({
        sourceMAC: pc1.getInterface('eth0')!.getMAC(),
        destinationMAC: router.getInterface('eth0')!.getMAC(),
        etherType: EtherType.IPv4,
        payload: paddedPayload
      });

      pc1.sendFrame('eth0', frame);

      // Verify reply
      expect(replyReceived).toBe(true);
      // TTL should be decremented twice (once each way through router)
      expect(finalTTL).toBeLessThan(64);
    });
  });

  describe('Scenario 3: TTL expired generates ICMP Time Exceeded', () => {
    let pc1: PC;
    let pc2: PC;
    let router: Router;

    beforeEach(() => {
      pc1 = new PC('pc1', 'PC 1');
      pc2 = new PC('pc2', 'PC 2');
      router = new Router('r1', 'Router 1', 2);

      pc1.setIPAddress('eth0', new IPAddress('192.168.1.10'), new SubnetMask('/24'));
      router.setIPAddress('eth0', new IPAddress('192.168.1.1'), new SubnetMask('/24'));
      router.setIPAddress('eth1', new IPAddress('192.168.2.1'), new SubnetMask('/24'));

      pc1.powerOn();
      router.powerOn();

      // Setup ARP
      pc1.addARPEntry(new IPAddress('192.168.1.1'), router.getInterface('eth0')!.getMAC());
      router.addARPEntry('eth0', new IPAddress('192.168.1.10'), pc1.getInterface('eth0')!.getMAC());

      // Connect
      pc1.onFrameTransmit((frame) => router.receiveFrame('eth0', frame));
      router.onFrameTransmit((iface, frame) => {
        if (iface === 'eth0') pc1.receiveFrame('eth0', frame);
      });
    });

    it('should receive ICMP Time Exceeded when TTL expires', () => {
      let timeExceededReceived = false;

      // Listen for Time Exceeded on PC1
      pc1.onFrameReceive((frame) => {
        if (frame.getEtherType() === EtherType.IPv4) {
          const ipPacket = IPv4Packet.fromBytes(frame.getPayload());
          if (ipPacket.getProtocol() === IPProtocol.ICMP) {
            const icmp = ICMPPacket.fromBytes(ipPacket.getPayload());
            if (icmp.isTimeExceeded()) {
              timeExceededReceived = true;
            }
          }
        }
      });

      // Send packet with TTL = 1 (will expire at router)
      const request = pc1.getICMPService().createEchoRequest(
        new IPAddress('192.168.2.10'),
        Buffer.from('ping')
      );

      const icmpBytes = request.toBytes();
      const ipPacket = new IPv4Packet({
        sourceIP: new IPAddress('192.168.1.10'),
        destinationIP: new IPAddress('192.168.2.10'),
        protocol: IPProtocol.ICMP,
        ttl: 1, // Will expire at router
        payload: icmpBytes
      });

      const packetBytes = ipPacket.toBytes();
      const paddedPayload = Buffer.concat([
        packetBytes,
        Buffer.alloc(Math.max(0, 46 - packetBytes.length))
      ]);

      const frame = new EthernetFrame({
        sourceMAC: pc1.getInterface('eth0')!.getMAC(),
        destinationMAC: router.getInterface('eth0')!.getMAC(),
        etherType: EtherType.IPv4,
        payload: paddedPayload
      });

      pc1.sendFrame('eth0', frame);

      // Verify Time Exceeded was received
      expect(timeExceededReceived).toBe(true);
    });
  });
});
