/**
 * Complex Network Integration Tests
 * Tests realistic multi-device network scenarios
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/domain/devices/LinuxPC';
import { WindowsPC } from '@/domain/devices/WindowsPC';
import { Router } from '@/domain/devices/Router';
import { Switch } from '@/domain/devices/Switch';
import { IPAddress } from '@/domain/network/value-objects/IPAddress';
import { SubnetMask } from '@/domain/network/value-objects/SubnetMask';
import { EthernetFrame, EtherType } from '@/domain/network/entities/EthernetFrame';
import { IPv4Packet, IPProtocol } from '@/domain/network/entities/IPv4Packet';
import { ICMPPacket, ICMPType } from '@/domain/network/entities/ICMPPacket';

describe('Complex Network Integration', () => {
  describe('Corporate Office Network', () => {
    /*
     * Topology:
     *   IT Department (192.168.1.0/24)
     *     PC1 (Linux) - .10
     *     PC2 (Windows) - .20
     *     SW1 (Switch)
     *
     *   Router (Core)
     *     eth0: 192.168.1.1
     *     eth1: 192.168.2.1
     *
     *   Sales Department (192.168.2.0/24)
     *     PC3 (Linux) - .10
     *     PC4 (Windows) - .20
     *     SW2 (Switch)
     */

    let pc1: LinuxPC;
    let pc2: WindowsPC;
    let sw1: Switch;
    let router: Router;
    let pc3: LinuxPC;
    let pc4: WindowsPC;
    let sw2: Switch;

    beforeEach(() => {
      // IT Department
      pc1 = new LinuxPC({ id: 'pc1', name: 'IT-Linux-01' });
      pc2 = new WindowsPC({ id: 'pc2', name: 'IT-Windows-01' });
      sw1 = new Switch('sw1', 'IT-Switch', 8);

      // Core Router
      router = new Router('r1', 'Core-Router', 2);

      // Sales Department
      pc3 = new LinuxPC({ id: 'pc3', name: 'Sales-Linux-01' });
      pc4 = new WindowsPC({ id: 'pc4', name: 'Sales-Windows-01' });
      sw2 = new Switch('sw2', 'Sales-Switch', 8);

      // Configure IT Department
      pc1.setIPAddress('eth0', new IPAddress('192.168.1.10'), new SubnetMask('/24'));
      pc1.setGateway(new IPAddress('192.168.1.1'));

      pc2.setIPAddress('eth0', new IPAddress('192.168.1.20'), new SubnetMask('/24'));
      pc2.setGateway(new IPAddress('192.168.1.1'));

      // Configure Router
      router.setIPAddress('eth0', new IPAddress('192.168.1.1'), new SubnetMask('/24'));
      router.setIPAddress('eth1', new IPAddress('192.168.2.1'), new SubnetMask('/24'));

      // Configure Sales Department
      pc3.setIPAddress('eth0', new IPAddress('192.168.2.10'), new SubnetMask('/24'));
      pc3.setGateway(new IPAddress('192.168.2.1'));

      pc4.setIPAddress('eth0', new IPAddress('192.168.2.20'), new SubnetMask('/24'));
      pc4.setGateway(new IPAddress('192.168.2.1'));

      // Power on all devices
      pc1.powerOn();
      pc2.powerOn();
      sw1.powerOn();
      router.powerOn();
      pc3.powerOn();
      pc4.powerOn();
      sw2.powerOn();

      // Setup ARP tables
      // IT Department
      pc1.addARPEntry(new IPAddress('192.168.1.1'), router.getInterface('eth0')!.getMAC());
      pc1.addARPEntry(new IPAddress('192.168.1.20'), pc2.getInterface('eth0')!.getMAC());
      pc2.addARPEntry(new IPAddress('192.168.1.1'), router.getInterface('eth0')!.getMAC());
      pc2.addARPEntry(new IPAddress('192.168.1.10'), pc1.getInterface('eth0')!.getMAC());
      router.addARPEntry('eth0', new IPAddress('192.168.1.10'), pc1.getInterface('eth0')!.getMAC());
      router.addARPEntry('eth0', new IPAddress('192.168.1.20'), pc2.getInterface('eth0')!.getMAC());

      // Sales Department
      pc3.addARPEntry(new IPAddress('192.168.2.1'), router.getInterface('eth1')!.getMAC());
      pc3.addARPEntry(new IPAddress('192.168.2.20'), pc4.getInterface('eth0')!.getMAC());
      pc4.addARPEntry(new IPAddress('192.168.2.1'), router.getInterface('eth1')!.getMAC());
      pc4.addARPEntry(new IPAddress('192.168.2.10'), pc3.getInterface('eth0')!.getMAC());
      router.addARPEntry('eth1', new IPAddress('192.168.2.10'), pc3.getInterface('eth0')!.getMAC());
      router.addARPEntry('eth1', new IPAddress('192.168.2.20'), pc4.getInterface('eth0')!.getMAC());

      // Connect topology
      // IT Department to Router
      pc1.onFrameTransmit((frame) => sw1.receiveFrame('eth0', frame));
      pc2.onFrameTransmit((frame) => sw1.receiveFrame('eth1', frame));
      sw1.onFrameForward((port, frame) => {
        if (port === 'eth0') pc1.receiveFrame('eth0', frame);
        if (port === 'eth1') pc2.receiveFrame('eth0', frame);
        if (port === 'eth7') router.receiveFrame('eth0', frame);
      });

      // Router to switches
      router.onFrameTransmit((iface, frame) => {
        if (iface === 'eth0') sw1.receiveFrame('eth7', frame);
        if (iface === 'eth1') sw2.receiveFrame('eth7', frame);
      });

      // Sales Department to Router
      pc3.onFrameTransmit((frame) => sw2.receiveFrame('eth0', frame));
      pc4.onFrameTransmit((frame) => sw2.receiveFrame('eth1', frame));
      sw2.onFrameForward((port, frame) => {
        if (port === 'eth0') pc3.receiveFrame('eth0', frame);
        if (port === 'eth1') pc4.receiveFrame('eth0', frame);
        if (port === 'eth7') router.receiveFrame('eth1', frame);
      });
    });

    it('should allow same-department communication (IT)', () => {
      let pc2Received = false;

      // PC2 listens for frames
      pc2.onFrameReceive(() => {
        pc2Received = true;
      });

      // PC1 sends to PC2 (same network)
      const data = Buffer.from('Hello from IT-Linux to IT-Windows');
      const ipPacket = new IPv4Packet({
        sourceIP: new IPAddress('192.168.1.10'),
        destinationIP: new IPAddress('192.168.1.20'),
        protocol: IPProtocol.ICMP,
        ttl: 64,
        payload: data
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

      expect(pc2Received).toBe(true);
    });

    it('should allow cross-department communication (IT to Sales)', () => {
      let pc3Received = false;
      let receivedSourceIP: string | undefined;

      // PC3 listens for ICMP packets
      pc3.onFrameReceive((frame) => {
        if (frame.getEtherType() === EtherType.IPv4) {
          const ipPacket = IPv4Packet.fromBytes(frame.getPayload());
          if (ipPacket.getProtocol() === IPProtocol.ICMP) {
            pc3Received = true;
            receivedSourceIP = ipPacket.getSourceIP().toString();
          }
        }
      });

      // PC1 (IT) pings PC3 (Sales)
      const icmpPacket = new ICMPPacket({
        type: ICMPType.ECHO_REQUEST,
        code: 0,
        identifier: 1,
        sequenceNumber: 1,
        data: Buffer.from('ping')
      });
      const ipPacket = new IPv4Packet({
        sourceIP: new IPAddress('192.168.1.10'),
        destinationIP: new IPAddress('192.168.2.10'),
        protocol: IPProtocol.ICMP,
        ttl: 64,
        payload: icmpPacket.toBytes()
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

      expect(pc3Received).toBe(true);
      expect(receivedSourceIP).toBe('192.168.1.10');
    });

    it('should isolate departments with switch learning', () => {
      // PC1 sends to PC2 (both on SW1)
      const testData = Buffer.from('test');
      const paddedPayload = Buffer.concat([
        testData,
        Buffer.alloc(Math.max(0, 46 - testData.length))
      ]);

      const frame = new EthernetFrame({
        sourceMAC: pc1.getInterface('eth0')!.getMAC(),
        destinationMAC: pc2.getInterface('eth0')!.getMAC(),
        etherType: EtherType.IPv4,
        payload: paddedPayload
      });

      pc1.sendFrame('eth0', frame);

      // Check that SW1 learned MAC addresses
      const macTableService = sw1.getMACTable();
      const pc1MAC = pc1.getInterface('eth0')!.getMAC();

      // Verify MAC was learned by checking if we can get entry
      const entry = macTableService.getEntry(pc1MAC);
      expect(entry).toBeDefined();
      expect(entry?.port).toBe('eth0');
    });

    it('should handle TTL expiration with ICMP Time Exceeded', () => {
      let timeExceededReceived = false;

      // PC1 listens for Time Exceeded
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

      // Send packet with TTL=1 (will expire at router)
      const icmpPacket = new ICMPPacket({
        type: ICMPType.ECHO_REQUEST,
        code: 0,
        identifier: 1,
        sequenceNumber: 1,
        data: Buffer.from('test')
      });
      const ipPacket = new IPv4Packet({
        sourceIP: new IPAddress('192.168.1.10'),
        destinationIP: new IPAddress('192.168.2.10'),
        protocol: IPProtocol.ICMP,
        ttl: 1,
        payload: icmpPacket.toBytes()
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

      expect(timeExceededReceived).toBe(true);
    });

    it('should support mixed OS communication (Linux to Windows)', () => {
      let pc4Received = false;

      // PC4 (Windows) listens
      pc4.onFrameReceive((frame) => {
        if (frame.getEtherType() === EtherType.IPv4) {
          pc4Received = true;
        }
      });

      // PC1 (Linux) sends to PC4 (Windows) across departments
      const icmpPacket = new ICMPPacket({
        type: ICMPType.ECHO_REQUEST,
        code: 0,
        identifier: 1,
        sequenceNumber: 1,
        data: Buffer.from('cross-os')
      });
      const ipPacket = new IPv4Packet({
        sourceIP: new IPAddress('192.168.1.10'),
        destinationIP: new IPAddress('192.168.2.20'),
        protocol: IPProtocol.ICMP,
        ttl: 64,
        payload: icmpPacket.toBytes()
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

      expect(pc4Received).toBe(true);
    });
  });

  describe('Multi-router Cascade', () => {
    it('should route through multiple routers', () => {
      // PC1 -- R1 -- R2 -- PC2
      const pc1 = new LinuxPC({ id: 'pc1', name: 'PC1' });
      const r1 = new Router('r1', 'Router1', 2);
      const r2 = new Router('r2', 'Router2', 2);
      const pc2 = new LinuxPC({ id: 'pc2', name: 'PC2' });

      // Configure network 1: 192.168.1.0/24
      pc1.setIPAddress('eth0', new IPAddress('192.168.1.10'), new SubnetMask('/24'));
      pc1.setGateway(new IPAddress('192.168.1.1'));
      r1.setIPAddress('eth0', new IPAddress('192.168.1.1'), new SubnetMask('/24'));

      // Transit network: 10.0.0.0/30
      r1.setIPAddress('eth1', new IPAddress('10.0.0.1'), new SubnetMask('/30'));
      r2.setIPAddress('eth0', new IPAddress('10.0.0.2'), new SubnetMask('/30'));

      // Configure network 2: 192.168.2.0/24
      r2.setIPAddress('eth1', new IPAddress('192.168.2.1'), new SubnetMask('/24'));
      pc2.setIPAddress('eth0', new IPAddress('192.168.2.10'), new SubnetMask('/24'));
      pc2.setGateway(new IPAddress('192.168.2.1'));

      // Add routes
      r1.addRoute(new IPAddress('192.168.2.0'), new SubnetMask('/24'), new IPAddress('10.0.0.2'), 'eth1');
      r2.addRoute(new IPAddress('192.168.1.0'), new SubnetMask('/24'), new IPAddress('10.0.0.1'), 'eth0');

      // Power on
      pc1.powerOn();
      r1.powerOn();
      r2.powerOn();
      pc2.powerOn();

      // Setup ARP
      pc1.addARPEntry(new IPAddress('192.168.1.1'), r1.getInterface('eth0')!.getMAC());
      r1.addARPEntry('eth0', new IPAddress('192.168.1.10'), pc1.getInterface('eth0')!.getMAC());
      r1.addARPEntry('eth1', new IPAddress('10.0.0.2'), r2.getInterface('eth0')!.getMAC());
      r2.addARPEntry('eth0', new IPAddress('10.0.0.1'), r1.getInterface('eth1')!.getMAC());
      r2.addARPEntry('eth1', new IPAddress('192.168.2.10'), pc2.getInterface('eth0')!.getMAC());
      pc2.addARPEntry(new IPAddress('192.168.2.1'), r2.getInterface('eth1')!.getMAC());

      // Connect topology
      pc1.onFrameTransmit((frame) => r1.receiveFrame('eth0', frame));
      r1.onFrameTransmit((iface, frame) => {
        if (iface === 'eth0') pc1.receiveFrame('eth0', frame);
        if (iface === 'eth1') r2.receiveFrame('eth0', frame);
      });
      r2.onFrameTransmit((iface, frame) => {
        if (iface === 'eth0') r1.receiveFrame('eth1', frame);
        if (iface === 'eth1') pc2.receiveFrame('eth0', frame);
      });
      pc2.onFrameTransmit((frame) => r2.receiveFrame('eth1', frame));

      // Test
      let pc2Received = false;
      pc2.onFrameReceive(() => { pc2Received = true; });

      const icmpPacket = new ICMPPacket({
        type: ICMPType.ECHO_REQUEST,
        code: 0,
        identifier: 1,
        sequenceNumber: 1,
        data: Buffer.from('test')
      });
      const ipPacket = new IPv4Packet({
        sourceIP: new IPAddress('192.168.1.10'),
        destinationIP: new IPAddress('192.168.2.10'),
        protocol: IPProtocol.ICMP,
        ttl: 64,
        payload: icmpPacket.toBytes()
      });

      const packetBytes = ipPacket.toBytes();
      const paddedPayload = Buffer.concat([
        packetBytes,
        Buffer.alloc(Math.max(0, 46 - packetBytes.length))
      ]);

      const frame = new EthernetFrame({
        sourceMAC: pc1.getInterface('eth0')!.getMAC(),
        destinationMAC: r1.getInterface('eth0')!.getMAC(),
        etherType: EtherType.IPv4,
        payload: paddedPayload
      });

      pc1.sendFrame('eth0', frame);

      expect(pc2Received).toBe(true);
    });
  });
});
