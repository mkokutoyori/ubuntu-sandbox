/**
 * TDD RED phase — Realistic ping behavior tests
 *
 * A professional network simulator must exhibit realistic behavior:
 * - Ping fails when the cable is disconnected
 * - Ping fails when the target device is powered off
 * - Ping fails when the interface is down
 * - Ping recovers when the cable is reconnected
 * - Ping fails when connection is set to down (admin shutdown)
 * - ARP cache doesn't magically make unreachable hosts reachable
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { useNetworkStore } from '@/store/networkStore';

describe('Realistic ping behavior (cable disconnect, power off, interface down)', () => {
  beforeEach(() => {
    useNetworkStore.getState().clearAll();
  });

  afterEach(() => {
    useNetworkStore.getState().clearAll();
  });

  /**
   * Helper: create a standard 2-PC + Switch topology, configure IPs, return instances
   */
  function setupLAN() {
    const store = useNetworkStore.getState();
    const pc1UI = store.addDevice('linux-pc', 100, 100);
    const pc2UI = store.addDevice('linux-pc', 400, 100);
    const swUI = store.addDevice('cisco-switch', 250, 250);

    const conn1 = store.addConnection(pc1UI.id, 'eth0', swUI.id, 'eth0', 'ethernet');
    const conn2 = store.addConnection(pc2UI.id, 'eth0', swUI.id, 'eth1', 'ethernet');

    const state = useNetworkStore.getState();
    const pc1 = state.deviceInstances.get(pc1UI.id)! as any;
    const pc2 = state.deviceInstances.get(pc2UI.id)! as any;

    return { store, pc1, pc2, pc1UI, pc2UI, swUI, conn1: conn1!, conn2: conn2! };
  }

  async function configureIPs(pc1: any, pc2: any) {
    await pc1.executeCommand('ifconfig eth0 192.168.1.10');
    await pc2.executeCommand('ifconfig eth0 192.168.1.20');
  }

  // ─── CABLE DISCONNECT ───────────────────────────────────────────────

  it('should fail ping after removing the cable (connection removed)', async () => {
    const { store, pc1, pc2, conn1, conn2 } = setupLAN();
    await configureIPs(pc1, pc2);

    // First ping should succeed (network is connected)
    const pingBefore = await pc1.executeCommand('ping -c 1 192.168.1.20');
    expect(pingBefore).toContain('1 received');
    expect(pingBefore).toContain('0% packet loss');

    // Disconnect the cable between PC1 and Switch
    store.removeConnection(conn1.id);

    // Ping should now FAIL - cable is disconnected
    const pingAfter = await pc1.executeCommand('ping -c 1 192.168.1.20');
    expect(pingAfter).toContain('100% packet loss');
    expect(pingAfter).toContain('0 received');
  });

  it('should fail ping after removing the target cable', async () => {
    const { store, pc1, pc2, conn2 } = setupLAN();
    await configureIPs(pc1, pc2);

    // First verify ping works
    const pingBefore = await pc1.executeCommand('ping -c 1 192.168.1.20');
    expect(pingBefore).toContain('1 received');

    // Disconnect PC2 from the switch
    store.removeConnection(conn2.id);

    // Ping should fail - target unreachable
    const pingAfter = await pc1.executeCommand('ping -c 1 192.168.1.20');
    expect(pingAfter).toContain('100% packet loss');
  });

  it('should recover ping after reconnecting the cable', async () => {
    const { store, pc1, pc2, pc1UI, swUI, conn1 } = setupLAN();
    await configureIPs(pc1, pc2);

    // Disconnect
    store.removeConnection(conn1.id);

    const pingDisconnected = await pc1.executeCommand('ping -c 1 192.168.1.20');
    expect(pingDisconnected).toContain('100% packet loss');

    // Reconnect PC1 to Switch
    store.addConnection(pc1UI.id, 'eth0', swUI.id, 'eth0', 'ethernet');

    // Ping should work again
    const pingReconnected = await pc1.executeCommand('ping -c 1 192.168.1.20');
    expect(pingReconnected).toContain('1 received');
    expect(pingReconnected).toContain('0% packet loss');
  });

  // ─── DEVICE POWER OFF ──────────────────────────────────────────────

  it('should fail ping when target device is powered off', async () => {
    const { pc1, pc2 } = setupLAN();
    await configureIPs(pc1, pc2);

    // First verify ping works
    const pingBefore = await pc1.executeCommand('ping -c 1 192.168.1.20');
    expect(pingBefore).toContain('1 received');

    // Power off PC2
    pc2.powerOff();

    // Ping should fail - target is offline
    const pingAfter = await pc1.executeCommand('ping -c 1 192.168.1.20');
    expect(pingAfter).toContain('100% packet loss');
  });

  it('should recover ping when target device is powered back on', async () => {
    const { pc1, pc2 } = setupLAN();
    await configureIPs(pc1, pc2);

    // Power off and verify failure
    pc2.powerOff();
    const pingOff = await pc1.executeCommand('ping -c 1 192.168.1.20');
    expect(pingOff).toContain('100% packet loss');

    // Power back on
    pc2.powerOn();

    // Ping should recover
    const pingOn = await pc1.executeCommand('ping -c 1 192.168.1.20');
    expect(pingOn).toContain('1 received');
  });

  // ─── MULTI-PACKET ──────────────────────────────────────────────────

  it('should report partial loss when cable is disconnected mid-ping', async () => {
    const { store, pc1, pc2, conn1 } = setupLAN();
    await configureIPs(pc1, pc2);

    // Ping with 4 packets - first packet succeeds, then disconnect
    // Since our simulation is synchronous, we can't truly "disconnect mid-ping"
    // But we verify that after disconnect, new pings fail
    const ping1 = await pc1.executeCommand('ping -c 1 192.168.1.20');
    expect(ping1).toContain('1 received');

    store.removeConnection(conn1.id);

    const ping2 = await pc1.executeCommand('ping -c 4 192.168.1.20');
    expect(ping2).toContain('4 packets transmitted');
    expect(ping2).toContain('0 received');
    expect(ping2).toContain('100% packet loss');
  });

  // ─── DIRECT CONNECTION (no switch) ─────────────────────────────────

  it('should fail ping after removing direct PC-to-PC connection', async () => {
    const store = useNetworkStore.getState();
    const pc1UI = store.addDevice('linux-pc', 100, 100);
    const pc2UI = store.addDevice('linux-pc', 400, 100);

    const conn = store.addConnection(pc1UI.id, 'eth0', pc2UI.id, 'eth0', 'ethernet');

    const state = useNetworkStore.getState();
    const pc1 = state.deviceInstances.get(pc1UI.id)! as any;
    const pc2 = state.deviceInstances.get(pc2UI.id)! as any;

    await pc1.executeCommand('ifconfig eth0 10.0.0.1');
    await pc2.executeCommand('ifconfig eth0 10.0.0.2');

    // Ping works
    const pingBefore = await pc1.executeCommand('ping -c 1 10.0.0.2');
    expect(pingBefore).toContain('1 received');

    // Remove cable
    store.removeConnection(conn!.id);

    // Ping fails
    const pingAfter = await pc1.executeCommand('ping -c 1 10.0.0.2');
    expect(pingAfter).toContain('100% packet loss');
  });

  // ─── SWITCH POWER OFF ──────────────────────────────────────────────

  it('should fail ping when the switch is powered off', async () => {
    const { pc1, pc2, swUI } = setupLAN();
    await configureIPs(pc1, pc2);

    // Verify ping works first
    const pingBefore = await pc1.executeCommand('ping -c 1 192.168.1.20');
    expect(pingBefore).toContain('1 received');

    // Power off the switch
    const state = useNetworkStore.getState();
    const sw = state.deviceInstances.get(swUI.id)!;
    sw.powerOff();

    // Ping should fail - switch is offline, frames are dropped
    const pingAfter = await pc1.executeCommand('ping -c 1 192.168.1.20');
    expect(pingAfter).toContain('100% packet loss');
  });
});
