/**
 * PRD-Suppression-Bus-Partage increment 5b — a machine's bus reaches
 * that machine only.
 *
 * Written BLIND, and written because the increment 5a guard was too
 * weak: it matched the TEXT `getDefaultEventBus().subscribe`, which a
 * bus held in a local variable defeats — and `store/networkStore.ts`
 * defeats it exactly that way at the line that bridges autonomous port
 * events into a canvas revision. A text guard on a spelling can always
 * be spelled around; the property to hold is behavioural, so it is
 * asserted behaviourally here.
 *
 * The property: an event published on one machine's bus is observable
 * on that machine and NOWHERE else. Two machines that never share an
 * object cannot signal each other except by a frame on a cable, which
 * is the whole point of the increment.
 *
 * The TEMOIN cases are what stop this from being satisfied by a bus
 * that delivers nothing at all: the owner still hears its own event,
 * and the canvas still refreshes on an autonomous link change with no
 * store action anywhere near it.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { Cable } from '@/network/hardware/Cable';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { getDefaultEventBus } from '@/events/EventBus';
import { useNetworkStore } from '@/store/networkStore';

beforeEach(() => {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();
  useNetworkStore.getState().clearAll();
});

describe('a machine bus is the machine own bus', () => {
  it('TEMOIN: the owner hears what it publishes', () => {
    const host = new LinuxPC('linux-pc', 'HOST', 0, 0);
    let heard = 0;
    host.getBus().subscribe('port.link.down', () => { heard++; });
    host.powerOn();

    host.getPort('eth0')!.setAdminDown(true);

    expect(heard).toBeGreaterThan(0);
  });

  it('another machine does not hear it', () => {
    const host = new LinuxPC('linux-pc', 'HOST', 0, 0);
    const other = new LinuxPC('linux-pc', 'OTHER', -150, 0);
    let heard = 0;
    other.getBus().subscribe('port.link.down', () => { heard++; });
    host.powerOn();

    host.getPort('eth0')!.setAdminDown(true);

    expect(heard).toBe(0);
  });

  it('the shared bus does not hear it', () => {
    const host = new LinuxPC('linux-pc', 'HOST', 0, 0);
    let heard = 0;
    getDefaultEventBus().subscribe('port.link.down', () => { heard++; });
    host.powerOn();

    host.getPort('eth0')!.setAdminDown(true);

    expect(heard).toBe(0);
  });

  it('a frame crossing a cable is not published on the shared bus', () => {
    const a = new CiscoSwitch('switch-cisco', 'SW1', 8, 0, 0);
    const b = new CiscoSwitch('switch-cisco', 'SW2', 8, -150, 0);
    let heard = 0;
    getDefaultEventBus().subscribe('port.frame.received', () => { heard++; });

    new Cable('c1').connect(a.getPort('FastEthernet0/1')!, b.getPort('FastEthernet0/1')!);

    expect(heard).toBe(0);
  });
});

describe('the canvas still refreshes without the shared bus', () => {
  it('TEMOIN: a link going down bumps the revision with no store action', () => {
    const store = useNetworkStore.getState();
    const created = store.addDevice('linux-pc', 0, 0);
    const device = useNetworkStore.getState().deviceInstances.get(created.id) as LinuxPC;
    device.powerOn();
    useNetworkStore.getState().getDevices();
    const before = useNetworkStore.getState().revision;

    device.getPort('eth0')!.setAdminDown(true);

    expect(useNetworkStore.getState().revision).toBeGreaterThan(before);
  });

  it('a device added after the bridge is armed is watched too', () => {
    const store = useNetworkStore.getState();
    store.addDevice('linux-pc', 0, 0);
    useNetworkStore.getState().getDevices();
    const created = useNetworkStore.getState().addDevice('linux-pc', 200, 0);
    const later = useNetworkStore.getState().deviceInstances.get(created.id) as LinuxPC;
    later.powerOn();
    useNetworkStore.getState().getDevices();
    const before = useNetworkStore.getState().revision;

    later.getPort('eth0')!.setAdminDown(true);

    expect(useNetworkStore.getState().revision).toBeGreaterThan(before);
  });
});
