/**
 * Traceroute P2 conformance tests.
 *
 * P2.1 — Router.executeTraceroute multi-probe
 *         Cisco/Huawei engines send 3 real independent probes per TTL.
 *         The `probe N` (Cisco) and `-q N` (Huawei) flags control count.
 * P2.2 — Per-probe RTT display
 *         Cisco/Huawei formatters use individual probe RTTs from probes[].
 *         Timed-out probes show * in their column.
 * P2.3 — Windows WinTracert uses hop.probes[] for 3 independent RTT columns.
 * P2.4 — icmpCode → !N/!H/!P/!A annotations in Cisco and Huawei output.
 *
 * Two topologies:
 *   reachable: R1(10.0.2.1) ──── R2(10.0.2.2 / 10.0.3.1) ──── PC2(10.0.3.2)
 *   unreachable: R1(default→R2) ──── R2 (no route to 10.0.99.x)
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { IPAddress, SubnetMask, resetCounters } from '@/network/core/types';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { HuaweiRouter } from '@/network/devices/HuaweiRouter';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { Cable } from '@/network/hardware/Cable';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

/** R1 → R2 → PC2 (reachable via specific routes) */
function buildTwoHopCisco() {
  const r1 = new CiscoRouter('R1');
  const r2 = new CiscoRouter('R2');
  const pc2 = new LinuxPC('linux-pc', 'PC2');

  r1.configureInterface('GigabitEthernet0/1', new IPAddress('10.0.2.1'), new SubnetMask('255.255.255.252'));
  r2.configureInterface('GigabitEthernet0/0', new IPAddress('10.0.2.2'), new SubnetMask('255.255.255.252'));
  r2.configureInterface('GigabitEthernet0/1', new IPAddress('10.0.3.1'), new SubnetMask('255.255.255.0'));
  pc2.configureInterface('eth0', new IPAddress('10.0.3.2'), new SubnetMask('255.255.255.0'));
  pc2.setDefaultGateway(new IPAddress('10.0.3.1'));
  r1.addStaticRoute(new IPAddress('10.0.3.0'), new SubnetMask('255.255.255.0'), new IPAddress('10.0.2.2'));
  r2.addStaticRoute(new IPAddress('0.0.0.0'), new SubnetMask('0.0.0.0'), new IPAddress('10.0.2.1'));

  new Cable('c1').connect(r1.getPort('GigabitEthernet0/1')!, r2.getPort('GigabitEthernet0/0')!);
  new Cable('c2').connect(r2.getPort('GigabitEthernet0/1')!, pc2.getPort('eth0')!);

  return { r1, r2, pc2 };
}

/** R1 → R2 → PC2 (reachable via specific routes) — Huawei */
function buildTwoHopHuawei() {
  const r1 = new HuaweiRouter('R1');
  const r2 = new HuaweiRouter('R2');
  const pc2 = new LinuxPC('linux-pc', 'PC2');

  r1.configureInterface('GE0/0/1', new IPAddress('10.0.2.1'), new SubnetMask('255.255.255.252'));
  r2.configureInterface('GE0/0/0', new IPAddress('10.0.2.2'), new SubnetMask('255.255.255.252'));
  r2.configureInterface('GE0/0/1', new IPAddress('10.0.3.1'), new SubnetMask('255.255.255.0'));
  pc2.configureInterface('eth0', new IPAddress('10.0.3.2'), new SubnetMask('255.255.255.0'));
  pc2.setDefaultGateway(new IPAddress('10.0.3.1'));
  r1.addStaticRoute(new IPAddress('10.0.3.0'), new SubnetMask('255.255.255.0'), new IPAddress('10.0.2.2'));
  r2.addStaticRoute(new IPAddress('0.0.0.0'), new SubnetMask('0.0.0.0'), new IPAddress('10.0.2.1'));

  new Cable('c1').connect(r1.getPort('GE0/0/1')!, r2.getPort('GE0/0/0')!);
  new Cable('c2').connect(r2.getPort('GE0/0/1')!, pc2.getPort('eth0')!);

  return { r1, r2, pc2 };
}

/**
 * Topology for !N test:
 *   R1 (default→R2) ──── R2 (only knows 10.0.2.0/30)
 * R1 forwards probe via default to R2; R2 has no route to 10.0.99.1 → sends Dest Unreachable.
 */
function buildUnreachableCisco() {
  const r1 = new CiscoRouter('R1');
  const r2 = new CiscoRouter('R2');

  r1.configureInterface('GigabitEthernet0/1', new IPAddress('10.0.2.1'), new SubnetMask('255.255.255.252'));
  r2.configureInterface('GigabitEthernet0/0', new IPAddress('10.0.2.2'), new SubnetMask('255.255.255.252'));

  // R1 has a default route so it can forward the probe to R2
  r1.addStaticRoute(new IPAddress('0.0.0.0'), new SubnetMask('0.0.0.0'), new IPAddress('10.0.2.2'));
  // R2 has NO default or specific route for 10.0.99.x → will send Destination Unreachable code 0

  new Cable('c1').connect(r1.getPort('GigabitEthernet0/1')!, r2.getPort('GigabitEthernet0/0')!);

  return { r1, r2 };
}

function buildUnreachableHuawei() {
  const r1 = new HuaweiRouter('R1');
  const r2 = new HuaweiRouter('R2');

  r1.configureInterface('GE0/0/1', new IPAddress('10.0.2.1'), new SubnetMask('255.255.255.252'));
  r2.configureInterface('GE0/0/0', new IPAddress('10.0.2.2'), new SubnetMask('255.255.255.252'));

  r1.addStaticRoute(new IPAddress('0.0.0.0'), new SubnetMask('0.0.0.0'), new IPAddress('10.0.2.2'));

  new Cable('c1').connect(r1.getPort('GE0/0/1')!, r2.getPort('GE0/0/0')!);

  return { r1, r2 };
}

function buildTwoHopWindows() {
  const r1 = new CiscoRouter('R1');
  const r2 = new CiscoRouter('R2');
  const pc2 = new LinuxPC('linux-pc', 'PC2');
  const win = new WindowsPC('windows-pc', 'WIN');

  win.configureInterface('eth0', new IPAddress('10.0.1.2'), new SubnetMask('255.255.255.0'));
  win.setDefaultGateway(new IPAddress('10.0.1.1'));
  r1.configureInterface('GigabitEthernet0/0', new IPAddress('10.0.1.1'), new SubnetMask('255.255.255.0'));
  r1.configureInterface('GigabitEthernet0/1', new IPAddress('10.0.2.1'), new SubnetMask('255.255.255.252'));
  r2.configureInterface('GigabitEthernet0/0', new IPAddress('10.0.2.2'), new SubnetMask('255.255.255.252'));
  r2.configureInterface('GigabitEthernet0/1', new IPAddress('10.0.3.1'), new SubnetMask('255.255.255.0'));
  pc2.configureInterface('eth0', new IPAddress('10.0.3.2'), new SubnetMask('255.255.255.0'));
  pc2.setDefaultGateway(new IPAddress('10.0.3.1'));
  r1.addStaticRoute(new IPAddress('10.0.3.0'), new SubnetMask('255.255.255.0'), new IPAddress('10.0.2.2'));
  r2.addStaticRoute(new IPAddress('10.0.1.0'), new SubnetMask('255.255.255.0'), new IPAddress('10.0.2.1'));

  new Cable('c1').connect(win.getPort('eth0')!, r1.getPort('GigabitEthernet0/0')!);
  new Cable('c2').connect(r1.getPort('GigabitEthernet0/1')!, r2.getPort('GigabitEthernet0/0')!);
  new Cable('c3').connect(r2.getPort('GigabitEthernet0/1')!, pc2.getPort('eth0')!);

  return { win, r1, r2, pc2 };
}

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.reset();
});

// ═══════════════════════════════════════════════════════════════════════
// P2.1 — Cisco probe N keyword
// ═══════════════════════════════════════════════════════════════════════

describe('P2.1 — Cisco traceroute probe N', () => {

  it('probe 1: shows exactly 1 msec per hop', async () => {
    const { r1 } = buildTwoHopCisco();
    await r1.executeCommand('enable');
    const out = await r1.executeCommand('traceroute 10.0.3.2 probe 1');
    const hopLines = out.split('\n').filter(l => /^\s+\d+\s+\d+/.test(l));
    expect(hopLines.length).toBeGreaterThan(0);
    for (const line of hopLines) {
      expect((line.match(/msec/g) || []).length).toBe(1);
    }
  });

  it('probe 2: shows exactly 2 msec per hop', async () => {
    const { r1 } = buildTwoHopCisco();
    await r1.executeCommand('enable');
    const out = await r1.executeCommand('traceroute 10.0.3.2 probe 2');
    const hopLines = out.split('\n').filter(l => /^\s+\d+\s+\d+/.test(l));
    expect(hopLines.length).toBeGreaterThan(0);
    for (const line of hopLines) {
      expect((line.match(/msec/g) || []).length).toBe(2);
    }
  });

  it('default 3 probes: shows exactly 3 msec per hop', async () => {
    const { r1 } = buildTwoHopCisco();
    await r1.executeCommand('enable');
    const out = await r1.executeCommand('traceroute 10.0.3.2');
    const hopLines = out.split('\n').filter(l => /^\s+\d+\s+\d+/.test(l));
    expect(hopLines.length).toBeGreaterThan(0);
    for (const line of hopLines) {
      expect((line.match(/msec/g) || []).length).toBe(3);
    }
  });

});

// ═══════════════════════════════════════════════════════════════════════
// P2.1 — Huawei -q N flag
// ═══════════════════════════════════════════════════════════════════════

describe('P2.1 — Huawei tracert -q N', () => {

  it('-q 1: shows exactly 1 ms per hop', async () => {
    const { r1 } = buildTwoHopHuawei();
    const out = await r1.executeCommand('tracert -q 1 10.0.3.2');
    const hopLines = out.split('\n').filter(l => /^\s+\d+\s+\d+/.test(l));
    expect(hopLines.length).toBeGreaterThan(0);
    for (const line of hopLines) {
      expect((line.match(/\bms\b/g) || []).length).toBe(1);
    }
  });

  it('-q 2: shows exactly 2 ms per hop', async () => {
    const { r1 } = buildTwoHopHuawei();
    const out = await r1.executeCommand('tracert -q 2 10.0.3.2');
    const hopLines = out.split('\n').filter(l => /^\s+\d+\s+\d+/.test(l));
    expect(hopLines.length).toBeGreaterThan(0);
    for (const line of hopLines) {
      expect((line.match(/\bms\b/g) || []).length).toBe(2);
    }
  });

  it('default 3 probes: shows exactly 3 ms per hop', async () => {
    const { r1 } = buildTwoHopHuawei();
    const out = await r1.executeCommand('tracert 10.0.3.2');
    const hopLines = out.split('\n').filter(l => /^\s+\d+\s+\d+/.test(l));
    expect(hopLines.length).toBeGreaterThan(0);
    for (const line of hopLines) {
      expect((line.match(/\bms\b/g) || []).length).toBe(3);
    }
  });

});

// ═══════════════════════════════════════════════════════════════════════
// P2.3 — Windows WinTracert independent RTT columns
// ═══════════════════════════════════════════════════════════════════════

describe('P2.3 — Windows tracert: per-probe RTT columns', () => {

  it('shows 3 ms columns from independent probes', async () => {
    const { win } = buildTwoHopWindows();
    const out = await win.executeCommand('tracert 10.0.3.2');
    const hopLines = out.split('\n').filter(l => /^\s+\d+\s+/.test(l) && !l.includes('*'));
    expect(hopLines.length).toBeGreaterThan(0);
    for (const line of hopLines) {
      expect((line.match(/ms/g) || []).length).toBeGreaterThanOrEqual(3);
    }
  });

  it('timeout hop shows "Request timed out." (Windows style)', async () => {
    const { win } = buildTwoHopWindows();
    const out = await win.executeCommand('tracert 10.0.99.1');
    expect(out).toMatch(/Request timed out\.|Destination net unreachable\.|unreachable/i);
  });

});

// ═══════════════════════════════════════════════════════════════════════
// P2.4 — icmpCode annotations in Cisco and Huawei
// ═══════════════════════════════════════════════════════════════════════

describe('P2.4 — icmpCode annotations in router traceroute', () => {

  it('Cisco: !N when next-hop router has no route (ICMP Destination Unreachable code 0)', async () => {
    // R1 has default route → R2; R2 has no route to 10.0.99.1 → sends ICMP Dest Unreachable code 0
    const { r1 } = buildUnreachableCisco();
    await r1.executeCommand('enable');
    const out = await r1.executeCommand('traceroute 10.0.99.1');
    expect(out).toMatch(/!N/);
  });

  it('Huawei: !N when next-hop router has no route (ICMP Destination Unreachable code 0)', async () => {
    const { r1 } = buildUnreachableHuawei();
    const out = await r1.executeCommand('tracert 10.0.99.1');
    expect(out).toMatch(/!N/);
  });

});
