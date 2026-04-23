/**
 * Traceroute P1 conformance tests.
 *
 * P1.5 — ICMP error correlated via originalPacket (no more reject-all)
 * P1.4 — Multi-probe: EndHost sends probesPerHop probes per TTL
 *          Linux shows 3 RTTs per hop; -q controls count
 * P1.6 — icmpCode propagated into TracerouteHop and mapped to !H/!N/!P/!A
 * P1.7 — UDP mode: Linux traceroute default uses UDP probes;
 *          destination responds with ICMP Port Unreachable (code 3);
 *          source detects arrival via code 3, not echo-reply;
 *          `-I` flag switches back to ICMP
 *
 * Topology (two-hop chain, same as conformance tests):
 *   Source (10.0.1.2) ─── R1 (10.0.1.1 / 10.0.2.1) ─── R2 (10.0.2.2 / 10.0.3.1) ─── PC2 (10.0.3.2)
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { IPAddress, SubnetMask, resetCounters } from '@/network/core/types';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { Cable } from '@/network/hardware/Cable';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

function buildTwoHopLinux() {
  const r1 = new CiscoRouter('R1');
  const r2 = new CiscoRouter('R2');
  const src = new LinuxPC('linux-pc', 'SRC');
  const dst = new LinuxPC('linux-pc', 'DST');

  src.configureInterface('eth0', new IPAddress('10.0.1.2'), new SubnetMask('255.255.255.0'));
  r1.configureInterface('GigabitEthernet0/0', new IPAddress('10.0.1.1'), new SubnetMask('255.255.255.0'));
  r1.configureInterface('GigabitEthernet0/1', new IPAddress('10.0.2.1'), new SubnetMask('255.255.255.252'));
  r2.configureInterface('GigabitEthernet0/0', new IPAddress('10.0.2.2'), new SubnetMask('255.255.255.252'));
  r2.configureInterface('GigabitEthernet0/1', new IPAddress('10.0.3.1'), new SubnetMask('255.255.255.0'));
  dst.configureInterface('eth0', new IPAddress('10.0.3.2'), new SubnetMask('255.255.255.0'));

  src.setDefaultGateway(new IPAddress('10.0.1.1'));
  dst.setDefaultGateway(new IPAddress('10.0.3.1'));
  r1.addStaticRoute(new IPAddress('10.0.3.0'), new SubnetMask('255.255.255.0'), new IPAddress('10.0.2.2'));
  r2.addStaticRoute(new IPAddress('10.0.1.0'), new SubnetMask('255.255.255.0'), new IPAddress('10.0.2.1'));

  const c1 = new Cable('c1'); c1.connect(src.getPort('eth0')!, r1.getPort('GigabitEthernet0/0')!);
  const c2 = new Cable('c2'); c2.connect(r1.getPort('GigabitEthernet0/1')!, r2.getPort('GigabitEthernet0/0')!);
  const c3 = new Cable('c3'); c3.connect(r2.getPort('GigabitEthernet0/1')!, dst.getPort('eth0')!);

  return { src, dst, r1, r2 };
}

function buildTwoHopWindows() {
  const { r1, r2, dst } = buildTwoHopLinux();
  // Add a Windows PC on the source side
  const win = new WindowsPC('windows-pc', 'WIN');
  win.configureInterface('eth0', new IPAddress('10.0.1.3'), new SubnetMask('255.255.255.0'));
  win.setDefaultGateway(new IPAddress('10.0.1.1'));
  const c = new Cable('cWin'); c.connect(win.getPort('eth0')!, r1.getPort('GigabitEthernet0/0')!);
  return { win, r1, r2, dst };
}

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.reset();
});

// ═══════════════════════════════════════════════════════════════════════
// P1.7 — UDP mode: destination replies with ICMP Port Unreachable
// ═══════════════════════════════════════════════════════════════════════

describe('P1.7 — Linux traceroute UDP mode', () => {

  it('default Linux traceroute (UDP) reaches final destination', async () => {
    const { src } = buildTwoHopLinux();
    const out = await src.executeCommand('traceroute 10.0.3.2');
    // Final destination must appear as a hop line
    expect(out).toContain('10.0.3.2');
    // And not be empty
    expect(out).not.toContain('Network is unreachable');
  });

  it('traceroute -I (ICMP mode) also reaches final destination', async () => {
    const { src } = buildTwoHopLinux();
    const out = await src.executeCommand('traceroute -I 10.0.3.2');
    expect(out).toContain('10.0.3.2');
  });

  it('traceroute -U (UDP mode explicit) reaches final destination', async () => {
    const { src } = buildTwoHopLinux();
    const out = await src.executeCommand('traceroute -U 10.0.3.2');
    expect(out).toContain('10.0.3.2');
  });

  it('UDP mode: hop 1 is R1 (ICMP Time Exceeded from router)', async () => {
    const { src } = buildTwoHopLinux();
    const out = await src.executeCommand('traceroute 10.0.3.2');
    // R1's ingress IP from src subnet
    expect(out).toContain('10.0.1.1');
  });

  it('UDP mode: -f sets first TTL (skips first N hops)', async () => {
    const { src } = buildTwoHopLinux();
    // -f 2 skips hop 1 → should NOT show 10.0.1.1 as a hop
    const out = await src.executeCommand('traceroute -f 2 10.0.3.2');
    const hopLines = out.split('\n').filter(l => /^\s+\d+\s+/.test(l));
    // With -f 2 the first hop shown is hop 2, so 10.0.1.1 (hop 1) should be absent from hop lines
    const hasHop1IP = hopLines.some(l => l.includes('10.0.1.1'));
    expect(hasHop1IP).toBe(false);
  });

});

// ═══════════════════════════════════════════════════════════════════════
// P1.4 — Multi-probe: 3 RTTs per hop line
// ═══════════════════════════════════════════════════════════════════════

describe('P1.4 — Multi-probe (3 RTTs per hop line)', () => {

  it('Linux: each hop shows 3 RTT values by default', async () => {
    const { src } = buildTwoHopLinux();
    const out = await src.executeCommand('traceroute 10.0.3.2');
    const hopLines = out.split('\n').filter(l => /^\s+\d+\s+/.test(l));
    expect(hopLines.length).toBeGreaterThan(0);
    for (const line of hopLines) {
      const msCount = (line.match(/\bms\b/g) || []).length;
      expect(msCount).toBeGreaterThanOrEqual(3);
    }
  });

  it('Linux: -q 1 shows exactly 1 RTT per hop', async () => {
    const { src } = buildTwoHopLinux();
    const out = await src.executeCommand('traceroute -q 1 10.0.3.2');
    const hopLines = out.split('\n').filter(l => /^\s+\d+\s+/.test(l));
    expect(hopLines.length).toBeGreaterThan(0);
    for (const line of hopLines) {
      const msCount = (line.match(/\bms\b/g) || []).length;
      expect(msCount).toBe(1);
    }
  });

  it('Linux: -q 2 shows exactly 2 RTTs per hop', async () => {
    const { src } = buildTwoHopLinux();
    const out = await src.executeCommand('traceroute -q 2 10.0.3.2');
    const hopLines = out.split('\n').filter(l => /^\s+\d+\s+/.test(l));
    expect(hopLines.length).toBeGreaterThan(0);
    for (const line of hopLines) {
      const msCount = (line.match(/\bms\b/g) || []).length;
      expect(msCount).toBe(2);
    }
  });

  it('Linux: hop format includes IP in (IP) notation', async () => {
    const { src } = buildTwoHopLinux();
    const out = await src.executeCommand('traceroute 10.0.3.2');
    // Real format: " 1  10.0.1.1 (10.0.1.1)  X ms  Y ms  Z ms"
    expect(out).toMatch(/\d+\.\d+\.\d+\.\d+\s+\(\d+\.\d+\.\d+\.\d+\)/);
  });

  it('Linux header includes (IP) notation for destination', async () => {
    const { src } = buildTwoHopLinux();
    const out = await src.executeCommand('traceroute 10.0.3.2');
    // Real format: "traceroute to 10.0.3.2 (10.0.3.2), 30 hops max, 60 byte packets"
    expect(out).toMatch(/traceroute to 10\.0\.3\.2 \(10\.0\.3\.2\)/);
  });

  it('Windows tracert: shows 3 RTT columns', async () => {
    const { win } = buildTwoHopWindows();
    const out = await win.executeCommand('tracert 10.0.3.2');
    const hopLines = out.split('\n').filter(l => /^\s+\d+\s+/.test(l) && !l.includes('*'));
    expect(hopLines.length).toBeGreaterThan(0);
    for (const line of hopLines) {
      const msCount = (line.match(/\bms\b/g) || []).length;
      expect(msCount).toBeGreaterThanOrEqual(3);
    }
  });

  it('Cisco traceroute: shows 3 RTT values per hop', async () => {
    const { r1 } = buildTwoHopLinux();
    await r1.executeCommand('enable');
    const out = await r1.executeCommand('traceroute 10.0.3.2');
    const hopLines = out.split('\n').filter(l => /^\s+\d+\s+\d+/.test(l));
    expect(hopLines.length).toBeGreaterThan(0);
    for (const line of hopLines) {
      const msecCount = (line.match(/msec/g) || []).length;
      expect(msecCount).toBeGreaterThanOrEqual(3);
    }
  });

});

// ═══════════════════════════════════════════════════════════════════════
// P1.5 — ICMP correlation via originalPacket
// ═══════════════════════════════════════════════════════════════════════

describe('P1.5 — ICMP correlation via originalPacket', () => {

  it('multi-probe traceroute completes without dropping valid probes', async () => {
    const { src } = buildTwoHopLinux();
    // With 3 probes per hop, each probe must independently resolve
    // If correlation is broken, subsequent probes after first Time Exceeded get killed
    const out = await src.executeCommand('traceroute -q 3 10.0.3.2');
    // Both hops must be visible
    expect(out).toContain('10.0.1.1');  // hop 1 = R1
    expect(out).toContain('10.0.3.2');  // hop 2 = destination
    // Hop 1 must show 3 RTTs (not 1 RTT + 2 missing due to reject-all)
    const hop1Line = out.split('\n').find(l => l.includes('10.0.1.1'));
    expect(hop1Line).toBeDefined();
    const msCount = (hop1Line!.match(/\bms\b/g) || []).length;
    expect(msCount).toBe(3);
  });

});

// ═══════════════════════════════════════════════════════════════════════
// P1.6 — icmpCode propagation: !N / !H annotations
// ═══════════════════════════════════════════════════════════════════════

describe('P1.6 — ICMP code annotations in traceroute output', () => {

  it('!N annotation when network unreachable (ICMP code 0)', async () => {
    const { src } = buildTwoHopLinux();
    // 10.0.99.1 has no route on R1 → R1 sends Destination Unreachable code 0
    const out = await src.executeCommand('traceroute 10.0.99.1');
    expect(out).toMatch(/!N/);
  });

  it('Linux -n flag suppresses DNS and still shows !N', async () => {
    const { src } = buildTwoHopLinux();
    const out = await src.executeCommand('traceroute -n 10.0.99.1');
    expect(out).toMatch(/!N/);
  });

});
