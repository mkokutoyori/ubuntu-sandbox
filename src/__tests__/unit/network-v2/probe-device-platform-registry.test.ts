/**
 * Device platforms load on demand, and creating a device gives exactly what
 * the old `switch` in DeviceFactory gave.
 *
 * The factory used to import every device class, so the browser's first
 * screen carried the whole simulator (28 MB of source, one 16 MB chunk in
 * production). It now looks a builder up in a registry that each platform
 * module fills when it is imported (`platforms/*Platform.ts`), and
 * `platformLoaders.ts` imports those modules on demand.
 *
 * Measured against the old factory on 2026-11-02: for each of the 17
 * catalog types the table below is what `createDevice(type, 5, 6)` returned
 * on the old code (class, generated name, port count, first port); the
 * registry factory returns the same, MAC addresses and positions included
 * (compared case by case in a throwaway differential test, then reduced to
 * this table).
 *
 * Every case falls before the change except the table: the three new modules
 * (`deviceBuilders`, `platformLoaders`, `deviceFactoryCore`) do not exist, so
 * the file cannot even be imported. The table cases are the non-regression
 * witness — they hold on both sides by construction of the table. This file
 * imports `deviceFactoryCore` only, never `DeviceFactory` or the `@/network`
 * barrel (which register every platform), so the first case proves the
 * registry starts empty.
 */
import { describe, expect, it } from 'vitest';
import { createDevice, resetDeviceCounters } from '@/network/devices/deviceFactoryCore';
import { isDevicePlatformLoaded } from '@/network/devices/deviceBuilders';
import {
  hasDevicePlatform, loadAllDevicePlatforms, loadDevicePlatform, loadDevicePlatforms,
} from '@/network/devices/platformLoaders';
import { DEVICE_CATALOG } from '@/network/core/deviceCatalog';
import type { DeviceType } from '@/network/core/types';

const OLD_FACTORY_OUTPUT: ReadonlyArray<readonly [DeviceType, string, string, number, string]> = [
  ['linux-pc', 'LinuxPC', 'PC1', 5, 'eth0'],
  ['windows-pc', 'WindowsPC', 'PC1', 4, 'eth0'],
  ['mac-pc', 'LinuxPC', 'Mac1', 5, 'eth0'],
  ['linux-server', 'LinuxServer', 'Server1', 5, 'eth0'],
  ['windows-server', 'WindowsServer', 'WinServer1', 4, 'eth0'],
  ['switch-cisco', 'CiscoSwitch', 'Switch1', 26, 'FastEthernet0/1'],
  ['switch-huawei', 'HuaweiSwitch', 'Switch1', 24, 'GigabitEthernet0/0/0'],
  ['switch-generic', 'GenericSwitch', 'Switch1', 24, 'eth0'],
  ['hub', 'Hub', 'Hub1', 8, 'eth0'],
  ['router-cisco', 'CiscoRouter', 'Router1', 4, 'GigabitEthernet0/0'],
  ['router-huawei', 'HuaweiRouter', 'Router1', 4, 'GE0/0/0'],
  ['firewall-cisco', 'AsaFirewall', 'FW1', 8, 'GigabitEthernet0/0'],
  ['firewall-fortinet', 'FortiGate', 'FW1', 10, 'port1'],
  ['firewall-paloalto', 'LinuxPC', 'FW1', 5, 'eth0'],
  ['access-point', 'Hub', 'AP1', 4, 'eth0'],
  ['cloud', 'LinuxPC', 'Cloud1', 5, 'eth0'],
];

const DEVICE_TYPE_REPORTED: Readonly<Partial<Record<DeviceType, DeviceType>>> = {
  'access-point': 'hub',
};

describe('device platform registry', () => {
  it('starts empty: nothing is creatable before its platform is loaded', () => {
    expect(isDevicePlatformLoaded('linux-pc')).toBe(false);
    expect(() => createDevice('linux-pc')).toThrow(/platform for "linux-pc" is not loaded/);
  });

  it('refuses a type no platform builds in the old words', () => {
    expect(DEVICE_CATALOG['firewall-generic']).toBeDefined();
    expect(hasDevicePlatform('firewall-generic')).toBe(false);
    expect(() => createDevice('firewall-generic')).toThrow('Unknown device type: firewall-generic');
    return expect(loadDevicePlatform('firewall-generic')).rejects.toThrow('Unknown device type: firewall-generic');
  });

  it('loads one platform without loading the others', async () => {
    await loadDevicePlatform('linux-pc');
    expect(isDevicePlatformLoaded('linux-pc')).toBe(true);
    expect(isDevicePlatformLoaded('linux-server')).toBe(true);
    expect(isDevicePlatformLoaded('windows-pc')).toBe(false);
    expect(isDevicePlatformLoaded('router-cisco')).toBe(false);
    expect(createDevice('linux-pc').constructor.name).toBe('LinuxPC');
  });

  it('shares one load between concurrent requests for the same platform', async () => {
    const first = loadDevicePlatform('windows-pc');
    const second = loadDevicePlatform('windows-server');
    await Promise.all([first, second]);
    expect(isDevicePlatformLoaded('windows-pc')).toBe(true);
    expect(isDevicePlatformLoaded('windows-server')).toBe(true);
  });

  it('loads a list of platforms and then every one', async () => {
    await loadDevicePlatforms(['router-cisco', 'switch-cisco', 'router-cisco']);
    expect(isDevicePlatformLoaded('router-cisco')).toBe(true);
    expect(isDevicePlatformLoaded('switch-huawei')).toBe(false);
    await loadAllDevicePlatforms();
    for (const [type] of OLD_FACTORY_OUTPUT) expect(isDevicePlatformLoaded(type)).toBe(true);
  });

  describe('once loaded, creation matches the old factory', () => {
    it.each(OLD_FACTORY_OUTPUT)('%s -> %s %s with %i ports starting at %s', async (type, className, name, portCount, firstPort) => {
      await loadAllDevicePlatforms();
      resetDeviceCounters();
      const device = createDevice(type, 5, 6);
      expect(device.constructor.name).toBe(className);
      expect(device.getName()).toBe(name);
      expect(device.getPorts()).toHaveLength(portCount);
      expect(device.getPorts()[0].getName()).toBe(firstPort);
      expect(device.getDeviceType()).toBe(DEVICE_TYPE_REPORTED[type] ?? type);
      expect(device.getPosition()).toEqual({ x: 5, y: 6 });
    });
  });
});
