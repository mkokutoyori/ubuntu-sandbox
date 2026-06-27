import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { Cable } from '@/network/hardware/Cable';
import { EthernetFrame, MACAddress, resetCounters } from '@/network/core/types';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { getDefaultEventBus } from '@/events/EventBus';

async function buildLab() {
  const sw = new CiscoSwitch('switch-cisco', 'Switch1', 8, 0, 0);
  const pcA = new LinuxPC('PCA', 0, 0);
  const pcB = new LinuxPC('PCB', 0, 0);
  const pcMirror = new LinuxPC('PCM', 0, 0);
  new Cable('cab-a').connect(pcA.getPort('eth0')!, sw.getPort('FastEthernet0/1')!);
  new Cable('cab-b').connect(pcB.getPort('eth0')!, sw.getPort('FastEthernet0/2')!);
  new Cable('cab-m').connect(pcMirror.getPort('eth0')!, sw.getPort('FastEthernet0/8')!);
  // Isolate the SPAN destination on its own VLAN so normal flooding
  // can never reach it — only the mirror egress (which bypasses VLAN
  // filtering, as real Cisco SPAN does) can put a frame on F0/8.
  await sw.executeCommand('enable');
  await sw.executeCommand('configure terminal');
  await sw.executeCommand('vlan 99');
  await sw.executeCommand('exit');
  await sw.executeCommand('interface FastEthernet0/8');
  await sw.executeCommand('switchport mode access');
  await sw.executeCommand('switchport access vlan 99');
  await sw.executeCommand('end');
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

describe('Cisco SPAN — port mirror config + forwarding', () => {
  beforeEach(() => {
    resetCounters();
    MACAddress.resetCounter();
    Logger.reset();
    EquipmentRegistry.resetInstance();
  });

  it('rx mirror copies ingressed frames onto the destination port', async () => {
    const { sw, pcA, pcB, pcMirror } = await buildLab();
    await pcA.executeCommand('ifconfig eth0 10.0.0.1');
    await pcB.executeCommand('ifconfig eth0 10.0.0.2');
    await sw.executeCommand('enable');
    await sw.executeCommand('configure terminal');
    await sw.executeCommand('monitor session 1 source interface FastEthernet0/1 rx');
    await sw.executeCommand('monitor session 1 destination interface FastEthernet0/8');
    await sw.executeCommand('end');

    const mirrored = captureFramesOn(pcMirror);
    await pcA.executeCommand('ping -c 1 10.0.0.2');

    expect(mirrored.length).toBeGreaterThan(0);
    expect(mirrored.some((f) => f.srcMAC.toString() === pcA.getPort('eth0')!.getMAC().toString())).toBe(true);
  });

  it('tx mirror copies frames sent out the source port', async () => {
    const { sw, pcA, pcB, pcMirror } = await buildLab();
    await pcA.executeCommand('ifconfig eth0 10.0.0.1');
    await pcB.executeCommand('ifconfig eth0 10.0.0.2');
    await sw.executeCommand('enable');
    await sw.executeCommand('configure terminal');
    await sw.executeCommand('monitor session 2 source interface FastEthernet0/2 tx');
    await sw.executeCommand('monitor session 2 destination interface FastEthernet0/8');
    await sw.executeCommand('end');

    const mirrored = captureFramesOn(pcMirror);
    await pcA.executeCommand('ping -c 1 10.0.0.2');

    expect(mirrored.length).toBeGreaterThan(0);
    expect(mirrored.some((f) => f.dstMAC.toString() === pcB.getPort('eth0')!.getMAC().toString())).toBe(true);
  });

  it('both direction captures both rx ingress and tx egress', async () => {
    const { sw, pcA, pcB, pcMirror } = await buildLab();
    await pcA.executeCommand('ifconfig eth0 10.0.0.1');
    await pcB.executeCommand('ifconfig eth0 10.0.0.2');
    await sw.executeCommand('enable');
    await sw.executeCommand('configure terminal');
    await sw.executeCommand('monitor session 3 source interface FastEthernet0/1 both');
    await sw.executeCommand('monitor session 3 destination interface FastEthernet0/8');
    await sw.executeCommand('end');

    const mirrored = captureFramesOn(pcMirror);
    await pcA.executeCommand('ping -c 1 10.0.0.2');

    const fromA = mirrored.filter((f) => f.srcMAC.toString() === pcA.getPort('eth0')!.getMAC().toString()).length;
    const toA = mirrored.filter((f) => f.dstMAC.toString() === pcA.getPort('eth0')!.getMAC().toString()).length;
    expect(fromA).toBeGreaterThan(0);
    expect(toA).toBeGreaterThan(0);
  });

  it('no monitor session removes the mirror — destination no longer sees the traffic', async () => {
    const { sw, pcA, pcB, pcMirror } = await buildLab();
    await pcA.executeCommand('ifconfig eth0 10.0.0.1');
    await pcB.executeCommand('ifconfig eth0 10.0.0.2');
    await sw.executeCommand('enable');
    await sw.executeCommand('configure terminal');
    await sw.executeCommand('monitor session 4 source interface FastEthernet0/1 both');
    await sw.executeCommand('monitor session 4 destination interface FastEthernet0/8');
    await sw.executeCommand('no monitor session 4');
    await sw.executeCommand('end');

    const mirrored = captureFramesOn(pcMirror);
    await pcA.executeCommand('ping -c 1 10.0.0.2');

    expect(mirrored.length).toBe(0);
    expect(sw.listMirrorSessions()).toEqual([]);
  });

  it('rejects setting the same port as source and destination of the same session', async () => {
    const { sw } = await buildLab();
    await sw.executeCommand('enable');
    await sw.executeCommand('configure terminal');
    await sw.executeCommand('monitor session 5 source interface FastEthernet0/1 both');
    const r = await sw.executeCommand('monitor session 5 destination interface FastEthernet0/1');
    expect(r).toMatch(/already a source/);
    const r2 = await sw.executeCommand('monitor session 5 source interface FastEthernet0/8');
    await sw.executeCommand('monitor session 5 destination interface FastEthernet0/8');
    expect(r2).toBeDefined();
    expect(await sw.executeCommand('monitor session 6 destination interface FastEthernet0/3')).toBe('');
    const r3 = await sw.executeCommand('monitor session 6 source interface FastEthernet0/3 rx');
    expect(r3).toMatch(/already a SPAN destination/);
  });

  it('show monitor session N renders sources + destination', async () => {
    const { sw } = await buildLab();
    await sw.executeCommand('enable');
    await sw.executeCommand('configure terminal');
    await sw.executeCommand('monitor session 7 source interface FastEthernet0/1 rx');
    await sw.executeCommand('monitor session 7 source interface FastEthernet0/2 tx');
    await sw.executeCommand('monitor session 7 destination interface FastEthernet0/8');
    await sw.executeCommand('end');
    const out = await sw.executeCommand('show monitor session 7');
    expect(out).toContain('Session 7');
    expect(out).toMatch(/RX Only\s+:\s+FastEthernet0\/1/);
    expect(out).toMatch(/TX Only\s+:\s+FastEthernet0\/2/);
    expect(out).toMatch(/Destination Ports\s+:\s+FastEthernet0\/8/);
  });

  it('show monitor (no args) lists every session', async () => {
    const { sw } = await buildLab();
    await sw.executeCommand('enable');
    await sw.executeCommand('configure terminal');
    await sw.executeCommand('monitor session 1 source interface FastEthernet0/1 both');
    await sw.executeCommand('monitor session 1 destination interface FastEthernet0/8');
    await sw.executeCommand('monitor session 2 source interface FastEthernet0/2 rx');
    await sw.executeCommand('monitor session 2 destination interface FastEthernet0/7');
    await sw.executeCommand('end');
    const out = await sw.executeCommand('show monitor');
    expect(out).toContain('Session 1');
    expect(out).toContain('Session 2');
  });

  it('mirroring does not loop when the destination port is also an egress path', async () => {
    const { sw, pcA, pcB, pcMirror } = await buildLab();
    await pcA.executeCommand('ifconfig eth0 10.0.0.1');
    await pcB.executeCommand('ifconfig eth0 10.0.0.2');
    await sw.executeCommand('enable');
    await sw.executeCommand('configure terminal');
    await sw.executeCommand('monitor session 8 source interface FastEthernet0/2 tx');
    await sw.executeCommand('monitor session 8 destination interface FastEthernet0/8');
    await sw.executeCommand('end');

    const mirrored = captureFramesOn(pcMirror);
    await pcA.executeCommand('ping -c 1 10.0.0.2');
    // A single ICMP round-trip generates a bounded number of frames;
    // a recursion bug would explode this number.
    expect(mirrored.length).toBeLessThan(20);
    expect(mirrored.length).toBeGreaterThan(0);
  });

  it('rx mirror captures ARP and ICMP request alike', async () => {
    const { sw, pcA, pcB, pcMirror } = await buildLab();
    await pcA.executeCommand('ifconfig eth0 10.0.0.1');
    await pcB.executeCommand('ifconfig eth0 10.0.0.2');
    await sw.executeCommand('enable');
    await sw.executeCommand('configure terminal');
    await sw.executeCommand('monitor session 9 source interface FastEthernet0/1 rx');
    await sw.executeCommand('monitor session 9 destination interface FastEthernet0/8');
    await sw.executeCommand('end');

    const mirrored = captureFramesOn(pcMirror);
    await pcA.executeCommand('ping -c 1 10.0.0.2');

    const ethertypes = new Set(mirrored.map((f) => f.etherType));
    expect(ethertypes.has(0x0806)).toBe(true); // ARP request from PCA
    expect(ethertypes.has(0x0800)).toBe(true); // ICMP echo request from PCA
  });
});
