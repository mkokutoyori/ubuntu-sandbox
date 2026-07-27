/**
 * Undo/redo for the network graph (rapport 09 audit, item #54).
 *
 * Covers exactly the 5 graph-shape actions the audit names — add/remove
 * device, add/remove connection, move — restoring a removed device by
 * keeping the SAME Equipment instance alive (its CLI-configured state,
 * e.g. a configured IP, was never destroyed, only detached from the
 * store/registry) rather than recreating a blank one.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { useNetworkStore } from '@/store/networkStore';
import { IPAddress, SubnetMask } from '@/network/core/types';

beforeEach(() => {
  useNetworkStore.getState().clearAll();
});

describe('undo/redo — addDevice', () => {
  it('undo removes the device, redo restores the same instance', () => {
    const store = useNetworkStore.getState();
    const created = store.addDevice('linux-pc', 10, 10);
    expect(store.getDevice(created.id)).toBeDefined();

    useNetworkStore.getState().undo();
    expect(useNetworkStore.getState().getDevice(created.id)).toBeUndefined();
    expect(useNetworkStore.getState().getDevices()).toHaveLength(0);

    useNetworkStore.getState().redo();
    const restored = useNetworkStore.getState().getDevice(created.id);
    expect(restored).toBeDefined();
    expect(restored).toBe(created.instance); // same object, not a recreation
  });
});

describe('undo/redo — removeDevice', () => {
  it('undo restores the device WITH its CLI-configured state intact', () => {
    const store = useNetworkStore.getState();
    const created = store.addDevice('linux-pc', 10, 10);
    const instance = store.getDevice(created.id)!;
    instance.getPorts()[0].configureIP(new IPAddress('192.168.1.10'), new SubnetMask('255.255.255.0'));

    useNetworkStore.getState().removeDevice(created.id);
    expect(useNetworkStore.getState().getDevice(created.id)).toBeUndefined();

    useNetworkStore.getState().undo();
    const restored = useNetworkStore.getState().getDevice(created.id);
    expect(restored).toBe(instance);
    expect(restored!.getPorts()[0].getIPAddress()?.toString()).toBe('192.168.1.10');
  });

  it('undo reconnects the cables that were disconnected as a side effect', () => {
    const store = useNetworkStore.getState();
    const a = store.addDevice('linux-pc', 10, 10);
    const b = store.addDevice('linux-pc', 200, 10);
    const conn = store.addConnection(a.id, a.instance.getPorts()[0].getName(), b.id, b.instance.getPorts()[0].getName())!;
    expect(conn.cable.isConnected()).toBe(true);

    useNetworkStore.getState().removeDevice(a.id);
    expect(conn.cable.isConnected()).toBe(false);

    useNetworkStore.getState().undo();
    const state = useNetworkStore.getState();
    expect(state.getDevice(a.id)).toBe(a.instance);
    const restoredConn = state.connections.find(c => c.id === conn.id);
    expect(restoredConn).toBeDefined();
    expect(restoredConn!.cable.isConnected()).toBe(true);
  });

  it('redo removes it again', () => {
    const store = useNetworkStore.getState();
    const created = store.addDevice('linux-pc', 10, 10);
    useNetworkStore.getState().removeDevice(created.id);
    useNetworkStore.getState().undo();
    expect(useNetworkStore.getState().getDevice(created.id)).toBeDefined();

    useNetworkStore.getState().redo();
    expect(useNetworkStore.getState().getDevice(created.id)).toBeUndefined();
  });

  it('a restored device comes back powered off (documented scope limit)', () => {
    const store = useNetworkStore.getState();
    const created = store.addDevice('linux-pc', 10, 10);
    expect(created.instance.getIsPoweredOn()).toBe(true);

    useNetworkStore.getState().removeDevice(created.id);
    useNetworkStore.getState().undo();
    expect(useNetworkStore.getState().getDevice(created.id)!.getIsPoweredOn()).toBe(false);
  });
});

describe('undo/redo — move', () => {
  it('per-pixel moveDevice calls do not themselves create undo steps', () => {
    const store = useNetworkStore.getState();
    const created = store.addDevice('linux-pc', 10, 10);
    const before = useNetworkStore.getState().historyPast.length;

    store.moveDevice(created.id, 50, 50);
    store.moveDevice(created.id, 60, 60);
    store.moveDevice(created.id, 70, 70);

    expect(useNetworkStore.getState().historyPast.length).toBe(before);
  });

  it('commitMove records one step for a whole drag gesture; undo/redo restore position', () => {
    const store = useNetworkStore.getState();
    const created = store.addDevice('linux-pc', 10, 10);

    // Simulates a drag: live ticks via moveDevice, one commitMove at the end.
    store.moveDevice(created.id, 50, 50);
    store.moveDevice(created.id, 100, 100);
    store.commitMove(created.id, { x: 10, y: 10 }, { x: 100, y: 100 });

    expect(useNetworkStore.getState().getDevice(created.id)!.getPosition()).toEqual({ x: 100, y: 100 });

    useNetworkStore.getState().undo();
    expect(useNetworkStore.getState().getDevice(created.id)!.getPosition()).toEqual({ x: 10, y: 10 });

    useNetworkStore.getState().redo();
    expect(useNetworkStore.getState().getDevice(created.id)!.getPosition()).toEqual({ x: 100, y: 100 });
  });

  it('commitMove with an unchanged position is a no-op (no undo step)', () => {
    const store = useNetworkStore.getState();
    const created = store.addDevice('linux-pc', 10, 10);
    const before = useNetworkStore.getState().historyPast.length;
    store.commitMove(created.id, { x: 10, y: 10 }, { x: 10, y: 10 });
    expect(useNetworkStore.getState().historyPast.length).toBe(before);
  });
});

describe('undo/redo — connections', () => {
  function twoConnectedDevices() {
    const store = useNetworkStore.getState();
    const a = store.addDevice('linux-pc', 10, 10);
    const b = store.addDevice('linux-pc', 200, 10);
    return { a, b };
  }

  it('undo of addConnection disconnects and removes it; redo restores it', () => {
    const { a, b } = twoConnectedDevices();
    const store = useNetworkStore.getState();
    const conn = store.addConnection(a.id, a.instance.getPorts()[0].getName(), b.id, b.instance.getPorts()[0].getName())!;
    expect(conn.cable.isConnected()).toBe(true);

    useNetworkStore.getState().undo();
    expect(useNetworkStore.getState().connections).toHaveLength(0);
    expect(conn.cable.isConnected()).toBe(false);

    useNetworkStore.getState().redo();
    const state = useNetworkStore.getState();
    expect(state.connections).toHaveLength(1);
    expect(state.connections[0].cable.isConnected()).toBe(true);
  });

  it('undo of removeConnection restores it; redo removes it again', () => {
    const { a, b } = twoConnectedDevices();
    const store = useNetworkStore.getState();
    const conn = store.addConnection(a.id, a.instance.getPorts()[0].getName(), b.id, b.instance.getPorts()[0].getName())!;

    useNetworkStore.getState().removeConnection(conn.id);
    expect(useNetworkStore.getState().connections).toHaveLength(0);

    useNetworkStore.getState().undo();
    expect(useNetworkStore.getState().connections).toHaveLength(1);
    expect(useNetworkStore.getState().connections[0].cable.isConnected()).toBe(true);

    useNetworkStore.getState().redo();
    expect(useNetworkStore.getState().connections).toHaveLength(0);
  });
});

describe('undo/redo — stack discipline', () => {
  it('a new action clears the redo stack', () => {
    const store = useNetworkStore.getState();
    const a = store.addDevice('linux-pc', 10, 10);
    useNetworkStore.getState().undo();
    expect(useNetworkStore.getState().historyFuture.length).toBe(1);

    useNetworkStore.getState().addDevice('linux-pc', 50, 50);
    expect(useNetworkStore.getState().historyFuture.length).toBe(0);
    // The undone device must not have reappeared.
    expect(useNetworkStore.getState().getDevice(a.id)).toBeUndefined();
  });

  it('undo/redo on empty stacks are no-ops, not errors', () => {
    expect(() => useNetworkStore.getState().undo()).not.toThrow();
    expect(() => useNetworkStore.getState().redo()).not.toThrow();
    expect(useNetworkStore.getState().getDevices()).toHaveLength(0);
  });

  it('clearAll wipes the history stacks (a fresh canvas has nothing to undo)', () => {
    const store = useNetworkStore.getState();
    store.addDevice('linux-pc', 10, 10);
    store.addDevice('linux-pc', 50, 50);
    expect(useNetworkStore.getState().historyPast.length).toBeGreaterThan(0);

    useNetworkStore.getState().clearAll();
    expect(useNetworkStore.getState().historyPast).toHaveLength(0);
    expect(useNetworkStore.getState().historyFuture).toHaveLength(0);
  });

  it('undoing multiple actions in sequence unwinds them in reverse order', () => {
    const store = useNetworkStore.getState();
    const a = store.addDevice('linux-pc', 10, 10);
    const b = store.addDevice('linux-pc', 50, 50);
    expect(useNetworkStore.getState().getDevices()).toHaveLength(2);

    useNetworkStore.getState().undo(); // removes b
    expect(useNetworkStore.getState().getDevice(b.id)).toBeUndefined();
    expect(useNetworkStore.getState().getDevice(a.id)).toBeDefined();

    useNetworkStore.getState().undo(); // removes a
    expect(useNetworkStore.getState().getDevices()).toHaveLength(0);

    useNetworkStore.getState().redo(); // restores a
    expect(useNetworkStore.getState().getDevice(a.id)).toBeDefined();
    useNetworkStore.getState().redo(); // restores b
    expect(useNetworkStore.getState().getDevices()).toHaveLength(2);
  });
});
