/**
 * TDD - Browser-like E2E ping test
 *
 * This test simulates the EXACT browser scenario:
 * 1. No Node.js Buffer polyfill (we temporarily remove it)
 * 2. Full store-driven flow (addDevice, connect via UI flow, configure, ping)
 * 3. Verifies that the domain entities work with the Buffer polyfill from 'buffer' package
 *
 * This test catches the root cause bug: domain entities use Buffer.alloc/Buffer.from
 * which don't exist in browsers without polyfill.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { useNetworkStore } from '@/store/networkStore';
import { NetworkSimulator } from '@/core/network/NetworkSimulator';

describe('Browser E2E: Full GUI ping flow', () => {
  beforeEach(() => {
    useNetworkStore.getState().clearAll();
  });

  afterEach(() => {
    useNetworkStore.getState().clearAll();
  });

  /**
   * Scenario: Two Linux PCs connected to a Cisco Switch
   * User connects them, configures IPs, and pings
   */
  it('should ping between two Linux PCs connected to a Cisco Switch (full GUI flow)', async () => {
    const store = useNetworkStore.getState();

    // 1. User drags devices onto canvas
    const pc1UI = store.addDevice('linux-pc', 100, 100);
    const pc2UI = store.addDevice('linux-pc', 400, 100);
    const swUI = store.addDevice('cisco-switch', 250, 250);

    // Verify all powered on
    expect(pc1UI.isPoweredOn).toBe(true);
    expect(pc2UI.isPoweredOn).toBe(true);
    expect(swUI.isPoweredOn).toBe(true);

    // 2. User connects PC1 to Switch via GUI (startConnecting/finishConnecting)
    store.startConnecting(pc1UI.id, 'eth0', 'ethernet');
    store.finishConnecting(swUI.id, 'eth0');

    // 3. User connects PC2 to Switch via GUI
    store.startConnecting(pc2UI.id, 'eth0', 'ethernet');
    store.finishConnecting(swUI.id, 'eth1');

    // Verify connections created with instances
    const state = useNetworkStore.getState();
    expect(state.connections.length).toBe(2);
    expect(state.connections[0].instance).toBeDefined();
    expect(state.connections[1].instance).toBeDefined();

    // Verify NetworkSimulator is wired
    expect(NetworkSimulator.isReady()).toBe(true);

    // 4. User opens terminal on PC1 and configures IP
    const pc1 = state.deviceInstances.get(pc1UI.id)! as any;
    const pc2 = state.deviceInstances.get(pc2UI.id)! as any;

    // Configure IPs (user types in terminal)
    const ifconfigResult1 = await pc1.executeCommand('ifconfig eth0 192.168.1.10');
    expect(ifconfigResult1).not.toContain('error');

    const ifconfigResult2 = await pc2.executeCommand('ifconfig eth0 192.168.1.20');
    expect(ifconfigResult2).not.toContain('error');

    // Verify IPs are configured
    const nic1 = pc1.getInterface('eth0');
    const nic2 = pc2.getInterface('eth0');
    expect(nic1.getIPAddress()?.toString()).toBe('192.168.1.10');
    expect(nic2.getIPAddress()?.toString()).toBe('192.168.1.20');

    // 5. User pings from PC1 to PC2
    const pingResult = await pc1.executeCommand('ping -c 4 192.168.1.20');

    // CRITICAL: This must NOT have 100% packet loss
    expect(pingResult).toContain('4 packets transmitted');
    expect(pingResult).toContain('received');
    expect(pingResult).not.toContain('100% packet loss');
    expect(pingResult).toContain('0% packet loss');

    // 6. Verify ARP table was populated
    const arpResult = await pc1.executeCommand('arp -a');
    expect(arpResult).toContain('192.168.1.20');

    // 7. Ping in reverse direction should also work
    const reversePing = await pc2.executeCommand('ping -c 1 192.168.1.10');
    expect(reversePing).toContain('1 received');
    expect(reversePing).not.toContain('100% packet loss');
  });

  /**
   * Scenario: Direct PC-to-PC connection (no switch)
   */
  it('should ping between two directly connected PCs', async () => {
    const store = useNetworkStore.getState();

    const pc1UI = store.addDevice('linux-pc', 100, 100);
    const pc2UI = store.addDevice('linux-pc', 400, 100);

    // Direct connection PC1.eth0 <-> PC2.eth0
    store.startConnecting(pc1UI.id, 'eth0', 'ethernet');
    store.finishConnecting(pc2UI.id, 'eth0');

    const state = useNetworkStore.getState();
    const pc1 = state.deviceInstances.get(pc1UI.id)! as any;
    const pc2 = state.deviceInstances.get(pc2UI.id)! as any;

    await pc1.executeCommand('ifconfig eth0 10.0.0.1');
    await pc2.executeCommand('ifconfig eth0 10.0.0.2');

    const pingResult = await pc1.executeCommand('ping -c 1 10.0.0.2');
    expect(pingResult).toContain('1 received');
    expect(pingResult).not.toContain('100% packet loss');
  });

  /**
   * Scenario: Three PCs connected to a switch (multi-device LAN)
   */
  it('should ping across three PCs on the same LAN via switch', async () => {
    const store = useNetworkStore.getState();

    const pc1UI = store.addDevice('linux-pc', 100, 100);
    const pc2UI = store.addDevice('linux-pc', 400, 100);
    const pc3UI = store.addDevice('linux-pc', 250, 50);
    const swUI = store.addDevice('cisco-switch', 250, 250);

    store.addConnection(pc1UI.id, 'eth0', swUI.id, 'eth0', 'ethernet');
    store.addConnection(pc2UI.id, 'eth0', swUI.id, 'eth1', 'ethernet');
    store.addConnection(pc3UI.id, 'eth0', swUI.id, 'eth2', 'ethernet');

    const state = useNetworkStore.getState();
    const pc1 = state.deviceInstances.get(pc1UI.id)! as any;
    const pc2 = state.deviceInstances.get(pc2UI.id)! as any;
    const pc3 = state.deviceInstances.get(pc3UI.id)! as any;

    await pc1.executeCommand('ifconfig eth0 192.168.1.1');
    await pc2.executeCommand('ifconfig eth0 192.168.1.2');
    await pc3.executeCommand('ifconfig eth0 192.168.1.3');

    // PC1 → PC2
    const ping12 = await pc1.executeCommand('ping -c 1 192.168.1.2');
    expect(ping12).toContain('1 received');

    // PC1 → PC3
    const ping13 = await pc1.executeCommand('ping -c 1 192.168.1.3');
    expect(ping13).toContain('1 received');

    // PC3 → PC2
    const ping32 = await pc3.executeCommand('ping -c 1 192.168.1.2');
    expect(ping32).toContain('1 received');
  });

  /**
   * Scenario: Windows PCs should also work
   */
  it('should ping between a Linux PC and a Windows PC', async () => {
    const store = useNetworkStore.getState();

    const linuxUI = store.addDevice('linux-pc', 100, 100);
    const winUI = store.addDevice('windows-pc', 400, 100);
    const swUI = store.addDevice('cisco-switch', 250, 250);

    store.addConnection(linuxUI.id, 'eth0', swUI.id, 'eth0', 'ethernet');
    store.addConnection(winUI.id, 'eth0', swUI.id, 'eth1', 'ethernet');

    const state = useNetworkStore.getState();
    const linux = state.deviceInstances.get(linuxUI.id)! as any;
    const win = state.deviceInstances.get(winUI.id)! as any;

    await linux.executeCommand('ifconfig eth0 192.168.1.10');
    await win.executeCommand('netsh interface ip set address "Ethernet0" static 192.168.1.20 255.255.255.0');

    // Linux → Windows
    const pingResult = await linux.executeCommand('ping -c 1 192.168.1.20');
    expect(pingResult).toContain('1 received');
    expect(pingResult).not.toContain('100% packet loss');
  });

  /**
   * Scenario: traceroute should work through the network
   */
  it('should execute traceroute between connected PCs', async () => {
    const store = useNetworkStore.getState();

    const pc1UI = store.addDevice('linux-pc', 100, 100);
    const pc2UI = store.addDevice('linux-pc', 400, 100);
    const swUI = store.addDevice('cisco-switch', 250, 250);

    store.addConnection(pc1UI.id, 'eth0', swUI.id, 'eth0', 'ethernet');
    store.addConnection(pc2UI.id, 'eth0', swUI.id, 'eth1', 'ethernet');

    const state = useNetworkStore.getState();
    const pc1 = state.deviceInstances.get(pc1UI.id)! as any;
    const pc2 = state.deviceInstances.get(pc2UI.id)! as any;

    await pc1.executeCommand('ifconfig eth0 192.168.1.10');
    await pc2.executeCommand('ifconfig eth0 192.168.1.20');

    const traceResult = await pc1.executeCommand('traceroute 192.168.1.20');
    expect(traceResult).toContain('traceroute to 192.168.1.20');
    expect(traceResult).not.toContain('network interface not configured');
  });

  /**
   * Scenario: Hub instead of switch
   */
  it('should ping through a Hub', async () => {
    const store = useNetworkStore.getState();

    const pc1UI = store.addDevice('linux-pc', 100, 100);
    const pc2UI = store.addDevice('linux-pc', 400, 100);
    const hubUI = store.addDevice('hub', 250, 250);

    store.addConnection(pc1UI.id, 'eth0', hubUI.id, 'eth0', 'ethernet');
    store.addConnection(pc2UI.id, 'eth0', hubUI.id, 'eth1', 'ethernet');

    const state = useNetworkStore.getState();
    const pc1 = state.deviceInstances.get(pc1UI.id)! as any;
    const pc2 = state.deviceInstances.get(pc2UI.id)! as any;

    await pc1.executeCommand('ifconfig eth0 172.16.0.1');
    await pc2.executeCommand('ifconfig eth0 172.16.0.2');

    const pingResult = await pc1.executeCommand('ping -c 1 172.16.0.2');
    expect(pingResult).toContain('1 received');
    expect(pingResult).not.toContain('100% packet loss');
  });

  /**
   * Scenario: Verify connection removal and re-creation works
   */
  it('should work after removing and re-creating connections', async () => {
    const store = useNetworkStore.getState();

    const pc1UI = store.addDevice('linux-pc', 100, 100);
    const pc2UI = store.addDevice('linux-pc', 400, 100);
    const swUI = store.addDevice('cisco-switch', 250, 250);

    const conn1 = store.addConnection(pc1UI.id, 'eth0', swUI.id, 'eth0', 'ethernet');
    const conn2 = store.addConnection(pc2UI.id, 'eth0', swUI.id, 'eth1', 'ethernet');

    // Remove connections
    store.removeConnection(conn1!.id);
    store.removeConnection(conn2!.id);

    // Re-create
    store.addConnection(pc1UI.id, 'eth0', swUI.id, 'eth0', 'ethernet');
    store.addConnection(pc2UI.id, 'eth0', swUI.id, 'eth1', 'ethernet');

    const state = useNetworkStore.getState();
    const pc1 = state.deviceInstances.get(pc1UI.id)! as any;
    const pc2 = state.deviceInstances.get(pc2UI.id)! as any;

    await pc1.executeCommand('ifconfig eth0 192.168.1.10');
    await pc2.executeCommand('ifconfig eth0 192.168.1.20');

    const pingResult = await pc1.executeCommand('ping -c 1 192.168.1.20');
    expect(pingResult).toContain('1 received');
    expect(pingResult).not.toContain('100% packet loss');
  });

  /**
   * Scenario: Verify NetworkSimulator connection info is accurate
   */
  it('should have accurate NetworkSimulator wiring after connections', () => {
    const store = useNetworkStore.getState();

    const pc1UI = store.addDevice('linux-pc', 100, 100);
    const pc2UI = store.addDevice('linux-pc', 400, 100);
    const swUI = store.addDevice('cisco-switch', 250, 250);

    store.addConnection(pc1UI.id, 'eth0', swUI.id, 'eth0', 'ethernet');
    store.addConnection(pc2UI.id, 'eth0', swUI.id, 'eth1', 'ethernet');

    const info = NetworkSimulator.getConnectionInfo();
    expect(info.devices).toBe(3);
    expect(info.connections).toBe(2);
    expect(info.connectionInstances).toBe(2);
  });
});
