/**
 * TDD - UI Store-level ping test
 *
 * Simulates the exact flow a user follows in the GUI:
 * 1. Add devices via store (DeviceFactory)
 * 2. Add connections via store (ConnectionFactory)
 * 3. Store auto-initializes NetworkSimulator (synchronously!)
 * 4. Open terminal and configure IPs
 * 5. Ping between devices
 *
 * CRITICAL: The store now calls NetworkSimulator.initialize() synchronously
 * inside addDevice/addConnection/removeDevice/removeConnection.
 * No React hook or useEffect is needed for the simulator to work.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { useNetworkStore } from '@/store/networkStore';
import { NetworkSimulator } from '@/core/network/NetworkSimulator';

describe('UI Store-level ping (simulating GUI flow)', () => {
  beforeEach(() => {
    // Reset store to clean state
    useNetworkStore.getState().clearAll();
  });

  afterEach(() => {
    useNetworkStore.getState().clearAll();
  });

  it('should create devices via store and verify they are powered on', () => {
    const store = useNetworkStore.getState();

    const pc1UI = store.addDevice('linux-pc', 100, 100);
    const pc2UI = store.addDevice('linux-pc', 400, 100);
    const swUI = store.addDevice('cisco-switch', 250, 250);

    expect(pc1UI.isPoweredOn).toBe(true);
    expect(pc2UI.isPoweredOn).toBe(true);
    expect(swUI.isPoweredOn).toBe(true);

    const state = useNetworkStore.getState();
    expect(state.deviceInstances.get(pc1UI.id)!.isOnline()).toBe(true);
    expect(state.deviceInstances.get(pc2UI.id)!.isOnline()).toBe(true);
    expect(state.deviceInstances.get(swUI.id)!.isOnline()).toBe(true);
  });

  it('should create connections with instances via store', () => {
    const store = useNetworkStore.getState();

    const pc1UI = store.addDevice('linux-pc', 100, 100);
    const pc2UI = store.addDevice('linux-pc', 400, 100);
    const swUI = store.addDevice('cisco-switch', 250, 250);

    const conn1 = store.addConnection(pc1UI.id, 'eth0', swUI.id, 'eth0', 'ethernet');
    const conn2 = store.addConnection(pc2UI.id, 'eth0', swUI.id, 'eth1', 'ethernet');

    expect(conn1).not.toBeNull();
    expect(conn2).not.toBeNull();
    expect(conn1!.instance).toBeDefined();
    expect(conn2!.instance).toBeDefined();
    expect(conn1!.instance!.isActive()).toBe(true);
    expect(conn2!.instance!.isActive()).toBe(true);
  });

  it('should auto-initialize NetworkSimulator when adding connections (no manual init needed)', () => {
    const store = useNetworkStore.getState();

    store.addDevice('linux-pc', 100, 100);
    store.addDevice('cisco-switch', 250, 250);

    // After addDevice, simulator should already be initialized
    expect(NetworkSimulator.isReady()).toBe(true);
  });

  it('should enable ping between PCs WITHOUT manual NetworkSimulator.initialize()', async () => {
    const store = useNetworkStore.getState();

    // Step 1: Add devices (store auto-syncs simulator)
    const pc1UI = store.addDevice('linux-pc', 100, 100);
    const pc2UI = store.addDevice('linux-pc', 400, 100);
    const swUI = store.addDevice('cisco-switch', 250, 250);

    // Step 2: Add connections (store auto-syncs simulator)
    store.addConnection(pc1UI.id, 'eth0', swUI.id, 'eth0', 'ethernet');
    store.addConnection(pc2UI.id, 'eth0', swUI.id, 'eth1', 'ethernet');

    // NO MANUAL NetworkSimulator.initialize() CALL!

    // Step 3: Get device instances and configure
    const state = useNetworkStore.getState();
    const pc1 = state.deviceInstances.get(pc1UI.id)! as any;
    const pc2 = state.deviceInstances.get(pc2UI.id)! as any;

    await pc1.executeCommand('ifconfig eth0 192.168.1.10 netmask 255.255.255.0');
    await pc2.executeCommand('ifconfig eth0 192.168.1.20 netmask 255.255.255.0');

    // Step 4: Ping should work immediately
    const pingResult = await pc1.executeCommand('ping -c 1 192.168.1.20');
    expect(pingResult).toContain('1 received');
    expect(pingResult).not.toContain('100% packet loss');
  });

  it('should enable ping with ifconfig WITHOUT netmask (user scenario)', async () => {
    const store = useNetworkStore.getState();

    const pc1UI = store.addDevice('linux-pc', 100, 100);
    const pc2UI = store.addDevice('linux-pc', 400, 100);
    const swUI = store.addDevice('cisco-switch', 250, 250);

    store.addConnection(pc1UI.id, 'eth0', swUI.id, 'eth0', 'ethernet');
    store.addConnection(pc2UI.id, 'eth0', swUI.id, 'eth1', 'ethernet');

    const state = useNetworkStore.getState();
    const pc1 = state.deviceInstances.get(pc1UI.id)! as any;
    const pc2 = state.deviceInstances.get(pc2UI.id)! as any;

    // User types ifconfig WITHOUT netmask (as reported in the bug)
    await pc1.executeCommand('ifconfig eth0 192.168.1.10');
    await pc2.executeCommand('ifconfig eth0 192.168.1.20');

    const pingResult = await pc1.executeCommand('ping -c 1 192.168.1.20');
    expect(pingResult).toContain('1 received');
    expect(pingResult).not.toContain('100% packet loss');
  });

  it('should support loopback ping via store flow', async () => {
    const store = useNetworkStore.getState();

    const pc1UI = store.addDevice('linux-pc', 100, 100);

    const state = useNetworkStore.getState();
    const pc1 = state.deviceInstances.get(pc1UI.id)! as any;

    await pc1.executeCommand('ifconfig eth0 192.168.1.10 netmask 255.255.255.0');

    const result1 = await pc1.executeCommand('ping -c 1 192.168.1.10');
    expect(result1).toContain('1 received');

    const result2 = await pc1.executeCommand('ping -c 1 localhost');
    expect(result2).toContain('1 received');

    const result3 = await pc1.executeCommand('ping -c 1 127.0.0.1');
    expect(result3).toContain('1 received');
  });

  it('should work with finishConnecting flow (actual GUI click flow)', async () => {
    const store = useNetworkStore.getState();

    const pc1UI = store.addDevice('linux-pc', 100, 100);
    const pc2UI = store.addDevice('linux-pc', 400, 100);
    const swUI = store.addDevice('cisco-switch', 250, 250);

    // Use the GUI flow: startConnecting/finishConnecting
    store.startConnecting(pc1UI.id, 'eth0', 'ethernet');
    store.finishConnecting(swUI.id, 'eth0');
    store.startConnecting(pc2UI.id, 'eth0', 'ethernet');
    store.finishConnecting(swUI.id, 'eth1');

    // NO MANUAL NetworkSimulator.initialize()!

    const stateAfterConnect = useNetworkStore.getState();
    expect(stateAfterConnect.connections.length).toBe(2);

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
    const pc1 = state.deviceInstances.get(pc1UI.id)! as any;
    const pc2 = state.deviceInstances.get(pc2UI.id)! as any;

    await pc1.executeCommand('ifconfig eth0 192.168.1.10 netmask 255.255.255.0');
    await pc2.executeCommand('ifconfig eth0 192.168.1.20 netmask 255.255.255.0');

    await pc1.executeCommand('ping -c 1 192.168.1.20');

    const arpResult = await pc1.executeCommand('arp -a');
    expect(arpResult).toContain('192.168.1.20');
  });

  it('should handle device removal and re-addition gracefully', async () => {
    const store = useNetworkStore.getState();

    const pc1UI = store.addDevice('linux-pc', 100, 100);
    const pc2UI = store.addDevice('linux-pc', 400, 100);
    const swUI = store.addDevice('cisco-switch', 250, 250);

    store.addConnection(pc1UI.id, 'eth0', swUI.id, 'eth0', 'ethernet');
    store.addConnection(pc2UI.id, 'eth0', swUI.id, 'eth1', 'ethernet');

    // Remove PC2 (removes connections too)
    store.removeDevice(pc2UI.id);
    let state = useNetworkStore.getState();
    expect(state.connections.length).toBe(1);

    // Add a new PC2
    const pc2NewUI = store.addDevice('linux-pc', 400, 100);
    store.addConnection(pc2NewUI.id, 'eth0', swUI.id, 'eth1', 'ethernet');

    // Configure and ping
    state = useNetworkStore.getState();
    const pc1 = state.deviceInstances.get(pc1UI.id)! as any;
    const pc2New = state.deviceInstances.get(pc2NewUI.id)! as any;

    await pc1.executeCommand('ifconfig eth0 192.168.1.10 netmask 255.255.255.0');
    await pc2New.executeCommand('ifconfig eth0 192.168.1.20 netmask 255.255.255.0');

    const pingResult = await pc1.executeCommand('ping -c 1 192.168.1.20');
    expect(pingResult).toContain('1 received');
    expect(pingResult).not.toContain('100% packet loss');
  });
});
