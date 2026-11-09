/*
 * Probe: a saved lab replays each FortiGate's configuration text line by line. The firewall policy rendered BEFORE the
 * UTM profiles, user groups and traffic shapers it names, so on reopening `set ips-sensor "x"`, `set webfilter-profile`,
 * `set av-profile`, `set groups` and `set traffic-shaper` hit "entry not found in datasource" and were dropped (the
 * importer only collects the rejection as a warning): the reopened firewall forwarded without the inspection the lab
 * had been built to demonstrate. The policy family (firewall policy, shaping policy, DoS and local-in policies, central
 * SNAT) now renders after the objects it references, as a FortiGate's own configuration does.
 *
 * Discriminated with git stash on src/network: 5 of 6 fall before the fix; the witness (the references are there
 * before the export) passes either way.
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
    'config system interface', 'edit port1', 'set mode static', 'set ip 10.0.0.1 255.255.255.0', 'next',
    'edit port2', 'set mode static', 'set ip 10.1.0.1 255.255.255.0', 'next', 'end',
    'config ips sensor', 'edit "SENSOR"', 'config entries', 'edit 1', 'set severity high', 'next', 'end', 'next', 'end',
    'config webfilter profile', 'edit "WEB"', 'next', 'end',
    'config antivirus profile', 'edit "AV"', 'next', 'end',
    'config user local', 'edit "alice"', 'set type password', 'set passwd "Secret2026!"', 'next', 'end',
    'config user group', 'edit "STAFF"', 'set member "alice"', 'next', 'end',
    'config firewall shaper traffic-shaper', 'edit "SLOW"', 'set maximum-bandwidth 1000', 'next', 'end',
    'config firewall policy', 'edit 1', 'set srcintf "port1"', 'set dstintf "port2"', 'set srcaddr "all"',
    'set dstaddr "all"', 'set service "ALL"', 'set action accept', 'set schedule "always"',
    'set utm-status enable', 'set inspection-mode flow', 'set ips-sensor "SENSOR"', 'set webfilter-profile "WEB"',
    'set av-profile "AV"', 'set groups "STAFF"', 'next', 'end',
    'config firewall shaping-policy', 'edit 1', 'set srcintf "port1"', 'set dstintf "port2"', 'set srcaddr "all"',
    'set dstaddr "all"', 'set service "ALL"', 'set traffic-shaper "SLOW"', 'next', 'end');
  return fgt;
}

async function reopened(fgt: FortiGate): Promise<FortiGate> {
  const devices = new Map<string, Equipment>([[fgt.getId(), fgt as Equipment]]);
  const saved = JSON.parse(JSON.stringify(exportTopology('lab', devices, [])));
  EquipmentRegistry.resetInstance(); resetCounters(); resetDeviceCounters(); MACAddress.resetCounter();
  const imported = await importTopology(saved);
  return [...imported.deviceInstances.values()][0] as FortiGate;
}

describe('a reopened lab keeps what a policy names', () => {
  it('witness: the references are there before the export', async () => {
    const policy = await (await build()).executeCommand('show firewall policy 1');
    expect(policy).toContain('set ips-sensor "SENSOR"');
    expect(policy).toContain('set groups "STAFF"');
  });

  it('the IPS sensor', async () => {
    expect(await (await reopened(await build())).executeCommand('show firewall policy 1')).toContain('set ips-sensor "SENSOR"');
  });

  it('the web filter profile', async () => {
    expect(await (await reopened(await build())).executeCommand('show firewall policy 1')).toContain('set webfilter-profile "WEB"');
  });

  it('the antivirus profile', async () => {
    expect(await (await reopened(await build())).executeCommand('show firewall policy 1')).toContain('set av-profile "AV"');
  });

  it('the user group', async () => {
    expect(await (await reopened(await build())).executeCommand('show firewall policy 1')).toContain('set groups "STAFF"');
  });

  it('the traffic shaper of a shaping policy', async () => {
    expect(await (await reopened(await build())).executeCommand('show firewall shaping-policy 1')).toContain('set traffic-shaper "SLOW"');
  });
});
