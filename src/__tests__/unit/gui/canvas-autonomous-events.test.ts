/**
 * Stale canvas on autonomous network events (rapport 09 audit, item #56).
 *
 * `NetworkCanvas`/`PropertiesPanel` subscribe to the whole zustand store,
 * so any `set()` call anywhere re-renders them and picks up a fresh
 * `getDevices()` snapshot. But a port going down on a dead-interval
 * timeout, or a DHCP lease expiring, mutates the live `Equipment`
 * instance directly and never calls a store action — so nothing ever
 * told React to re-render, no matter how broad the subscription was.
 *
 * Covers the fix: the store now bridges a small allowlist of
 * "state-changed" topics off the default EventBus into a `revision`
 * bump, so an autonomous event is visible with NO store action, and NO
 * `getDevices()` call, happening in between.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { useNetworkStore } from '@/store/networkStore';
import { Logger } from '@/network/core/Logger';
import { IPAddress, SubnetMask } from '@/network/core/types';
import { __setDefaultEventBus } from '@/events/EventBus';

describe('autonomous network events reach the canvas', () => {
  beforeEach(() => {
    useNetworkStore.getState().clearAll();
  });

  it('a port going down with no store action in between bumps revision', () => {
    const store = useNetworkStore.getState();
    const created = store.addDevice('linux-pc', 10, 10);
    store.getDevices(); // establishes the bridge, same as a first render would

    const revisionBefore = useNetworkStore.getState().revision;
    created.instance.getPorts()[0].setUp(false); // autonomous — no store action
    expect(useNetworkStore.getState().revision).toBeGreaterThan(revisionBefore);

    const ui = useNetworkStore.getState().getDevices().find(d => d.id === created.id)!;
    expect(ui.interfaces[0].isUp).toBe(false);
  });

  it('an autonomous IP change (e.g. a DHCP lease clearing) bumps revision', () => {
    const store = useNetworkStore.getState();
    const created = store.addDevice('linux-pc', 10, 10);
    store.getDevices();

    const port = created.instance.getPorts()[0];
    port.configureIP(new IPAddress('192.168.1.10'), new SubnetMask('255.255.255.0'));
    const revisionBefore = useNetworkStore.getState().revision;
    port.clearIP(); // e.g. what a DHCP client does on lease expiry
    expect(useNetworkStore.getState().revision).toBeGreaterThan(revisionBefore);
  });

  it('unrelated bus traffic (e.g. a log event) does not bump revision', () => {
    const store = useNetworkStore.getState();
    store.addDevice('linux-pc', 10, 10);
    store.getDevices();

    const revisionBefore = useNetworkStore.getState().revision;
    Logger.info('dev-1', 'test:event', 'unrelated log line');
    expect(useNetworkStore.getState().revision).toBe(revisionBefore);
  });

  it('rebridges after the default EventBus is swapped (mirrors setupGlobalState.ts between tests)', () => {
    const store = useNetworkStore.getState();
    store.addDevice('linux-pc', 10, 10);
    store.getDevices(); // bridge attaches to the bus that's current right now

    // A device's port binds to whichever bus is default AT CONSTRUCTION TIME
    // (Equipment.addPort -> port.setEventBus(this.getBus())), so the swap has
    // to happen before the device that will fire the event is created — this
    // is what actually happens between test files via setupGlobalState.ts's
    // `__setDefaultEventBus(null)` beforeEach.
    __setDefaultEventBus(null);
    const created = store.addDevice('linux-pc', 60, 10); // built against the NEW bus
    store.getDevices(); // must notice the swap, not stay subscribed to the old (dead) bus

    const revisionBefore = useNetworkStore.getState().revision;
    created.instance.getPorts()[0].setUp(false);
    expect(useNetworkStore.getState().revision).toBeGreaterThan(revisionBefore);
  });
});
