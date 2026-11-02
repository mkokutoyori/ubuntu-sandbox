/**
 * `networkStore.requestDevice` is what the palette and the canvas call now
 * that a device platform may still be on its way over the network.
 *
 * A first version added the device inside an async function and handed it to
 * `onAdded` one microtask later, so React rendered the addition and the
 * selection in two commits: the polite live region announced "PC1 added to
 * canvas" and replaced it at once with "PC1 selected", and a screen reader
 * heard only the second (`e2e/canvas-accessibility.spec.ts`, which clicks the
 * palette before the platforms have loaded, caught it). The addition and
 * `onAdded` must be one synchronous step whether or not the platform was
 * loaded.
 *
 * This file imports the store and nothing that registers a platform, so the
 * first case starts with an empty registry (cases run in order). Against the
 * first version two of the three cases fall — the "same synchronous step" one
 * and the failure one (that path did not exist) — and the loaded-platform
 * case passes either way, as the witness that the synchronous path is intact.
 */
import { describe, expect, it, vi } from 'vitest';
import { useNetworkStore } from '@/store/networkStore';
import { isDevicePlatformLoaded } from '@/network/devices/deviceBuilders';
import { Logger } from '@/network/core/Logger';

function nextMacrotask(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe('networkStore.requestDevice', () => {
  it('adds a device whose platform is not loaded, and calls onAdded in the same synchronous step', async () => {
    expect(isDevicePlatformLoaded('linux-pc')).toBe(false);
    const store = useNetworkStore;
    let microtaskPassedSinceAdd = false;
    let added: { id: string; type: string } | null = null;
    const unsubscribe = store.subscribe((state, previous) => {
      if (state.deviceInstances.size > previous.deviceInstances.size) {
        queueMicrotask(() => { microtaskPassedSinceAdd = true; });
      }
    });

    let onAddedSawAGap = true;
    store.getState().requestDevice('linux-pc', 10, 20, (device) => {
      onAddedSawAGap = microtaskPassedSinceAdd;
      added = device;
    });
    expect(store.getState().getDevices()).toHaveLength(0);

    await vi.waitFor(() => expect(added).not.toBeNull(), { timeout: 60_000, interval: 20 });
    unsubscribe();

    expect(added).not.toBeNull();
    expect(added!.type).toBe('linux-pc');
    expect(store.getState().getDevices().map((device) => device.id)).toEqual([added!.id]);
    expect(onAddedSawAGap).toBe(false);
  }, 90_000);

  it('adds synchronously once the platform is loaded', () => {
    expect(isDevicePlatformLoaded('linux-pc')).toBe(true);
    const store = useNetworkStore;
    store.getState().clearAll();
    let added = false;
    store.getState().requestDevice('linux-pc', 1, 2, () => { added = true; });
    expect(added).toBe(true);
    expect(store.getState().getDevices()).toHaveLength(1);
  });

  it('reports a platform that cannot load: nothing is added, onFailed runs, the failure is logged', async () => {
    const store = useNetworkStore;
    store.getState().clearAll();
    let failure: unknown = null;
    let addedCalls = 0;
    store.getState().requestDevice('firewall-generic', 0, 0, () => { addedCalls++; }, (error) => { failure = error; });
    await nextMacrotask();

    expect(addedCalls).toBe(0);
    expect(String(failure)).toContain('Unknown device type: firewall-generic');
    expect(store.getState().getDevices()).toHaveLength(0);
    const logged = Logger.getLogsBySource('store').filter((log) => log.event === 'device-platform-load-failed');
    expect(logged).toHaveLength(1);
    expect(logged[0].level).toBe('error');
  });
});
