/**
 * Unit tests for NetworkInterface (NIC)
 * Following TDD approach - tests written first
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NetworkInterface, InterfaceStatus } from '@/domain/devices/NetworkInterface';
import { MACAddress } from '@/domain/network/value-objects/MACAddress';
import { IPAddress } from '@/domain/network/value-objects/IPAddress';
import { SubnetMask } from '@/domain/network/value-objects/SubnetMask';
import { EthernetFrame, EtherType } from '@/domain/network/entities/EthernetFrame';

describe('NetworkInterface', () => {
  let nic: NetworkInterface;
  let mac: MACAddress;

  beforeEach(() => {
    mac = new MACAddress('AA:BB:CC:DD:EE:FF');
    nic = new NetworkInterface('eth0', mac);
  });

  describe('construction', () => {
    it('should create interface with name and MAC', () => {
      expect(nic.getName()).toBe('eth0');
      expect(nic.getMAC().equals(mac)).toBe(true);
    });

    it('should initialize with down status', () => {
      expect(nic.getStatus()).toBe('down');
    });

    it('should have no IP address initially', () => {
      expect(nic.getIPAddress()).toBeUndefined();
    });
  });

  describe('status management', () => {
    it('should bring interface up', () => {
      nic.up();

      expect(nic.getStatus()).toBe('up');
      expect(nic.isUp()).toBe(true);
    });

    it('should bring interface down', () => {
      nic.up();
      nic.down();

      expect(nic.getStatus()).toBe('down');
      expect(nic.isUp()).toBe(false);
    });
  });

  describe('IP configuration', () => {
    it('should set IP address and subnet mask', () => {
      const ip = new IPAddress('192.168.1.10');
      const mask = new SubnetMask('255.255.255.0');

      nic.setIPAddress(ip, mask);

      expect(nic.getIPAddress()?.equals(ip)).toBe(true);
      expect(nic.getSubnetMask()?.equals(mask)).toBe(true);
    });

    it('should clear IP address', () => {
      const ip = new IPAddress('192.168.1.10');
      const mask = new SubnetMask('255.255.255.0');

      nic.setIPAddress(ip, mask);
      nic.clearIPAddress();

      expect(nic.getIPAddress()).toBeUndefined();
      expect(nic.getSubnetMask()).toBeUndefined();
    });

    it('should check if IP is configured', () => {
      expect(nic.hasIPAddress()).toBe(false);

      nic.setIPAddress(new IPAddress('192.168.1.10'), new SubnetMask('/24'));

      expect(nic.hasIPAddress()).toBe(true);
    });

    it('should set gateway', () => {
      const gateway = new IPAddress('192.168.1.1');

      nic.setGateway(gateway);

      expect(nic.getGateway()?.equals(gateway)).toBe(true);
    });
  });

  describe('frame transmission', () => {
    it('should send frame when interface is up', () => {
      const callback = vi.fn();
      nic.onTransmit(callback);

      nic.up();

      const frame = new EthernetFrame({
        sourceMAC: mac,
        destinationMAC: new MACAddress('00:11:22:33:44:55'),
        etherType: EtherType.IPv4,
        payload: Buffer.alloc(46)
      });

      nic.transmit(frame);

      expect(callback).toHaveBeenCalledWith(frame);
    });

    it('should not send frame when interface is down', () => {
      const callback = vi.fn();
      nic.onTransmit(callback);

      const frame = new EthernetFrame({
        sourceMAC: mac,
        destinationMAC: new MACAddress('00:11:22:33:44:55'),
        etherType: EtherType.IPv4,
        payload: Buffer.alloc(46)
      });

      expect(() => nic.transmit(frame)).toThrow('Interface is down');
      expect(callback).not.toHaveBeenCalled();
    });

    it('should track transmitted frames', () => {
      nic.up();

      const frame = new EthernetFrame({
        sourceMAC: mac,
        destinationMAC: new MACAddress('00:11:22:33:44:55'),
        etherType: EtherType.IPv4,
        payload: Buffer.alloc(46)
      });

      nic.transmit(frame);
      nic.transmit(frame);

      const stats = nic.getStatistics();
      expect(stats.txFrames).toBe(2);
    });
  });

  describe('frame reception', () => {
    it('should receive frame when interface is up', () => {
      const callback = vi.fn();
      nic.onReceive(callback);

      nic.up();

      const frame = new EthernetFrame({
        sourceMAC: new MACAddress('00:11:22:33:44:55'),
        destinationMAC: mac,
        etherType: EtherType.IPv4,
        payload: Buffer.alloc(46)
      });

      nic.receive(frame);

      expect(callback).toHaveBeenCalledWith(frame);
    });

    it('should not receive frame when interface is down', () => {
      const callback = vi.fn();
      nic.onReceive(callback);

      const frame = new EthernetFrame({
        sourceMAC: new MACAddress('00:11:22:33:44:55'),
        destinationMAC: mac,
        etherType: EtherType.IPv4,
        payload: Buffer.alloc(46)
      });

      nic.receive(frame);

      expect(callback).not.toHaveBeenCalled();
    });

    it('should accept broadcast frames', () => {
      const callback = vi.fn();
      nic.onReceive(callback);

      nic.up();

      const frame = new EthernetFrame({
        sourceMAC: new MACAddress('00:11:22:33:44:55'),
        destinationMAC: MACAddress.BROADCAST,
        etherType: EtherType.ARP,
        payload: Buffer.alloc(46)
      });

      nic.receive(frame);

      expect(callback).toHaveBeenCalledWith(frame);
    });

    it('should drop frames not destined for this interface', () => {
      const callback = vi.fn();
      nic.onReceive(callback);

      nic.up();

      const frame = new EthernetFrame({
        sourceMAC: new MACAddress('00:11:22:33:44:55'),
        destinationMAC: new MACAddress('99:99:99:99:99:99'), // Different MAC
        etherType: EtherType.IPv4,
        payload: Buffer.alloc(46)
      });

      nic.receive(frame);

      expect(callback).not.toHaveBeenCalled();
    });

    it('should track received frames', () => {
      nic.up();

      const frame = new EthernetFrame({
        sourceMAC: new MACAddress('00:11:22:33:44:55'),
        destinationMAC: mac,
        etherType: EtherType.IPv4,
        payload: Buffer.alloc(46)
      });

      nic.receive(frame);
      nic.receive(frame);

      const stats = nic.getStatistics();
      expect(stats.rxFrames).toBe(2);
    });

    it('should track dropped frames', () => {
      nic.up();

      const frame = new EthernetFrame({
        sourceMAC: new MACAddress('00:11:22:33:44:55'),
        destinationMAC: new MACAddress('99:99:99:99:99:99'),
        etherType: EtherType.IPv4,
        payload: Buffer.alloc(46)
      });

      nic.receive(frame);

      const stats = nic.getStatistics();
      expect(stats.droppedFrames).toBe(1);
    });
  });

  describe('statistics', () => {
    it('should track bytes transmitted', () => {
      nic.up();

      const frame = new EthernetFrame({
        sourceMAC: mac,
        destinationMAC: new MACAddress('00:11:22:33:44:55'),
        etherType: EtherType.IPv4,
        payload: Buffer.alloc(46)
      });

      nic.transmit(frame);

      const stats = nic.getStatistics();
      expect(stats.txBytes).toBeGreaterThan(0);
    });

    it('should track bytes received', () => {
      nic.up();

      const frame = new EthernetFrame({
        sourceMAC: new MACAddress('00:11:22:33:44:55'),
        destinationMAC: mac,
        etherType: EtherType.IPv4,
        payload: Buffer.alloc(46)
      });

      nic.receive(frame);

      const stats = nic.getStatistics();
      expect(stats.rxBytes).toBeGreaterThan(0);
    });

    it('should reset statistics', () => {
      nic.up();

      const frame = new EthernetFrame({
        sourceMAC: mac,
        destinationMAC: new MACAddress('00:11:22:33:44:55'),
        etherType: EtherType.IPv4,
        payload: Buffer.alloc(46)
      });

      nic.transmit(frame);

      nic.resetStatistics();

      const stats = nic.getStatistics();
      expect(stats.txFrames).toBe(0);
      expect(stats.txBytes).toBe(0);
    });
  });

  describe('MTU', () => {
    it('should have default MTU of 1500', () => {
      expect(nic.getMTU()).toBe(1500);
    });

    it('should allow setting custom MTU', () => {
      nic.setMTU(9000); // Jumbo frames

      expect(nic.getMTU()).toBe(9000);
    });

    it('should enforce minimum MTU', () => {
      expect(() => nic.setMTU(500)).toThrow('MTU too small');
    });

    it('should enforce maximum MTU', () => {
      expect(() => nic.setMTU(10000)).toThrow('MTU too large');
    });
  });

  describe('promiscuous mode', () => {
    it('should not be in promiscuous mode by default', () => {
      expect(nic.isPromiscuous()).toBe(false);
    });

    it('should enable promiscuous mode', () => {
      nic.setPromiscuous(true);

      expect(nic.isPromiscuous()).toBe(true);
    });

    it('should receive all frames in promiscuous mode', () => {
      const callback = vi.fn();
      nic.onReceive(callback);

      nic.up();
      nic.setPromiscuous(true);

      const frame = new EthernetFrame({
        sourceMAC: new MACAddress('00:11:22:33:44:55'),
        destinationMAC: new MACAddress('99:99:99:99:99:99'), // Different MAC
        etherType: EtherType.IPv4,
        payload: Buffer.alloc(46)
      });

      nic.receive(frame);

      expect(callback).toHaveBeenCalledWith(frame);
    });
  });
});
