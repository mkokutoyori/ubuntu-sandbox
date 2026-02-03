/**
 * TDD RED Phase - End-to-end LAN ping tests
 *
 * Reproduces the exact user scenario: 2 Linux PCs + Switch,
 * configure IPs via terminal, and test ping.
 * These tests use the NetworkSimulator wiring (not manual wiring)
 * to match the real GUI flow.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/domain/devices/LinuxPC';
import { Switch } from '@/domain/devices/Switch';
import { NetworkSimulator } from '@/core/network/NetworkSimulator';
import { ConnectionFactory } from '@/domain/connections/ConnectionFactory';
import { Connection } from '@/domain/devices/types';
import { BaseDevice } from '@/domain/devices/BaseDevice';

describe('LAN ping end-to-end (with NetworkSimulator wiring)', () => {
  let pc1: LinuxPC;
  let pc2: LinuxPC;
  let sw: Switch;
  let connections: Connection[];
  let deviceInstances: Map<string, BaseDevice>;

  beforeEach(() => {
    // Create devices (as the GUI would)
    pc1 = new LinuxPC({ id: 'pc1', name: 'PC1', hostname: 'pc1' });
    pc2 = new LinuxPC({ id: 'pc2', name: 'PC2', hostname: 'pc2' });
    sw = new Switch('sw1', 'SW1', 8);

    // Power on the switch (LinuxPC auto-powers on via config)
    sw.powerOn();

    // Create connection instances (as the store does)
    const conn1Instance = ConnectionFactory.createEthernet({
      id: 'conn-1',
      sourceDeviceId: 'pc1',
      sourceInterfaceId: 'eth0',
      targetDeviceId: 'sw1',
      targetInterfaceId: 'eth0'
    });
    const conn2Instance = ConnectionFactory.createEthernet({
      id: 'conn-2',
      sourceDeviceId: 'pc2',
      sourceInterfaceId: 'eth0',
      targetDeviceId: 'sw1',
      targetInterfaceId: 'eth1'
    });

    connections = [
      {
        id: 'conn-1', type: 'ethernet',
        sourceDeviceId: 'pc1', sourceInterfaceId: 'eth0',
        targetDeviceId: 'sw1', targetInterfaceId: 'eth0',
        isActive: true,
        instance: conn1Instance
      },
      {
        id: 'conn-2', type: 'ethernet',
        sourceDeviceId: 'pc2', sourceInterfaceId: 'eth0',
        targetDeviceId: 'sw1', targetInterfaceId: 'eth1',
        isActive: true,
        instance: conn2Instance
      }
    ];

    // Register devices in a map (as the store does)
    deviceInstances = new Map<string, BaseDevice>();
    deviceInstances.set('pc1', pc1);
    deviceInstances.set('pc2', pc2);
    deviceInstances.set('sw1', sw);

    // Initialize NetworkSimulator (as the useNetworkSimulator hook does)
    NetworkSimulator.initialize(deviceInstances, connections);
  });

  describe('self-ping (loopback)', () => {
    it('should succeed when pinging own IP', async () => {
      // Configure IP via terminal command
      await pc1.executeCommand('ifconfig eth0 192.168.1.10 netmask 255.255.255.0');

      // Ping own IP - should succeed (loopback)
      const result = await pc1.executeCommand('ping -c 1 192.168.1.10');
      expect(result).toContain('1 received');
      expect(result).not.toContain('100% packet loss');
    });

    it('should succeed when pinging 127.0.0.1', async () => {
      const result = await pc1.executeCommand('ping -c 1 127.0.0.1');
      expect(result).toContain('1 received');
      expect(result).not.toContain('100% packet loss');
    });

    it('should succeed when pinging localhost', async () => {
      const result = await pc1.executeCommand('ping -c 1 localhost');
      expect(result).toContain('1 received');
      expect(result).not.toContain('100% packet loss');
    });
  });

  describe('cross-device ping through switch', () => {
    beforeEach(async () => {
      // Configure both PCs via terminal commands
      await pc1.executeCommand('ifconfig eth0 192.168.1.10 netmask 255.255.255.0');
      await pc2.executeCommand('ifconfig eth0 192.168.1.20 netmask 255.255.255.0');
    });

    it('should succeed when pinging another PC on the same LAN', async () => {
      const result = await pc1.executeCommand('ping -c 1 192.168.1.20');
      expect(result).toContain('1 received');
      expect(result).not.toContain('100% packet loss');
    });

    it('should succeed in reverse direction (PC2 → PC1)', async () => {
      const result = await pc2.executeCommand('ping -c 1 192.168.1.10');
      expect(result).toContain('1 received');
      expect(result).not.toContain('100% packet loss');
    });

    it('should resolve ARP automatically during ping', async () => {
      // Ping should trigger ARP exchange automatically
      await pc1.executeCommand('ping -c 1 192.168.1.20');

      // After ping, ARP cache should have the entry
      const arpTable = pc1.getARPTable();
      const entry = arpTable.find(e => e.ip.toString() === '192.168.1.20');
      expect(entry).toBeDefined();

      // The MAC should match PC2's actual MAC
      const pc2MAC = pc2.getInterface('eth0')!.getMAC();
      expect(entry!.mac.toString()).toBe(pc2MAC.toString());
    });

    it('should show ARP table via terminal after ping', async () => {
      await pc1.executeCommand('ping -c 1 192.168.1.20');

      const arpOutput = await pc1.executeCommand('arp -a');
      expect(arpOutput).toContain('192.168.1.20');
    });

    it('should fail when pinging IP not on the network', async () => {
      const result = await pc1.executeCommand('ping -c 1 10.0.0.1');
      expect(result).toContain('packet loss');
      // Should show 100% loss or unreachable
      const hasLoss = result.includes('100% packet loss') ||
                      result.includes('unreachable') ||
                      result.includes('Network is unreachable');
      expect(hasLoss).toBe(true);
    });
  });

  describe('ping with multiple packets', () => {
    beforeEach(async () => {
      await pc1.executeCommand('ifconfig eth0 192.168.1.10 netmask 255.255.255.0');
      await pc2.executeCommand('ifconfig eth0 192.168.1.20 netmask 255.255.255.0');
    });

    it('should succeed with -c 4 (default count)', async () => {
      const result = await pc1.executeCommand('ping -c 4 192.168.1.20');
      expect(result).toContain('4 packets transmitted');
      expect(result).toContain('4 received');
      expect(result).toContain('0% packet loss');
    });
  });
});
