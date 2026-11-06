/*
 * Probe: `config system netflow` `template-tx-timeout` (FortiOS CLI Reference 7.4.12 p.1748-1749: "Timeout for periodic
 * template flowset transmission (60 - 86400 sec, default = 1800)") was absent from the schema, and the shared exporter
 * resent its template only every template-tx-counter packets. RFC 3954 section 9 asks for both: a collector that restarted
 * after the first template would otherwise wait for the packet count, however long the exporter stays quiet. The exporter now
 * resends the template once the timeout has elapsed since the last one it sent to that collector.
 *
 * Discriminated with git stash on src/network: 2 of 4 fall before the fix; the witness (the first export carries the
 * template) and the "not repeated" case (vacuous while the attribute is unknown) pass either way.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { loadAllDevicePlatforms } from '@/network';
import { useNetworkStore } from '@/store/networkStore';
import { resetCounters, MACAddress, type IPv4Packet, type UDPPacket } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { Logger } from '@/network/core/Logger';
import { LabWorkbench } from '@/labs/LabWorkbench';
import { VirtualTimeScheduler, __setDefaultScheduler } from '@/events/Scheduler';
import type { NetFlowV9Packet, NetFlowV9DataFlowSet, NetFlowV9TemplateFlowSet } from '@/network/netflow/types';

beforeEach(async () => {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); EquipmentRegistry.resetInstance(); Logger.reset();
  await loadAllDevicePlatforms();
  useNetworkStore.getState().clearAll();
});

async function lab(sampler: string[]) {
  const clock = new VirtualTimeScheduler();
  __setDefaultScheduler(clock);
  const bench = new LabWorkbench();
  const fgt = bench.place('firewall-fortinet', 'F', 0, 0);
  const pc = bench.place('linux-pc', 'PC', 0, 0);
  const srv = bench.place('linux-server', 'SRV', 0, 0);
  const collector = bench.place('linux-server', 'COL', 0, 0);
  const sw = bench.place('switch-generic', 'SW', 0, 0);
  bench.connect(fgt, 'port1', pc, 'eth0');
  bench.connect(fgt, 'port2', sw, 'eth0');
  bench.connect(srv, 'eth0', sw, 'eth1');
  bench.connect(collector, 'eth0', sw, 'eth2');
  await bench.shell(fgt,
    'config system interface', 'edit port1', 'set mode static', 'set ip 10.1.0.1 255.255.255.0', ...sampler, 'next',
    'edit port2', 'set mode static', 'set ip 10.2.0.1 255.255.255.0', 'next', 'end',
    'config firewall policy', 'edit 1', 'set srcintf "port1"', 'set dstintf "port2"', 'set srcaddr "all"', 'set dstaddr "all"', 'set service "ALL"', 'set action accept', 'set schedule "always"', 'next', 'end',
    'config system netflow', 'set inactive-flow-timeout 10', 'config collectors', 'edit 1', 'set collector-ip 10.2.0.30', 'set collector-port 2055', 'next', 'end', 'end');
  await bench.shell(pc, 'ip addr add 10.1.0.50/24 dev eth0', 'ip link set eth0 up', 'ip route add default via 10.1.0.1');
  await bench.shell(srv, 'ip addr add 10.2.0.10/24 dev eth0', 'ip link set eth0 up', 'ip route add default via 10.2.0.1');
  await bench.shell(collector, 'ip addr add 10.2.0.30/24 dev eth0', 'ip link set eth0 up', 'ip route add default via 10.2.0.1');
  return { fgt, pc, clock };
}

function exported(fgt: { getPacketCapture(): { select(q: object): Array<{ frame: { payload: unknown } }> } }): NetFlowV9Packet[] {
  return fgt.getPacketCapture().select({ iface: 'port2', matches: () => true, limit: 0 })
    .map(entry => entry.frame.payload as IPv4Packet)
    .filter(packet => packet?.type === 'ipv4' && (packet.payload as UDPPacket | undefined)?.destinationPort === 2055)
    .map(packet => (packet.payload as UDPPacket).payload as NetFlowV9Packet)
    .filter(payload => payload?.type === 'netflow-v9');
}

async function sessionThenAge(fgt: { executeCommand(c: string): Promise<string> }, pc: { executeCommand(c: string): Promise<string> }, clock: VirtualTimeScheduler) {
  await pc.executeCommand('ping -c 1 10.2.0.10');
  await fgt.executeCommand('diagnose sys session clear');
  clock.advance(30_000);
}


function templatePackets(fgt: unknown): number {
  return exported(fgt as Parameters<typeof exported>[0]).filter(packet => packet.flowSets.some(set => set.flowSetId === 0)).length;
}

const tune = (counter: number, timeout: string[]): string[] => [
  'config system netflow', `set template-tx-counter ${counter}`, ...timeout, 'end',
];

describe('system netflow template-tx-timeout', () => {
  it('witness: the first export carries the template', async () => {
    const { fgt, pc, clock } = await lab(['set netflow-sampler rx']);
    await fgt.executeCommand(tune(6000, []).join('\n'));
    await sessionThenAge(fgt, pc, clock);
    expect(templatePackets(fgt)).toBe(1);
  });

  it('is accepted, bounded to 60-86400 seconds, and shown', async () => {
    const { fgt } = await lab(['set netflow-sampler rx']);
    const outcome = [] as string[];
    for (const line of tune(6000, ['set template-tx-timeout 60'])) outcome.push(await fgt.executeCommand(line));
    expect(outcome.join('\n')).not.toMatch(/Command fail|unknown/i);
    expect(await fgt.executeCommand('show system netflow')).toContain('set template-tx-timeout 60');
    await fgt.executeCommand('config system netflow');
    expect(await fgt.executeCommand('set template-tx-timeout 59')).toMatch(/Command fail|range|invalid/i);
    await fgt.executeCommand('end');
  });

  it('without the timeout elapsing, the template is not repeated', async () => {
    const { fgt, pc, clock } = await lab(['set netflow-sampler rx']);
    for (const line of tune(6000, ['set template-tx-timeout 600'])) await fgt.executeCommand(line);
    await sessionThenAge(fgt, pc, clock);
    await sessionThenAge(fgt, pc, clock);
    expect(templatePackets(fgt)).toBe(1);
  });

  it('once the timeout has elapsed, the next export carries the template again', async () => {
    const { fgt, pc, clock } = await lab(['set netflow-sampler rx']);
    for (const line of tune(6000, ['set template-tx-timeout 60'])) await fgt.executeCommand(line);
    await sessionThenAge(fgt, pc, clock);
    clock.advance(100_000);
    await sessionThenAge(fgt, pc, clock);
    expect(templatePackets(fgt)).toBe(2);
  });
});
