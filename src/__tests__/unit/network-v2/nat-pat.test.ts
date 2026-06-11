/**
 * NAT/PAT Test Suite
 *
 * Group 1: NATEngine unit tests (pure engine, no router)
 * Group 2: Cisco IOS CLI — static NAT configuration
 * Group 3: Cisco IOS CLI — PAT/overload configuration
 * Group 4: Cisco IOS CLI — show commands and running-config
 * Group 5: Huawei VRP CLI — nat static / nat outbound
 * Group 6: Huawei VRP CLI — nat server (port forwarding)
 * Group 7: Huawei VRP CLI — display commands
 * Group 8: NATEngine packet translation (SNAT/DNAT/PAT)
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  IPAddress, SubnetMask, MACAddress,
  createIPv4Packet,
  ETHERTYPE_IPV4,
  IP_PROTO_ICMP, IP_PROTO_UDP, IP_PROTO_TCP,
  resetCounters,
} from '@/network/core/types';
import type { UDPPacket, TCPPacket, ICMPPacket, IPv4Packet } from '@/network/core/types';
import { NATEngine } from '@/network/devices/router/NATEngine';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { HuaweiRouter } from '@/network/devices/HuaweiRouter';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
});

function makeCiscoRouter(): CiscoRouter {
  const r = new CiscoRouter('R1');
  r.configureInterface('GigabitEthernet0/0', new IPAddress('192.168.1.1'), new SubnetMask('255.255.255.0'));
  r.configureInterface('GigabitEthernet0/1', new IPAddress('203.0.113.1'), new SubnetMask('255.255.255.0'));
  return r;
}

function makeHuaweiRouter(): HuaweiRouter {
  const r = new HuaweiRouter('HW1');
  r.configureInterface('GE0/0/0', new IPAddress('192.168.1.1'), new SubnetMask('255.255.255.0'));
  r.configureInterface('GE0/0/1', new IPAddress('203.0.113.1'), new SubnetMask('255.255.255.0'));
  return r;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function cfg(router: CiscoRouter | HuaweiRouter, cmds: string[]): Promise<void> {
  for (const cmd of cmds) await router.executeCommand(cmd);
}

function makeUDPPacket(srcIP: string, dstIP: string, srcPort: number, dstPort: number): IPv4Packet {
  const udp: UDPPacket = { type: 'udp', sourcePort: srcPort, destinationPort: dstPort, payload: null };
  return createIPv4Packet(new IPAddress(srcIP), new IPAddress(dstIP), IP_PROTO_UDP, 64, udp, 28);
}

function makeICMPPacket(srcIP: string, dstIP: string, id = 1): IPv4Packet {
  const icmp: ICMPPacket = { type: 'icmp', icmpType: 'echo-request', code: 0, id, sequence: 1, dataSize: 8 };
  return createIPv4Packet(new IPAddress(srcIP), new IPAddress(dstIP), IP_PROTO_ICMP, 64, icmp, 16);
}

function makeTCPPacket(
  srcIP: string, dstIP: string, srcPort: number, dstPort: number,
  flags: Partial<{ syn: boolean; ack: boolean; fin: boolean; rst: boolean }> = {},
): IPv4Packet {
  const tcp: TCPPacket = {
    type: 'tcp', sourcePort: srcPort, destinationPort: dstPort,
    sequenceNumber: 1000, acknowledgementNumber: 0,
    flags: { syn: false, ack: false, fin: false, rst: false, psh: false, urg: false, ...flags },
    windowSize: 65535, checksum: 0, payload: null,
  };
  return createIPv4Packet(new IPAddress(srcIP), new IPAddress(dstIP), IP_PROTO_TCP, 64, tcp, 40);
}

// ═══════════════════════════════════════════════════════════════════════════
// Group 1: NATEngine unit tests
// ═══════════════════════════════════════════════════════════════════════════

describe('Group 1: NATEngine — static NAT entries', () => {
  let engine: NATEngine;

  beforeEach(() => { engine = new NATEngine(); });

  it('1.1 addStaticEntry stores and retrieves entry', () => {
    engine.addStaticEntry({ localIP: '192.168.1.10', globalIP: '203.0.113.10' });
    const entries = engine.getStaticEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0].localIP).toBe('192.168.1.10');
    expect(entries[0].globalIP).toBe('203.0.113.10');
  });

  it('1.2 addStaticEntry prevents duplicates', () => {
    engine.addStaticEntry({ localIP: '192.168.1.10', globalIP: '203.0.113.10' });
    engine.addStaticEntry({ localIP: '192.168.1.10', globalIP: '203.0.113.10' });
    expect(engine.getStaticEntries()).toHaveLength(1);
  });

  it('1.3 removeStaticEntry removes by localIP+globalIP', () => {
    engine.addStaticEntry({ localIP: '192.168.1.10', globalIP: '203.0.113.10' });
    engine.removeStaticEntry('192.168.1.10', '203.0.113.10');
    expect(engine.getStaticEntries()).toHaveLength(0);
  });

  it('1.4 port-forwarding static entry stores protocol and ports', () => {
    engine.addStaticEntry({ localIP: '192.168.1.20', globalIP: '203.0.113.20', protocol: 'tcp', localPort: 80, globalPort: 8080 });
    const e = engine.getStaticEntries()[0];
    expect(e.protocol).toBe('tcp');
    expect(e.localPort).toBe(80);
    expect(e.globalPort).toBe(8080);
  });
});

describe('Group 1b: NATEngine — interface designation', () => {
  let engine: NATEngine;

  beforeEach(() => { engine = new NATEngine(); });

  it('1.5 setInsideInterface marks interface as inside', () => {
    engine.setInsideInterface('GigabitEthernet0/0');
    expect(engine.isInsideInterface('GigabitEthernet0/0')).toBe(true);
    expect(engine.isOutsideInterface('GigabitEthernet0/0')).toBe(false);
  });

  it('1.6 setOutsideInterface marks interface as outside', () => {
    engine.setOutsideInterface('GigabitEthernet0/1');
    expect(engine.isOutsideInterface('GigabitEthernet0/1')).toBe(true);
    expect(engine.isInsideInterface('GigabitEthernet0/1')).toBe(false);
  });

  it('1.7 removeInsideInterface clears designation', () => {
    engine.setInsideInterface('GigabitEthernet0/0');
    engine.removeInsideInterface('GigabitEthernet0/0');
    expect(engine.isInsideInterface('GigabitEthernet0/0')).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Group 2: Cisco IOS — static NAT CLI
// ═══════════════════════════════════════════════════════════════════════════

describe('Group 2: Cisco IOS — static NAT CLI', () => {
  let r: CiscoRouter;

  beforeEach(() => { r = makeCiscoRouter(); });

  it('2.1 ip nat inside marks interface', async () => {
    await cfg(r, ['enable', 'configure terminal', 'interface GigabitEthernet0/0', 'ip nat inside']);
    expect(r._getNATEngine().isInsideInterface('GigabitEthernet0/0')).toBe(true);
  });

  it('2.2 ip nat outside marks interface', async () => {
    await cfg(r, ['enable', 'configure terminal', 'interface GigabitEthernet0/1', 'ip nat outside']);
    expect(r._getNATEngine().isOutsideInterface('GigabitEthernet0/1')).toBe(true);
  });

  it('2.3 no ip nat inside removes designation', async () => {
    await cfg(r, ['enable', 'configure terminal', 'interface GigabitEthernet0/0', 'ip nat inside', 'no ip nat inside']);
    expect(r._getNATEngine().isInsideInterface('GigabitEthernet0/0')).toBe(false);
  });

  it('2.4 ip nat inside source static adds IP-only entry', async () => {
    await cfg(r, ['enable', 'configure terminal', 'ip nat inside source static 192.168.1.10 203.0.113.10']);
    const entries = r._getNATEngine().getStaticEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0].localIP).toBe('192.168.1.10');
    expect(entries[0].globalIP).toBe('203.0.113.10');
    expect(entries[0].protocol).toBeUndefined();
  });

  it('2.5 ip nat inside source static tcp adds port-forwarding entry', async () => {
    await cfg(r, ['enable', 'configure terminal',
      'ip nat inside source static tcp 192.168.1.20 80 203.0.113.20 8080']);
    const e = r._getNATEngine().getStaticEntries()[0];
    expect(e.protocol).toBe('tcp');
    expect(e.localPort).toBe(80);
    expect(e.globalPort).toBe(8080);
  });

  it('2.6 no ip nat inside source static removes entry', async () => {
    await cfg(r, ['enable', 'configure terminal',
      'ip nat inside source static 192.168.1.10 203.0.113.10',
      'no ip nat inside source static 192.168.1.10 203.0.113.10']);
    expect(r._getNATEngine().getStaticEntries()).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Group 3: Cisco IOS — PAT / dynamic NAT CLI
// ═══════════════════════════════════════════════════════════════════════════

describe('Group 3: Cisco IOS — PAT / dynamic NAT CLI', () => {
  let r: CiscoRouter;

  beforeEach(() => { r = makeCiscoRouter(); });

  it('3.1 ip nat inside source list … overload adds PAT rule', async () => {
    await cfg(r, ['enable', 'configure terminal',
      'ip nat inside source list 1 interface GigabitEthernet0/1 overload']);
    const rules = r._getNATEngine().getDynamicRules();
    expect(rules).toHaveLength(1);
    expect(rules[0].type).toBe('overload');
    expect(String(rules[0].aclId)).toBe('1');
  });

  it('3.2 ip nat inside source list … pool adds pool rule', async () => {
    await cfg(r, ['enable', 'configure terminal',
      'ip nat pool MYPOOL 203.0.113.10 203.0.113.20 netmask 255.255.255.0',
      'ip nat inside source list 1 pool MYPOOL']);
    const rules = r._getNATEngine().getDynamicRules();
    expect(rules[0].type).toBe('pool');
    expect(rules[0].poolName).toBe('MYPOOL');
  });

  it('3.3 ip nat pool stores pool', async () => {
    await cfg(r, ['enable', 'configure terminal',
      'ip nat pool EXTPOOL 203.0.113.50 203.0.113.60 netmask 255.255.255.0']);
    const pool = r._getNATEngine().getPool('EXTPOOL');
    expect(pool).toBeDefined();
    expect(pool!.startIP).toBe('203.0.113.50');
    expect(pool!.endIP).toBe('203.0.113.60');
  });

  it('3.4 no ip nat inside source list removes rule', async () => {
    await cfg(r, ['enable', 'configure terminal',
      'ip nat inside source list 1 interface GigabitEthernet0/1 overload',
      'no ip nat inside source list 1']);
    expect(r._getNATEngine().getDynamicRules()).toHaveLength(0);
  });

  it('3.5 no ip nat pool removes pool', async () => {
    await cfg(r, ['enable', 'configure terminal',
      'ip nat pool P1 203.0.113.10 203.0.113.20 netmask 255.255.255.0',
      'no ip nat pool P1']);
    expect(r._getNATEngine().getPool('P1')).toBeUndefined();
  });

  it('3.6 clear ip nat translation * removes sessions', async () => {
    // Set up PAT so a session can be created
    const engine = r._getNATEngine();
    engine.setInsideInterface('GigabitEthernet0/0');
    engine.setOutsideInterface('GigabitEthernet0/1');
    engine.setInterfaceIPFn(() => '203.0.113.1');
    engine.setACLMatchFn(() => true);
    engine.addDynamicRule({ aclId: '1', type: 'overload' });
    const pkt = makeUDPPacket('192.168.1.10', '8.8.8.8', 5000, 53);
    engine.translateOutbound(pkt, 'GigabitEthernet0/1', 'GigabitEthernet0/0');
    expect(engine.getTranslationCount()).toBeGreaterThan(0);

    await cfg(r, ['enable', 'clear ip nat translation *']);
    expect(engine.getTranslationCount()).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Group 4: Cisco IOS — show commands and running-config
// ═══════════════════════════════════════════════════════════════════════════

describe('Group 4: Cisco IOS — show ip nat translations', () => {
  let r: CiscoRouter;

  beforeEach(() => { r = makeCiscoRouter(); });

  it('4.1 show ip nat translations empty', async () => {
    await cfg(r, ['enable']);
    const out = await r.executeCommand('show ip nat translations');
    expect(out).toMatch(/No NAT translations/i);
  });

  it('4.2 show ip nat translations shows static entry', async () => {
    await cfg(r, ['enable', 'configure terminal',
      'ip nat inside source static 192.168.1.10 203.0.113.10']);
    const out = await r.executeCommand('show ip nat translations');
    expect(out).toContain('192.168.1.10');
    expect(out).toContain('203.0.113.10');
    expect(out).toContain('---');
  });

  it('4.3 show ip nat statistics shows interface designations', async () => {
    await cfg(r, ['enable', 'configure terminal',
      'interface GigabitEthernet0/0', 'ip nat inside',
      'interface GigabitEthernet0/1', 'ip nat outside']);
    const out = await r.executeCommand('show ip nat statistics');
    expect(out).toContain('GigabitEthernet0/0');
    expect(out).toContain('GigabitEthernet0/1');
  });

  it('4.4 show running-config includes ip nat inside/outside on interface', async () => {
    await cfg(r, ['enable', 'configure terminal',
      'interface GigabitEthernet0/0', 'ip nat inside',
      'interface GigabitEthernet0/1', 'ip nat outside']);
    const out = await r.executeCommand('show running-config');
    expect(out).toContain('ip nat inside');
    expect(out).toContain('ip nat outside');
  });

  it('4.5 show running-config includes static NAT commands', async () => {
    await cfg(r, ['enable', 'configure terminal',
      'ip nat inside source static 192.168.1.10 203.0.113.10',
      'ip nat inside source static tcp 192.168.1.20 80 203.0.113.20 8080']);
    const out = await r.executeCommand('show running-config');
    expect(out).toContain('ip nat inside source static 192.168.1.10 203.0.113.10');
    expect(out).toContain('ip nat inside source static tcp 192.168.1.20 80 203.0.113.20 8080');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Group 5: Huawei VRP — nat static / nat outbound CLI
// ═══════════════════════════════════════════════════════════════════════════

describe('Group 5: Huawei VRP — nat static / nat outbound CLI', () => {
  let r: HuaweiRouter;

  beforeEach(() => { r = makeHuaweiRouter(); });

  it('5.1 nat static global … inside … creates static entry', async () => {
    await cfg(r, ['system-view', 'interface GE0/0/1',
      'nat static global 203.0.113.10 inside 192.168.1.10']);
    const entries = r._getNATEngine().getStaticEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0].globalIP).toBe('203.0.113.10');
    expect(entries[0].localIP).toBe('192.168.1.10');
  });

  it('5.2 nat static marks interface as outside automatically', async () => {
    await cfg(r, ['system-view', 'interface GE0/0/1',
      'nat static global 203.0.113.10 inside 192.168.1.10']);
    expect(r._getNATEngine().isOutsideInterface('GE0/0/1')).toBe(true);
  });

  it('5.3 undo nat static removes entry', async () => {
    await cfg(r, ['system-view', 'interface GE0/0/1',
      'nat static global 203.0.113.10 inside 192.168.1.10',
      'undo nat static global 203.0.113.10 inside 192.168.1.10']);
    expect(r._getNATEngine().getStaticEntries()).toHaveLength(0);
  });

  it('5.4 nat outbound <acl> creates overload rule', async () => {
    await cfg(r, ['system-view', 'interface GE0/0/1',
      'nat outbound 2000']);
    const rules = r._getNATEngine().getDynamicRules();
    expect(rules).toHaveLength(1);
    expect(rules[0].type).toBe('overload');
    expect(String(rules[0].aclId)).toBe('2000');
  });

  it('5.5 nat outbound marks interface as outside automatically', async () => {
    await cfg(r, ['system-view', 'interface GE0/0/1',
      'nat outbound 2000']);
    expect(r._getNATEngine().isOutsideInterface('GE0/0/1')).toBe(true);
  });

  it('5.6 undo nat outbound removes rule', async () => {
    await cfg(r, ['system-view', 'interface GE0/0/1',
      'nat outbound 2000', 'undo nat outbound 2000']);
    expect(r._getNATEngine().getDynamicRules()).toHaveLength(0);
  });

  it('5.7 nat inside marks interface as inside', async () => {
    await cfg(r, ['system-view', 'interface GE0/0/0', 'nat inside']);
    expect(r._getNATEngine().isInsideInterface('GE0/0/0')).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Group 6: Huawei VRP — nat server (port forwarding)
// ═══════════════════════════════════════════════════════════════════════════

describe('Group 6: Huawei VRP — nat server CLI', () => {
  let r: HuaweiRouter;

  beforeEach(() => { r = makeHuaweiRouter(); });

  it('6.1 nat server protocol tcp creates port-forwarding entry', async () => {
    await cfg(r, ['system-view', 'interface GE0/0/1',
      'nat server protocol tcp global 203.0.113.1 8080 inside 192.168.1.10 80']);
    const entries = r._getNATEngine().getStaticEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0].protocol).toBe('tcp');
    expect(entries[0].globalPort).toBe(8080);
    expect(entries[0].localPort).toBe(80);
    expect(entries[0].globalIP).toBe('203.0.113.1');
    expect(entries[0].localIP).toBe('192.168.1.10');
  });

  it('6.2 nat server protocol udp creates UDP port-forwarding', async () => {
    await cfg(r, ['system-view', 'interface GE0/0/1',
      'nat server protocol udp global 203.0.113.1 53 inside 192.168.1.5 53']);
    const e = r._getNATEngine().getStaticEntries()[0];
    expect(e.protocol).toBe('udp');
    expect(e.globalPort).toBe(53);
  });

  it('6.3 nat server marks interface as outside', async () => {
    await cfg(r, ['system-view', 'interface GE0/0/1',
      'nat server protocol tcp global 203.0.113.1 443 inside 192.168.1.10 443']);
    expect(r._getNATEngine().isOutsideInterface('GE0/0/1')).toBe(true);
  });

  it('6.4 undo nat server removes entry', async () => {
    await cfg(r, ['system-view', 'interface GE0/0/1',
      'nat server protocol tcp global 203.0.113.1 8080 inside 192.168.1.10 80',
      'undo nat server protocol tcp global 203.0.113.1 8080']);
    expect(r._getNATEngine().getStaticEntries()).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Group 7: Huawei VRP — display commands
// ═══════════════════════════════════════════════════════════════════════════

describe('Group 7: Huawei VRP — display nat commands', () => {
  let r: HuaweiRouter;

  beforeEach(() => { r = makeHuaweiRouter(); });

  it('7.1 display nat static shows nothing when empty', async () => {
    await cfg(r, ['system-view']);
    const out = await r.executeCommand('display nat static');
    expect(out).toMatch(/No static NAT/i);
  });

  it('7.2 display nat static shows configured entries', async () => {
    await cfg(r, ['system-view', 'interface GE0/0/1',
      'nat static global 203.0.113.10 inside 192.168.1.10', 'quit']);
    const out = await r.executeCommand('display nat static');
    expect(out).toContain('203.0.113.10');
    expect(out).toContain('192.168.1.10');
  });

  it('7.3 display nat outbound shows nothing when empty', async () => {
    await cfg(r, ['system-view']);
    const out = await r.executeCommand('display nat outbound');
    expect(out).toMatch(/No NAT outbound/i);
  });

  it('7.4 display nat outbound shows configured rule', async () => {
    await cfg(r, ['system-view', 'interface GE0/0/1', 'nat outbound 2000', 'quit']);
    const out = await r.executeCommand('display nat outbound');
    expect(out).toContain('2000');
    expect(out).toContain('overload');
  });

  it('7.5 display nat session shows nothing when no sessions', async () => {
    await cfg(r, ['system-view']);
    const out = await r.executeCommand('display nat session');
    expect(out).toMatch(/No active NAT sessions/i);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Group 8: NATEngine — packet translation (SNAT / DNAT / PAT)
// ═══════════════════════════════════════════════════════════════════════════

describe('Group 8: NATEngine — SNAT (translateOutbound)', () => {
  let engine: NATEngine;

  beforeEach(() => {
    engine = new NATEngine();
    engine.setInsideInterface('inside');
    engine.setOutsideInterface('outside');
  });

  it('8.1 static NAT rewrites source IP on outbound packet', () => {
    engine.addStaticEntry({ localIP: '192.168.1.10', globalIP: '203.0.113.10' });
    const pkt = makeUDPPacket('192.168.1.10', '8.8.8.8', 5000, 53);
    const result = engine.translateOutbound(pkt, 'outside', 'inside');
    expect(result).not.toBeNull();
    expect(result!.sourceIP.toString()).toBe('203.0.113.10');
  });

  it('8.2 static NAT does not translate unmatched source', () => {
    engine.addStaticEntry({ localIP: '192.168.1.10', globalIP: '203.0.113.10' });
    const pkt = makeUDPPacket('192.168.1.99', '8.8.8.8', 5000, 53);
    const result = engine.translateOutbound(pkt, 'outside', 'inside');
    expect(result).toBeNull();
  });

  it('8.3 PAT allocates unique port for each session', () => {
    engine.setInterfaceIPFn(() => '203.0.113.1');
    engine.setACLMatchFn(() => true);
    engine.addDynamicRule({ aclId: '1', type: 'overload' });

    const p1 = makeUDPPacket('192.168.1.10', '8.8.8.8', 5000, 53);
    const p2 = makeUDPPacket('192.168.1.11', '8.8.8.8', 5001, 53);
    const r1 = engine.translateOutbound(p1, 'outside', 'inside');
    const r2 = engine.translateOutbound(p2, 'outside', 'inside');

    expect(r1).not.toBeNull();
    expect(r2).not.toBeNull();
    const udp1 = r1!.payload as UDPPacket;
    const udp2 = r2!.payload as UDPPacket;
    expect(udp1.sourcePort).not.toBe(udp2.sourcePort);
    expect(r1!.sourceIP.toString()).toBe('203.0.113.1');
  });

  it('8.3b PAT wraparound skips ports still held by live sessions (RFC 4787 REQ-1)', () => {
    engine.setInterfaceIPFn(() => '203.0.113.1');
    engine.setACLMatchFn(() => true);
    engine.addDynamicRule({ aclId: '1', type: 'overload' });

    // Session A takes the first ephemeral port.
    const rA = engine.translateOutbound(
      makeUDPPacket('192.168.1.10', '8.8.8.8', 5000, 53), 'outside', 'inside');
    const portA = (rA!.payload as UDPPacket).sourcePort;

    // Simulate the cursor wrapping back onto A's port while A is alive.
    (engine as unknown as { nextPort: number }).nextPort = portA;
    const rB = engine.translateOutbound(
      makeUDPPacket('192.168.1.11', '8.8.8.8', 5001, 53), 'outside', 'inside');
    const portB = (rB!.payload as UDPPacket).sourcePort;

    // The old allocator handed out portA again and silently overwrote
    // A's reverse mapping — inbound traffic for A reached host B.
    expect(portB).not.toBe(portA);

    // A's reverse mapping is intact: an inbound reply to portA still
    // translates back to host A.
    const replyA = makeUDPPacket('8.8.8.8', '203.0.113.1', 53, portA);
    const backA = engine.translateInbound(replyA, 'outside');
    expect(backA).not.toBeNull();
    expect(backA!.destinationIP.toString()).toBe('192.168.1.10');
  });

  it('8.4 PAT reuses existing session for same source', () => {
    engine.setInterfaceIPFn(() => '203.0.113.1');
    engine.setACLMatchFn(() => true);
    engine.addDynamicRule({ aclId: '1', type: 'overload' });

    const pkt = makeUDPPacket('192.168.1.10', '8.8.8.8', 5000, 53);
    const r1 = engine.translateOutbound(pkt, 'outside', 'inside');
    const r2 = engine.translateOutbound(pkt, 'outside', 'inside');

    const udp1 = r1!.payload as UDPPacket;
    const udp2 = r2!.payload as UDPPacket;
    expect(udp1.sourcePort).toBe(udp2.sourcePort);
  });

  it('8.5 no translation when inbound interface is not inside', () => {
    engine.setInterfaceIPFn(() => '203.0.113.1');
    engine.setACLMatchFn(() => true);
    engine.addDynamicRule({ aclId: '1', type: 'overload' });
    const pkt = makeUDPPacket('192.168.1.10', '8.8.8.8', 5000, 53);
    const result = engine.translateOutbound(pkt, 'outside', 'dmz'); // dmz is not inside
    expect(result).toBeNull();
  });

  it('8.6 ICMP PAT uses identifier field as port', () => {
    engine.setInterfaceIPFn(() => '203.0.113.1');
    engine.setACLMatchFn(() => true);
    engine.addDynamicRule({ aclId: '1', type: 'overload' });
    const pkt = makeICMPPacket('192.168.1.10', '8.8.8.8', 42);
    const result = engine.translateOutbound(pkt, 'outside', 'inside');
    expect(result).not.toBeNull();
    expect(result!.sourceIP.toString()).toBe('203.0.113.1');
  });
});

describe('Group 8b: NATEngine — DNAT (translateInbound)', () => {
  let engine: NATEngine;

  beforeEach(() => {
    engine = new NATEngine();
    engine.setInsideInterface('inside');
    engine.setOutsideInterface('outside');
  });

  it('8.7 static NAT rewrites destination IP on inbound packet', () => {
    engine.addStaticEntry({ localIP: '192.168.1.10', globalIP: '203.0.113.10' });
    const pkt = makeUDPPacket('8.8.8.8', '203.0.113.10', 1234, 53);
    const result = engine.translateInbound(pkt, 'outside');
    expect(result).not.toBeNull();
    expect(result!.destinationIP.toString()).toBe('192.168.1.10');
  });

  it('8.8 port-forwarding DNAT rewrites destination IP and port', () => {
    engine.addStaticEntry({ localIP: '192.168.1.20', globalIP: '203.0.113.10', protocol: 'udp', localPort: 53, globalPort: 5353 });
    const pkt = makeUDPPacket('8.8.8.8', '203.0.113.10', 1234, 5353);
    const result = engine.translateInbound(pkt, 'outside');
    expect(result).not.toBeNull();
    expect(result!.destinationIP.toString()).toBe('192.168.1.20');
    const udp = result!.payload as UDPPacket;
    expect(udp.destinationPort).toBe(53);
  });

  it('8.9 PAT reply packet uses reverse session for DNAT', () => {
    // Setup PAT session first (outbound)
    engine.setInterfaceIPFn(() => '203.0.113.1');
    engine.setACLMatchFn(() => true);
    engine.addDynamicRule({ aclId: '1', type: 'overload' });

    const outPkt = makeUDPPacket('192.168.1.10', '8.8.8.8', 5000, 53);
    const translated = engine.translateOutbound(outPkt, 'outside', 'inside')!;
    const allocatedPort = (translated.payload as UDPPacket).sourcePort;

    // Now simulate reply: dst = globalIP:allocatedPort → should DNAT to 192.168.1.10:5000
    const reply = makeUDPPacket('8.8.8.8', '203.0.113.1', 53, allocatedPort);
    const result = engine.translateInbound(reply, 'outside');
    expect(result).not.toBeNull();
    expect(result!.destinationIP.toString()).toBe('192.168.1.10');
  });

  it('8.10 hairpinning: inside → global IP is DNAT-ed (RFC 5382 §5)', () => {
    // Inside host targets public IP → should be redirected to inside server
    engine.addStaticEntry({ localIP: '192.168.1.10', globalIP: '203.0.113.10' });
    const pkt = makeUDPPacket('192.168.1.20', '203.0.113.10', 1234, 80);
    const result = engine.translateInbound(pkt, 'inside'); // inside → hairpin DNAT
    expect(result).not.toBeNull();
    expect(result!.destinationIP.toString()).toBe('192.168.1.10');
  });

  it('8.10b no DNAT on unknown (unregistered) interface', () => {
    engine.addStaticEntry({ localIP: '192.168.1.10', globalIP: '203.0.113.10' });
    const pkt = makeUDPPacket('10.0.0.1', '203.0.113.10', 1234, 80);
    const result = engine.translateInbound(pkt, 'dmz'); // unregistered → no DNAT
    expect(result).toBeNull();
  });
});

describe('Group 8c: NATEngine — getTranslations output', () => {
  let engine: NATEngine;

  beforeEach(() => {
    engine = new NATEngine();
    engine.setInsideInterface('inside');
    engine.setOutsideInterface('outside');
  });

  it('8.11 getTranslations includes static IP-only entry', () => {
    engine.addStaticEntry({ localIP: '192.168.1.10', globalIP: '203.0.113.10' });
    const entries = engine.getTranslations();
    expect(entries).toHaveLength(1);
    expect(entries[0].proto).toBe('---');
    expect(entries[0].insideLocal).toBe('192.168.1.10');
    expect(entries[0].insideGlobal).toBe('203.0.113.10');
  });

  it('8.12 getTranslations includes PAT session with ports', () => {
    engine.setInterfaceIPFn(() => '203.0.113.1');
    engine.setACLMatchFn(() => true);
    engine.addDynamicRule({ aclId: '1', type: 'overload' });

    const pkt = makeUDPPacket('192.168.1.10', '8.8.8.8', 5000, 53);
    engine.translateOutbound(pkt, 'outside', 'inside');

    const entries = engine.getTranslations();
    const session = entries.find(e => e.proto === 'udp');
    expect(session).toBeDefined();
    expect(session!.insideLocal).toContain('192.168.1.10');
    expect(session!.insideGlobal).toContain('203.0.113.1');
  });

  it('8.13 purgeStale removes expired sessions', () => {
    engine.setInterfaceIPFn(() => '203.0.113.1');
    engine.setACLMatchFn(() => true);
    engine.addDynamicRule({ aclId: '1', type: 'overload' });

    const pkt = makeUDPPacket('192.168.1.10', '8.8.8.8', 5000, 53);
    engine.translateOutbound(pkt, 'outside', 'inside');
    expect(engine.getTranslationCount()).toBeGreaterThan(0);

    engine.purgeStale(-1); // negative timeout → everything is considered stale
    expect(engine.getTranslationCount()).toBe(0);
  });
});

describe('Group 1c: NATEngine — dynamic rules and pools', () => {
  let engine: NATEngine;

  beforeEach(() => { engine = new NATEngine(); });

  it('1.8 addDynamicRule stores overload rule', () => {
    engine.addDynamicRule({ aclId: '1', type: 'overload' });
    const rules = engine.getDynamicRules();
    expect(rules).toHaveLength(1);
    expect(rules[0].type).toBe('overload');
  });

  it('1.9 removeDynamicRule removes by aclId', () => {
    engine.addDynamicRule({ aclId: '1', type: 'overload' });
    engine.removeDynamicRule('1');
    expect(engine.getDynamicRules()).toHaveLength(0);
  });

  it('1.10 addPool stores pool', () => {
    engine.addPool({ name: 'POOL1', startIP: '203.0.113.10', endIP: '203.0.113.20' });
    const pool = engine.getPool('POOL1');
    expect(pool).toBeDefined();
    expect(pool!.startIP).toBe('203.0.113.10');
  });

  it('1.11 clearTranslations removes sessions', () => {
    // Simulate a session by doing PAT
    engine.setInsideInterface('inside');
    engine.setOutsideInterface('outside');
    engine.setInterfaceIPFn(() => '203.0.113.1');
    engine.setACLMatchFn(() => true);
    engine.addDynamicRule({ aclId: '1', type: 'overload' });
    const pkt = makeUDPPacket('192.168.1.10', '8.8.8.8', 5000, 53);
    engine.translateOutbound(pkt, 'outside', 'inside');
    expect(engine.getTranslationCount()).toBeGreaterThan(0);
    engine.clearTranslations();
    expect(engine.getTranslationCount()).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Group 9: TCP NAT / PAT
// ═══════════════════════════════════════════════════════════════════════════

describe('Group 9: TCP NAT/PAT', () => {
  let engine: NATEngine;

  beforeEach(() => {
    engine = new NATEngine();
    engine.setInsideInterface('inside');
    engine.setOutsideInterface('outside');
    engine.setInterfaceIPFn(() => '203.0.113.1');
    engine.setACLMatchFn(() => true);
  });

  it('9.1 TCP PAT — sourceIP and sourcePort are rewritten', () => {
    engine.addDynamicRule({ aclId: '1', type: 'overload' });
    const pkt = makeTCPPacket('192.168.1.10', '8.8.8.8', 4321, 80, { syn: true });
    const out = engine.translateOutbound(pkt, 'outside', 'inside');
    expect(out).not.toBeNull();
    expect(out!.sourceIP.toString()).toBe('203.0.113.1');
    const tcp = out!.payload as TCPPacket;
    expect(tcp.sourcePort).not.toBe(4321);
  });

  it('9.2 TCP PAT — reply is reverse-translated (DNAT)', () => {
    engine.addDynamicRule({ aclId: '1', type: 'overload' });
    const syn = makeTCPPacket('192.168.1.10', '8.8.8.8', 4321, 80, { syn: true });
    const out = engine.translateOutbound(syn, 'outside', 'inside');
    const mappedPort = (out!.payload as TCPPacket).sourcePort;

    const reply = makeTCPPacket('8.8.8.8', '203.0.113.1', 80, mappedPort, { syn: true, ack: true });
    const inPkt = engine.translateInbound(reply, 'outside');
    expect(inPkt).not.toBeNull();
    expect(inPkt!.destinationIP.toString()).toBe('192.168.1.10');
    const replyTCP = inPkt!.payload as TCPPacket;
    expect(replyTCP.destinationPort).toBe(4321);
  });

  it('9.3 TCP static port-forwarding — inbound DNAT', () => {
    engine.addStaticEntry({ localIP: '192.168.1.20', globalIP: '203.0.113.1', protocol: 'tcp', localPort: 22, globalPort: 2222 });
    const pkt = makeTCPPacket('1.2.3.4', '203.0.113.1', 50000, 2222, { syn: true });
    const out = engine.translateInbound(pkt, 'outside');
    expect(out).not.toBeNull();
    expect(out!.destinationIP.toString()).toBe('192.168.1.20');
    expect((out!.payload as TCPPacket).destinationPort).toBe(22);
  });

  it('9.4 TCP static port-forwarding — does not match wrong port', () => {
    engine.addStaticEntry({ localIP: '192.168.1.20', globalIP: '203.0.113.1', protocol: 'tcp', localPort: 22, globalPort: 2222 });
    const pkt = makeTCPPacket('1.2.3.4', '203.0.113.1', 50000, 80, { syn: true });
    const out = engine.translateInbound(pkt, 'outside');
    expect(out).toBeNull();
  });

  it('9.5 TCP session gets tcpState = syn-seen on first SYN', () => {
    engine.addDynamicRule({ aclId: '1', type: 'overload' });
    const syn = makeTCPPacket('192.168.1.10', '8.8.8.8', 5000, 80, { syn: true });
    engine.translateOutbound(syn, 'outside', 'inside');
    // Translation count includes sessions
    expect(engine.getTranslationCount()).toBeGreaterThan(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Group 10: TCP state machine + per-protocol timeouts
// ═══════════════════════════════════════════════════════════════════════════

describe('Group 10: per-protocol timeouts', () => {
  let engine: NATEngine;

  beforeEach(() => {
    engine = new NATEngine();
    engine.setInsideInterface('inside');
    engine.setOutsideInterface('outside');
    engine.setInterfaceIPFn(() => '203.0.113.1');
    engine.setACLMatchFn(() => true);
    engine.addDynamicRule({ aclId: '1', type: 'overload' });
  });

  it('10.1 setTimeouts / getTimeouts round-trip', () => {
    engine.setTimeouts({ tcp: 3600_000, udp: 120_000 });
    const t = engine.getTimeouts();
    expect(t.tcp).toBe(3600_000);
    expect(t.udp).toBe(120_000);
    // others unchanged
    expect(t.icmp).toBe(60_000);
    expect(t.tcpHalfOpen).toBe(30_000);
  });

  it('10.2 TCP half-open session purged with tcpHalfOpen timeout', () => {
    // SYN-only (no ACK) → tcpState = syn-seen → uses tcpHalfOpen timeout
    const syn = makeTCPPacket('192.168.1.10', '8.8.8.8', 5000, 80, { syn: true });
    engine.translateOutbound(syn, 'outside', 'inside');
    expect(engine.getTranslationCount()).toBeGreaterThan(0);
    // purgeStale with -1 → all sessions expire
    engine.purgeStale(-1);
    expect(engine.getTranslationCount()).toBe(0);
  });

  it('10.3 UDP session purged after override timeout', () => {
    const pkt = makeUDPPacket('192.168.1.10', '8.8.8.8', 5000, 53);
    engine.translateOutbound(pkt, 'outside', 'inside');
    expect(engine.getTranslationCount()).toBeGreaterThan(0);
    engine.purgeStale(-1);
    expect(engine.getTranslationCount()).toBe(0);
  });

  it('10.4 ICMP session purged after override timeout', () => {
    const pkt = makeICMPPacket('192.168.1.10', '8.8.8.8');
    engine.translateOutbound(pkt, 'outside', 'inside');
    expect(engine.getTranslationCount()).toBeGreaterThan(0);
    engine.purgeStale(-1);
    expect(engine.getTranslationCount()).toBe(0);
  });

  it('10.5 expiredCount increments on purge', () => {
    engine.resetCounters();
    const pkt = makeUDPPacket('192.168.1.10', '8.8.8.8', 5000, 53);
    engine.translateOutbound(pkt, 'outside', 'inside');
    engine.purgeStale(-1);
    expect(engine.getCounters().expired).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Group 11: ICMP embedded-packet re-translation (RFC 5508 §3)
// ═══════════════════════════════════════════════════════════════════════════

describe('Group 11: ICMP embedded-packet re-translation (RFC 5508)', () => {
  let engine: NATEngine;

  beforeEach(() => {
    engine = new NATEngine();
    engine.setInsideInterface('inside');
    engine.setOutsideInterface('outside');
    engine.setInterfaceIPFn(() => '203.0.113.1');
    engine.setACLMatchFn(() => true);
    engine.addDynamicRule({ aclId: '1', type: 'overload' });
  });

  it('11.1 inbound ICMP error re-translates embedded packet src (PAT)', () => {
    // Step 1: inside host sends UDP to outside → gets a PAT mapping
    const udpOut = makeUDPPacket('192.168.1.10', '8.8.8.8', 5000, 53);
    const translated = engine.translateOutbound(udpOut, 'outside', 'inside');
    expect(translated).not.toBeNull();
    const mappedPort = (translated!.payload as import('@/network/core/types').UDPPacket).sourcePort;

    // Step 2: outside sends ICMP unreachable with the translated (global) packet embedded
    const embeddedPkt: IPv4Packet = makeUDPPacket('203.0.113.1', '8.8.8.8', mappedPort, 53);
    const icmpError: ICMPPacket = {
      type: 'icmp', icmpType: 'destination-unreachable', code: 1,
      id: 0, sequence: 0, dataSize: 8,
      originalPacket: embeddedPkt,
    };
    const icmpPkt = createIPv4Packet(new IPAddress('8.8.8.8'), new IPAddress('203.0.113.1'), IP_PROTO_ICMP, 64, icmpError, 32);

    const result = engine.translateInbound(icmpPkt, 'outside');
    expect(result).not.toBeNull();
    // The embedded packet's source should now be the local IP
    const innerResult = (result!.payload as ICMPPacket).originalPacket;
    expect(innerResult).toBeDefined();
    expect(innerResult!.sourceIP.toString()).toBe('192.168.1.10');
  });

  it('11.2 outbound ICMP error re-translates embedded static-mapped dst', () => {
    // Static NAT: inside server 192.168.1.20 → global 203.0.113.10
    engine.addStaticEntry({ localIP: '192.168.1.20', globalIP: '203.0.113.10' });

    // An ICMP error generated by the router for an inbound packet to 203.0.113.10
    const embeddedPkt: IPv4Packet = makeUDPPacket('1.2.3.4', '203.0.113.10', 9999, 80);
    const icmpError: ICMPPacket = {
      type: 'icmp', icmpType: 'destination-unreachable', code: 1,
      id: 0, sequence: 0, dataSize: 8,
      originalPacket: embeddedPkt,
    };
    const icmpPkt = createIPv4Packet(new IPAddress('203.0.113.1'), new IPAddress('1.2.3.4'), IP_PROTO_ICMP, 64, icmpError, 32);

    const result = engine.translateOutbound(icmpPkt, 'outside', 'inside');
    expect(result).not.toBeNull();
    const innerResult = (result!.payload as ICMPPacket).originalPacket;
    expect(innerResult).toBeDefined();
    expect(innerResult!.destinationIP.toString()).toBe('192.168.1.20');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Group 12: Hit / miss counters
// ═══════════════════════════════════════════════════════════════════════════

describe('Group 12: hit/miss counters', () => {
  let engine: NATEngine;

  beforeEach(() => {
    engine = new NATEngine();
    engine.setInsideInterface('inside');
    engine.setOutsideInterface('outside');
    engine.setInterfaceIPFn(() => '203.0.113.1');
    engine.setACLMatchFn(() => true);
    engine.addDynamicRule({ aclId: '1', type: 'overload' });
    engine.resetCounters();
  });

  it('12.1 first outbound packet → missCount += 1', () => {
    const pkt = makeUDPPacket('192.168.1.10', '8.8.8.8', 5000, 53);
    engine.translateOutbound(pkt, 'outside', 'inside');
    expect(engine.getCounters().misses).toBe(1);
    expect(engine.getCounters().hits).toBe(0);
  });

  it('12.2 second outbound same 5-tuple → hitCount += 1', () => {
    const pkt = makeUDPPacket('192.168.1.10', '8.8.8.8', 5000, 53);
    engine.translateOutbound(pkt, 'outside', 'inside');
    engine.translateOutbound(pkt, 'outside', 'inside');
    expect(engine.getCounters().misses).toBe(1);
    expect(engine.getCounters().hits).toBe(1);
  });

  it('12.3 inbound reply to existing session → hitCount += 1', () => {
    const out = makeUDPPacket('192.168.1.10', '8.8.8.8', 5000, 53);
    const translated = engine.translateOutbound(out, 'outside', 'inside');
    engine.resetCounters();
    const udp = translated!.payload as import('@/network/core/types').UDPPacket;
    const reply = makeUDPPacket('8.8.8.8', '203.0.113.1', 53, udp.sourcePort);
    engine.translateInbound(reply, 'outside');
    expect(engine.getCounters().hits).toBe(1);
    expect(engine.getCounters().misses).toBe(0);
  });

  it('12.4 inbound with no matching session → missCount += 1', () => {
    const pkt = makeUDPPacket('8.8.8.8', '203.0.113.1', 53, 9999);
    engine.translateInbound(pkt, 'outside');
    expect(engine.getCounters().misses).toBe(1);
    expect(engine.getCounters().hits).toBe(0);
  });

  it('12.5 static NAT hit → hitCount increments on inbound', () => {
    engine.addStaticEntry({ localIP: '192.168.1.20', globalIP: '203.0.113.10' });
    engine.resetCounters();
    const pkt = makeUDPPacket('1.2.3.4', '203.0.113.10', 9999, 80);
    engine.translateInbound(pkt, 'outside');
    expect(engine.getCounters().hits).toBe(1);
  });

  it('12.6 resetCounters zeroes all counters', () => {
    const pkt = makeUDPPacket('192.168.1.10', '8.8.8.8', 5000, 53);
    engine.translateOutbound(pkt, 'outside', 'inside');
    engine.resetCounters();
    const c = engine.getCounters();
    expect(c.hits).toBe(0);
    expect(c.misses).toBe(0);
    expect(c.expired).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Group 13: Cisco CLI — timeout commands + show ip nat statistics
// ═══════════════════════════════════════════════════════════════════════════

describe('Group 13: Cisco CLI — timeout commands', () => {
  it('13.1 ip nat translation tcp-timeout sets TCP timeout', async () => {
    const r = makeCiscoRouter();
    await cfg(r, [
      'enable',
      'configure terminal',
      'ip nat translation tcp-timeout 7200',
      'end',
    ]);
    const t = r._getNATEngine().getTimeouts();
    expect(t.tcp).toBe(7200 * 1000);
  });

  it('13.2 ip nat translation udp-timeout sets UDP timeout', async () => {
    const r = makeCiscoRouter();
    await cfg(r, [
      'enable',
      'configure terminal',
      'ip nat translation udp-timeout 60',
      'end',
    ]);
    expect(r._getNATEngine().getTimeouts().udp).toBe(60_000);
  });

  it('13.3 ip nat translation icmp-timeout sets ICMP timeout', async () => {
    const r = makeCiscoRouter();
    await cfg(r, [
      'enable',
      'configure terminal',
      'ip nat translation icmp-timeout 30',
      'end',
    ]);
    expect(r._getNATEngine().getTimeouts().icmp).toBe(30_000);
  });

  it('13.4 ip nat translation syn-timeout sets TCP half-open timeout', async () => {
    const r = makeCiscoRouter();
    await cfg(r, [
      'enable',
      'configure terminal',
      'ip nat translation syn-timeout 10',
      'end',
    ]);
    expect(r._getNATEngine().getTimeouts().tcpHalfOpen).toBe(10_000);
  });

  it('13.5 show ip nat statistics includes hits/misses/timeouts', async () => {
    const r = makeCiscoRouter();
    await cfg(r, [
      'enable',
      'configure terminal',
      'ip nat translation udp-timeout 120',
      'end',
    ]);
    const out = await r.executeCommand('show ip nat statistics');
    expect(out).toContain('Hits:');
    expect(out).toContain('Misses:');
    expect(out).toContain('udp 120');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Group 14: Huawei CLI — nat aging-time + display nat statistics
// ═══════════════════════════════════════════════════════════════════════════

describe('Group 14: Huawei CLI — aging-time + display nat statistics', () => {
  it('14.1 nat aging-time tcp sets TCP timeout', async () => {
    const r = makeHuaweiRouter();
    await cfg(r, [
      'system-view',
      'interface GE0/0/1',
      'nat aging-time tcp 7200',
      'quit',
    ]);
    expect(r._getNATEngine().getTimeouts().tcp).toBe(7200_000);
  });

  it('14.2 nat aging-time udp sets UDP timeout', async () => {
    const r = makeHuaweiRouter();
    await cfg(r, [
      'system-view',
      'interface GE0/0/1',
      'nat aging-time udp 60',
      'quit',
    ]);
    expect(r._getNATEngine().getTimeouts().udp).toBe(60_000);
  });

  it('14.3 nat aging-time icmp sets ICMP timeout', async () => {
    const r = makeHuaweiRouter();
    await cfg(r, [
      'system-view',
      'interface GE0/0/1',
      'nat aging-time icmp 30',
      'quit',
    ]);
    expect(r._getNATEngine().getTimeouts().icmp).toBe(30_000);
  });

  it('14.4 nat aging-time syn sets TCP half-open timeout', async () => {
    const r = makeHuaweiRouter();
    await cfg(r, [
      'system-view',
      'interface GE0/0/1',
      'nat aging-time syn 10',
      'quit',
    ]);
    expect(r._getNATEngine().getTimeouts().tcpHalfOpen).toBe(10_000);
  });

  it('14.5 display nat statistics shows counters and timeouts', async () => {
    const r = makeHuaweiRouter();
    await cfg(r, [
      'system-view',
      'interface GE0/0/1',
      'nat aging-time udp 120',
      'quit',
    ]);
    const out = await r.executeCommand('display nat statistics');
    expect(out).toContain('hits');
    expect(out).toContain('misses');
    expect(out).toContain('120');
  });

  it('14.6 reset nat session clears sessions', async () => {
    const r = makeHuaweiRouter();
    // Create a session via direct engine call
    const engine = r._getNATEngine();
    engine.setInsideInterface('GE0/0/0');
    engine.setOutsideInterface('GE0/0/1');
    engine.setInterfaceIPFn(() => '203.0.113.1');
    engine.setACLMatchFn(() => true);
    engine.addDynamicRule({ aclId: '3000', type: 'overload' });
    engine.translateOutbound(makeUDPPacket('192.168.1.10', '8.8.8.8', 5000, 53), 'GE0/0/1', 'GE0/0/0');
    expect(engine.getTranslationCount()).toBeGreaterThan(0);

    await r.executeCommand('reset nat session');
    expect(engine.getTranslationCount()).toBe(engine.getStaticEntries().length);
  });
});
