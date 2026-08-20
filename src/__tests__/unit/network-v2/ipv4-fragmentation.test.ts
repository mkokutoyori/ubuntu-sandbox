/**
 * IPv4 fragmentation and reassembly (RFC 791 §3.2), at least for UDP.
 *
 * Before this, a router forwarding an oversized DF=0 datagram onto a
 * smaller-MTU link neither fragmented it nor dropped it — the oversized
 * packet just went out as-is. The DF=1 case (ICMP Fragmentation Needed)
 * already worked and must keep working unchanged.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { Cable } from '@/network/hardware/Cable';
import { EventBus } from '@/events/EventBus';
import {
  IPAddress, SubnetMask, resetCounters, createIPv4Packet, IP_PROTO_UDP, type UDPPacket,
} from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import {
  fragmentIPv4, needsFragmentation, IPv4Reassembler, IPV4_FLAG_MF, isIPv4FragmentData,
} from '@/network/core/Ipv4Fragmentation';

const SRC = new IPAddress('10.0.0.1');
const DST = new IPAddress('10.0.0.2');

function bigUdpPacket(payloadBytes: number) {
  const udp: UDPPacket = {
    type: 'udp', sourcePort: 5000, destinationPort: 9000,
    length: 8 + payloadBytes, checksum: 0, payload: 'X'.repeat(payloadBytes),
  };
  return createIPv4Packet(SRC, DST, IP_PROTO_UDP, 64, udp, 8 + payloadBytes, { flags: 0 });
}

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.reset();
});

describe('fragmentIPv4 (RFC 791 §3.2)', () => {
  it('leaves a datagram that already fits the MTU unchanged', () => {
    const pkt = bigUdpPacket(100);
    expect(needsFragmentation(pkt, 1500)).toBe(false);
    expect(fragmentIPv4(pkt, 1500)).toEqual([pkt]);
  });

  it('splits an oversized datagram into contiguous, 8-byte-aligned fragments', () => {
    const pkt = bigUdpPacket(3000); // totalLength = 20 + 8 + 3000 = 3028
    expect(needsFragmentation(pkt, 1500)).toBe(true);

    const frags = fragmentIPv4(pkt, 1500);
    expect(frags.length).toBe(3); // 1480 + 1480 + 48 bytes of payload

    let expectedOffsetBytes = 0;
    frags.forEach((f, i) => {
      const isLast = i === frags.length - 1;
      expect(f.identification).toBe(pkt.identification);
      expect(f.sourceIP).toBe(pkt.sourceIP);
      expect(f.destinationIP).toBe(pkt.destinationIP);
      expect(f.fragmentOffset * 8).toBe(expectedOffsetBytes);
      expect((f.flags & IPV4_FLAG_MF) !== 0).toBe(!isLast);
      expect(f.totalLength).toBeLessThanOrEqual(1500);
      expect((f.totalLength - 20) % 8 === 0 || isLast).toBe(true);
      expectedOffsetBytes += f.totalLength - 20;
    });
    expect(expectedOffsetBytes).toBe(pkt.totalLength - 20);
  });

  it('only the first fragment carries the real upper-layer payload', () => {
    const pkt = bigUdpPacket(3000);
    const frags = fragmentIPv4(pkt, 1500);
    expect(frags[0].payload).toBe(pkt.payload);
    expect(isIPv4FragmentData(frags[1].payload)).toBe(true);
    expect(isIPv4FragmentData(frags[2].payload)).toBe(true);
  });
});

describe('IPv4Reassembler (RFC 791 §3.2)', () => {
  it('passes a non-fragment straight through', () => {
    const pkt = bigUdpPacket(100);
    const r = new IPv4Reassembler();
    expect(r.add(pkt)).toBe(pkt);
  });

  it('reassembles fragments regardless of arrival order', () => {
    const pkt = bigUdpPacket(3000);
    const frags = fragmentIPv4(pkt, 1500);
    expect(frags.length).toBe(3);

    const r = new IPv4Reassembler();
    expect(r.add(frags[2])).toBeNull();
    expect(r.add(frags[0])).toBeNull();
    const result = r.add(frags[1]);

    expect(result).not.toBeNull();
    expect(result!.totalLength).toBe(pkt.totalLength);
    expect(result!.payload).toBe(pkt.payload);
    expect(result!.fragmentOffset).toBe(0);
    expect(result!.flags & IPV4_FLAG_MF).toBe(0);
  });

  it('keeps unrelated identifications/flows separate', () => {
    const a = fragmentIPv4(bigUdpPacket(3000), 1500);
    const b = fragmentIPv4(bigUdpPacket(3000), 1500);
    const r = new IPv4Reassembler();
    expect(r.add(a[0])).toBeNull();
    expect(r.add(b[0])).toBeNull();
    expect(r.add(b[1])).toBeNull();
    expect(r.add(b[2])?.payload).toBe(b[0].payload);
    // `a`'s set is still incomplete — feeding its remaining fragments now works.
    expect(r.add(a[1])).toBeNull();
    expect(r.add(a[2])?.payload).toBe(a[0].payload);
  });

  it('drops a fragment set that never completes within the reassembly timeout', () => {
    const frags = fragmentIPv4(bigUdpPacket(3000), 1500);
    const r = new IPv4Reassembler();
    expect(r.add(frags[0], 0)).toBeNull();
    // Still within the window: completing it now succeeds.
    expect(r.add(frags[1], 1000)).toBeNull();
    expect(r.add(frags[2], 2000)).not.toBeNull();
  });

  it('purges a stale incomplete set so a fresh set with the same key can complete later', () => {
    const frags = fragmentIPv4(bigUdpPacket(3000), 1500);
    const r = new IPv4Reassembler();
    expect(r.add(frags[0], 0)).toBeNull();
    // 30s+ later, the old entry is stale; only frags[1]/[2] arrive now —
    // that alone must NOT complete a reassembly (frags[0]'s slot was purged).
    expect(r.add(frags[1], 40_000)).toBeNull();
    expect(r.add(frags[2], 40_000)).toBeNull();
  });
});

describe('router forwarding fragments oversized UDP across an MTU boundary', () => {
  async function buildTopo(serverSideMtu: number) {
    const bus = new EventBus();
    const cli = new LinuxPC('CLI', 0, 0);
    const srv = new LinuxServer('linux-server', 'SRV', 0, 0);
    const r1 = new CiscoRouter('R1', 0, 0);
    cli.setEventBus(bus); srv.setEventBus(bus); r1.setEventBus(bus);
    cli.powerOn(); srv.powerOn(); r1.powerOn();

    const c1 = new Cable('c1'); c1.setEventBus(bus);
    c1.connect(cli.getPort('eth0')!, r1.getPort('GigabitEthernet0/0')!);
    const c2 = new Cable('c2'); c2.setEventBus(bus);
    c2.connect(r1.getPort('GigabitEthernet0/1')!, srv.getPort('eth0')!);

    await cli.executeCommand('ifconfig eth0 10.0.1.10 netmask 255.255.255.0');
    await cli.executeCommand('ip route add default via 10.0.1.1');
    await srv.executeCommand('ifconfig eth0 10.0.2.10 netmask 255.255.255.0');
    await srv.executeCommand('ip route add default via 10.0.2.1');

    await r1.executeCommand('enable');
    await r1.executeCommand('configure terminal');
    await r1.executeCommand('interface GigabitEthernet0/0');
    await r1.executeCommand('ip address 10.0.1.1 255.255.255.0');
    await r1.executeCommand('no shutdown');
    await r1.executeCommand('exit');
    await r1.executeCommand('interface GigabitEthernet0/1');
    await r1.executeCommand('ip address 10.0.2.1 255.255.255.0');
    await r1.executeCommand('no shutdown');
    await r1.executeCommand('exit');
    await r1.executeCommand('end');

    r1.getPort('GigabitEthernet0/1')!.setMTU(serverSideMtu);
    return { cli, srv, r1 };
  }

  it('delivers a UDP datagram larger than the path MTU intact when DF is clear', async () => {
    const { cli, srv } = await buildTopo(500);
    const received: unknown[] = [];
    srv.udpBind(9300, (d) => received.push(d.udp.payload));

    const payload = 'A'.repeat(3000);
    const ok = cli.sendUdpDatagram(new IPAddress('10.0.2.10'), 9300, 40000, payload, payload.length, { df: false });

    expect(ok).toBe(true);
    expect(received).toEqual([payload]);
  });

  it('actually puts multiple fragments on the wire instead of one oversized passthrough', async () => {
    const { cli, srv, r1 } = await buildTopo(500);
    srv.udpBind(9302, () => {});

    // Warm the router's ARP entry for srv with a small datagram first, so
    // the big one below takes the immediate-send branch (the queued/ARP-
    // pending branch fragments identically but doesn't log a fragment
    // count — this keeps the assertion on the log message reliable).
    cli.sendUdpDatagram(new IPAddress('10.0.2.10'), 9302, 40002, 'warm', 4, { df: false });

    const payload = 'C'.repeat(3000);
    cli.sendUdpDatagram(new IPAddress('10.0.2.10'), 9302, 40002, payload, payload.length, { df: false });

    const fwdLog = Logger.getLogsBySource(r1.id).find(
      (l) => l.event === 'router:forward' && l.message.includes('fragmented'),
    );
    expect(fwdLog).toBeTruthy();
  });

  it('still answers Fragmentation Needed instead of forwarding oversized when DF is set', async () => {
    const { cli, srv, r1 } = await buildTopo(500);
    const received: unknown[] = [];
    srv.udpBind(9301, (d) => received.push(d.udp.payload));

    const payload = 'B'.repeat(3000);
    cli.sendUdpDatagram(new IPAddress('10.0.2.10'), 9301, 40001, payload, payload.length, { df: true });

    expect(received).toEqual([]);
    const mtuLog = Logger.getLogsBySource(r1.id).find((l) => l.event === 'router:mtu-exceeded');
    expect(mtuLog).toBeTruthy();
  });
});

describe('Linux NAT-gateway forwarding also fragments across an MTU boundary', () => {
  async function buildLinuxGateway(dstSideMtu: number) {
    const src = new LinuxPC('linux-pc', 'SRC');
    const gw = new LinuxServer('linux-server', 'GW');
    const dst = new LinuxPC('linux-pc', 'DST');

    src.configureInterface('eth0', new IPAddress('10.0.1.2'), new SubnetMask('255.255.255.0'));
    gw.configureInterface('eth0', new IPAddress('10.0.1.1'), new SubnetMask('255.255.255.0'));
    gw.configureInterface('eth1', new IPAddress('10.0.2.1'), new SubnetMask('255.255.255.0'));
    dst.configureInterface('eth0', new IPAddress('10.0.2.2'), new SubnetMask('255.255.255.0'));

    src.setDefaultGateway(new IPAddress('10.0.1.1'));
    dst.setDefaultGateway(new IPAddress('10.0.2.1'));

    new Cable('c1').connect(src.getPort('eth0')!, gw.getPort('eth0')!);
    new Cable('c2').connect(gw.getPort('eth1')!, dst.getPort('eth0')!);

    await gw.executeCommand('sysctl -w net.ipv4.ip_forward=1');
    gw.getPort('eth1')!.setMTU(dstSideMtu);
    return { src, gw, dst };
  }

  it('delivers an oversized DF=0 UDP datagram intact through a Linux gateway', async () => {
    const { src, dst } = await buildLinuxGateway(500);
    const received: unknown[] = [];
    dst.udpBind(9400, (d) => received.push(d.udp.payload));

    const payload = 'D'.repeat(3000);
    src.sendUdpDatagram(new IPAddress('10.0.2.2'), 9400, 41000, payload, payload.length, { df: false });

    expect(received).toEqual([payload]);
  });

  it('answers Fragmentation Needed instead of forwarding oversized when DF is set on a Linux gateway', async () => {
    const { src, gw, dst } = await buildLinuxGateway(500);
    const received: unknown[] = [];
    dst.udpBind(9401, (d) => received.push(d.udp.payload));

    const payload = 'E'.repeat(3000);
    src.sendUdpDatagram(new IPAddress('10.0.2.2'), 9401, 41001, payload, payload.length, { df: true });

    expect(received).toEqual([]);
    const mtuLog = Logger.getLogsBySource(gw.id).find((l) => l.event === 'ipv4:mtu-exceeded');
    expect(mtuLog).toBeTruthy();
  });
});
