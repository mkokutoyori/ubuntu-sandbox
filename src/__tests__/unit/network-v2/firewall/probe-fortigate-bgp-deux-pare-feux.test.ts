/*
 * Probe: two FortiGate peering in BGP. Measured on a pair cabled port1-port1 : with the 2.2.2.2 unit configured
 * first the 1.1.1.1 unit showed the session ; configured in the other order, 2.2.2.2 said Established while
 * `get router info bgp summary` on 1.1.1.1 answered "never Idle" — although the session existed in its engine.
 * Cause : the summary read the engine's cached neighbour view, refreshed only by a convergence round, and an
 * inbound session establishes without one (the Cisco `show` runs a round, the FortiGate view did not).
 * Discriminated with git stash on src/network: both fall before the fix (the dialling unit's view was stale in
 * either order once both units are read) ; no case passes either way.
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

async function pair(firstIsLowId: boolean) {
  const clock = new VirtualTimeScheduler();
  __setDefaultScheduler(clock);
  const bench = new LabWorkbench();
  const low = bench.place('firewall-fortinet', 'LOW', 0, 0);
  const high = bench.place('firewall-fortinet', 'HIGH', 0, 0);
  bench.connect(low, 'port1', high, 'port1');
  const side = (ip: string, peer: string, asn: number, peerAsn: number, id: string) => [
    'config system interface', 'edit port1', 'set mode static', `set ip ${ip} 255.255.255.0`, 'next', 'end',
    'config router bgp', `set as ${asn}`, `set router-id ${id}`, 'config neighbor', `edit ${peer}`, `set remote-as ${peerAsn}`, 'next', 'end', 'end',
  ];
  const lowLines = side('10.6.0.1', '10.6.0.2', 65001, 65002, '1.1.1.1');
  const highLines = side('10.6.0.2', '10.6.0.1', 65002, 65001, '2.2.2.2');
  if (firstIsLowId) { await bench.shell(low, ...lowLines); await bench.shell(high, ...highLines); }
  else { await bench.shell(high, ...highLines); await bench.shell(low, ...lowLines); }
  clock.advance(120_000);
  return { low, high };
}

const established = (summary: string) => /\s\d+\s+\d+\s+\d+\s+\d+\s+\d+\s+\S+\s+\d+\s*$/m.test(summary) && !/never/.test(summary);

describe('two FortiGate in BGP', () => {
  it('the 2.2.2.2 unit configured first, both units show the session', async () => {
    const { low, high } = await pair(false);
    expect(established(await low.executeCommand('get router info bgp summary'))).toBe(true);
    expect(established(await high.executeCommand('get router info bgp summary'))).toBe(true);
  });

  it('the 1.1.1.1 unit configured first, both units show the session', async () => {
    const { low, high } = await pair(true);
    expect(established(await low.executeCommand('get router info bgp summary'))).toBe(true);
    expect(established(await high.executeCommand('get router info bgp summary'))).toBe(true);
  });
});
