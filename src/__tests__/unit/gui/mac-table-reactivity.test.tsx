/** @vitest-environment jsdom */

import { renderHook, act, waitFor } from '@testing-library/react';
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, SubnetMask, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { useMacTable } from '@/react/hooks';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.reset();
});

function lan() {
  const a = new LinuxPC('linux-pc', 'pcA', 0, 0);
  const b = new LinuxPC('linux-pc', 'pcB', 0, 0);
  const sw = new GenericSwitch('switch-generic', 'sw1', 8, 0, 0);
  a.powerOn(); b.powerOn(); sw.powerOn();
  new Cable('c1').connect(a.getPorts()[0], sw.getPorts()[0]);
  new Cable('c2').connect(b.getPorts()[0], sw.getPorts()[1]);
  const mask = new SubnetMask('255.255.255.0');
  a.getPorts()[0].configureIP(new IPAddress('10.0.0.1'), mask);
  b.getPorts()[0].configureIP(new IPAddress('10.0.0.2'), mask);
  // Building the lab is already traffic: `configureIP` announces the
  // address, so the switch has learned both MACs before a test can watch.
  // The bus event fires on FIRST learn, so a test that subscribed after
  // this point saw nothing and read as "learning publishes nothing" —
  // the switch was right, the lab had simply already taught it. Forget
  // what it learned, so the ping below is what teaches it.
  sw.clearMACTable();
  return { a, b, sw };
}

describe('switch MAC bus events', () => {
  it('learning publishes switch.mac.learned with the entry', async () => {
    const { a, sw } = lan();
    const learned: { mac: string; port: string }[] = [];
    const off = sw.getBus().subscribe('switch.mac.learned', (e) => {
      learned.push({ mac: e.payload.mac, port: e.payload.port });
    });
    await a.executeCommand('ping -c 1 10.0.0.2');
    off();
    expect(learned.length).toBeGreaterThan(0);
    expect(learned[0].port).toBeTruthy();
    expect(sw.getMACTable().length).toBeGreaterThan(0);
  });

  it('clearMACTable publishes switch.mac.cleared', () => {
    const { sw } = lan();
    let cleared = 0;
    const off = sw.getBus().subscribe('switch.mac.cleared', () => { cleared++; });
    sw.clearMACTable();
    off();
    expect(cleared).toBe(1);
  });
});

describe('useMacTable reacts to the live forwarding table', () => {
  it('starts empty, fills after traffic, empties after clear — no manual refresh', async () => {
    const { a, sw } = lan();
    const { result } = renderHook(() => useMacTable(sw));
    expect(result.current).toEqual([]);

    await act(async () => {
      await a.executeCommand('ping -c 1 10.0.0.2');
    });
    await waitFor(() => expect(result.current.length).toBeGreaterThan(0));
    expect(result.current[0].vlan).toBe(1);
    expect(result.current[0].type).toBe('dynamic');
    expect(result.current[0].mac).toMatch(/^[0-9A-Fa-f:]+$/);

    act(() => { sw.clearMACTable(); });
    await waitFor(() => expect(result.current).toEqual([]));
  });

  it('a null instance yields an empty table', () => {
    const { result } = renderHook(() => useMacTable(null));
    expect(result.current).toEqual([]);
  });
});
