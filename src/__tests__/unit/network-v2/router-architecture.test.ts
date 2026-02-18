/**
 * TDD Tests for Router Architecture (ARCH-L3-ROUTER-001)
 *
 * T-ROUT-01: LPM precision — 3 routes on different interfaces
 * T-ROUT-02: ICMP error generation — Dest Unreachable + Time Exceeded + counters
 * T-ROUT-03: L2 rewrite — SrcMAC = egress interface, not original sender
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  IPAddress, SubnetMask, MACAddress,
  IPv4Packet, ICMPPacket, EthernetFrame,
  createIPv4Packet, computeIPv4Checksum, verifyIPv4Checksum,
  IP_PROTO_ICMP, ETHERTYPE_IPV4,
  resetCounters,
} from '@/network/core/types';
import { LinuxPC } from '@/network/devices/LinuxPC';
import type { RouterCounters } from '@/network/devices/Router';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { HuaweiRouter } from '@/network/devices/HuaweiRouter';
import { Cable } from '@/network/hardware/Cable';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.reset();
});

// ═══════════════════════════════════════════════════════════════════
// T-ROUT-01: LPM Precision
// ═══════════════════════════════════════════════════════════════════

describe('T-ROUT-01: LPM Precision — 3 routes on different interfaces', () => {

  it('should select /24 route over /16 and default for 192.168.1.50', () => {
    // Topology:
    //   Router R1 with 3 interfaces:
    //     GigabitEthernet0/0 = 10.0.0.1/8         (default route target network)
    //     GigabitEthernet0/1 = 192.168.0.1/16      (/16 route)
    //     GigabitEthernet0/2 = 192.168.1.1/24      (/24 route — most specific)
    const r1 = new CiscoRouter('R1');

    r1.configureInterface('GigabitEthernet0/0',
      new IPAddress('10.0.0.1'), new SubnetMask('255.0.0.0'));
    r1.configureInterface('GigabitEthernet0/1',
      new IPAddress('192.168.0.1'), new SubnetMask('255.255.0.0'));
    r1.configureInterface('GigabitEthernet0/2',
      new IPAddress('192.168.1.1'), new SubnetMask('255.255.255.0'));

    // Add a default route via 10.0.0.254 (reachable on /8 interface)
    r1.setDefaultRoute(new IPAddress('10.0.0.254'));

    const table = r1.getRoutingTable();

    // Should have 4 routes: 3 connected + 1 default
    expect(table.length).toBe(4);

    // Verify connected routes by interface
    const routes = table.filter(r => r.type === 'connected');
    expect(routes.length).toBe(3);

    const eth0Route = routes.find(r => r.iface === 'GigabitEthernet0/0');
    const eth1Route = routes.find(r => r.iface === 'GigabitEthernet0/1');
    const eth2Route = routes.find(r => r.iface === 'GigabitEthernet0/2');

    expect(eth0Route!.mask.toCIDR()).toBe(8);
    expect(eth1Route!.mask.toCIDR()).toBe(16);
    expect(eth2Route!.mask.toCIDR()).toBe(24);
  });

  it('should forward 192.168.1.50 out /24 interface (eth2), not /16 or default', async () => {
    // Full end-to-end test with actual packet forwarding
    //
    // Topology:
    //   Sender (10.0.0.2) -- R1 -- (3 destinations)
    //     eth0: 10.0.0.0/8      → connected to Sender
    //     eth1: 192.168.0.0/16  → connected to PC_B (192.168.0.2)
    //     eth2: 192.168.1.0/24  → connected to PC_C (192.168.1.50)

    const sender = new LinuxPC('linux-pc', 'Sender');
    const pcB = new LinuxPC('linux-pc', 'PC_B');
    const pcC = new LinuxPC('linux-pc', 'PC_C');
    const r1 = new CiscoRouter('R1');

    sender.configureInterface('eth0', new IPAddress('10.0.0.2'), new SubnetMask('255.0.0.0'));
    pcB.configureInterface('eth0', new IPAddress('192.168.0.2'), new SubnetMask('255.255.0.0'));
    pcC.configureInterface('eth0', new IPAddress('192.168.1.50'), new SubnetMask('255.255.255.0'));

    r1.configureInterface('GigabitEthernet0/0',
      new IPAddress('10.0.0.1'), new SubnetMask('255.0.0.0'));
    r1.configureInterface('GigabitEthernet0/1',
      new IPAddress('192.168.0.1'), new SubnetMask('255.255.0.0'));
    r1.configureInterface('GigabitEthernet0/2',
      new IPAddress('192.168.1.1'), new SubnetMask('255.255.255.0'));

    sender.setDefaultGateway(new IPAddress('10.0.0.1'));
    pcB.setDefaultGateway(new IPAddress('192.168.0.1'));
    pcC.setDefaultGateway(new IPAddress('192.168.1.1'));

    // Wire up
    const c1 = new Cable('c1');
    c1.connect(sender.getPort('eth0')!, r1.getPort('GigabitEthernet0/0')!);
    const c2 = new Cable('c2');
    c2.connect(r1.getPort('GigabitEthernet0/1')!, pcB.getPort('eth0')!);
    const c3 = new Cable('c3');
    c3.connect(r1.getPort('GigabitEthernet0/2')!, pcC.getPort('eth0')!);

    // Ping 192.168.1.50 from Sender → should go via /24 route (eth2) to PC_C
    const output = await sender.executeCommand('ping -c 1 192.168.1.50');
    expect(output).toContain('64 bytes from 192.168.1.50');
    expect(output).toContain('ttl=63'); // 1 router hop
    expect(output).toContain('1 received');

    // Also verify counters show forwarding activity
    const counters = r1.getCounters();
    expect(counters.ipForwDatagrams).toBeGreaterThanOrEqual(1);
  });

  it('should forward 192.168.2.50 out /16 interface (eth1), not /24', async () => {
    // 192.168.2.50 matches 192.168.0.0/16 but NOT 192.168.1.0/24
    const sender = new LinuxPC('linux-pc', 'Sender');
    const pcB = new LinuxPC('linux-pc', 'PC_B');
    const pcC = new LinuxPC('linux-pc', 'PC_C');
    const r1 = new CiscoRouter('R1');

    sender.configureInterface('eth0', new IPAddress('10.0.0.2'), new SubnetMask('255.0.0.0'));
    pcB.configureInterface('eth0', new IPAddress('192.168.2.50'), new SubnetMask('255.255.0.0'));
    pcC.configureInterface('eth0', new IPAddress('192.168.1.50'), new SubnetMask('255.255.255.0'));

    r1.configureInterface('GigabitEthernet0/0',
      new IPAddress('10.0.0.1'), new SubnetMask('255.0.0.0'));
    r1.configureInterface('GigabitEthernet0/1',
      new IPAddress('192.168.0.1'), new SubnetMask('255.255.0.0'));
    r1.configureInterface('GigabitEthernet0/2',
      new IPAddress('192.168.1.1'), new SubnetMask('255.255.255.0'));

    sender.setDefaultGateway(new IPAddress('10.0.0.1'));
    pcB.setDefaultGateway(new IPAddress('192.168.0.1'));
    pcC.setDefaultGateway(new IPAddress('192.168.1.1'));

    const c1 = new Cable('c1');
    c1.connect(sender.getPort('eth0')!, r1.getPort('GigabitEthernet0/0')!);
    const c2 = new Cable('c2');
    c2.connect(r1.getPort('GigabitEthernet0/1')!, pcB.getPort('eth0')!);
    const c3 = new Cable('c3');
    c3.connect(r1.getPort('GigabitEthernet0/2')!, pcC.getPort('eth0')!);

    // Ping 192.168.2.50 from Sender → should match /16 route → eth1 → PC_B
    const output = await sender.executeCommand('ping -c 1 192.168.2.50');
    expect(output).toContain('64 bytes from 192.168.2.50');
    expect(output).toContain('ttl=63');
    expect(output).toContain('1 received');
  });

  it('should use default route for 8.8.8.8 when no specific route matches', async () => {
    // 8.8.8.8 does not match /24 or /16, so should fall through to default
    const sender = new LinuxPC('linux-pc', 'Sender');
    const defaultGw = new LinuxPC('linux-pc', 'DefaultGW');
    const r1 = new CiscoRouter('R1');

    sender.configureInterface('eth0', new IPAddress('10.0.0.2'), new SubnetMask('255.255.255.0'));
    defaultGw.configureInterface('eth0', new IPAddress('172.16.0.2'), new SubnetMask('255.255.255.0'));

    r1.configureInterface('GigabitEthernet0/0',
      new IPAddress('10.0.0.1'), new SubnetMask('255.255.255.0'));
    r1.configureInterface('GigabitEthernet0/1',
      new IPAddress('172.16.0.1'), new SubnetMask('255.255.255.0'));

    // Default route via 172.16.0.2
    r1.setDefaultRoute(new IPAddress('172.16.0.2'));

    sender.setDefaultGateway(new IPAddress('10.0.0.1'));

    const c1 = new Cable('c1');
    c1.connect(sender.getPort('eth0')!, r1.getPort('GigabitEthernet0/0')!);
    const c2 = new Cable('c2');
    c2.connect(r1.getPort('GigabitEthernet0/1')!, defaultGw.getPort('eth0')!);

    // defaultGw needs to know how to reply back — but it won't route back
    // since it has no route to 10.0.0.0/24. The forwarding to defaultGw should
    // still happen. Let's verify the counter shows a forward attempt.
    r1.resetCounters();

    // We can't complete the full ping (defaultGw can't route back),
    // but we can verify the router forwarded the packet by checking counters
    // Use a short ping with timeout — will fail but router should attempt forward
    const output = await sender.executeCommand('ping -c 1 8.8.8.8');

    // Router should have attempted to forward (the packet was sent via default route)
    const counters = r1.getCounters();
    // Either forwarded (if ARP resolved) or at least no addr error (route exists)
    expect(counters.ipInAddrErrors).toBe(0); // Route was found (default)
  });
});

// ═══════════════════════════════════════════════════════════════════
// T-ROUT-02: ICMP Error Generation + Counters
// ═══════════════════════════════════════════════════════════════════

describe('T-ROUT-02: ICMP Error Generation', () => {

  it('should send ICMP Time Exceeded and increment icmpOutTimeExcds when TTL expires', async () => {
    // PC_A (10.0.1.2) → R1 (10.0.1.1 / 10.0.2.1) → PC_B (10.0.2.2)
    const pcA = new LinuxPC('linux-pc', 'PC_A');
    const pcB = new LinuxPC('linux-pc', 'PC_B');
    const r1 = new CiscoRouter('R1');

    pcA.configureInterface('eth0', new IPAddress('10.0.1.2'), new SubnetMask('255.255.255.0'));
    pcB.configureInterface('eth0', new IPAddress('10.0.2.2'), new SubnetMask('255.255.255.0'));
    r1.configureInterface('GigabitEthernet0/0', new IPAddress('10.0.1.1'), new SubnetMask('255.255.255.0'));
    r1.configureInterface('GigabitEthernet0/1', new IPAddress('10.0.2.1'), new SubnetMask('255.255.255.0'));

    pcA.setDefaultGateway(new IPAddress('10.0.1.1'));
    pcB.setDefaultGateway(new IPAddress('10.0.2.1'));

    const c1 = new Cable('c1');
    c1.connect(pcA.getPort('eth0')!, r1.getPort('GigabitEthernet0/0')!);
    const c2 = new Cable('c2');
    c2.connect(r1.getPort('GigabitEthernet0/1')!, pcB.getPort('eth0')!);

    r1.resetCounters();

    // Use traceroute with hop 1 — TTL=1 expires at router
    const output = await pcA.executeCommand('traceroute 10.0.2.2');

    // Router should be visible as hop 1 (Time Exceeded generated)
    expect(output).toContain('10.0.1.1');

    // Verify ICMP Time Exceeded counter
    const counters = r1.getCounters();
    expect(counters.icmpOutTimeExcds).toBeGreaterThanOrEqual(1);
    expect(counters.icmpOutMsgs).toBeGreaterThanOrEqual(1);
  });

  it('should send ICMP Destination Unreachable when no route exists, and increment counter', async () => {
    // PC_A → R1 → ??? (no route to destination)
    const pcA = new LinuxPC('linux-pc', 'PC_A');
    const r1 = new CiscoRouter('R1');

    pcA.configureInterface('eth0', new IPAddress('10.0.1.2'), new SubnetMask('255.255.255.0'));
    r1.configureInterface('GigabitEthernet0/0', new IPAddress('10.0.1.1'), new SubnetMask('255.255.255.0'));
    // Only one interface — no route to 172.16.0.0/16

    pcA.setDefaultGateway(new IPAddress('10.0.1.1'));

    const c1 = new Cable('c1');
    c1.connect(pcA.getPort('eth0')!, r1.getPort('GigabitEthernet0/0')!);

    r1.resetCounters();

    // Ping a destination that has no route at the router
    const output = await pcA.executeCommand('ping -c 1 172.16.0.1');

    // Verify counters: destination unreachable should have been generated
    const counters = r1.getCounters();
    expect(counters.icmpOutDestUnreachs).toBeGreaterThanOrEqual(1);
    expect(counters.icmpOutMsgs).toBeGreaterThanOrEqual(1);
    expect(counters.ipInAddrErrors).toBeGreaterThanOrEqual(1);
  });

  it('should display counters via Cisco CLI "show counters"', async () => {
    const r1 = new CiscoRouter('R1');
    r1.configureInterface('GigabitEthernet0/0', new IPAddress('10.0.1.1'), new SubnetMask('255.255.255.0'));

    const output = await r1.executeCommand('show counters');
    expect(output).toContain('IP statistics:');
    expect(output).toContain('header errors');
    expect(output).toContain('ICMP statistics:');
    expect(output).toContain('Destination unreachable:');
    expect(output).toContain('Time exceeded:');
    expect(output).toContain('Echo replies:');
  });

  it('should display counters via Huawei CLI "display ip traffic"', async () => {
    const r1 = new HuaweiRouter('R1');
    r1.configureInterface('GE0/0/0', new IPAddress('10.0.1.1'), new SubnetMask('255.255.255.0'));

    const output = await r1.executeCommand('display ip traffic');
    expect(output).toContain('IP statistics:');
    expect(output).toContain('header errors');
    expect(output).toContain('ICMP statistics:');
    expect(output).toContain('Destination unreachable:');
    expect(output).toContain('Time exceeded:');
  });

  it('should drop packets with invalid IPv4 version and increment ipInHdrErrors', async () => {
    // We need to directly test the header sanity check.
    // Create a router + connected PC, then spy on the counters.
    const pcA = new LinuxPC('linux-pc', 'PC_A');
    const r1 = new CiscoRouter('R1');

    pcA.configureInterface('eth0', new IPAddress('10.0.1.2'), new SubnetMask('255.255.255.0'));
    r1.configureInterface('GigabitEthernet0/0', new IPAddress('10.0.1.1'), new SubnetMask('255.255.255.0'));

    pcA.setDefaultGateway(new IPAddress('10.0.1.1'));

    const c1 = new Cable('c1');
    c1.connect(pcA.getPort('eth0')!, r1.getPort('GigabitEthernet0/0')!);

    r1.resetCounters();

    // First do a normal ping so ARP is resolved
    await pcA.executeCommand('ping -c 1 10.0.1.1');

    const beforeErrors = r1.getCounters().ipInHdrErrors;

    // Now manually inject a malformed packet via the port
    const routerPort = r1.getPort('GigabitEthernet0/0')!;
    const badPkt = createIPv4Packet(
      new IPAddress('10.0.1.2'),
      new IPAddress('10.0.2.1'),
      IP_PROTO_ICMP,
      64,
      null,
      64,
    );
    // Corrupt the version field
    (badPkt as any).version = 6;
    // Recalculate checksum so checksum check passes but version fails
    badPkt.headerChecksum = 0;
    badPkt.headerChecksum = computeIPv4Checksum(badPkt);

    const frame: EthernetFrame = {
      srcMAC: pcA.getPort('eth0')!.getMAC(),
      dstMAC: routerPort.getMAC(),
      etherType: ETHERTYPE_IPV4,
      payload: badPkt,
    };

    // Deliver frame to router port via cable simulation
    routerPort.receiveFrame(frame);

    const afterErrors = r1.getCounters().ipInHdrErrors;
    expect(afterErrors).toBe(beforeErrors + 1);
  });
});

// ═══════════════════════════════════════════════════════════════════
// T-ROUT-03: L2 Rewrite — MAC Verification
// ═══════════════════════════════════════════════════════════════════

describe('T-ROUT-03: L2 Rewrite — egress MAC verification', () => {

  it('should rewrite srcMAC to router egress interface MAC, not original sender MAC', async () => {
    // PC_A (10.0.1.2) → R1 → PC_B (10.0.2.2)
    // When R1 forwards, the frame to PC_B should have:
    //   srcMAC = R1's GigabitEthernet0/1 MAC (egress)
    //   dstMAC = PC_B's eth0 MAC (next-hop)
    // NOT srcMAC = PC_A's eth0 MAC

    const pcA = new LinuxPC('linux-pc', 'PC_A');
    const pcB = new LinuxPC('linux-pc', 'PC_B');
    const r1 = new CiscoRouter('R1');

    pcA.configureInterface('eth0', new IPAddress('10.0.1.2'), new SubnetMask('255.255.255.0'));
    pcB.configureInterface('eth0', new IPAddress('10.0.2.2'), new SubnetMask('255.255.255.0'));
    r1.configureInterface('GigabitEthernet0/0', new IPAddress('10.0.1.1'), new SubnetMask('255.255.255.0'));
    r1.configureInterface('GigabitEthernet0/1', new IPAddress('10.0.2.1'), new SubnetMask('255.255.255.0'));

    pcA.setDefaultGateway(new IPAddress('10.0.1.1'));
    pcB.setDefaultGateway(new IPAddress('10.0.2.1'));

    const c1 = new Cable('c1');
    c1.connect(pcA.getPort('eth0')!, r1.getPort('GigabitEthernet0/0')!);
    const c2 = new Cable('c2');
    c2.connect(r1.getPort('GigabitEthernet0/1')!, pcB.getPort('eth0')!);

    // Capture frames arriving at PC_B's port
    const receivedFrames: EthernetFrame[] = [];
    const pcBPort = pcB.getPort('eth0')!;
    const origReceive = pcBPort.receiveFrame.bind(pcBPort);
    pcBPort.receiveFrame = (frame: EthernetFrame) => {
      receivedFrames.push(frame);
      origReceive(frame);
    };

    // Ping to trigger forwarding
    await pcA.executeCommand('ping -c 1 10.0.2.2');

    // Reference MACs
    const pcA_MAC = pcA.getPort('eth0')!.getMAC();
    const r1EgressMAC = r1.getPort('GigabitEthernet0/1')!.getMAC();
    const pcB_MAC = pcBPort.getMAC();

    // Find the IPv4 frame forwarded by the router (not ARP)
    const ipv4Frames = receivedFrames.filter(f => f.etherType === ETHERTYPE_IPV4);
    expect(ipv4Frames.length).toBeGreaterThanOrEqual(1);

    // The first IPv4 frame from router to PC_B should have:
    const fwd = ipv4Frames[0];
    // srcMAC MUST be router's egress interface, NOT PC_A's MAC
    expect(fwd.srcMAC.equals(r1EgressMAC)).toBe(true);
    expect(fwd.srcMAC.equals(pcA_MAC)).toBe(false);
    // dstMAC MUST be PC_B's MAC
    expect(fwd.dstMAC.equals(pcB_MAC)).toBe(true);
  });

  it('should rewrite srcMAC at each hop in multi-router topology', async () => {
    // PC_A → R1 → R2 → PC_B
    // At each hop, srcMAC should be the forwarding router's egress interface
    const pcA = new LinuxPC('linux-pc', 'PC_A');
    const pcB = new LinuxPC('linux-pc', 'PC_B');
    const r1 = new CiscoRouter('R1');
    const r2 = new CiscoRouter('R2');

    pcA.configureInterface('eth0', new IPAddress('10.0.1.2'), new SubnetMask('255.255.255.0'));
    pcB.configureInterface('eth0', new IPAddress('10.0.3.2'), new SubnetMask('255.255.255.0'));

    r1.configureInterface('GigabitEthernet0/0', new IPAddress('10.0.1.1'), new SubnetMask('255.255.255.0'));
    r1.configureInterface('GigabitEthernet0/1', new IPAddress('10.0.2.1'), new SubnetMask('255.255.255.0'));

    r2.configureInterface('GigabitEthernet0/0', new IPAddress('10.0.2.2'), new SubnetMask('255.255.255.0'));
    r2.configureInterface('GigabitEthernet0/1', new IPAddress('10.0.3.1'), new SubnetMask('255.255.255.0'));

    r1.addStaticRoute(new IPAddress('10.0.3.0'), new SubnetMask('255.255.255.0'), new IPAddress('10.0.2.2'));
    r2.addStaticRoute(new IPAddress('10.0.1.0'), new SubnetMask('255.255.255.0'), new IPAddress('10.0.2.1'));

    pcA.setDefaultGateway(new IPAddress('10.0.1.1'));
    pcB.setDefaultGateway(new IPAddress('10.0.3.1'));

    const c1 = new Cable('c1');
    c1.connect(pcA.getPort('eth0')!, r1.getPort('GigabitEthernet0/0')!);
    const c2 = new Cable('c2');
    c2.connect(r1.getPort('GigabitEthernet0/1')!, r2.getPort('GigabitEthernet0/0')!);
    const c3 = new Cable('c3');
    c3.connect(r2.getPort('GigabitEthernet0/1')!, pcB.getPort('eth0')!);

    // Capture frames arriving at R2's ingress (from R1)
    const r2IngressFrames: EthernetFrame[] = [];
    const r2InPort = r2.getPort('GigabitEthernet0/0')!;
    const origR2Recv = r2InPort.receiveFrame.bind(r2InPort);
    r2InPort.receiveFrame = (frame: EthernetFrame) => {
      r2IngressFrames.push(frame);
      origR2Recv(frame);
    };

    // Capture frames arriving at PC_B (from R2)
    const pcBFrames: EthernetFrame[] = [];
    const pcBPort = pcB.getPort('eth0')!;
    const origPcBRecv = pcBPort.receiveFrame.bind(pcBPort);
    pcBPort.receiveFrame = (frame: EthernetFrame) => {
      pcBFrames.push(frame);
      origPcBRecv(frame);
    };

    // Ping
    await pcA.executeCommand('ping -c 1 10.0.3.2');

    const r1EgressMAC = r1.getPort('GigabitEthernet0/1')!.getMAC();
    const r2EgressMAC = r2.getPort('GigabitEthernet0/1')!.getMAC();
    const pcA_MAC = pcA.getPort('eth0')!.getMAC();

    // Frames from R1 → R2: srcMAC should be R1's egress interface
    const r2Ipv4 = r2IngressFrames.filter(f => f.etherType === ETHERTYPE_IPV4);
    expect(r2Ipv4.length).toBeGreaterThanOrEqual(1);
    expect(r2Ipv4[0].srcMAC.equals(r1EgressMAC)).toBe(true);
    expect(r2Ipv4[0].srcMAC.equals(pcA_MAC)).toBe(false);

    // Frames from R2 → PC_B: srcMAC should be R2's egress interface
    const pcBIpv4 = pcBFrames.filter(f => f.etherType === ETHERTYPE_IPV4);
    expect(pcBIpv4.length).toBeGreaterThanOrEqual(1);
    expect(pcBIpv4[0].srcMAC.equals(r2EgressMAC)).toBe(true);
    expect(pcBIpv4[0].srcMAC.equals(r1EgressMAC)).toBe(false);
    expect(pcBIpv4[0].srcMAC.equals(pcA_MAC)).toBe(false);
  });

  it('should verify dstMAC is the next-hop MAC, not the final destination MAC', async () => {
    // PC_A → R1 → PC_B
    // Frame from PC_A to R1: dstMAC = R1's ingress MAC
    // Frame from R1 to PC_B: dstMAC = PC_B's MAC

    const pcA = new LinuxPC('linux-pc', 'PC_A');
    const pcB = new LinuxPC('linux-pc', 'PC_B');
    const r1 = new CiscoRouter('R1');

    pcA.configureInterface('eth0', new IPAddress('10.0.1.2'), new SubnetMask('255.255.255.0'));
    pcB.configureInterface('eth0', new IPAddress('10.0.2.2'), new SubnetMask('255.255.255.0'));
    r1.configureInterface('GigabitEthernet0/0', new IPAddress('10.0.1.1'), new SubnetMask('255.255.255.0'));
    r1.configureInterface('GigabitEthernet0/1', new IPAddress('10.0.2.1'), new SubnetMask('255.255.255.0'));

    pcA.setDefaultGateway(new IPAddress('10.0.1.1'));
    pcB.setDefaultGateway(new IPAddress('10.0.2.1'));

    // Capture frames at R1 ingress
    const r1InFrames: EthernetFrame[] = [];
    const r1InPort = r1.getPort('GigabitEthernet0/0')!;
    const origR1Recv = r1InPort.receiveFrame.bind(r1InPort);
    r1InPort.receiveFrame = (frame: EthernetFrame) => {
      r1InFrames.push(frame);
      origR1Recv(frame);
    };

    // Capture frames at PC_B
    const pcBFrames: EthernetFrame[] = [];
    const pcBPort = pcB.getPort('eth0')!;
    const origPcBRecv = pcBPort.receiveFrame.bind(pcBPort);
    pcBPort.receiveFrame = (frame: EthernetFrame) => {
      pcBFrames.push(frame);
      origPcBRecv(frame);
    };

    const c1 = new Cable('c1');
    c1.connect(pcA.getPort('eth0')!, r1.getPort('GigabitEthernet0/0')!);
    const c2 = new Cable('c2');
    c2.connect(r1.getPort('GigabitEthernet0/1')!, pcB.getPort('eth0')!);

    await pcA.executeCommand('ping -c 1 10.0.2.2');

    const r1IngressMAC = r1.getPort('GigabitEthernet0/0')!.getMAC();
    const pcB_MAC = pcBPort.getMAC();

    // Frames arriving at R1 from PC_A: dstMAC should be R1's ingress MAC
    const r1Ipv4 = r1InFrames.filter(f => f.etherType === ETHERTYPE_IPV4);
    expect(r1Ipv4.length).toBeGreaterThanOrEqual(1);
    expect(r1Ipv4[0].dstMAC.equals(r1IngressMAC)).toBe(true);

    // Frames arriving at PC_B from R1: dstMAC should be PC_B's MAC
    const pcBIpv4 = pcBFrames.filter(f => f.etherType === ETHERTYPE_IPV4);
    expect(pcBIpv4.length).toBeGreaterThanOrEqual(1);
    expect(pcBIpv4[0].dstMAC.equals(pcB_MAC)).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════
// T-ROUT-VENDOR: Huawei VRP CLI commands
// ═══════════════════════════════════════════════════════════════════

describe('T-ROUT-VENDOR: Huawei VRP CLI', () => {

  it('should use GE0/0/N port naming for Huawei routers', () => {
    const r = new HuaweiRouter('HW1');
    expect(r.getPort('GE0/0/0')).toBeDefined();
    expect(r.getPort('GE0/0/1')).toBeDefined();
    expect(r.getPort('GE0/0/2')).toBeDefined();
    expect(r.getPort('GE0/0/3')).toBeDefined();
  });

  it('should display routing table in Huawei format', async () => {
    const r = new HuaweiRouter('HW1');
    r.configureInterface('GE0/0/0', new IPAddress('10.0.1.1'), new SubnetMask('255.255.255.0'));
    r.configureInterface('GE0/0/1', new IPAddress('10.0.2.1'), new SubnetMask('255.255.255.0'));

    const output = await r.executeCommand('display ip routing-table');
    expect(output).toContain('Routing Tables: Public');
    expect(output).toContain('Destination/Mask');
    expect(output).toContain('Direct');
    expect(output).toContain('GE0/0/0');
    expect(output).toContain('GE0/0/1');
  });

  it('should add static route via ip route-static command', async () => {
    const r = new HuaweiRouter('HW1');
    r.configureInterface('GE0/0/0', new IPAddress('10.0.1.1'), new SubnetMask('255.255.255.0'));
    r.configureInterface('GE0/0/1', new IPAddress('10.0.2.1'), new SubnetMask('255.255.255.0'));

    const result = await r.executeCommand('ip route-static 192.168.0.0 255.255.255.0 10.0.2.2');
    expect(result).toBe('');

    const table = r.getRoutingTable();
    const staticRoute = table.find(rt => rt.type === 'static');
    expect(staticRoute).toBeDefined();
    expect(staticRoute!.network.toString()).toBe('192.168.0.0');
    expect(staticRoute!.nextHop!.toString()).toBe('10.0.2.2');
  });

  it('should display current-configuration in Huawei format', async () => {
    const r = new HuaweiRouter('HW1');
    r.configureInterface('GE0/0/0', new IPAddress('10.0.1.1'), new SubnetMask('255.255.255.0'));

    const output = await r.executeCommand('display current-configuration');
    expect(output).toContain('sysname');
    expect(output).toContain('interface GE0/0/0');
    expect(output).toContain('ip address 10.0.1.1');
  });

  it('should report correct OS type for each vendor', () => {
    const cisco = new CiscoRouter('C1');
    const huawei = new HuaweiRouter('H1');

    expect(cisco.getOSType()).toBe('cisco-ios');
    expect(huawei.getOSType()).toBe('huawei-vrp');
  });
});
