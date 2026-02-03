/**
 * TDD RED Phase - UI Store-level ping test
 *
 * Simulates the exact flow a user follows in the GUI:
 * 1. Add devices via store (DeviceFactory)
 * 2. Add connections via store (ConnectionFactory)
 * 3. Initialize NetworkSimulator (as the useNetworkSimulator hook does)
 * 4. Open terminal and configure IPs
 * 5. Ping between devices
 *
 * This test does NOT use React - it tests the store + domain logic directly.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { useNetworkStore } from '@/store/networkStore';
import { NetworkSimulator } from '@/core/network/NetworkSimulator';
import { BaseDevice } from '@/domain/devices';

describe('UI Store-level ping (simulating GUI flow)', () => {
  beforeEach(() => {
    // Reset store to clean state
    const store = useNetworkStore.getState();
    // Clear all state
    useNetworkStore.setState({
      deviceInstances: new Map(),
      connections: [],
      selectedDeviceId: null,
      selectedConnectionId: null,
      isConnecting: false,
      connectionSource: null,
    });
    NetworkSimulator.reset();
  });

  afterEach(() => {
    NetworkSimulator.reset();
  });

  it('should create devices via store and verify they are powered on', () => {
    const store = useNetworkStore.getState();

    // Step 1: User adds devices from the toolbar
    const pc1UI = store.addDevice('linux-pc', 100, 100);
    const pc2UI = store.addDevice('linux-pc', 400, 100);
    const swUI = store.addDevice('cisco-switch', 250, 250);

    expect(pc1UI.isPoweredOn).toBe(true);
    expect(pc2UI.isPoweredOn).toBe(true);
    expect(swUI.isPoweredOn).toBe(true);

    // Verify actual instances are powered on
    const state = useNetworkStore.getState();
    const pc1 = state.deviceInstances.get(pc1UI.id)!;
    const pc2 = state.deviceInstances.get(pc2UI.id)!;
    const sw = state.deviceInstances.get(swUI.id)!;

    expect(pc1.isOnline()).toBe(true);
    expect(pc2.isOnline()).toBe(true);
    expect(sw.isOnline()).toBe(true);
  });

  it('should create connections with instances via store', () => {
    const store = useNetworkStore.getState();

    const pc1UI = store.addDevice('linux-pc', 100, 100);
    const pc2UI = store.addDevice('linux-pc', 400, 100);
    const swUI = store.addDevice('cisco-switch', 250, 250);

    // Step 2: User connects devices (via InterfaceSelectorPopover)
    const conn1 = store.addConnection(pc1UI.id, 'eth0', swUI.id, 'eth0', 'ethernet');
    const conn2 = store.addConnection(pc2UI.id, 'eth0', swUI.id, 'eth1', 'ethernet');

    expect(conn1).not.toBeNull();
    expect(conn2).not.toBeNull();
    expect(conn1!.instance).toBeDefined();
    expect(conn2!.instance).toBeDefined();
    expect(conn1!.instance!.isActive()).toBe(true);
    expect(conn2!.instance!.isActive()).toBe(true);
  });

  it('should wire up NetworkSimulator and enable ping between PCs', async () => {
    const store = useNetworkStore.getState();

    // Step 1: Add devices
    const pc1UI = store.addDevice('linux-pc', 100, 100);
    const pc2UI = store.addDevice('linux-pc', 400, 100);
    const swUI = store.addDevice('cisco-switch', 250, 250);

    // Step 2: Add connections
    store.addConnection(pc1UI.id, 'eth0', swUI.id, 'eth0', 'ethernet');
    store.addConnection(pc2UI.id, 'eth0', swUI.id, 'eth1', 'ethernet');

    // Step 3: Initialize NetworkSimulator (as the useNetworkSimulator hook does)
    const state = useNetworkStore.getState();
    NetworkSimulator.initialize(state.deviceInstances, state.connections);

    // Step 4: Get actual device instances (as the terminal does)
    const pc1 = state.deviceInstances.get(pc1UI.id)! as any;
    const pc2 = state.deviceInstances.get(pc2UI.id)! as any;

    // Step 5: Configure IPs via terminal commands
    const ifconfigResult1 = await pc1.executeCommand('ifconfig eth0 192.168.1.10 netmask 255.255.255.0');
    const ifconfigResult2 = await pc2.executeCommand('ifconfig eth0 192.168.1.20 netmask 255.255.255.0');

    expect(ifconfigResult1).not.toBe('Device is offline');
    expect(ifconfigResult2).not.toBe('Device is offline');

    // Step 6: Verify IPs are configured
    const pc1IP = pc1.getInterface('eth0')?.getIPAddress()?.toString();
    const pc2IP = pc2.getInterface('eth0')?.getIPAddress()?.toString();
    expect(pc1IP).toBe('192.168.1.10');
    expect(pc2IP).toBe('192.168.1.20');

    // Step 7: Ping PC2 from PC1
    const pingResult = await pc1.executeCommand('ping -c 1 192.168.1.20');

    expect(pingResult).toContain('1 received');
    expect(pingResult).not.toContain('100% packet loss');
  });

  it('should support loopback ping via store flow', async () => {
    const store = useNetworkStore.getState();

    const pc1UI = store.addDevice('linux-pc', 100, 100);

    const state = useNetworkStore.getState();
    const pc1 = state.deviceInstances.get(pc1UI.id)! as any;

    // Configure IP
    await pc1.executeCommand('ifconfig eth0 192.168.1.10 netmask 255.255.255.0');

    // Ping own IP
    const result1 = await pc1.executeCommand('ping -c 1 192.168.1.10');
    expect(result1).toContain('1 received');

    // Ping localhost
    const result2 = await pc1.executeCommand('ping -c 1 localhost');
    expect(result2).toContain('1 received');

    // Ping 127.0.0.1
    const result3 = await pc1.executeCommand('ping -c 1 127.0.0.1');
    expect(result3).toContain('1 received');
  });

  it('should work with finishConnecting flow (like the actual GUI click)', async () => {
    const store = useNetworkStore.getState();

    // Step 1: Add devices
    const pc1UI = store.addDevice('linux-pc', 100, 100);
    const pc2UI = store.addDevice('linux-pc', 400, 100);
    const swUI = store.addDevice('cisco-switch', 250, 250);

    // Step 2: Connect via startConnecting/finishConnecting (the actual GUI flow)
    store.startConnecting(pc1UI.id, 'eth0', 'ethernet');
    store.finishConnecting(swUI.id, 'eth0');

    store.startConnecting(pc2UI.id, 'eth0', 'ethernet');
    store.finishConnecting(swUI.id, 'eth1');

    // Verify connections were created
    const stateAfterConnect = useNetworkStore.getState();
    expect(stateAfterConnect.connections.length).toBe(2);
    expect(stateAfterConnect.connections[0].instance).toBeDefined();
    expect(stateAfterConnect.connections[1].instance).toBeDefined();

    // Step 3: Initialize NetworkSimulator
    NetworkSimulator.initialize(stateAfterConnect.deviceInstances, stateAfterConnect.connections);

    // Step 4: Configure and ping
    const pc1 = stateAfterConnect.deviceInstances.get(pc1UI.id)! as any;
    const pc2 = stateAfterConnect.deviceInstances.get(pc2UI.id)! as any;

    await pc1.executeCommand('ifconfig eth0 192.168.1.10 netmask 255.255.255.0');
    await pc2.executeCommand('ifconfig eth0 192.168.1.20 netmask 255.255.255.0');

    const pingResult = await pc1.executeCommand('ping -c 1 192.168.1.20');
    expect(pingResult).toContain('1 received');
    expect(pingResult).not.toContain('100% packet loss');
  });

  it('should show ARP table after ping through store flow', async () => {
    const store = useNetworkStore.getState();

    const pc1UI = store.addDevice('linux-pc', 100, 100);
    const pc2UI = store.addDevice('linux-pc', 400, 100);
    const swUI = store.addDevice('cisco-switch', 250, 250);

    store.addConnection(pc1UI.id, 'eth0', swUI.id, 'eth0', 'ethernet');
    store.addConnection(pc2UI.id, 'eth0', swUI.id, 'eth1', 'ethernet');

    const state = useNetworkStore.getState();
    NetworkSimulator.initialize(state.deviceInstances, state.connections);

    const pc1 = state.deviceInstances.get(pc1UI.id)! as any;
    const pc2 = state.deviceInstances.get(pc2UI.id)! as any;

    await pc1.executeCommand('ifconfig eth0 192.168.1.10 netmask 255.255.255.0');
    await pc2.executeCommand('ifconfig eth0 192.168.1.20 netmask 255.255.255.0');

    // Ping to trigger ARP
    await pc1.executeCommand('ping -c 1 192.168.1.20');

    // Check ARP table
    const arpResult = await pc1.executeCommand('arp -a');
    expect(arpResult).toContain('192.168.1.20');
  });

  it('should support re-initialization when new connections are added', async () => {
    const store = useNetworkStore.getState();

    // Step 1: Add devices
    const pc1UI = store.addDevice('linux-pc', 100, 100);
    const pc2UI = store.addDevice('linux-pc', 400, 100);
    const swUI = store.addDevice('cisco-switch', 250, 250);

    // Step 2: Initialize with NO connections first (like when devices are just added)
    let state = useNetworkStore.getState();
    NetworkSimulator.initialize(state.deviceInstances, state.connections);

    // Step 3: Then add connections (like the user connecting devices later)
    store.addConnection(pc1UI.id, 'eth0', swUI.id, 'eth0', 'ethernet');
    store.addConnection(pc2UI.id, 'eth0', swUI.id, 'eth1', 'ethernet');

    // Step 4: Re-initialize (as useEffect would do on connections change)
    state = useNetworkStore.getState();
    NetworkSimulator.initialize(state.deviceInstances, state.connections);

    // Step 5: Configure and ping
    const pc1 = state.deviceInstances.get(pc1UI.id)! as any;
    const pc2 = state.deviceInstances.get(pc2UI.id)! as any;

    await pc1.executeCommand('ifconfig eth0 192.168.1.10 netmask 255.255.255.0');
    await pc2.executeCommand('ifconfig eth0 192.168.1.20 netmask 255.255.255.0');

    const pingResult = await pc1.executeCommand('ping -c 1 192.168.1.20');
    expect(pingResult).toContain('1 received');
    expect(pingResult).not.toContain('100% packet loss');
  });
});
