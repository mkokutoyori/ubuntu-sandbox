/*
 * Probe: `config router static` > `set bfd enable` (FortiOS CLI Reference 7.4.12 p.1204: "Enable/disable Bidirectional
 * Forwarding Detection (BFD)") was refused as an unknown attribute. The firewall already ran a BFD agent for `router bfd`
 * neighbours and BGP peers; a static route that names a gateway now provisions a session to that gateway on the route's
 * device, and is withdrawn from the routing table while that session is not up, as a BGP peer is held down. A route without
 * `bfd` is untouched by the session state.
 *
 * Discriminated with git stash on src/network: 4 of 6 fall before the fix; two pass either way and are named: the witness
 * (the plain static route stays installed while the neighbour is silent) and "installed while the session is up" (a
 * non-regression: the route is there with or without BFD).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { loadAllDevicePlatforms } from '@/network';
import { useNetworkStore } from '@/store/networkStore';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { Logger } from '@/network/core/Logger';
import { LabWorkbench } from '@/labs/LabWorkbench';
import { VirtualTimeScheduler, __setDefaultScheduler } from '@/events/Scheduler';

beforeEach(async () => {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); EquipmentRegistry.resetInstance(); Logger.reset();
  await loadAllDevicePlatforms();
  useNetworkStore.getState().clearAll();
});

async function lab(bfd: boolean) {
  const clock = new VirtualTimeScheduler();
  __setDefaultScheduler(clock);
  const bench = new LabWorkbench();
  const a = bench.place('firewall-fortinet', 'A', 0, 0);
  const b = bench.place('firewall-fortinet', 'B', 0, 0);
  bench.connect(a, 'port1', b, 'port1');
  const side = (ip: string, peer: string, far: string) => [
    'config system interface', 'edit port1', 'set mode static', `set ip ${ip} 255.255.255.0`, 'set allowaccess ping', 'next', 'end',
    'config router static',
    'edit 1', `set dst ${far} 255.255.255.0`, `set gateway ${peer}`, 'set device "port1"', ...(bfd ? ['set bfd enable'] : []), 'next',
    'edit 2', 'set dst 10.99.0.0 255.255.255.0', `set gateway ${peer}`, 'set device "port1"', 'next',
    'end',
  ];
  const typed = await bench.shell(a, ...side('10.5.0.1', '10.5.0.2', '10.9.0.0'));
  await bench.shell(b, ...side('10.5.0.2', '10.5.0.1', '10.8.0.0'));
  clock.advance(10_000);
  return { a, b, clock, typed };
}

const statics = (fgt: { executeCommand(c: string): Promise<string> }) =>
  fgt.executeCommand('get router info routing-table static');

async function silence(b: { executeCommand(c: string): Promise<string> }) {
  for (const line of ['config system interface', 'edit port1', 'set status down', 'end']) await b.executeCommand(line);
}

describe('router static bfd', () => {
  it('witness: a plain static route stays installed whatever the neighbour does', async () => {
    const { a, b, clock } = await lab(true);
    await silence(b);
    clock.advance(30_000);
    expect(await statics(a)).toContain('10.99.0.0/24');
  });

  it('accepts the attribute and shows it', async () => {
    const { a, typed } = await lab(true);
    expect(typed).not.toMatch(/Command fail|unknown attribute/);
    expect(await a.executeCommand('show router static 1')).toContain('set bfd enable');
  });

  it('provisions the session without any router bfd entry, and it reaches UP', async () => {
    const { a } = await lab(true);
    expect(await a.executeCommand('get router info bfd neighbor')).toMatch(/10\.5\.0\.1\s+10\.5\.0\.2\s+UP\s+port1/);
  });

  it('the route is installed while the session is up', async () => {
    const { a } = await lab(true);
    expect(await statics(a)).toContain('10.9.0.0/24');
  });

  it('the route is withdrawn when the neighbour falls silent, the plain one is not', async () => {
    const { a, b, clock } = await lab(true);
    await silence(b);
    clock.advance(30_000);
    const table = await statics(a);
    expect(table).not.toContain('10.9.0.0/24');
    expect(table).toContain('10.99.0.0/24');
  });

  it('the route comes back when the session recovers', async () => {
    const { a, b, clock } = await lab(true);
    await silence(b);
    clock.advance(30_000);
    expect(await statics(a)).not.toContain('10.9.0.0/24');
    for (const line of ['config system interface', 'edit port1', 'set status up', 'end']) await b.executeCommand(line);
    clock.advance(60_000);
    expect(await statics(a)).toContain('10.9.0.0/24');
  });
});
