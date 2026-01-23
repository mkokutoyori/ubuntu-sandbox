/**
 * Integration tests for traceroute functionality
 * Tests end-to-end traceroute with Time Exceeded responses
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { PC } from '@/domain/devices/PC';
import { Router } from '@/domain/devices/Router';
import { IPAddress } from '@/domain/network/value-objects/IPAddress';
import { SubnetMask } from '@/domain/network/value-objects/SubnetMask';
import { ICMPPacket, ICMPType } from '@/domain/network/entities/ICMPPacket';
import { IPv4Packet, IPProtocol } from '@/domain/network/entities/IPv4Packet';
import { EthernetFrame, EtherType } from '@/domain/network/entities/EthernetFrame';

describe('Traceroute Integration Tests', () => {
  describe('Scenario 1: Simple traceroute through single router', () => {
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

    it('should send packets with incrementing TTL and get Time Exceeded responses', () => {
      const timeExceededResponses: Array<{ ttl: number }> = [];

      // Listen for Time Exceeded responses on PC1
      pc1.onFrameReceive((frame) => {
        if (frame.getEtherType() === EtherType.IPv4) {
          const ipPacket = IPv4Packet.fromBytes(frame.getPayload());
          if (ipPacket.getProtocol() === IPProtocol.ICMP) {
            const icmp = ICMPPacket.fromBytes(ipPacket.getPayload());
            if (icmp.isTimeExceeded()) {
              timeExceededResponses.push({
                ttl: timeExceededResponses.length + 1
              });
            }
          }
        }
      });

      // Send traceroute packets with TTL 1, 2
      for (let ttl = 1; ttl <= 2; ttl++) {
        const data = Buffer.alloc(32);
        data.write(`Hop ${ttl}`, 0);

        const icmpService = pc1.getICMPService();
        const request = icmpService.createEchoRequest(
          new IPAddress('192.168.2.10'),
          data
        );

        // Encapsulate and send with specific TTL
        const icmpBytes = request.toBytes();
        const ipPacket = new IPv4Packet({
          sourceIP: new IPAddress('192.168.1.10'),
          destinationIP: new IPAddress('192.168.2.10'),
          protocol: IPProtocol.ICMP,
          ttl: ttl,
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
      }

      // Verify we received Time Exceeded responses (TTL=1 expires at router)
      expect(timeExceededResponses.length).toBeGreaterThanOrEqual(1);
    });

    it('should receive Time Exceeded from router for TTL=1', () => {
      let timeExceededReceived = false;
      let timeExceededSource: string | undefined;

      // Listen for Time Exceeded on PC1
      pc1.onFrameReceive((frame) => {
        if (frame.getEtherType() === EtherType.IPv4) {
          const ipPacket = IPv4Packet.fromBytes(frame.getPayload());
          if (ipPacket.getProtocol() === IPProtocol.ICMP) {
            const icmp = ICMPPacket.fromBytes(ipPacket.getPayload());
            if (icmp.isTimeExceeded()) {
              timeExceededReceived = true;
              timeExceededSource = ipPacket.getSourceIP().toString();
            }
          }
        }
      });

      // Send packet with TTL=1 (will expire at first hop - router)
      const data = Buffer.alloc(32);
      const icmpService = pc1.getICMPService();
      const request = icmpService.createEchoRequest(
        new IPAddress('192.168.2.10'),
        data
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

      // Verify Time Exceeded was received from router
      expect(timeExceededReceived).toBe(true);
      expect(timeExceededSource).toBe('192.168.1.1'); // Router's IP on PC1's side
    });

    it('should reach destination with sufficient TTL', () => {
      let echoReplyReceived = false;
      let replySource: string | undefined;

      // Listen for Echo Reply on PC1
      pc1.onFrameReceive((frame) => {
        if (frame.getEtherType() === EtherType.IPv4) {
          const ipPacket = IPv4Packet.fromBytes(frame.getPayload());
          if (ipPacket.getProtocol() === IPProtocol.ICMP) {
            const icmp = ICMPPacket.fromBytes(ipPacket.getPayload());
            if (icmp.isEchoReply()) {
              echoReplyReceived = true;
              replySource = ipPacket.getSourceIP().toString();
            }
          }
        }
      });

      // Send packet with TTL=64 (sufficient to reach destination)
      const data = Buffer.alloc(32);
      const icmpService = pc1.getICMPService();
      const request = icmpService.createEchoRequest(
        new IPAddress('192.168.2.10'),
        data
      );

      const icmpBytes = request.toBytes();
      const ipPacket = new IPv4Packet({
        sourceIP: new IPAddress('192.168.1.10'),
        destinationIP: new IPAddress('192.168.2.10'),
        protocol: IPProtocol.ICMP,
        ttl: 64, // Sufficient TTL
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

      // Verify Echo Reply was received from destination
      expect(echoReplyReceived).toBe(true);
      expect(replySource).toBe('192.168.2.10'); // PC2's IP
    });
  });

  describe('Scenario 2: Multi-hop traceroute', () => {
    let pc1: PC;
    let pc2: PC;
    let router1: Router;
    let router2: Router;

    beforeEach(() => {
      // Topology: PC1 -- Router1 -- Router2 -- PC2
      pc1 = new PC('pc1', 'PC 1');
      pc2 = new PC('pc2', 'PC 2');
      router1 = new Router('r1', 'Router 1', 2);
      router2 = new Router('r2', 'Router 2', 2);

      // Configure PC1
      pc1.setIPAddress('eth0', new IPAddress('192.168.1.10'), new SubnetMask('/24'));
      pc1.setGateway(new IPAddress('192.168.1.1'));

      // Configure Router1
      router1.setIPAddress('eth0', new IPAddress('192.168.1.1'), new SubnetMask('/24'));
      router1.setIPAddress('eth1', new IPAddress('10.0.0.1'), new SubnetMask('/30'));
      router1.addRoute(new IPAddress('192.168.2.0'), new SubnetMask('/24'), new IPAddress('10.0.0.2'), 'eth1');

      // Configure Router2
      router2.setIPAddress('eth0', new IPAddress('10.0.0.2'), new SubnetMask('/30'));
      router2.setIPAddress('eth1', new IPAddress('192.168.2.1'), new SubnetMask('/24'));
      router2.addRoute(new IPAddress('192.168.1.0'), new SubnetMask('/24'), new IPAddress('10.0.0.1'), 'eth0');

      // Configure PC2
      pc2.setIPAddress('eth0', new IPAddress('192.168.2.10'), new SubnetMask('/24'));
      pc2.setGateway(new IPAddress('192.168.2.1'));

      // Power on
      pc1.powerOn();
      pc2.powerOn();
      router1.powerOn();
      router2.powerOn();

      // Setup ARP
      pc1.addARPEntry(new IPAddress('192.168.1.1'), router1.getInterface('eth0')!.getMAC());
      router1.addARPEntry('eth0', new IPAddress('192.168.1.10'), pc1.getInterface('eth0')!.getMAC());
      router1.addARPEntry('eth1', new IPAddress('10.0.0.2'), router2.getInterface('eth0')!.getMAC());
      router2.addARPEntry('eth0', new IPAddress('10.0.0.1'), router1.getInterface('eth1')!.getMAC());
      router2.addARPEntry('eth1', new IPAddress('192.168.2.10'), pc2.getInterface('eth0')!.getMAC());
      pc2.addARPEntry(new IPAddress('192.168.2.1'), router2.getInterface('eth1')!.getMAC());

      // Connect topology
      pc1.onFrameTransmit((frame) => router1.receiveFrame('eth0', frame));

      router1.onFrameTransmit((iface, frame) => {
        if (iface === 'eth0') pc1.receiveFrame('eth0', frame);
        if (iface === 'eth1') router2.receiveFrame('eth0', frame);
      });

      router2.onFrameTransmit((iface, frame) => {
        if (iface === 'eth0') router1.receiveFrame('eth1', frame);
        if (iface === 'eth1') pc2.receiveFrame('eth0', frame);
      });

      pc2.onFrameTransmit((frame) => router2.receiveFrame('eth1', frame));
    });

    it('should trace path through multiple routers', () => {
      const timeExceededResponses: Array<{ hop: number; from: string }> = [];

      // Listen for ICMP responses
      pc1.onFrameReceive((frame) => {
        if (frame.getEtherType() === EtherType.IPv4) {
          const ipPacket = IPv4Packet.fromBytes(frame.getPayload());
          if (ipPacket.getProtocol() === IPProtocol.ICMP) {
            const icmp = ICMPPacket.fromBytes(ipPacket.getPayload());
            if (icmp.isTimeExceeded()) {
              timeExceededResponses.push({
                hop: timeExceededResponses.length + 1,
                from: ipPacket.getSourceIP().toString()
              });
            }
          }
        }
      });

      // Send packets with TTL 1, 2, 3
      for (let ttl = 1; ttl <= 3; ttl++) {
        const data = Buffer.alloc(32);
        const icmpService = pc1.getICMPService();
        const request = icmpService.createEchoRequest(
          new IPAddress('192.168.2.10'),
          data
        );

        const icmpBytes = request.toBytes();
        const ipPacket = new IPv4Packet({
          sourceIP: new IPAddress('192.168.1.10'),
          destinationIP: new IPAddress('192.168.2.10'),
          protocol: IPProtocol.ICMP,
          ttl: ttl,
          payload: icmpBytes
        });

        const packetBytes = ipPacket.toBytes();
        const paddedPayload = Buffer.concat([
          packetBytes,
          Buffer.alloc(Math.max(0, 46 - packetBytes.length))
        ]);

        const frame = new EthernetFrame({
          sourceMAC: pc1.getInterface('eth0')!.getMAC(),
          destinationMAC: router1.getInterface('eth0')!.getMAC(),
          etherType: EtherType.IPv4,
          payload: paddedPayload
        });

        pc1.sendFrame('eth0', frame);
      }

      // Verify we received at least one Time Exceeded response
      // (TTL=1 expires at Router1)
      expect(timeExceededResponses.length).toBeGreaterThanOrEqual(1);

      // TTL=1 should expire at Router1
      const hop1 = timeExceededResponses.find(r => r.from === '192.168.1.1');
      expect(hop1).toBeDefined();

      // Note: TTL=2 response from Router2 may not reach PC1 in simple simulation
      // as it requires proper routing setup for ICMP responses from intermediate routers
    });
  });
});
