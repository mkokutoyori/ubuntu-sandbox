/*
 * Probe: a saved lab replays each FortiGate's configuration text line by line, in render order. The route-map rendered AFTER
 * router bgp (238 against 236), the AS-path and community lists after the route-map, so on reopening a BGP neighbour's
 * `set route-map-in`/`route-map-out` and a VRF `leak-target`'s `set route-map` hit "entry not found in datasource" and were
 * dropped (the importer only collects the rejection as a warning): the reopened unit kept the session and lost the policy. The
 * route-map now renders after the lists it matches (prefix, AS-path, community) and before router bgp.
 *
 * Discriminated with git stash on src/network: 3 of 4 fall before the fix; the witness (the references are there before the
 * export) passes either way.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { FortiGate } from '@/network/devices/firewall/vendors/fortios/FortiGate';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { exportTopology, importTopology } from '@/store/topologySerializer';
import type { Equipment } from '@/network/equipment/Equipment';

beforeEach(() => {
  EquipmentRegistry.resetInstance(); resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();
});

async function run(device: FortiGate, ...lines: string[]): Promise<void> {
  for (const line of lines) await device.executeCommand(line);
}

async function build(): Promise<FortiGate> {
  const fgt = new FortiGate('firewall-fortinet', 'FGT', 0, 0);
  await run(fgt,
    'config system interface', 'edit port1', 'set mode static', 'set ip 10.9.0.1 255.255.255.0', 'next', 'end',
    'config router prefix-list', 'edit "p"', 'config rule', 'edit 1', 'set prefix 10.0.0.0 255.0.0.0', 'set action permit', 'next', 'end', 'next', 'end',
    'config router aspath-list', 'edit "as1"', 'config rule', 'edit 1', 'set action permit', 'set regexp "^65002"', 'next', 'end', 'next', 'end',
    'config router route-map', 'edit "rm"', 'config rule', 'edit 1', 'set match-ip-address "p"', 'set match-as-path "as1"', 'next', 'end', 'next', 'end',
    'config router bgp', 'set as 65001',
    'config neighbor', 'edit "10.9.0.2"', 'set remote-as 65002', 'set route-map-in "rm"', 'set route-map-out "rm"', 'next', 'end',
    'config vrf', 'edit 0', 'config leak-target', 'edit 30', 'set interface "port1"', 'set route-map "rm"', 'next', 'end', 'next', 'end',
    'end');
  return fgt;
}

async function reopened(fgt: FortiGate): Promise<FortiGate> {
  const devices = new Map<string, Equipment>([[fgt.getId(), fgt as Equipment]]);
  const saved = JSON.parse(JSON.stringify(exportTopology('lab', devices, [])));
  EquipmentRegistry.resetInstance(); resetCounters(); resetDeviceCounters(); MACAddress.resetCounter();
  const imported = await importTopology(saved);
  expect(imported.warnings).toEqual([]);
  return [...imported.deviceInstances.values()][0] as FortiGate;
}

describe('a reopened lab keeps what BGP names', () => {
  it('witness: the references are there before the export', async () => {
    const shown = await (await build()).executeCommand('show router bgp');
    expect(shown).toContain('set route-map-in "rm"');
    expect(shown).toContain('set route-map "rm"');
  });

  it('the neighbour route-maps survive a save and reopen', async () => {
    const shown = await (await reopened(await build())).executeCommand('show router bgp');
    expect(shown).toContain('set route-map-in "rm"');
    expect(shown).toContain('set route-map-out "rm"');
  });

  it('the VRF leak route-map survives a save and reopen', async () => {
    const shown = await (await reopened(await build())).executeCommand('show router bgp');
    expect(shown).toContain('set route-map "rm"');
  });

  it('the route-map keeps the lists it matches', async () => {
    const shown = await (await reopened(await build())).executeCommand('show router route-map rm');
    expect(shown).toContain('set match-ip-address "p"');
    expect(shown).toContain('set match-as-path "as1"');
  });
});
