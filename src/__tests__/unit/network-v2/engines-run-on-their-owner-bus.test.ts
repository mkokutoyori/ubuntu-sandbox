import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { HuaweiRouter } from '@/network/devices/HuaweiRouter';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { MACAddress, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import type { Equipment } from '@/network/equipment/Equipment';
import { getDefaultEventBus } from '@/events/EventBus';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
  EquipmentRegistry.resetInstance();
});

/**
 * An engine advertises its bus seam by carrying a `busOverride` field
 * alongside a `setEventBus` method — the shape every reactive engine in
 * `src/network` uses. `busOverride === null` means it never received one
 * and publishes on the process-wide default instead.
 */
type BusHolder = { busOverride: unknown; setEventBus: (b: unknown) => void };

function isBusHolder(v: unknown): v is BusHolder {
  if (v === null || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return 'busOverride' in o && typeof o.setEventBus === 'function';
}

/** Every engine reachable from a device, with the path that reaches it. */
function reachableEngines(root: object, maxDepth = 4): Map<string, BusHolder> {
  const found = new Map<string, BusHolder>();
  const seen = new WeakSet<object>();

  const walk = (node: unknown, path: string, depth: number): void => {
    if (depth > maxDepth || node === null || typeof node !== 'object') return;
    if (seen.has(node as object)) return;
    seen.add(node as object);
    if (Array.isArray(node) || node instanceof Map || node instanceof Set) return;
    if (isBusHolder(node)) found.set(path, node);

    for (const key of Object.keys(node)) {
      let child: unknown;
      try { child = (node as Record<string, unknown>)[key]; } catch { continue; }
      if (child === null || typeof child !== 'object') continue;
      if (child instanceof Date || child instanceof RegExp) continue;
      walk(child, path ? `${path}.${key}` : key, depth + 1);
    }
  };

  walk(root, '', 0);
  return found;
}

const busOf = (d: Equipment) => (d as unknown as { getBus: () => unknown }).getBus();

/**
 * The device's own bus forwards everything it carries up to the default
 * one, so an engine on the owner's bus stays just as observable — what
 * changes is that another device can no longer receive its events.
 */
function offOwnerBus(device: Equipment): string[] {
  const own = busOf(device);
  const wrong: string[] = [];
  for (const [path, engine] of reachableEngines(device as unknown as object)) {
    // The device itself owns the bus rather than receiving one, so its
    // own `busOverride` is legitimately unset.
    if (path === '') continue;
    if (engine.busOverride !== own) wrong.push(path);
  }
  return wrong;
}

async function configuredCiscoRouter(name: string): Promise<CiscoRouter> {
  const r = new CiscoRouter(name, 0, 0);
  const iface = r.getPortNames()[0];
  for (const cmd of [
    'enable', 'configure terminal', `hostname ${name}`,
    `interface ${iface}`, 'ip address 10.0.0.1 255.255.255.0', 'no shutdown', 'exit',
    'router ospf 1', 'network 10.0.0.0 0.0.0.255 area 0', 'exit',
    'router rip', 'version 2', 'network 10.0.0.0', 'end',
  ]) await r.executeCommand(cmd);
  return r;
}

describe('every engine a device owns publishes on that device\'s bus', () => {
  it('a configured Cisco router leaves no engine on the process-wide default bus', async () => {
    const r = await configuredCiscoRouter('R1');
    expect(
      offOwnerBus(r),
      'an engine still on the default bus meets every other device\'s events there, ' +
      'and can only tell them apart by filtering on a device id',
    ).toEqual([]);
  }, 40000);

  it('a Huawei router, a switch, a Linux host and a Windows host too', async () => {
    const devices: Equipment[] = [
      new HuaweiRouter('R2', 0, 0),
      new CiscoSwitch('switch-cisco', 'SW1', 24, 0, 0),
      new LinuxPC('linux-pc', 'PC1', 0, 0),
      new WindowsPC('windows-pc', 'WIN1', 0, 0),
    ];
    const offenders = devices.flatMap((d) =>
      offOwnerBus(d).map((p) => `${d.constructor.name}.${p}`),
    );
    expect(offenders).toEqual([]);
  }, 40000);

  it('a device\'s bus still forwards to the default one, so observers lose nothing', async () => {
    const r = await configuredCiscoRouter('R3');
    const seen: string[] = [];
    getDefaultEventBus().subscribeAll((e) => seen.push(e.topic));
    await r.executeCommand('configure terminal');
    await r.executeCommand('interface ' + r.getPortNames()[1]);
    await r.executeCommand('shutdown');
    await r.executeCommand('end');
    expect(
      seen.length,
      'moving engines onto the owner bus must not make the Logger/UI tap go quiet',
    ).toBeGreaterThan(0);
  }, 40000);
});
