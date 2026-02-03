// @vitest-environment jsdom
/**
 * TDD RED Phase - React hook-level ping test
 *
 * Tests the actual useNetworkSimulator hook in a jsdom environment
 * to verify the React useEffect fires correctly and the NetworkSimulator
 * gets initialized when devices and connections change.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useNetworkStore } from '@/store/networkStore';
import { useNetworkSimulator } from '@/hooks/useNetworkSimulator';
import { NetworkSimulator } from '@/core/network/NetworkSimulator';

describe('React hook-level ping (useNetworkSimulator integration)', () => {
  beforeEach(() => {
    // Reset store
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

  it('should initialize NetworkSimulator when devices and connections are added', async () => {
    // Mount the hook
    const { result } = renderHook(() => useNetworkSimulator());

    // Add devices and connections in the store
    let pc1Id: string;
    let pc2Id: string;

    act(() => {
      const store = useNetworkStore.getState();
      const pc1UI = store.addDevice('linux-pc', 100, 100);
      const pc2UI = store.addDevice('linux-pc', 400, 100);
      const swUI = store.addDevice('cisco-switch', 250, 250);
      pc1Id = pc1UI.id;
      pc2Id = pc2UI.id;

      store.addConnection(pc1UI.id, 'eth0', swUI.id, 'eth0', 'ethernet');
      store.addConnection(pc2UI.id, 'eth0', swUI.id, 'eth1', 'ethernet');
    });

    // After act, useEffect should have fired
    expect(result.current.isReady()).toBe(true);

    // Now test the actual ping through the wired simulator
    const state = useNetworkStore.getState();
    const pc1 = state.deviceInstances.get(pc1Id!)! as any;
    const pc2 = state.deviceInstances.get(pc2Id!)! as any;

    await pc1.executeCommand('ifconfig eth0 192.168.1.10 netmask 255.255.255.0');
    await pc2.executeCommand('ifconfig eth0 192.168.1.20 netmask 255.255.255.0');

    const pingResult = await pc1.executeCommand('ping -c 1 192.168.1.20');

    expect(pingResult).toContain('1 received');
    expect(pingResult).not.toContain('100% packet loss');
  });

  it('should re-initialize when connections change after initial load', async () => {
    const { result } = renderHook(() => useNetworkSimulator());

    let pc1Id: string;
    let pc2Id: string;
    let swId: string;

    // Step 1: Add devices only (no connections)
    act(() => {
      const store = useNetworkStore.getState();
      const pc1UI = store.addDevice('linux-pc', 100, 100);
      const pc2UI = store.addDevice('linux-pc', 400, 100);
      const swUI = store.addDevice('cisco-switch', 250, 250);
      pc1Id = pc1UI.id;
      pc2Id = pc2UI.id;
      swId = swUI.id;
    });

    // Step 2: Add connections later (like user connecting cables)
    act(() => {
      const store = useNetworkStore.getState();
      store.addConnection(pc1Id!, 'eth0', swId!, 'eth0', 'ethernet');
      store.addConnection(pc2Id!, 'eth0', swId!, 'eth1', 'ethernet');
    });

    // After act, useEffect should have re-fired with connections
    expect(result.current.isReady()).toBe(true);

    // Verify ping works
    const state = useNetworkStore.getState();
    const pc1 = state.deviceInstances.get(pc1Id!)! as any;
    const pc2 = state.deviceInstances.get(pc2Id!)! as any;

    await pc1.executeCommand('ifconfig eth0 192.168.1.10 netmask 255.255.255.0');
    await pc2.executeCommand('ifconfig eth0 192.168.1.20 netmask 255.255.255.0');

    const pingResult = await pc1.executeCommand('ping -c 1 192.168.1.20');
    expect(pingResult).toContain('1 received');
    expect(pingResult).not.toContain('100% packet loss');
  });

  it('should work with startConnecting/finishConnecting flow', async () => {
    const { result } = renderHook(() => useNetworkSimulator());

    let pc1Id: string;
    let pc2Id: string;

    act(() => {
      const store = useNetworkStore.getState();
      const pc1UI = store.addDevice('linux-pc', 100, 100);
      const pc2UI = store.addDevice('linux-pc', 400, 100);
      const swUI = store.addDevice('cisco-switch', 250, 250);
      pc1Id = pc1UI.id;
      pc2Id = pc2UI.id;

      // Use the GUI flow: startConnecting/finishConnecting
      store.startConnecting(pc1UI.id, 'eth0', 'ethernet');
      store.finishConnecting(swUI.id, 'eth0');

      store.startConnecting(pc2UI.id, 'eth0', 'ethernet');
      store.finishConnecting(swUI.id, 'eth1');
    });

    expect(result.current.isReady()).toBe(true);

    const state = useNetworkStore.getState();
    expect(state.connections.length).toBe(2);

    const pc1 = state.deviceInstances.get(pc1Id!)! as any;
    const pc2 = state.deviceInstances.get(pc2Id!)! as any;

    await pc1.executeCommand('ifconfig eth0 192.168.1.10 netmask 255.255.255.0');
    await pc2.executeCommand('ifconfig eth0 192.168.1.20 netmask 255.255.255.0');

    const pingResult = await pc1.executeCommand('ping -c 1 192.168.1.20');
    expect(pingResult).toContain('1 received');
    expect(pingResult).not.toContain('100% packet loss');
  });
});
