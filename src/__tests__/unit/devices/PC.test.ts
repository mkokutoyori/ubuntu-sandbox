/**
 * Unit tests for PC device
 * Following TDD approach - tests written first
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { PC } from '@/domain/devices/PC';
import { MACAddress } from '@/domain/network/value-objects/MACAddress';
import { IPAddress } from '@/domain/network/value-objects/IPAddress';
import { SubnetMask } from '@/domain/network/value-objects/SubnetMask';
import { EthernetFrame, EtherType } from '@/domain/network/entities/EthernetFrame';

describe('PC', () => {
  let pc: PC;

  beforeEach(() => {
    pc = new PC('pc1', 'PC 1');
  });

  describe('construction', () => {
    it('should create PC with id and name', () => {
      expect(pc.getId()).toBe('pc1');
      expect(pc.getName()).toBe('PC 1');
      expect(pc.getType()).toBe('pc');
    });

    it('should have one network interface (eth0)', () => {
      expect(pc.hasInterface('eth0')).toBe(true);
    });

    it('should generate random MAC address for interface', () => {
      const iface = pc.getInterface('eth0');
      expect(iface).toBeDefined();
      expect(iface!.getMAC()).toBeDefined();
    });
  });

  describe('power management', () => {
    it('should power on PC', () => {
      pc.powerOn();

      expect(pc.getStatus()).toBe('online');
      expect(pc.isOnline()).toBe(true);
    });

    it('should bring up network interface when powered on', () => {
      pc.powerOn();

      const iface = pc.getInterface('eth0');
      expect(iface!.isUp()).toBe(true);
    });

    it('should power off PC', () => {
      pc.powerOn();
      pc.powerOff();

      expect(pc.getStatus()).toBe('offline');
    });

    it('should bring down network interface when powered off', () => {
      pc.powerOn();
      pc.powerOff();

      const iface = pc.getInterface('eth0');
      expect(iface!.isUp()).toBe(false);
    });

    it('should reset PC', () => {
      pc.powerOn();
      pc.reset();

      expect(pc.getStatus()).toBe('online');
    });
  });

  describe('network configuration', () => {
    it('should configure IP address on interface', () => {
      const ip = new IPAddress('192.168.1.10');
      const mask = new SubnetMask('255.255.255.0');

      pc.setIPAddress('eth0', ip, mask);

      const iface = pc.getInterface('eth0');
      expect(iface!.getIPAddress()?.equals(ip)).toBe(true);
      expect(iface!.getSubnetMask()?.equals(mask)).toBe(true);
    });

    it('should set default gateway', () => {
      const gateway = new IPAddress('192.168.1.1');

      pc.setGateway(gateway);

      const iface = pc.getInterface('eth0');
      expect(iface!.getGateway()?.equals(gateway)).toBe(true);
    });

    it('should throw error for non-existent interface', () => {
      const ip = new IPAddress('192.168.1.10');
      const mask = new SubnetMask('/24');

      expect(() => pc.setIPAddress('eth99', ip, mask)).toThrow('Interface not found');
    });
  });

  describe('interface management', () => {
    it('should get interface by name', () => {
      const iface = pc.getInterface('eth0');

      expect(iface).toBeDefined();
      expect(iface!.getName()).toBe('eth0');
    });

    it('should return undefined for non-existent interface', () => {
      const iface = pc.getInterface('eth99');

      expect(iface).toBeUndefined();
    });

    it('should check if interface exists', () => {
      expect(pc.hasInterface('eth0')).toBe(true);
      expect(pc.hasInterface('eth1')).toBe(false);
    });

    it('should list all interfaces', () => {
      const interfaces = pc.getInterfaces();

      expect(interfaces).toHaveLength(1);
      expect(interfaces[0].getName()).toBe('eth0');
    });
  });

  describe('ARP functionality', () => {
    beforeEach(() => {
      pc.powerOn();
      pc.setIPAddress('eth0', new IPAddress('192.168.1.10'), new SubnetMask('/24'));
    });

    it('should create ARP request for IP address', () => {
      const targetIP = new IPAddress('192.168.1.20');

      const arpPacket = pc.createARPRequest(targetIP);

      expect(arpPacket.operation).toBe('request');
      expect(arpPacket.targetIP.equals(targetIP)).toBe(true);
      expect(arpPacket.senderIP.equals(new IPAddress('192.168.1.10'))).toBe(true);
    });

    it('should resolve IP to MAC from ARP cache', () => {
      const targetIP = new IPAddress('192.168.1.20');
      const targetMAC = new MACAddress('00:11:22:33:44:55');

      // Manually add to cache (simulating ARP reply)
      pc.addARPEntry(targetIP, targetMAC);

      const resolvedMAC = pc.resolveMAC(targetIP);

      expect(resolvedMAC).toBeDefined();
      expect(resolvedMAC!.equals(targetMAC)).toBe(true);
    });

    it('should return undefined when MAC not in ARP cache', () => {
      const targetIP = new IPAddress('192.168.1.20');

      const resolvedMAC = pc.resolveMAC(targetIP);

      expect(resolvedMAC).toBeUndefined();
    });

    it('should process ARP reply and update cache', () => {
      const arpReply = {
        operation: 'reply' as const,
        senderIP: new IPAddress('192.168.1.20'),
        senderMAC: new MACAddress('00:11:22:33:44:55'),
        targetIP: new IPAddress('192.168.1.10'),
        targetMAC: pc.getInterface('eth0')!.getMAC()
      };

      pc.processARPPacket(arpReply);

      const resolvedMAC = pc.resolveMAC(new IPAddress('192.168.1.20'));
      expect(resolvedMAC!.equals(new MACAddress('00:11:22:33:44:55'))).toBe(true);
    });
  });

  describe('frame transmission', () => {
    beforeEach(() => {
      pc.powerOn();
    });

    it('should send frame on interface', () => {
      let sentFrame: EthernetFrame | undefined;

      pc.onFrameTransmit((frame) => {
        sentFrame = frame;
      });

      const frame = new EthernetFrame({
        sourceMAC: pc.getInterface('eth0')!.getMAC(),
        destinationMAC: new MACAddress('00:11:22:33:44:55'),
        etherType: EtherType.IPv4,
        payload: Buffer.alloc(46)
      });

      pc.sendFrame('eth0', frame);

      expect(sentFrame).toBeDefined();
      expect(sentFrame!.getSourceMAC().equals(pc.getInterface('eth0')!.getMAC())).toBe(true);
    });

    it('should throw error when sending on non-existent interface', () => {
      const frame = new EthernetFrame({
        sourceMAC: pc.getInterface('eth0')!.getMAC(),
        destinationMAC: new MACAddress('00:11:22:33:44:55'),
        etherType: EtherType.IPv4,
        payload: Buffer.alloc(46)
      });

      expect(() => pc.sendFrame('eth99', frame)).toThrow('Interface not found');
    });
  });

  describe('frame reception', () => {
    beforeEach(() => {
      pc.powerOn();
    });

    it('should receive frame on interface', () => {
      let receivedFrame: EthernetFrame | undefined;

      pc.onFrameReceive((frame) => {
        receivedFrame = frame;
      });

      const frame = new EthernetFrame({
        sourceMAC: new MACAddress('00:11:22:33:44:55'),
        destinationMAC: pc.getInterface('eth0')!.getMAC(),
        etherType: EtherType.IPv4,
        payload: Buffer.alloc(46)
      });

      pc.receiveFrame('eth0', frame);

      expect(receivedFrame).toBeDefined();
    });

    it('should process ARP packets automatically', () => {
      const arpService = pc.getARPService();

      const arpPacket = {
        operation: 'request' as const,
        senderIP: new IPAddress('192.168.1.20'),
        senderMAC: new MACAddress('00:11:22:33:44:55'),
        targetIP: new IPAddress('192.168.1.10'),
        targetMAC: MACAddress.ZERO
      };

      // Encapsulate ARP in Ethernet frame
      const arpBytes = arpService.serializePacket(arpPacket);
      const paddedPayload = Buffer.concat([arpBytes, Buffer.alloc(Math.max(0, 46 - arpBytes.length))]);

      const frame = new EthernetFrame({
        sourceMAC: arpPacket.senderMAC,
        destinationMAC: MACAddress.BROADCAST,
        etherType: EtherType.ARP,
        payload: paddedPayload
      });

      pc.receiveFrame('eth0', frame);

      // ARP cache should be updated
      const resolvedMAC = pc.resolveMAC(new IPAddress('192.168.1.20'));
      expect(resolvedMAC!.equals(new MACAddress('00:11:22:33:44:55'))).toBe(true);
    });
  });

  describe('statistics', () => {
    beforeEach(() => {
      pc.powerOn();
    });

    it('should track interface statistics', () => {
      const frame = new EthernetFrame({
        sourceMAC: pc.getInterface('eth0')!.getMAC(),
        destinationMAC: new MACAddress('00:11:22:33:44:55'),
        etherType: EtherType.IPv4,
        payload: Buffer.alloc(46)
      });

      pc.sendFrame('eth0', frame);

      const iface = pc.getInterface('eth0')!;
      const stats = iface.getStatistics();

      expect(stats.txFrames).toBe(1);
    });
  });

  describe('hostname', () => {
    it('should set and get hostname', () => {
      pc.setHostname('workstation-1');

      expect(pc.getHostname()).toBe('workstation-1');
    });

    it('should use device name as default hostname', () => {
      expect(pc.getHostname()).toBe('PC 1');
    });
  });
});
