/*
 * Probe — a saved topology keeps the symbolic links an operator created, and the type of the registry values
 * it set.
 *
 * Measured first: on a Linux server where `ln -s /etc/nginx/sites-available/site /etc/nginx/sites-enabled/site`
 * enabled a virtual host, the export carried the file in sites-available and forgot the link, so the reopened
 * nginx answered 404 for the site (no `server` block was enabled) while `systemctl status` said "active".
 * On a Windows host, `reg add ... /t REG_MULTI_SZ` came back as REG_SZ: the export wrote `{ path, name, value }`
 * and the import re-created the value with the type its JavaScript type suggests.
 *
 * Authority: symlink(2) — a link is an inode of its own whose content is the target STRING, relative or
 * absolute, which the kernel resolves at use; and the registry value types REG_SZ, REG_MULTI_SZ, REG_DWORD
 * of the Windows registry reference (winnt.h), where the type is part of the value.
 *
 * Discrimination (the probe run on the tree before the change): 3 of the 5 cases fall. The two that pass either
 * way are the WITNESSES of the lab (the link and the multi-string exist before any export).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters, MACAddress } from '@/network/core/types';
import { createDevice, resetDeviceCounters } from '@/network/devices/DeviceFactory';
import type { WindowsPC } from '@/network/devices/WindowsPC';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import type { Equipment } from '@/network/equipment/Equipment';
import { exportTopology, importTopology, type TopologyExport } from '@/store/topologySerializer';

beforeEach(() => {
  resetCounters();
  MACAddress.resetCounter();
  resetDeviceCounters();
  Logger.reset();
  EquipmentRegistry.resetInstance();
});

async function reopen(...devices: Equipment[]): Promise<Map<string, Equipment>> {
  const exported = JSON.parse(JSON.stringify(
    exportTopology('lab', new Map(devices.map((d) => [d.getId(), d])), []),
  )) as TopologyExport;
  EquipmentRegistry.resetInstance();
  const imported = await importTopology(exported);
  return new Map([...imported.deviceInstances.values()].map((d) => [d.getName(), d]));
}

async function linuxLab(): Promise<Equipment> {
  const server = createDevice('linux-server', 0, 0, 'WEB');
  await server.executeCommand('sudo ln -s /etc/hostname /etc/lab-link');
  await server.executeCommand('sudo rm /etc/nginx/sites-enabled/default');
  await server.executeCommand('sudo ln -s ../sites-available/default /etc/nginx/sites-enabled/site2');
  return server;
}

async function windowsLab(): Promise<Equipment> {
  const host = createDevice('windows-pc', 0, 0, 'WIN') as unknown as WindowsPC;
  host.powerOn();
  host.setCurrentUser('Administrator');
  await host.executeCommand('reg add HKLM\\SOFTWARE\\Lab /v Names /t REG_MULTI_SZ /d "alpha\\0beta" /f');
  await host.executeCommand('reg add HKLM\\SOFTWARE\\Lab /v Count /t REG_DWORD /d 7 /f');
  await host.executeCommand('reg add HKLM\\SOFTWARE\\Lab /v Label /t REG_SZ /d hello /f');
  return host as unknown as Equipment;
}

describe('symbolic links', () => {
  it('the link exists before any export — WITNESS', async () => {
    const server = await linuxLab();

    expect(await server.executeCommand('readlink /etc/lab-link')).toBe('/etc/hostname');
    expect(await server.executeCommand('readlink /etc/nginx/sites-enabled/site2')).toBe('../sites-available/default');
  }, 60000);

  it('survive a reopening, absolute and relative, with their target text unchanged', async () => {
    const devices = await reopen(await linuxLab());

    const server = devices.get('WEB')!;
    expect(await server.executeCommand('readlink /etc/lab-link')).toBe('/etc/hostname');
    expect(await server.executeCommand('readlink /etc/nginx/sites-enabled/site2')).toBe('../sites-available/default');
  }, 60000);

  it('a removed link stays removed, and the factory links are not exported', async () => {
    const server = await linuxLab();
    const exported = exportTopology('lab', new Map([[server.getId(), server]]), []);
    const symlinks = exported.devices[0].symlinks?.map((link) => link.path) ?? [];

    expect(symlinks).toContain('/etc/lab-link');
    expect(symlinks).not.toContain('/bin');
    const devices = await reopen(server);
    expect(await devices.get('WEB')!.executeCommand('ls /etc/nginx/sites-enabled')).not.toContain('default');
  }, 60000);
});

describe('registry value types', () => {
  it('the multi-string exists before any export — WITNESS', async () => {
    const host = await windowsLab();

    expect(await host.executeCommand('reg query HKLM\\SOFTWARE\\Lab')).toMatch(/Names\s+REG_MULTI_SZ/);
  }, 60000);

  it('REG_MULTI_SZ keeps its type, REG_DWORD and REG_SZ are unchanged', async () => {
    const devices = await reopen(await windowsLab());

    const dump = await devices.get('WIN')!.executeCommand('reg query HKLM\\SOFTWARE\\Lab');
    expect(dump).toMatch(/Names\s+REG_MULTI_SZ\s+alpha\\0beta/);
    expect(dump).toMatch(/Count\s+REG_DWORD\s+0x7/);
    expect(dump).toMatch(/Label\s+REG_SZ\s+hello/);
  }, 60000);
});
