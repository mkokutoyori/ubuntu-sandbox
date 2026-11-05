/*
 * Probe: `config system netflow` + `set netflow-sampler` on an interface (FortiOS CLI Reference 7.4.12 pp.1748, 1660)
 * make the firewall export the flows of its sessions as NetFlow v9 (RFC 3954) datagrams to a collector, over the
 * cable: a template flowset first (and again every template-tx-counter packets), then data flowsets using it. The
 * exporter is the shared NetFlow agent the Cisco routers use, extended with the v9 format (template + data).
 * A session is exported as two unidirectional flows when it closes, only if one of its interfaces is sampled in the
 * matching direction. Measured before: "unknown configuration path system netflow".
 * Discriminated with git stash on src/network: 3 of 6 fall before the fix. Three pass either way and are named: the
 * witness (the session passes the firewall) and the two « exports nothing » cases, which hold vacuously while no
 * exporter exists and carry the measure only next to the positive case that precedes them.
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

describe('system netflow', () => {
  it('witness: the pinged server answers through the firewall', async () => {
    const { pc } = await lab(['set netflow-sampler rx']);
    expect(await pc.executeCommand('ping -c 1 10.2.0.10')).toContain('1 received');
  });

  it('accepts the configuration and shows it', async () => {
    const { fgt } = await lab(['set netflow-sampler rx']);
    const shown = await fgt.executeCommand('show system netflow');
    expect(shown).toContain('set collector-ip 10.2.0.30');
    expect(await fgt.executeCommand('show system interface port1')).toContain('set netflow-sampler rx');
  });

  it('exports a v9 datagram to the collector, with its template first', async () => {
    const { fgt, pc, clock } = await lab(['set netflow-sampler rx']);
    await sessionThenAge(fgt, pc, clock);
    const packets = exported(fgt);
    expect(packets.length).toBeGreaterThan(0);
    expect(packets[0].header.version).toBe(9);
    const template = packets[0].flowSets[0] as NetFlowV9TemplateFlowSet;
    expect(template.flowSetId).toBe(0);
    expect(template.templates[0].templateId).toBe(256);
  });

  it('the data flowset carries both directions of the session', async () => {
    const { fgt, pc, clock } = await lab(['set netflow-sampler rx']);
    await sessionThenAge(fgt, pc, clock);
    const records = exported(fgt).flatMap(packet => packet.flowSets)
      .filter((set): set is NetFlowV9DataFlowSet => set.flowSetId === 256)
      .flatMap(set => set.records);
    expect(records.some(r => r.sourceIp === '10.1.0.50' && r.destinationIp === '10.2.0.10' && r.protocol === 1)).toBe(true);
    expect(records.some(r => r.sourceIp === '10.2.0.10' && r.destinationIp === '10.1.0.50')).toBe(true);
  });

  it('an unsampled firewall exports nothing', async () => {
    const { fgt, pc, clock } = await lab([]);
    await sessionThenAge(fgt, pc, clock);
    expect(exported(fgt)).toEqual([]);
  });

  it('a direction that is not the sampled one exports nothing', async () => {
    const { fgt, pc, clock } = await lab(['set netflow-sampler tx']);
    await sessionThenAge(fgt, pc, clock);
    expect(exported(fgt)).toEqual([]);
  });
});
