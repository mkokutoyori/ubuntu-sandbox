/**
 * ICMP error generation by end hosts acting as gateways (RFC 792 / 1122 / 1812).
 *
 * Before this fix, a Linux PC with net.ipv4.ip_forward=1 silently dropped
 * packets whose TTL expired and packets with no matching route — making the
 * hop invisible to traceroute and leaving senders without diagnostics.
 *
 * Covers:
 *  - shared IcmpErrors module guards (RFC 1122 §3.2.2)
 *  - Time Exceeded emitted by a forwarding Linux PC (visible to traceroute)
 *  - Destination Unreachable (net) emitted when the gateway has no route
 *
 * Topology:
 *   PC1 (192.168.1.10/24, gw .1) ── GW LinuxPC (eth0 192.168.1.1/24,
 *   eth1 10.0.0.1/24, ip_forward=1) ── PC2 (10.0.0.2/24, gw .1)
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  IPAddress,
  SubnetMask,
  resetCounters,
  createIPv4Packet,
  verifyIPv4Checksum,
  IP_PROTO_ICMP,
  IP_PROTO_UDP,
  ICMPPacket,
} from '@/network/core/types';
import {
  buildICMPError,
  mayGenerateICMPError,
  isICMPErrorMessage,
  ICMP_UNREACH_NET,
  ICMP_TTL_EXPIRED_IN_TRANSIT,
} from '@/network/core/IcmpErrors';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

// ─── Fixtures ───────────────────────────────────────────────────────────

function makeEchoRequestPacket(src: string, dst: string, ttl = 64) {
  const icmp: ICMPPacket = {
    type: 'icmp', icmpType: 'echo-request', code: 0,
    id: 1, sequence: 1, dataSize: 56,
  };
  return createIPv4Packet(new IPAddress(src), new IPAddress(dst), IP_PROTO_ICMP, ttl, icmp, 64);
}

async function buildGatewayTopology() {
  const pc1 = new LinuxPC('linux-pc', 'PC1');
  const gw = new LinuxPC('linux-pc', 'GW');
  const pc2 = new LinuxPC('linux-pc', 'PC2');

  new Cable('pc1-gw').connect(pc1.getPort('eth0')!, gw.getPort('eth0')!);
  new Cable('gw-pc2').connect(gw.getPort('eth1')!, pc2.getPort('eth0')!);

  pc1.configureInterface('eth0', new IPAddress('192.168.1.10'), new SubnetMask('255.255.255.0'));
  pc1.setDefaultGateway(new IPAddress('192.168.1.1'));

  gw.configureInterface('eth0', new IPAddress('192.168.1.1'), new SubnetMask('255.255.255.0'));
  gw.configureInterface('eth1', new IPAddress('10.0.0.1'), new SubnetMask('255.255.255.0'));
  await gw.executeCommand('sudo sysctl -w net.ipv4.ip_forward=1');

  pc2.configureInterface('eth0', new IPAddress('10.0.0.2'), new SubnetMask('255.255.255.0'));
  pc2.setDefaultGateway(new IPAddress('10.0.0.1'));

  return { pc1, gw, pc2 };
}

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.clear();
});

// ─── Unit: RFC 1122 §3.2.2 guards ───────────────────────────────────────

describe('mayGenerateICMPError (RFC 1122 §3.2.2)', () => {
  it('allows errors about ordinary unicast datagrams', () => {
    expect(mayGenerateICMPError(makeEchoRequestPacket('10.0.0.2', '10.0.1.2'))).toBe(true);
  });

  it('never generates an error about an ICMP error message', () => {
    const offending = makeEchoRequestPacket('10.0.0.2', '10.0.1.2');
    const error = buildICMPError(
      new IPAddress('10.0.0.1'), offending, 'time-exceeded',
      ICMP_TTL_EXPIRED_IN_TRANSIT, 64,
    );
    expect(isICMPErrorMessage(error)).toBe(true);
    expect(mayGenerateICMPError(error)).toBe(false);
  });

  it('still allows errors about echo requests/replies (not ICMP errors)', () => {
    const echo = makeEchoRequestPacket('10.0.0.2', '10.0.1.2');
    expect(isICMPErrorMessage(echo)).toBe(false);
    expect(mayGenerateICMPError(echo)).toBe(true);
  });

  it('never generates an error about a non-initial fragment', () => {
    const pkt = makeEchoRequestPacket('10.0.0.2', '10.0.1.2');
    pkt.fragmentOffset = 185;
    expect(mayGenerateICMPError(pkt)).toBe(false);
  });

  it('never generates an error about a multicast-destined packet', () => {
    const pkt = createIPv4Packet(
      new IPAddress('10.0.0.2'), new IPAddress('224.0.0.5'),
      IP_PROTO_UDP, 1, undefined, 8,
    );
    expect(mayGenerateICMPError(pkt)).toBe(false);
  });

  it('never generates an error about a limited-broadcast-destined packet', () => {
    const pkt = createIPv4Packet(
      new IPAddress('10.0.0.2'), new IPAddress('255.255.255.255'),
      IP_PROTO_UDP, 1, undefined, 8,
    );
    expect(mayGenerateICMPError(pkt)).toBe(false);
  });

  it('never replies to a packet sourced from the unspecified address', () => {
    expect(mayGenerateICMPError(makeEchoRequestPacket('0.0.0.0', '10.0.1.2'))).toBe(false);
  });

  it('never replies to a packet sourced from a multicast address', () => {
    expect(mayGenerateICMPError(makeEchoRequestPacket('224.0.0.1', '10.0.1.2'))).toBe(false);
  });
});

describe('buildICMPError', () => {
  it('builds a routable datagram addressed to the offender source', () => {
    const offending = makeEchoRequestPacket('10.0.0.2', '10.0.1.2');
    const error = buildICMPError(
      new IPAddress('10.0.0.1'), offending, 'time-exceeded',
      ICMP_TTL_EXPIRED_IN_TRANSIT, 64,
    );

    expect(error.sourceIP.toString()).toBe('10.0.0.1');
    expect(error.destinationIP.toString()).toBe('10.0.0.2');
    expect(error.protocol).toBe(IP_PROTO_ICMP);
    expect(verifyIPv4Checksum(error)).toBe(true);
    // 20-byte IP header + 8-byte ICMP header + original header + 8 bytes
    expect(error.totalLength).toBe(56);

    const icmp = error.payload as ICMPPacket;
    expect(icmp.icmpType).toBe('time-exceeded');
    expect(icmp.code).toBe(ICMP_TTL_EXPIRED_IN_TRANSIT);
    expect(icmp.originalPacket).toBe(offending);
  });

  it('includes Next-Hop MTU only for Fragmentation Needed (RFC 1191 §4)', () => {
    const offending = makeEchoRequestPacket('10.0.0.2', '10.0.1.2');
    const fragNeeded = buildICMPError(
      new IPAddress('10.0.0.1'), offending, 'destination-unreachable', 4, 64,
      { nextHopMTU: 1400 },
    );
    expect((fragNeeded.payload as ICMPPacket).mtu).toBe(1400);

    const netUnreach = buildICMPError(
      new IPAddress('10.0.0.1'), offending, 'destination-unreachable',
      ICMP_UNREACH_NET, 64, { nextHopMTU: 1400 },
    );
    expect((netUnreach.payload as ICMPPacket).mtu).toBeUndefined();
  });
});

// ─── Integration: Linux PC as forwarding gateway ────────────────────────

describe('Linux PC gateway emits ICMP errors (RFC 792)', () => {
  it('replies Time Exceeded when forwarding a packet whose TTL expires', async () => {
    const { pc1 } = await buildGatewayTopology();

    const out = await pc1.executeCommand('ping -c 1 -t 1 10.0.0.2');

    expect(out).toContain('From 192.168.1.1');
    expect(out.toLowerCase()).toContain('time to live exceeded');
  }, 15000);

  it('is visible as a traceroute hop (Time Exceeded per probe)', async () => {
    const { pc1 } = await buildGatewayTopology();

    const out = await pc1.executeCommand('traceroute 10.0.0.2');

    const lines = out.split('\n').filter(l => /^\s*\d+\s/.test(l));
    expect(lines.length).toBeGreaterThanOrEqual(2);
    expect(lines[0]).toContain('192.168.1.1'); // the PC gateway, hop 1
    expect(lines[1]).toContain('10.0.0.2');    // destination, hop 2
  }, 20000);

  it('replies Destination Net Unreachable when it has no route', async () => {
    const { pc1 } = await buildGatewayTopology();

    // GW has no route to 203.0.113.0/24 and no default gateway
    const out = await pc1.executeCommand('ping -c 1 203.0.113.9');

    expect(out).toContain('From 192.168.1.1');
    expect(out.toLowerCase()).toContain('unreachable');
  }, 15000);

  it('still forwards normally when TTL is sufficient', async () => {
    const { pc1 } = await buildGatewayTopology();

    const out = await pc1.executeCommand('ping -c 1 10.0.0.2');

    expect(out).toContain('1 received');
    expect(out).toContain('0% packet loss');
  }, 15000);
});
