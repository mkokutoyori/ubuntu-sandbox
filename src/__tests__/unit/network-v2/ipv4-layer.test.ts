/**
 * TDD Tests for IPv4 Layer (DET-L3-001)
 *
 * Group 1: Unit Tests — IPv4 structure, checksum, encapsulation
 * Group 2: Functional Tests — Routing, TTL, ICMP errors
 * Group 3: Integration Tests — ARP-IP binding, multi-router
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  IPAddress, SubnetMask, MACAddress,
  IPv4Packet, ICMPPacket, EthernetFrame,
  createIPv4Packet, computeIPv4Checksum, verifyIPv4Checksum,
  IP_PROTO_ICMP, ETHERTYPE_IPV4,
  resetCounters,
} from '@/network/core/types';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { Switch } from '@/network/devices/Switch';
import { Router } from '@/network/devices/Router';
import { Cable } from '@/network/hardware/Cable';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.reset();
});

// ═══════════════════════════════════════════════════════════════════
// GROUP 1: Unit Tests — Structure & Checksum
// ═══════════════════════════════════════════════════════════════════

describe('Group 1: IPv4 Structure & Checksum', () => {

  // U-L3-01: Checksum integrity
  describe('U-L3-01: Checksum integrity', () => {
    it('should compute a valid checksum for a standard IPv4 packet', () => {
      const pkt = createIPv4Packet(
        new IPAddress('192.168.1.10'),
        new IPAddress('192.168.1.20'),
        IP_PROTO_ICMP,
        64,
        null,
        64,
      );

      expect(pkt.headerChecksum).not.toBe(0);
      expect(verifyIPv4Checksum(pkt)).toBe(true);
    });

    it('should fail verification when source IP is modified', () => {
      const pkt = createIPv4Packet(
        new IPAddress('192.168.1.10'),
        new IPAddress('192.168.1.20'),
        IP_PROTO_ICMP,
        64,
        null,
        64,
      );

      // Corrupt the source IP without recalculating checksum
      (pkt as any).sourceIP = new IPAddress('10.0.0.1');
      expect(verifyIPv4Checksum(pkt)).toBe(false);
    });

    it('should fail verification when TTL is modified without recalculation', () => {
      const pkt = createIPv4Packet(
        new IPAddress('10.0.1.2'),
        new IPAddress('10.0.2.2'),
        IP_PROTO_ICMP,
        64,
        null,
        64,
      );

      pkt.ttl = 63; // Simulate TTL decrement without recalculating
      expect(verifyIPv4Checksum(pkt)).toBe(false);
    });

    it('should pass verification after TTL decrement + checksum recalculation', () => {
      const pkt = createIPv4Packet(
        new IPAddress('10.0.1.2'),
        new IPAddress('10.0.2.2'),
        IP_PROTO_ICMP,
        64,
        null,
        64,
      );

      pkt.ttl = 63;
      pkt.headerChecksum = 0;
      pkt.headerChecksum = computeIPv4Checksum(pkt);
      expect(verifyIPv4Checksum(pkt)).toBe(true);
    });
  });

  // U-L3-02: Encapsulation sequence
  describe('U-L3-02: Encapsulation sequence', () => {
    it('should encapsulate ICMP inside IPv4 inside Ethernet', () => {
      const icmp: ICMPPacket = {
        type: 'icmp',
        icmpType: 'echo-request',
        code: 0,
        id: 1,
        sequence: 1,
        dataSize: 56,
      };

      const ipPkt = createIPv4Packet(
        new IPAddress('192.168.1.10'),
        new IPAddress('192.168.1.20'),
        IP_PROTO_ICMP,
        64,
        icmp,
        64,
      );

      const frame: EthernetFrame = {
        srcMAC: MACAddress.generate(),
        dstMAC: MACAddress.generate(),
        etherType: ETHERTYPE_IPV4,
        payload: ipPkt,
      };

      // Verify encapsulation hierarchy
      expect(frame.etherType).toBe(0x0800);

      const l3 = frame.payload as IPv4Packet;
      expect(l3.type).toBe('ipv4');
      expect(l3.version).toBe(4);
      expect(l3.ihl).toBe(5);
      expect(l3.protocol).toBe(IP_PROTO_ICMP);
      expect(l3.sourceIP.toString()).toBe('192.168.1.10');
      expect(l3.destinationIP.toString()).toBe('192.168.1.20');
      expect(l3.ttl).toBe(64);
      expect(l3.totalLength).toBe(20 + 64); // header + payload
      expect(l3.flags).toBe(0b010); // DF set

      const l4 = l3.payload as ICMPPacket;
      expect(l4.type).toBe('icmp');
      expect(l4.icmpType).toBe('echo-request');
      expect(l4.id).toBe(1);
      expect(l4.sequence).toBe(1);
      expect(l4.dataSize).toBe(56);
    });

    it('should NOT have source/destination IP in ICMP packet', () => {
      const icmp: ICMPPacket = {
        type: 'icmp',
        icmpType: 'echo-request',
        code: 0,
        id: 1,
        sequence: 1,
        dataSize: 56,
      };

      // ICMPPacket should NOT have sourceIP or destinationIP
      expect((icmp as any).sourceIP).toBeUndefined();
      expect((icmp as any).destinationIP).toBeUndefined();
      expect((icmp as any).ttl).toBeUndefined();
    });
  });
});

// ═══════════════════════════════════════════════════════════════════
// GROUP 2: Functional Tests — Routing & TTL
// ═══════════════════════════════════════════════════════════════════

describe('Group 2: Routing & TTL', () => {

  // F-L3-01: Successful router hop
  describe('F-L3-01: Router hop — TTL decrement', () => {
    it('should decrement TTL by 1 when passing through a router', async () => {
      // Topology: PC_A (10.0.1.2) — Switch — Router (10.0.1.1 / 10.0.2.1) — Switch — PC_B (10.0.2.2)
      const pcA = new LinuxPC('linux-pc', 'PC_A');
      const pcB = new LinuxPC('linux-pc', 'PC_B');
      const sw1 = new Switch('switch-cisco', 'SW1', 8);
      const sw2 = new Switch('switch-cisco', 'SW2', 8);
      const router = new Router('router-cisco', 'R1');

      // Configure IPs
      pcA.getPort('eth0')!.configureIP(new IPAddress('10.0.1.2'), new SubnetMask('255.255.255.0'));
      pcB.getPort('eth0')!.configureIP(new IPAddress('10.0.2.2'), new SubnetMask('255.255.255.0'));
      router.configureInterface('GigabitEthernet0/0', new IPAddress('10.0.1.1'), new SubnetMask('255.255.255.0'));
      router.configureInterface('GigabitEthernet0/1', new IPAddress('10.0.2.1'), new SubnetMask('255.255.255.0'));

      // Set default gateways
      pcA.setDefaultGateway(new IPAddress('10.0.1.1'));
      pcB.setDefaultGateway(new IPAddress('10.0.2.1'));

      // Wire: PC_A.eth0 — SW1.port0 — R1.Gi0/0, R1.Gi0/1 — SW2.port0 — PC_B.eth0
      const c1 = new Cable('c1');
      c1.connect(pcA.getPort('eth0')!, sw1.getPort('GigabitEthernet0/0')!);
      const c2 = new Cable('c2');
      c2.connect(sw1.getPort('GigabitEthernet0/1')!, router.getPort('GigabitEthernet0/0')!);
      const c3 = new Cable('c3');
      c3.connect(router.getPort('GigabitEthernet0/1')!, sw2.getPort('GigabitEthernet0/0')!);
      const c4 = new Cable('c4');
      c4.connect(sw2.getPort('GigabitEthernet0/1')!, pcB.getPort('eth0')!);

      // Ping from A to B
      const results = await pcA.executeCommand('ping -c 1 10.0.2.2');

      // Should succeed with TTL=63 (64 - 1 hop)
      expect(results).toContain('64 bytes from 10.0.2.2');
      expect(results).toContain('ttl=63');
      expect(results).toContain('1 received');
    });
  });

  // F-L3-02: TTL expiry — ICMP Time Exceeded
  describe('F-L3-02: TTL expiry', () => {
    it('should receive ICMP Time Exceeded when TTL expires at router', async () => {
      // Same topology but we send with TTL that will expire
      const pcA = new LinuxPC('linux-pc', 'PC_A');
      const pcB = new LinuxPC('linux-pc', 'PC_B');
      const sw1 = new Switch('switch-cisco', 'SW1', 8);
      const sw2 = new Switch('switch-cisco', 'SW2', 8);
      const router = new Router('router-cisco', 'R1');

      pcA.getPort('eth0')!.configureIP(new IPAddress('10.0.1.2'), new SubnetMask('255.255.255.0'));
      pcB.getPort('eth0')!.configureIP(new IPAddress('10.0.2.2'), new SubnetMask('255.255.255.0'));
      router.configureInterface('GigabitEthernet0/0', new IPAddress('10.0.1.1'), new SubnetMask('255.255.255.0'));
      router.configureInterface('GigabitEthernet0/1', new IPAddress('10.0.2.1'), new SubnetMask('255.255.255.0'));

      pcA.setDefaultGateway(new IPAddress('10.0.1.1'));
      pcB.setDefaultGateway(new IPAddress('10.0.2.1'));

      const c1 = new Cable('c1');
      c1.connect(pcA.getPort('eth0')!, sw1.getPort('GigabitEthernet0/0')!);
      const c2 = new Cable('c2');
      c2.connect(sw1.getPort('GigabitEthernet0/1')!, router.getPort('GigabitEthernet0/0')!);
      const c3 = new Cable('c3');
      c3.connect(router.getPort('GigabitEthernet0/1')!, sw2.getPort('GigabitEthernet0/0')!);
      const c4 = new Cable('c4');
      c4.connect(sw2.getPort('GigabitEthernet0/1')!, pcB.getPort('eth0')!);

      // Traceroute sends with incrementing TTL — first hop (TTL=1) should reveal router
      const results = await pcA.executeCommand('traceroute 10.0.2.2');

      // Should show the router as hop 1 and destination as hop 2
      expect(results).toContain('10.0.1.1');  // Router IP at hop 1
      expect(results).toContain('10.0.2.2');  // Destination at hop 2
    });
  });

  // F-L3-03: Destination unreachable (no route)
  describe('F-L3-03: Destination unreachable', () => {
    it('should return unreachable when PC has no route to destination', async () => {
      const pcA = new LinuxPC('linux-pc', 'PC_A');
      pcA.getPort('eth0')!.configureIP(new IPAddress('192.168.1.10'), new SubnetMask('255.255.255.0'));
      // No default gateway set → 10.0.0.1 is unreachable

      const results = await pcA.executeCommand('ping -c 1 10.0.0.1');
      expect(results).toContain('Network is unreachable');
    });
  });
});

// ═══════════════════════════════════════════════════════════════════
// GROUP 3: Integration Tests — Realistic Scenarios
// ═══════════════════════════════════════════════════════════════════

describe('Group 3: Integration — Realistic Scenarios', () => {

  // I-L3-01: Same-subnet ping still works (ARP → IPv4 → ICMP)
  describe('I-L3-01: Same-subnet ping with proper encapsulation', () => {
    it('should ping on same subnet with IPv4 encapsulation', async () => {
      const pc1 = new LinuxPC('linux-pc', 'PC1');
      const pc2 = new LinuxPC('linux-pc', 'PC2');
      const sw = new Switch('switch-cisco', 'SW1', 8);

      pc1.getPort('eth0')!.configureIP(new IPAddress('192.168.1.10'), new SubnetMask('255.255.255.0'));
      pc2.getPort('eth0')!.configureIP(new IPAddress('192.168.1.20'), new SubnetMask('255.255.255.0'));

      const c1 = new Cable('c1');
      c1.connect(pc1.getPort('eth0')!, sw.getPort('GigabitEthernet0/0')!);
      const c2 = new Cable('c2');
      c2.connect(pc2.getPort('eth0')!, sw.getPort('GigabitEthernet0/1')!);

      const output = await pc1.executeCommand('ping -c 2 192.168.1.20');

      expect(output).toContain('64 bytes from 192.168.1.20');
      expect(output).toContain('icmp_seq=1');
      expect(output).toContain('icmp_seq=2');
      expect(output).toContain('2 received');
      expect(output).toContain('0% packet loss');
      // TTL should be 64 (same subnet, no router hop)
      expect(output).toContain('ttl=64');
    });
  });

  // I-L3-02: Multi-router ping — TTL decremented at each hop
  describe('I-L3-02: Multi-router — TTL decremented at each hop', () => {
    it('should decrement TTL across 2 routers', async () => {
      // PC_A (10.0.1.2) — R1 (10.0.1.1/10.0.2.1) — R2 (10.0.2.2/10.0.3.1) — PC_B (10.0.3.2)
      const pcA = new LinuxPC('linux-pc', 'PC_A');
      const pcB = new LinuxPC('linux-pc', 'PC_B');
      const r1 = new Router('router-cisco', 'R1');
      const r2 = new Router('router-cisco', 'R2');

      pcA.getPort('eth0')!.configureIP(new IPAddress('10.0.1.2'), new SubnetMask('255.255.255.0'));
      pcB.getPort('eth0')!.configureIP(new IPAddress('10.0.3.2'), new SubnetMask('255.255.255.0'));

      r1.configureInterface('GigabitEthernet0/0', new IPAddress('10.0.1.1'), new SubnetMask('255.255.255.0'));
      r1.configureInterface('GigabitEthernet0/1', new IPAddress('10.0.2.1'), new SubnetMask('255.255.255.0'));

      r2.configureInterface('GigabitEthernet0/0', new IPAddress('10.0.2.2'), new SubnetMask('255.255.255.0'));
      r2.configureInterface('GigabitEthernet0/1', new IPAddress('10.0.3.1'), new SubnetMask('255.255.255.0'));

      // Static routes
      r1.addStaticRoute(new IPAddress('10.0.3.0'), new SubnetMask('255.255.255.0'), new IPAddress('10.0.2.2'));
      r2.addStaticRoute(new IPAddress('10.0.1.0'), new SubnetMask('255.255.255.0'), new IPAddress('10.0.2.1'));

      // Default gateways
      pcA.setDefaultGateway(new IPAddress('10.0.1.1'));
      pcB.setDefaultGateway(new IPAddress('10.0.3.1'));

      // Cables: PC_A — R1 — R2 — PC_B (direct connections, no switches needed)
      const c1 = new Cable('c1');
      c1.connect(pcA.getPort('eth0')!, r1.getPort('GigabitEthernet0/0')!);
      const c2 = new Cable('c2');
      c2.connect(r1.getPort('GigabitEthernet0/1')!, r2.getPort('GigabitEthernet0/0')!);
      const c3 = new Cable('c3');
      c3.connect(r2.getPort('GigabitEthernet0/1')!, pcB.getPort('eth0')!);

      const output = await pcA.executeCommand('ping -c 1 10.0.3.2');

      // TTL should be 62 (64 - 2 hops)
      expect(output).toContain('64 bytes from 10.0.3.2');
      expect(output).toContain('ttl=62');
      expect(output).toContain('1 received');
    });
  });

  // I-L3-03: Windows PC through router
  describe('I-L3-03: Windows PC through router', () => {
    it('should ping through router with Windows TTL (128)', async () => {
      const winPC = new WindowsPC('windows-pc', 'WinPC');
      const linPC = new LinuxPC('linux-pc', 'LinPC');
      const router = new Router('router-cisco', 'R1');

      winPC.getPort('eth0')!.configureIP(new IPAddress('10.0.1.2'), new SubnetMask('255.255.255.0'));
      linPC.getPort('eth0')!.configureIP(new IPAddress('10.0.2.2'), new SubnetMask('255.255.255.0'));
      router.configureInterface('GigabitEthernet0/0', new IPAddress('10.0.1.1'), new SubnetMask('255.255.255.0'));
      router.configureInterface('GigabitEthernet0/1', new IPAddress('10.0.2.1'), new SubnetMask('255.255.255.0'));

      winPC.setDefaultGateway(new IPAddress('10.0.1.1'));
      linPC.setDefaultGateway(new IPAddress('10.0.2.1'));

      const c1 = new Cable('c1');
      c1.connect(winPC.getPort('eth0')!, router.getPort('GigabitEthernet0/0')!);
      const c2 = new Cable('c2');
      c2.connect(router.getPort('GigabitEthernet0/1')!, linPC.getPort('eth0')!);

      // Ping from Windows → Linux (through router)
      const output = await winPC.executeCommand('ping -n 1 10.0.2.2');

      expect(output).toContain('Reply from 10.0.2.2');
      // Linux replies with TTL=64, decremented by 1 through router = 63
      expect(output).toContain('TTL=63');
    });
  });

  // I-L3-04: Router show commands
  describe('I-L3-04: Router CLI commands', () => {
    it('should display routing table with connected and static routes', async () => {
      const router = new Router('router-cisco', 'R1');
      router.configureInterface('GigabitEthernet0/0', new IPAddress('10.0.1.1'), new SubnetMask('255.255.255.0'));
      router.configureInterface('GigabitEthernet0/1', new IPAddress('10.0.2.1'), new SubnetMask('255.255.255.0'));
      router.addStaticRoute(new IPAddress('10.0.3.0'), new SubnetMask('255.255.255.0'), new IPAddress('10.0.2.2'));

      const output = await router.executeCommand('show ip route');
      expect(output).toContain('C    10.0.1.0/24 is directly connected');
      expect(output).toContain('C    10.0.2.0/24 is directly connected');
      expect(output).toContain('S    10.0.3.0/24 via 10.0.2.2');
    });

    it('should display interface brief', async () => {
      const router = new Router('router-cisco', 'R1');
      router.configureInterface('GigabitEthernet0/0', new IPAddress('10.0.1.1'), new SubnetMask('255.255.255.0'));

      const output = await router.executeCommand('show ip interface brief');
      expect(output).toContain('GigabitEthernet0/0');
      expect(output).toContain('10.0.1.1');
    });
  });

  // I-L3-05: Ping router interface directly
  describe('I-L3-05: Ping router interface', () => {
    it('should respond to ping addressed to router interface IP', async () => {
      const pc = new LinuxPC('linux-pc', 'PC1');
      const router = new Router('router-cisco', 'R1');

      pc.getPort('eth0')!.configureIP(new IPAddress('10.0.1.2'), new SubnetMask('255.255.255.0'));
      router.configureInterface('GigabitEthernet0/0', new IPAddress('10.0.1.1'), new SubnetMask('255.255.255.0'));

      const c1 = new Cable('c1');
      c1.connect(pc.getPort('eth0')!, router.getPort('GigabitEthernet0/0')!);

      const output = await pc.executeCommand('ping -c 1 10.0.1.1');
      expect(output).toContain('64 bytes from 10.0.1.1');
      // Router uses TTL=255
      expect(output).toContain('ttl=255');
    });
  });

  // I-L3-06: ip route command on Linux
  describe('I-L3-06: Linux ip route command', () => {
    it('should show connected routes and default gateway', async () => {
      const pc = new LinuxPC('linux-pc', 'PC1');
      pc.getPort('eth0')!.configureIP(new IPAddress('192.168.1.10'), new SubnetMask('255.255.255.0'));
      pc.setDefaultGateway(new IPAddress('192.168.1.1'));

      const output = await pc.executeCommand('ip route');
      expect(output).toContain('192.168.1.0/24 dev eth0');
      expect(output).toContain('default via 192.168.1.1 dev eth0');
    });
  });
});
