/**
 * Traceroute / tracert conformance tests.
 *
 * Verifies real-world-standard behavior for:
 *  - Windows `tracert` (P0a): `-h maxhops` honored in output header + hop limit
 *  - Windows `tracert` (P0a): unreachable hops show proper line
 *  - Cisco IOS `traceroute` (P0c): available from exec and privileged mode
 *  - Huawei VRP `tracert` (P0b): available from user mode
 *
 * Topology used (two-hop chain):
 *   WinPC / LinuxPC / CiscoR / HuaweiR
 *       eth0 / GE0 ─── GE0/0 / GE0/0/0   R1 (router under test)
 *                                          │
 *                                      GE0/1 / GE0/0/1
 *                                          │
 *                                      GE0/0 / GE0/0/0  R2
 *                                          │
 *                                      GE0/1 / GE0/0/1  ─── PC2 (target: 10.0.3.2)
 *
 * Address plan:
 *   10.0.1.0/24 — PC ↔ R1 (PC=.2, R1=.1)
 *   10.0.2.0/30 — R1 ↔ R2 (R1=.1, R2=.2)
 *   10.0.3.0/24 — R2 ↔ PC2 (PC2=.2, R2=.1)
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { IPAddress, SubnetMask, resetCounters } from '@/network/core/types';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { HuaweiRouter } from '@/network/devices/HuaweiRouter';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

function buildTwoHopTopology(
  sourceType: 'windows' | 'linux' | 'cisco' | 'huawei',
  routerType: 'cisco' | 'huawei' = 'cisco',
) {
  // R1 (the "origin" router or the router behind the source host)
  const r1 = routerType === 'cisco'
    ? new CiscoRouter('R1')
    : new HuaweiRouter('R1');
  // R2 (intermediate)
  const r2 = routerType === 'cisco'
    ? new CiscoRouter('R2')
    : new HuaweiRouter('R2');
  // PC2 (final destination)
  const pc2 = new LinuxPC('linux-pc', 'PC2');

  const r1Lan = routerType === 'cisco' ? 'GigabitEthernet0/0' : 'GE0/0/0';
  const r1Wan = routerType === 'cisco' ? 'GigabitEthernet0/1' : 'GE0/0/1';
  const r2Lan = routerType === 'cisco' ? 'GigabitEthernet0/0' : 'GE0/0/0';
  const r2Wan = routerType === 'cisco' ? 'GigabitEthernet0/1' : 'GE0/0/1';

  r1.configureInterface(r1Wan, new IPAddress('10.0.2.1'), new SubnetMask('255.255.255.252'));
  r2.configureInterface(r2Lan, new IPAddress('10.0.2.2'), new SubnetMask('255.255.255.252'));
  r2.configureInterface(r2Wan, new IPAddress('10.0.3.1'), new SubnetMask('255.255.255.0'));
  pc2.configureInterface('eth0', new IPAddress('10.0.3.2'), new SubnetMask('255.255.255.0'));
  pc2.setDefaultGateway(new IPAddress('10.0.3.1'));
  r1.addStaticRoute(new IPAddress('10.0.3.0'), new SubnetMask('255.255.255.0'), new IPAddress('10.0.2.2'));
  r2.addStaticRoute(new IPAddress('10.0.1.0'), new SubnetMask('255.255.255.0'), new IPAddress('10.0.2.1'));

  const cR1R2 = new Cable('cR1R2'); cR1R2.connect(r1.getPort(r1Wan)!, r2.getPort(r2Lan)!);
  const cR2PC2 = new Cable('cR2PC2'); cR2PC2.connect(r2.getPort(r2Wan)!, pc2.getPort('eth0')!);

  let source: WindowsPC | LinuxPC | CiscoRouter | HuaweiRouter;
  if (sourceType === 'windows') {
    const win = new WindowsPC('windows-pc', 'WinPC');
    win.configureInterface('eth0', new IPAddress('10.0.1.2'), new SubnetMask('255.255.255.0'));
    win.setDefaultGateway(new IPAddress('10.0.1.1'));
    r1.configureInterface(r1Lan, new IPAddress('10.0.1.1'), new SubnetMask('255.255.255.0'));
    r2.addStaticRoute(new IPAddress('10.0.1.0'), new SubnetMask('255.255.255.0'), new IPAddress('10.0.2.1'));
    const c = new Cable('cWinR1'); c.connect(win.getPort('eth0')!, r1.getPort(r1Lan)!);
    source = win;
  } else if (sourceType === 'linux') {
    const lpc = new LinuxPC('linux-pc', 'LinuxPC');
    lpc.configureInterface('eth0', new IPAddress('10.0.1.2'), new SubnetMask('255.255.255.0'));
    lpc.setDefaultGateway(new IPAddress('10.0.1.1'));
    r1.configureInterface(r1Lan, new IPAddress('10.0.1.1'), new SubnetMask('255.255.255.0'));
    const c = new Cable('cLpcR1'); c.connect(lpc.getPort('eth0')!, r1.getPort(r1Lan)!);
    source = lpc;
  } else if (sourceType === 'cisco') {
    // R1 IS the source — no additional host
    source = r1 as CiscoRouter;
  } else {
    source = r1 as HuaweiRouter;
  }

  return { source, r1, r2, pc2 };
}

// ═══════════════════════════════════════════════════════════════════════
// Windows tracert
// ═══════════════════════════════════════════════════════════════════════

describe('Windows tracert — P0a fixes', () => {
  beforeEach(() => {
    resetCounters();
    resetDeviceCounters();
    Logger.reset();
  });

  it('header shows "30 hops" when -h is not specified', async () => {
    const { source } = buildTwoHopTopology('windows');
    const win = source as WindowsPC;
    const out = await win.executeCommand('tracert 10.0.3.2');
    expect(out).toContain('over a maximum of 30 hops');
  });

  it('-h <n> is reflected in the output header', async () => {
    const { source } = buildTwoHopTopology('windows');
    const win = source as WindowsPC;
    const out = await win.executeCommand('tracert -h 5 10.0.3.2');
    expect(out).toContain('over a maximum of 5 hops');
    expect(out).not.toContain('over a maximum of 30 hops');
  });

  it('-h 1 stops after the first hop (gateway only)', async () => {
    const { source } = buildTwoHopTopology('windows');
    const win = source as WindowsPC;
    const out = await win.executeCommand('tracert -h 1 10.0.3.2');
    // First hop (gateway R1) must appear
    expect(out).toContain('10.0.1.1');
    // The final destination must NOT appear as a hop line (it may appear in the header)
    const hopLines = out.split('\n').filter(l => /^\s+\d+\s+/.test(l));
    const destinationAsHop = hopLines.some(l => l.includes('10.0.3.2'));
    expect(destinationAsHop).toBe(false);
    // Only one hop line should exist
    expect(hopLines.length).toBe(1);
  });

  it('shows all intermediate hops on a successful trace', async () => {
    const { source } = buildTwoHopTopology('windows');
    const win = source as WindowsPC;
    const out = await win.executeCommand('tracert 10.0.3.2');
    expect(out).toContain('10.0.1.1');  // first hop: R1
    expect(out).toContain('10.0.3.2');  // destination
    expect(out).toContain('Trace complete.');
  });

  it('shows "Destination net unreachable." for an unreachable route', async () => {
    const { source } = buildTwoHopTopology('windows');
    const win = source as WindowsPC;
    // 10.0.99.1 is unreachable (no route on R1 beyond 10.0.2.0/30)
    const out = await win.executeCommand('tracert 10.0.99.1');
    // R1 replies with ICMP Destination Unreachable — should render as !N / unreachable line
    expect(out).toMatch(/unreachable|!N|\*/i);
  });

  it('shows three RTT columns per hop', async () => {
    const { source } = buildTwoHopTopology('windows');
    const win = source as WindowsPC;
    const out = await win.executeCommand('tracert 10.0.3.2');
    // Each hop line must have pattern: "  N  X ms  X ms  X ms  <ip>"
    const hopLines = out.split('\n').filter(l => /^\s+\d+\s+/.test(l) && !l.includes('timed out') && !l.includes('*'));
    expect(hopLines.length).toBeGreaterThan(0);
    for (const line of hopLines) {
      // Should contain at least two "ms" occurrences (3 RTT columns)
      const msCount = (line.match(/ms/g) || []).length;
      expect(msCount).toBeGreaterThanOrEqual(3);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Cisco IOS traceroute
// ═══════════════════════════════════════════════════════════════════════

describe('Cisco IOS traceroute — P0c', () => {
  beforeEach(() => {
    resetCounters();
    resetDeviceCounters();
    Logger.reset();
  });

  async function ciscoCli(router: CiscoRouter, cmd: string): Promise<string> {
    return router.executeCommand(cmd);
  }

  it('traceroute is available in user exec mode', async () => {
    const { source } = buildTwoHopTopology('cisco', 'cisco');
    const r1 = source as CiscoRouter;
    const out = await ciscoCli(r1, 'traceroute 10.0.3.2');
    // Must not return "Invalid input" or "Unknown"
    expect(out).not.toMatch(/Invalid input|Unknown command|unrecognized/i);
  });

  it('traceroute is available in privileged exec mode', async () => {
    const { source } = buildTwoHopTopology('cisco', 'cisco');
    const r1 = source as CiscoRouter;
    await ciscoCli(r1, 'enable');
    const out = await ciscoCli(r1, 'traceroute 10.0.3.2');
    expect(out).not.toMatch(/Invalid input|Unknown command|unrecognized/i);
  });

  it('output includes "Type escape sequence to abort."', async () => {
    const { source } = buildTwoHopTopology('cisco', 'cisco');
    const r1 = source as CiscoRouter;
    await ciscoCli(r1, 'enable');
    const out = await ciscoCli(r1, 'traceroute 10.0.3.2');
    expect(out).toContain('Type escape sequence to abort.');
  });

  it('output contains the destination IP', async () => {
    const { source } = buildTwoHopTopology('cisco', 'cisco');
    const r1 = source as CiscoRouter;
    await ciscoCli(r1, 'enable');
    const out = await ciscoCli(r1, 'traceroute 10.0.3.2');
    expect(out).toContain('10.0.3.2');
  });

  it('shows intermediate hop R2 (10.0.2.2)', async () => {
    const { source } = buildTwoHopTopology('cisco', 'cisco');
    const r1 = source as CiscoRouter;
    await ciscoCli(r1, 'enable');
    const out = await ciscoCli(r1, 'traceroute 10.0.3.2');
    // R2's ingress IP on the R1-R2 link
    expect(out).toContain('10.0.2.2');
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Huawei VRP tracert
// ═══════════════════════════════════════════════════════════════════════

describe('Huawei VRP tracert — P0b', () => {
  beforeEach(() => {
    resetCounters();
    resetDeviceCounters();
    Logger.reset();
  });

  async function vrpCli(router: HuaweiRouter, cmd: string): Promise<string> {
    return router.executeCommand(cmd);
  }

  it('tracert is available in user view', async () => {
    const { source } = buildTwoHopTopology('huawei', 'huawei');
    const r1 = source as HuaweiRouter;
    const out = await vrpCli(r1, 'tracert 10.0.3.2');
    expect(out).not.toMatch(/Error|Unknown command|unrecognized/i);
  });

  it('output contains the destination IP', async () => {
    const { source } = buildTwoHopTopology('huawei', 'huawei');
    const r1 = source as HuaweiRouter;
    const out = await vrpCli(r1, 'tracert 10.0.3.2');
    expect(out).toContain('10.0.3.2');
  });

  it('shows intermediate hop R2 (10.0.2.2)', async () => {
    const { source } = buildTwoHopTopology('huawei', 'huawei');
    const r1 = source as HuaweiRouter;
    const out = await vrpCli(r1, 'tracert 10.0.3.2');
    expect(out).toContain('10.0.2.2');
  });

  it('output header follows Huawei format', async () => {
    const { source } = buildTwoHopTopology('huawei', 'huawei');
    const r1 = source as HuaweiRouter;
    const out = await vrpCli(r1, 'tracert 10.0.3.2');
    // Huawei: "tracert to 10.0.3.2(10.0.3.2), ..."
    expect(out).toMatch(/tracert? to 10\.0\.3\.2/i);
  });
});
