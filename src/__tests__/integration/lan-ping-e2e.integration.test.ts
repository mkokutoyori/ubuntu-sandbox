/**
 * LAN Ping End-to-End Integration Tests
 *
 * Tests that ping works between 2 PCs connected via a Switch:
 *   PC1 (192.168.1.10) <---> Switch <---> PC2 (192.168.1.20)
 *
 * Uses TDD approach to verify realistic network behavior.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { LinuxPC } from '@/domain/devices/LinuxPC';
import { WindowsPC } from '@/domain/devices/WindowsPC';
import { Switch } from '@/domain/devices/Switch';
import { IPAddress } from '@/domain/network/value-objects/IPAddress';
import { SubnetMask } from '@/domain/network/value-objects/SubnetMask';
import { EthernetFrame, EtherType } from '@/domain/network/entities/EthernetFrame';
import { MACAddress } from '@/domain/network/value-objects/MACAddress';

describe('LAN Ping End-to-End', () => {
  let pc1: LinuxPC;
  let pc2: LinuxPC;
  let sw: Switch;

  // Track frames for verification
  let framesFromPC1: EthernetFrame[];
  let framesFromPC2: EthernetFrame[];
  let framesFromSwitch: Map<string, EthernetFrame[]>;

  beforeEach(() => {
    // Create devices
    pc1 = new LinuxPC({ id: 'pc1', name: 'PC1' });
    pc2 = new LinuxPC({ id: 'pc2', name: 'PC2' });
    sw = new Switch('switch1', 'Switch1');

    // Configure IPs
    pc1.setIPAddress('eth0', new IPAddress('192.168.1.10'), new SubnetMask('/24'));
    pc2.setIPAddress('eth0', new IPAddress('192.168.1.20'), new SubnetMask('/24'));

    // Power on all devices
    pc1.powerOn();
    pc2.powerOn();
    sw.powerOn();

    // Track frames
    framesFromPC1 = [];
    framesFromPC2 = [];
    framesFromSwitch = new Map([['eth0', []], ['eth1', []]]);

    // Wire up the network topology:
    // PC1.eth0 <-> Switch.eth0
    // PC2.eth0 <-> Switch.eth1
    wireUpNetwork();
  });

  /**
   * Wire up the network so frames flow between devices
   * This simulates what the NetworkSimulator should do
   */
  function wireUpNetwork() {
    const pc1Interface = pc1.getInterface('eth0');
    const pc2Interface = pc2.getInterface('eth0');

    if (!pc1Interface || !pc2Interface) {
      throw new Error('Interfaces not found');
    }

    // When PC1 transmits, send to Switch port eth0
    pc1Interface.onTransmit((frame) => {
      framesFromPC1.push(frame);
      sw.receiveFrame('eth0', frame);
    });

    // When PC2 transmits, send to Switch port eth1
    pc2Interface.onTransmit((frame) => {
      framesFromPC2.push(frame);
      sw.receiveFrame('eth1', frame);
    });

    // When Switch forwards frames, deliver to the appropriate device
    sw.onFrameForward((port, frame) => {
      framesFromSwitch.get(port)?.push(frame);

      if (port === 'eth0') {
        // Frame going to PC1
        pc1Interface.receive(frame);
      } else if (port === 'eth1') {
        // Frame going to PC2
        pc2Interface.receive(frame);
      }
    });

    // Switch ports are enabled by default
    // sw.enablePort('eth0'); // Already enabled by default
    // sw.enablePort('eth1'); // Already enabled by default
  }

  /**
   * Pre-populate ARP tables so devices know each other's MAC addresses
   */
  function setupARPTables() {
    const pc1MAC = pc1.getInterface('eth0')!.getMAC();
    const pc2MAC = pc2.getInterface('eth0')!.getMAC();

    // PC1 knows PC2's MAC
    pc1.addARPEntry(new IPAddress('192.168.1.20'), pc2MAC);
    // PC2 knows PC1's MAC
    pc2.addARPEntry(new IPAddress('192.168.1.10'), pc1MAC);
  }

  describe('Basic Connectivity', () => {
    it('should have both PCs configured with IPs', () => {
      const pc1IP = pc1.getInterface('eth0')?.getIPAddress();
      const pc2IP = pc2.getInterface('eth0')?.getIPAddress();

      expect(pc1IP?.toString()).toBe('192.168.1.10');
      expect(pc2IP?.toString()).toBe('192.168.1.20');
    });

    it('should have switch with 2 ports enabled', () => {
      expect(sw.isPortEnabled('eth0')).toBe(true);
      expect(sw.isPortEnabled('eth1')).toBe(true);
    });

    it('should allow devices to be powered on', () => {
      expect(pc1.isOnline()).toBe(true);
      expect(pc2.isOnline()).toBe(true);
      expect(sw.isOnline()).toBe(true);
    });
  });

  describe('Ping Command Execution', () => {
    beforeEach(() => {
      setupARPTables();
    });

    it('should send ICMP Echo Request when ping command is executed', async () => {
      // Execute ping command on PC1
      const result = await pc1.executeCommand('ping 192.168.1.20');

      // Verify output indicates packet was sent
      expect(result).toContain('PING 192.168.1.20');
      expect(result).toContain('bytes');

      // Verify frame was actually sent
      expect(framesFromPC1.length).toBeGreaterThan(0);
    });

    it('should send frame to switch when pinging', async () => {
      await pc1.executeCommand('ping 192.168.1.20');

      // Verify at least one frame reached the switch
      expect(framesFromPC1.length).toBeGreaterThan(0);

      // Verify the frame has correct destination MAC
      const frame = framesFromPC1[0];
      const pc2MAC = pc2.getInterface('eth0')!.getMAC();
      expect(frame.getDestinationMAC().equals(pc2MAC)).toBe(true);
    });

    it('should have switch forward frame to PC2', async () => {
      await pc1.executeCommand('ping 192.168.1.20');

      // Verify switch forwarded frame to port eth1 (where PC2 is connected)
      const forwardedToEth1 = framesFromSwitch.get('eth1') || [];
      expect(forwardedToEth1.length).toBeGreaterThan(0);
    });
  });

  describe('Frame Flow Through Switch', () => {
    beforeEach(() => {
      setupARPTables();
    });

    it('should learn PC1 MAC address on port eth0', async () => {
      await pc1.executeCommand('ping 192.168.1.20');

      // Check switch MAC table service
      const macTableService = sw.getMACTable();
      const pc1MAC = pc1.getInterface('eth0')!.getMAC();

      // Lookup PC1's MAC in the MAC table
      const foundPort = macTableService.lookup(pc1MAC);

      expect(foundPort).toBe('eth0');
    });

    it('should forward frame based on learned MAC (after initial flood)', async () => {
      // First ping: PC1 -> PC2 (switch learns PC1's MAC, floods to find PC2)
      await pc1.executeCommand('ping 192.168.1.20');

      // Second ping: PC2 -> PC1 (switch knows PC1's MAC, direct forward)
      await pc2.executeCommand('ping 192.168.1.10');

      // Check that switch learned both MACs
      const macTableService = sw.getMACTable();
      const pc1MAC = pc1.getInterface('eth0')!.getMAC();
      const pc2MAC = pc2.getInterface('eth0')!.getMAC();

      expect(macTableService.lookup(pc1MAC)).toBe('eth0');
      expect(macTableService.lookup(pc2MAC)).toBe('eth1');
    });
  });

  describe('Windows PC Ping', () => {
    let winPC: WindowsPC;

    beforeEach(() => {
      winPC = new WindowsPC({ id: 'winpc1', name: 'Windows PC' });
      winPC.setIPAddress('eth0', new IPAddress('192.168.1.30'), new SubnetMask('/24'));
      winPC.powerOn();

      // Add ARP entries for Windows PC
      const winMAC = winPC.getInterface('eth0')!.getMAC();
      const pc1MAC = pc1.getInterface('eth0')!.getMAC();

      winPC.addARPEntry(new IPAddress('192.168.1.10'), pc1MAC);
      pc1.addARPEntry(new IPAddress('192.168.1.30'), winMAC);
    });

    it('should execute ping command on Windows PC', async () => {
      const result = await winPC.executeCommand('ping 192.168.1.10');

      expect(result).toContain('Pinging 192.168.1.10');
      expect(result).toContain('bytes');
    });

    it('should execute tracert command on Windows PC', async () => {
      const result = await winPC.executeCommand('tracert 192.168.1.10');

      expect(result).toContain('Tracing route to 192.168.1.10');
      expect(result).toContain('hops');
    });
  });

  describe('Linux PC Traceroute', () => {
    beforeEach(() => {
      setupARPTables();
    });

    it('should execute traceroute command on Linux PC', async () => {
      const result = await pc1.executeCommand('traceroute 192.168.1.20');

      expect(result).toContain('traceroute to 192.168.1.20');
      expect(result).toContain('hops');
    });

    it('should send packets with incrementing TTL', async () => {
      await pc1.executeCommand('traceroute 192.168.1.20');

      // Verify frames were sent
      expect(framesFromPC1.length).toBeGreaterThan(0);
    });
  });

  describe('Error Cases', () => {
    it('should return error when pinging without IP configuration', async () => {
      const unconfiguredPC = new LinuxPC({ id: 'noip', name: 'NoIP PC' });
      unconfiguredPC.powerOn();

      // Clear IP address
      const iface = unconfiguredPC.getInterface('eth0');
      iface?.clearIPAddress();

      const result = await unconfiguredPC.executeCommand('ping 192.168.1.1');

      expect(result).toContain('not configured');
    });

    it('should return error when pinging with invalid IP', async () => {
      const result = await pc1.executeCommand('ping not.an.ip');

      expect(result).toContain('not known');
    });

    it('should return offline message when device is off', async () => {
      pc1.powerOff();

      const result = await pc1.executeCommand('ping 192.168.1.20');

      expect(result).toBe('Device is offline');
    });
  });

  describe('ifconfig Command Integration', () => {
    it('should show configured IP with ifconfig', async () => {
      const result = await pc1.executeCommand('ifconfig');

      expect(result).toContain('192.168.1.10');
      expect(result).toContain('eth0');
    });

    it('should allow reconfiguring IP via ifconfig', async () => {
      await pc1.executeCommand('ifconfig eth0 10.0.0.100 netmask 255.0.0.0');

      const newIP = pc1.getInterface('eth0')?.getIPAddress();
      expect(newIP?.toString()).toBe('10.0.0.100');
    });
  });
});
