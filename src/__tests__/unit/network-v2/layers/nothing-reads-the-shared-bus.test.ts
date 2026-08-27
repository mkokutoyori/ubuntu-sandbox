/**
 * PRD-Suppression-Bus-Partage increment 5a — production reads nothing
 * from the shared bus.
 *
 * Written BLIND. Increments 1 to 4 removed the three cross-machine
 * readers named in the PRD's opening measurement. Two readers were found
 * afterwards and are the subject here:
 *
 *   - `terminal/sessions/FortiTerminalSession` watches `device.power-on`
 *     on the global bus and filters by id — the filter is the tell: the
 *     source was wider than the question. Its device has its own bus.
 *   - `store/networkStore` bridges `port.link.*` and
 *     `port.config.ip-changed` into a canvas revision. The store OWNS
 *     `deviceInstances`, so it can watch the devices it holds instead of
 *     a channel anyone can write to.
 *
 * The behavioural cases pin what must NOT change: the canvas still
 * refreshes when a link goes down with no store action anywhere near it,
 * which is the whole reason that bridge exists.
 *
 * The structural case is the guard, and it is deliberately about
 * SUBSCRIBING rather than about the symbol: a machine relaying its own
 * events one way to an observer is what `PRD-Frame-Only-Refactor.md`
 * sanctions for Logger/UI/tests. What must never come back is production
 * code READING that relay — that is the only shape in which a shared bus
 * becomes a communication channel again. Cutting the relay itself is
 * increment 5b, and it converts 37 test files.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { useNetworkStore } from '@/store/networkStore';

beforeEach(() => {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();
  useNetworkStore.getState().clearAll();
});

describe('the canvas still refreshes on an autonomous link change', () => {
  it('a link going down bumps the revision with no store action', () => {
    const store = useNetworkStore.getState();
    const created = store.addDevice('linux-pc', 0, 0);
    const device = useNetworkStore.getState().deviceInstances.get(created.id) as LinuxPC;
    device.powerOn();
    const peer = new LinuxPC('linux-pc', 'PEER', -150, 0);
    peer.powerOn();
    new Cable('c1').connect(peer.getPort('eth0')!, device.getPort('eth0')!);
    useNetworkStore.getState().getDevices();
    const before = useNetworkStore.getState().revision;

    device.getPort('eth0')!.setAdminDown(true);

    expect(useNetworkStore.getState().revision).toBeGreaterThan(before);
  });
});

describe('no production file subscribes to the shared bus', () => {
  it('the symbol is never subscribed to outside src/events', () => {
    const hits = execSync(
      "grep -rn 'getDefaultEventBus()\\.subscribe' src/ --include=*.ts --include=*.tsx "
      + "| grep -v __tests__ | grep -v '^src/events/' || true",
      { encoding: 'utf8' }).trim();

    expect(hits).toBe('');
  });

  it('the FortiOS console watches its own device', () => {
    const source = readFileSync('src/terminal/sessions/FortiTerminalSession.ts', 'utf8');

    expect(source).not.toContain('getDefaultEventBus');
    expect(source).toContain('device.getBus()');
  });

  it('the store watches the devices it holds', () => {
    const source = readFileSync('src/store/networkStore.ts', 'utf8');

    expect(/getDefaultEventBus\(\)\.subscribe/.test(source)).toBe(false);
  });
});
