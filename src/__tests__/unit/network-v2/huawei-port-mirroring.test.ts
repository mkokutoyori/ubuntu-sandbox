import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { HuaweiSwitch } from '@/network/devices/HuaweiSwitch';
import { Cable } from '@/network/hardware/Cable';
import { EthernetFrame, MACAddress, resetCounters } from '@/network/core/types';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { getDefaultEventBus } from '@/events/EventBus';

async function buildLab() {
  const sw = new HuaweiSwitch('switch-huawei', 'SW1', 24);
  const pcA = new LinuxPC('PCA', 0, 0);
  const pcB = new LinuxPC('PCB', 0, 0);
  const pcMirror = new LinuxPC('PCM', 0, 0);
  new Cable('cab-a').connect(pcA.getPort('eth0')!, sw.getPort('GigabitEthernet0/0/1')!);
  new Cable('cab-b').connect(pcB.getPort('eth0')!, sw.getPort('GigabitEthernet0/0/2')!);
  new Cable('cab-m').connect(pcMirror.getPort('eth0')!, sw.getPort('GigabitEthernet0/0/8')!);
  for (const c of [
    'system-view',
    'vlan 99', 'quit',
    'interface GigabitEthernet0/0/8',
    'port link-type access',
    'port default vlan 99',
    'quit', 'quit',
  ]) await sw.executeCommand(c);
  return { sw, pcA, pcB, pcMirror };
}

function captureFramesOn(pc: LinuxPC): EthernetFrame[] {
  const captured: EthernetFrame[] = [];
  getDefaultEventBus().subscribe('port.frame.received', (e) => {
    const payload = e.payload as { deviceId?: string; portName?: string; frame: EthernetFrame };
    if (payload.deviceId === pc.getId() && payload.portName === 'eth0') {
      captured.push(payload.frame);
    }
  });
  return captured;
}

describe('Huawei port-mirroring — observe-port + mirror to observe-port', () => {
  beforeEach(() => {
    resetCounters();
    MACAddress.resetCounter();
    Logger.reset();
    EquipmentRegistry.resetInstance();
  });

  it('inbound mirror copies ingress frames onto the observe-port', async () => {
    const { sw, pcA, pcB, pcMirror } = await buildLab();
    await pcA.executeCommand('ifconfig eth0 10.0.0.1');
    await pcB.executeCommand('ifconfig eth0 10.0.0.2');
    for (const c of [
      'system-view',
      'observe-port 1 interface GigabitEthernet0/0/8',
      'interface GigabitEthernet0/0/1',
      'port-mirroring to observe-port 1 inbound',
      'quit', 'quit',
    ]) await sw.executeCommand(c);

    const mirrored = captureFramesOn(pcMirror);
    await pcA.executeCommand('ping -c 1 10.0.0.2');
    expect(mirrored.length).toBeGreaterThan(0);
    expect(mirrored.some((f) => f.srcMAC.toString() === pcA.getPort('eth0')!.getMAC().toString())).toBe(true);
  });

  it('outbound mirror copies egress frames sent out the source port', async () => {
    const { sw, pcA, pcB, pcMirror } = await buildLab();
    await pcA.executeCommand('ifconfig eth0 10.0.0.1');
    await pcB.executeCommand('ifconfig eth0 10.0.0.2');
    for (const c of [
      'system-view',
      'observe-port 1 interface GigabitEthernet0/0/8',
      'interface GigabitEthernet0/0/2',
      'port-mirroring to observe-port 1 outbound',
      'quit', 'quit',
    ]) await sw.executeCommand(c);

    const mirrored = captureFramesOn(pcMirror);
    await pcA.executeCommand('ping -c 1 10.0.0.2');
    expect(mirrored.some((f) => f.dstMAC.toString() === pcB.getPort('eth0')!.getMAC().toString())).toBe(true);
  });

  it('both direction captures both directions on the mirrored port', async () => {
    const { sw, pcA, pcB, pcMirror } = await buildLab();
    await pcA.executeCommand('ifconfig eth0 10.0.0.1');
    await pcB.executeCommand('ifconfig eth0 10.0.0.2');
    for (const c of [
      'system-view',
      'observe-port 2 interface GigabitEthernet0/0/8',
      'interface GigabitEthernet0/0/1',
      'port-mirroring to observe-port 2 both',
      'quit', 'quit',
    ]) await sw.executeCommand(c);

    const mirrored = captureFramesOn(pcMirror);
    await pcA.executeCommand('ping -c 1 10.0.0.2');
    const fromA = mirrored.filter((f) => f.srcMAC.toString() === pcA.getPort('eth0')!.getMAC().toString()).length;
    const toA = mirrored.filter((f) => f.dstMAC.toString() === pcA.getPort('eth0')!.getMAC().toString()).length;
    expect(fromA).toBeGreaterThan(0);
    expect(toA).toBeGreaterThan(0);
  });

  it('undo port-mirroring removes the source — mirror stream stops', async () => {
    const { sw, pcA, pcB, pcMirror } = await buildLab();
    await pcA.executeCommand('ifconfig eth0 10.0.0.1');
    await pcB.executeCommand('ifconfig eth0 10.0.0.2');
    for (const c of [
      'system-view',
      'observe-port 3 interface GigabitEthernet0/0/8',
      'interface GigabitEthernet0/0/1',
      'port-mirroring to observe-port 3 both',
      'undo port-mirroring to observe-port 3',
      'quit', 'quit',
    ]) await sw.executeCommand(c);

    const mirrored = captureFramesOn(pcMirror);
    await pcA.executeCommand('ping -c 1 10.0.0.2');
    // Only STP BPDUs and broadcast on vlan 99 can still naturally reach
    // PCM — there should be no unicast ICMP from PCA's MAC.
    expect(mirrored.some((f) => f.srcMAC.toString() === pcA.getPort('eth0')!.getMAC().toString() && f.etherType === 0x0800)).toBe(false);
  });

  it('undo observe-port drops every source bound to it', async () => {
    const { sw } = await buildLab();
    for (const c of [
      'system-view',
      'observe-port 5 interface GigabitEthernet0/0/8',
      'interface GigabitEthernet0/0/1',
      'port-mirroring to observe-port 5 both',
      'quit',
      'undo observe-port 5',
      'quit',
    ]) await sw.executeCommand(c);
    expect(sw.listMirrorSessions()).toEqual([]);
  });

  it('rejects setting the observe-port destination on a port already mirroring as source', async () => {
    const { sw } = await buildLab();
    for (const c of [
      'system-view',
      'observe-port 6 interface GigabitEthernet0/0/8',
      'interface GigabitEthernet0/0/1',
      'port-mirroring to observe-port 6 inbound',
      'quit',
    ]) await sw.executeCommand(c);
    const out = await sw.executeCommand('observe-port 6 interface GigabitEthernet0/0/1');
    expect(out).toMatch(/already a mirroring source/);
  });

  it('rejects port-mirroring on the observe-port destination itself', async () => {
    const { sw } = await buildLab();
    for (const c of [
      'system-view',
      'observe-port 7 interface GigabitEthernet0/0/8',
      'interface GigabitEthernet0/0/8',
    ]) await sw.executeCommand(c);
    const out = await sw.executeCommand('port-mirroring to observe-port 7 both');
    expect(out).toMatch(/is the observe-port destination/);
  });

  it('display observe-port lists the destination, display port-mirroring lists sources', async () => {
    const { sw } = await buildLab();
    for (const c of [
      'system-view',
      'observe-port 8 interface GigabitEthernet0/0/8',
      'interface GigabitEthernet0/0/1',
      'port-mirroring to observe-port 8 inbound',
      'quit',
      'interface GigabitEthernet0/0/2',
      'port-mirroring to observe-port 8 outbound',
      'quit', 'quit',
    ]) await sw.executeCommand(c);
    const op = await sw.executeCommand('display observe-port');
    expect(op).toContain('GigabitEthernet0/0/8');
    expect(op).toContain(' 8');
    const pm = await sw.executeCommand('display port-mirroring');
    expect(pm).toContain('Observe-port 8 : GigabitEthernet0/0/8');
    expect(pm).toContain('GigabitEthernet0/0/1 inbound');
    expect(pm).toContain('GigabitEthernet0/0/2 outbound');
  });

  it('port-mirroring is refused when the observe-port group does not exist', async () => {
    const { sw } = await buildLab();
    for (const c of [
      'system-view',
      'interface GigabitEthernet0/0/1',
    ]) await sw.executeCommand(c);
    const out = await sw.executeCommand('port-mirroring to observe-port 99 both');
    expect(out).toMatch(/Observe-port 99 is not configured/);
  });
});
