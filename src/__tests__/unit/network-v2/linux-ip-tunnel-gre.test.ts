import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { Cable } from '@/network/hardware/Cable';
import { EventBus } from '@/events/EventBus';
import {
  MACAddress, IPAddress, resetCounters,
  IP_PROTO_ICMP, nextIPv4Id, computeIPv4Checksum,
  type IPv4Packet, type ICMPPacket,
} from '@/network/core/types';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  EquipmentRegistry.resetInstance();
  resetCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

function makeInner(srcIp: string, dstIp: string): IPv4Packet {
  const icmp: ICMPPacket = {
    type: 'icmp', icmpType: 'echo-request', code: 0,
    id: 7, sequence: 1, dataSize: 8,
  };
  const pkt: IPv4Packet = {
    type: 'ipv4', version: 4, ihl: 5, tos: 0,
    totalLength: 28,
    identification: nextIPv4Id(), flags: 0, fragmentOffset: 0,
    ttl: 64, protocol: IP_PROTO_ICMP, headerChecksum: 0,
    sourceIP: new IPAddress(srcIp),
    destinationIP: new IPAddress(dstIp),
    payload: icmp,
  };
  pkt.headerChecksum = computeIPv4Checksum(pkt);
  return pkt;
}

function buildLan(bus: EventBus): { pc1: LinuxPC; pc2: LinuxPC } {
  const pc1 = new LinuxPC('PC1', 0, 0);
  const pc2 = new LinuxPC('PC2', 100, 0);
  const sw = new CiscoSwitch('switch-cisco', 'SW1', 24, 50, 50);
  pc1.setEventBus(bus); pc2.setEventBus(bus); sw.setEventBus(bus);
  new Cable('c1').connect(pc1.getPort('eth0')!, sw.getPort('FastEthernet0/1')!);
  new Cable('c2').connect(pc2.getPort('eth0')!, sw.getPort('FastEthernet0/2')!);
  return { pc1, pc2 };
}

describe('ip tunnel (GRE) command surface over the existing GRE engine (PRD-ip.md P4)', () => {
  it('ip tunnel add creates a real tunnel visible via ip tunnel show', async () => {
    const pc1 = new LinuxPC('PC1', 0, 0);
    const output = await pc1.executeCommand('ip tunnel add gre0 mode gre remote 10.0.0.2 local 10.0.0.1');
    expect(output).toBe('');
    const show = await pc1.executeCommand('ip tunnel show');
    expect(show).toContain('gre0: gre/ip');
    expect(show).toContain('remote 10.0.0.2');
    expect(show).toContain('local 10.0.0.1');
    expect(pc1.getGreAgent().getTunnel('gre0')?.sourceIp).toBe('10.0.0.1');
    expect(pc1.getGreAgent().getTunnel('gre0')?.destinationIp).toBe('10.0.0.2');
  });

  it('ip tunnel add with key/ttl is reflected in real tunnel state and ip tunnel show', async () => {
    const pc1 = new LinuxPC('PC1', 0, 0);
    await pc1.executeCommand('ip tunnel add gre1 mode gre remote 10.0.0.9 local 10.0.0.1 key 42 ttl 32');
    expect(pc1.getGreAgent().getTunnel('gre1')?.key).toBe(42);
    expect(pc1.getGreAgent().getTunnel('gre1')?.ttl).toBe(32);
    const show = await pc1.executeCommand('ip tunnel show gre1');
    expect(show).toContain('key 42');
    expect(show).toContain('ttl 32');
  });

  it('ip tunnel del removes a real tunnel', async () => {
    const pc1 = new LinuxPC('PC1', 0, 0);
    await pc1.executeCommand('ip tunnel add gre0 mode gre remote 10.0.0.2 local 10.0.0.1');
    expect(pc1.getGreAgent().getTunnel('gre0')).toBeDefined();
    const output = await pc1.executeCommand('ip tunnel del gre0');
    expect(output).toBe('');
    expect(pc1.getGreAgent().getTunnel('gre0')).toBeUndefined();
  });

  it('ip tunnel del on a nonexistent tunnel fails with a real RTNETLINK error', async () => {
    const pc1 = new LinuxPC('PC1', 0, 0);
    const output = await pc1.executeCommand('ip tunnel del does-not-exist');
    expect(output).toContain('RTNETLINK answers: No such device');
  });

  it('ip tunnel add without "remote"/"local" fails with a real usage error', async () => {
    const pc1 = new LinuxPC('PC1', 0, 0);
    const output = await pc1.executeCommand('ip tunnel add gre0 mode gre local 10.0.0.1');
    expect(output).toContain('"remote" address is required');
  });

  it('a GRE tunnel created via ip tunnel carries real ICMP traffic end-to-end between two LinuxPCs, and the reply completes a genuine round trip', async () => {
    const bus = new EventBus();
    const { pc1, pc2 } = buildLan(bus);
    await pc1.executeCommand('ifconfig eth0 10.0.0.1 netmask 255.255.255.0');
    await pc2.executeCommand('ifconfig eth0 10.0.0.2 netmask 255.255.255.0');

    await pc1.executeCommand('ip tunnel add gre0 mode gre remote 10.0.0.2 local 10.0.0.1');
    await pc2.executeCommand('ip tunnel add gre0 mode gre remote 10.0.0.1 local 10.0.0.2');

    const decaps: Array<{ deviceId: string; tunnelId: string }> = [];
    bus.subscribe('gre.packet.decapsulated', (e) => decaps.push(e.payload));
    const replies: Array<{ deviceId: string; fromIp: string }> = [];
    bus.subscribe('host.icmp.echo-reply', (e) => replies.push(e.payload));

    const inner = makeInner('10.0.0.1', '10.0.0.2');
    const sent = pc1.getGreAgent().encapsulateAndSend('gre0', inner);
    expect(sent).toBe(true);

    const pc2Decaps = decaps.filter((d) => d.deviceId === pc2.id);
    expect(pc2Decaps.length).toBe(1);
    expect(pc2Decaps[0].tunnelId).toBe('gre0');

    const pc1Replies = replies.filter((r) => r.deviceId === pc1.id);
    expect(pc1Replies.length).toBe(1);
    expect(pc1Replies[0].fromIp).toBe('10.0.0.2');
  });
});
