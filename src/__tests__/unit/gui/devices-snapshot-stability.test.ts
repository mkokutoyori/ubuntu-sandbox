/**
 * Referential stability of getDevices() snapshots (GAP §11.2).
 *
 * The canvas re-renders on every store tick; what prunes the re-render
 * storm is that getDevices() keeps the SAME object/array references
 * while nothing visibly changed, and only the mutated device gets a new
 * snapshot. Crucially this is NOT a blind cache: device state mutated
 * outside the store (e.g. an IP configured from a terminal) must still
 * surface on the next call.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { useNetworkStore } from '@/store/networkStore';
import { IPAddress, SubnetMask } from '@/network/core/types';

describe('getDevices() referential stability', () => {
  beforeEach(() => {
    useNetworkStore.getState().clearAll();
  });

  it('returns the same array and objects when nothing changed', () => {
    const store = useNetworkStore.getState();
    store.addDevice('linux-pc', 10, 10);
    store.addDevice('router-cisco', 50, 50);
    const a = store.getDevices();
    const b = store.getDevices();
    expect(b).toBe(a);
    expect(b[0]).toBe(a[0]);
    expect(b[1]).toBe(a[1]);
  });

  it('moving one device renews only its snapshot, not the neighbours', () => {
    const store = useNetworkStore.getState();
    const moved = store.addDevice('linux-pc', 10, 10);
    store.addDevice('router-cisco', 50, 50);
    const before = store.getDevices();

    store.moveDevice(moved.id, 200, 220);
    const after = useNetworkStore.getState().getDevices();

    expect(after).not.toBe(before);
    const movedAfter = after.find(d => d.id === moved.id)!;
    const otherAfter = after.find(d => d.id !== moved.id)!;
    const otherBefore = before.find(d => d.id !== moved.id)!;
    expect(movedAfter.x).toBe(200);
    expect(movedAfter.y).toBe(220);
    expect(movedAfter).not.toBe(before.find(d => d.id === moved.id));
    expect(otherAfter).toBe(otherBefore);
  });

  it('moveDevice signals via revision without copying the instances Map', () => {
    const store = useNetworkStore.getState();
    const dev = store.addDevice('linux-pc', 10, 10);
    const mapBefore = useNetworkStore.getState().deviceInstances;
    const revBefore = useNetworkStore.getState().revision;

    store.moveDevice(dev.id, 99, 99);

    const state = useNetworkStore.getState();
    expect(state.deviceInstances).toBe(mapBefore);
    expect(state.revision).toBe(revBefore + 1);
    expect(state.deviceInstances.get(dev.id)!.getPosition()).toEqual({ x: 99, y: 99 });
  });

  it('NOT a stale cache: out-of-store mutations surface on the next call', () => {
    const store = useNetworkStore.getState();
    const ui = store.addDevice('linux-pc', 10, 10);
    const before = store.getDevices().find(d => d.id === ui.id)!;
    expect(before.interfaces[0].ipAddress).toBeUndefined();

    // Mutate the live instance the way a terminal command would —
    // no store action involved.
    const instance = store.getDevice(ui.id)!;
    instance.getPorts()[0].configureIP(
      new IPAddress('192.168.1.10'), new SubnetMask('255.255.255.0'));

    const after = store.getDevices().find(d => d.id === ui.id)!;
    expect(after).not.toBe(before);
    expect(after.interfaces[0].ipAddress).toBe('192.168.1.10');
  });

  it('renaming via updateDevice renews that snapshot', () => {
    const store = useNetworkStore.getState();
    const ui = store.addDevice('linux-pc', 10, 10);
    const before = store.getDevices().find(d => d.id === ui.id)!;
    store.updateDevice(ui.id, { name: 'edge-fw' });
    const after = useNetworkStore.getState().getDevices().find(d => d.id === ui.id)!;
    expect(after).not.toBe(before);
    expect(after.name).toBe('edge-fw');
  });

  it('adding and removing devices changes the array membership', () => {
    const store = useNetworkStore.getState();
    const a = store.addDevice('linux-pc', 10, 10);
    const arr1 = store.getDevices();
    expect(arr1).toHaveLength(1);
    store.addDevice('router-cisco', 50, 50);
    const arr2 = useNetworkStore.getState().getDevices();
    expect(arr2).toHaveLength(2);
    expect(arr2).not.toBe(arr1);
    useNetworkStore.getState().removeDevice(a.id);
    expect(useNetworkStore.getState().getDevices()).toHaveLength(1);
  });
});
