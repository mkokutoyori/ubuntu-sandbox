/*
 * Probe — config system settings asymroute / asymroute-icmp: accepted, and
 * DECIDING what happens to a packet that matches no session.
 *
 * Before: "set asymroute" was an unknown attribute. Authority: Fortinet
 * technical tip FD39943 "How the FortiGate behaves when asymmetric routing
 * is enabled", read through search excerpts (community.fortinet.com is
 * refused by this environment's proxy): a SYN still creates a session and
 * is checked against the policies; a non-SYN packet without a session is
 * forwarded by the routing table with no policy lookup; ICMP behaves the
 * same. asymroute-icmp enables the ICMP half alone (Fortinet Ansible schema
 * fortios_system_settings: "Enable/disable ICMP asymmetric routing").
 * Frames are injected on port1 and counted leaving wan1.
 *
 * Measured before the change (git stash of src/network/devices/firewall):
 * 4 of the 9 cases fail.
 * Passing either way:
 *   - "a SYN allowed by policy crosses the firewall" is the WITNESS: the
 *     injection, the route and the capture are sound.
 *   - the three "dropped"/"still needs a policy" cases are non-regression:
 *     the default is disable and a SYN keeps its policy check.
 *   - "installs no session" passes before only because the packet was
 *     dropped; after, it proves the routed packet leaves no state.
 */
import { describe, it, expect } from 'vitest';
import { createDevice } from '@/network/devices/DeviceFactory';
import type { FortiGate } from '@/network/devices/firewall/vendors/fortios/FortiGate';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import {
  IPAddress, ETHERTYPE_IPV4, IP_PROTO_ICMP, IP_PROTO_TCP, nextIPv4Id, computeIPv4Checksum,
  type IPv4Packet, type ICMPPacket, type TCPPacket,
} from '@/network/core/types';
import { framesSentOn } from '../../../support/wireWatch';
import { type Cli, taper } from '../../new_firewall/fortigateBatteryHarness';

interface Lab { pc: LinuxPC; srv: LinuxServer; fw: FortiGate & Cli }

async function buildLab(policy: boolean): Promise<Lab> {
  const pc = new LinuxPC('linux-pc', 'pc1', 0, 0);
  const srv = new LinuxServer('linux-server', 'srv1', 0, 0);
  const fw = createDevice('firewall-fortinet', 0, 0) as unknown as FortiGate & Cli;
  pc.powerOn();
  srv.powerOn();
  new Cable('lan').connect(pc.getPort('eth0') as never, fw.getPort('port1') as never);
  new Cable('wan').connect(fw.getPort('wan1') as never, srv.getPort('eth0') as never);
  await taper(fw, [
    'config system interface',
    'edit port1', 'set mode static', 'set ip 192.168.1.1 255.255.255.0', 'next',
    'edit wan1', 'set mode static', 'set ip 203.0.113.1 255.255.255.0', 'set allowaccess ping', 'next',
    'end',
  ]);
  if (policy) {
    await taper(fw, [
      'config firewall policy',
      'edit 1', 'set srcintf "port1"', 'set dstintf "wan1"', 'set srcaddr "all"',
      'set dstaddr "all"', 'set action accept', 'set schedule "always"',
      'set service "ALL"', 'set nat enable', 'next',
      'end',
    ]);
  }
  await taper(pc as unknown as Cli, [
    'ip link set eth0 up', 'ip addr add 192.168.1.10/24 dev eth0', 'ip route add default via 192.168.1.1',
  ]);
  await taper(srv as unknown as Cli, [
    'ip link set eth0 up', 'ip addr add 203.0.113.9/24 dev eth0', 'ip route add default via 203.0.113.1',
    'ping -c 1 203.0.113.1',
  ]);
  return { pc, srv, fw };
}

function tcpSegment(flags: Partial<TCPPacket['flags']>): IPv4Packet {
  const segment = {
    type: 'tcp', sourcePort: 40000, destinationPort: 80,
    sequenceNumber: 1000, acknowledgementNumber: 5000,
    flags: { syn: false, ack: false, fin: false, rst: false, psh: false, urg: false, ...flags },
    windowSize: 65535, checksum: 0, payload: null,
  } as unknown as TCPPacket;
  return ipv4(IP_PROTO_TCP, segment, 40);
}

function echoReply(): IPv4Packet {
  const icmp: ICMPPacket = {
    type: 'icmp', icmpType: 'echo-reply', code: 0, id: 9, sequence: 1, dataSize: 56,
  };
  return ipv4(IP_PROTO_ICMP, icmp, 84);
}

function ipv4(protocol: number, payload: unknown, totalLength: number): IPv4Packet {
  const packet = {
    type: 'ipv4', version: 4, ihl: 5, tos: 0, totalLength,
    identification: nextIPv4Id(), flags: 0, fragmentOffset: 0, ttl: 64,
    protocol, headerChecksum: 0,
    sourceIP: new IPAddress('192.168.1.10'), destinationIP: new IPAddress('203.0.113.9'),
    payload,
  } as IPv4Packet;
  packet.headerChecksum = computeIPv4Checksum(packet);
  return packet;
}

function inject(lab: Lab, packet: IPv4Packet): IPv4Packet[] {
  const sent = framesSentOn(lab.fw, 'wan1');
  lab.fw.getPort('port1')!.receiveFrame({
    srcMAC: lab.pc.getPort('eth0')!.getMAC(),
    dstMAC: lab.fw.getPort('port1')!.getMAC(),
    etherType: ETHERTYPE_IPV4,
    payload: packet,
  });
  return sent
    .filter((frame) => frame.etherType === ETHERTYPE_IPV4)
    .map((frame) => frame.payload as IPv4Packet)
    .filter((forwarded) => forwarded.protocol === packet.protocol);
}

async function settings(fw: Cli, lines: readonly string[]): Promise<void> {
  await taper(fw, ['config system settings', ...lines, 'end']);
}

describe('FortiGate asymmetric routing', () => {
  it('a SYN allowed by policy crosses the firewall', async () => {
    const lab = await buildLab(true);
    expect(inject(lab, tcpSegment({ syn: true }))).toHaveLength(1);
  });

  it('asymroute is disabled by default', async () => {
    const { fw } = await buildLab(true);
    expect(await fw.executeCommand('get system settings')).toMatch(/^asymroute\s*: disable$/m);
  });

  it('with asymroute disabled, an ACK without a session is dropped', async () => {
    const lab = await buildLab(true);
    expect(inject(lab, tcpSegment({ ack: true }))).toHaveLength(0);
  });

  it('with asymroute enabled, an ACK without a session is routed with no policy at all', async () => {
    const lab = await buildLab(false);
    await settings(lab.fw, ['set asymroute enable']);
    const forwarded = inject(lab, tcpSegment({ ack: true }));
    expect(forwarded).toHaveLength(1);
    expect(forwarded[0].sourceIP.toString()).toBe('192.168.1.10');
  });

  it('a packet routed by asymroute installs no session', async () => {
    const lab = await buildLab(false);
    await settings(lab.fw, ['set asymroute enable']);
    inject(lab, tcpSegment({ ack: true }));
    expect(await lab.fw.executeCommand('diagnose sys session list')).toMatch(/^total session 0$/m);
  });

  it('with asymroute enabled, a SYN still needs a policy', async () => {
    const lab = await buildLab(false);
    await settings(lab.fw, ['set asymroute enable']);
    expect(inject(lab, tcpSegment({ syn: true }))).toHaveLength(0);
  });

  it('with asymroute enabled, an ICMP reply without a session is routed', async () => {
    const lab = await buildLab(false);
    await settings(lab.fw, ['set asymroute enable']);
    expect(inject(lab, echoReply())).toHaveLength(1);
  });

  it('asymroute-icmp alone routes the ICMP reply and still drops the ACK', async () => {
    const lab = await buildLab(false);
    await settings(lab.fw, ['set asymroute-icmp enable']);
    expect(inject(lab, echoReply())).toHaveLength(1);
    expect(inject(lab, tcpSegment({ ack: true }))).toHaveLength(0);
  });

  it('with both disabled, an ICMP reply without a session is dropped', async () => {
    const lab = await buildLab(false);
    expect(inject(lab, echoReply())).toHaveLength(0);
  });
});
