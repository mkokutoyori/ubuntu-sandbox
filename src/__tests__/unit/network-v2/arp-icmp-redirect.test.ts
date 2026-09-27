/**
 * ARP NUD states, gratuitous ARP, ICMP Redirect
 *
 * Tests:
 *   8.01 – ip neigh show reflects NUD states (REACHABLE / STALE / PERMANENT)
 *   8.02 – Gratuitous ARP updates neighbor caches on connected devices
 *   8.03 – ICMP Redirect toward an unknown gateway: the host probes it and keeps its route
 *   8.04 – ip neigh add inserts a static (PERMANENT) entry
 *   8.05 – ip neigh del removes an entry
 *   8.06 – ip neigh flush [dev] removes dynamic entries
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { ARP_REACHABLE_TIME_MS } from '@/network/devices/EndHost';
import { pingOnSimulatedClock } from '../../support/fastPing';

afterEach(() => { vi.useRealTimers(); });

// ─── helpers ────────────────────────────────────────────────────────────────

/** Build a minimal two-router, two-PC topology and return configured devices. */
async function buildTwoRouterTopology() {
  const r1 = new CiscoRouter('R1');
  const r2 = new CiscoRouter('R2');
  const pc1 = new LinuxPC('linux-pc', 'PC1');
  const pc2 = new LinuxPC('linux-pc', 'PC2');

  new Cable('wan').connect(r1.getPort('GigabitEthernet0/1')!, r2.getPort('GigabitEthernet0/1')!);
  new Cable('lan1').connect(pc1.getPort('eth0')!, r1.getPort('GigabitEthernet0/0')!);
  new Cable('lan2').connect(pc2.getPort('eth0')!, r2.getPort('GigabitEthernet0/0')!);

  // R1
  await r1.executeCommand('enable');
  await r1.executeCommand('configure terminal');
  await r1.executeCommand('interface GigabitEthernet0/0');
  await r1.executeCommand('ip address 192.168.1.1 255.255.255.0');
  await r1.executeCommand('no shutdown');
  await r1.executeCommand('exit');
  await r1.executeCommand('interface GigabitEthernet0/1');
  await r1.executeCommand('ip address 10.0.0.1 255.255.255.252');
  await r1.executeCommand('no shutdown');
  await r1.executeCommand('exit');
  await r1.executeCommand('ip route 192.168.2.0 255.255.255.0 10.0.0.2');
  await r1.executeCommand('end');

  // R2
  await r2.executeCommand('enable');
  await r2.executeCommand('configure terminal');
  await r2.executeCommand('interface GigabitEthernet0/0');
  await r2.executeCommand('ip address 192.168.2.1 255.255.255.0');
  await r2.executeCommand('no shutdown');
  await r2.executeCommand('exit');
  await r2.executeCommand('interface GigabitEthernet0/1');
  await r2.executeCommand('ip address 10.0.0.2 255.255.255.252');
  await r2.executeCommand('no shutdown');
  await r2.executeCommand('exit');
  await r2.executeCommand('ip route 192.168.1.0 255.255.255.0 10.0.0.1');
  await r2.executeCommand('end');

  // PCs
  await pc1.executeCommand('sudo ip addr add 192.168.1.10/24 dev eth0');
  await pc1.executeCommand('sudo ip route add default via 192.168.1.1');
  await pc2.executeCommand('sudo ip addr add 192.168.2.10/24 dev eth0');
  await pc2.executeCommand('sudo ip route add default via 192.168.2.1');

  return { r1, r2, pc1, pc2 };
}

// ─── 8.01 – NUD state ────────────────────────────────────────────────────────

describe('ARP NUD States', () => {

  it('8.01a – freshly learned entry is REACHABLE', async () => {
    const { pc1, pc2 } = await buildTwoRouterTopology();

    // Trigger ARP exchange by pinging
    await pingOnSimulatedClock(pc1, 'ping -c 1 192.168.1.1');

    // pc1 should have R1's GW MAC as REACHABLE
    const neigh = await pc1.executeCommand('ip neigh show');
    expect(neigh).toContain('192.168.1.1');
    expect(neigh).toContain('REACHABLE');
  });

  it('8.01b – entry older than 30 s shows as STALE', async () => {
    const { pc1 } = await buildTwoRouterTopology();

    await pingOnSimulatedClock(pc1, 'ping -c 1 192.168.1.1');

    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + ARP_REACHABLE_TIME_MS + 1000 });

    const neigh = await pc1.executeCommand('ip neigh show');
    expect(neigh).toContain('192.168.1.1');
    expect(neigh).toContain('STALE');
  });

  it('8.01c – static entry shows as PERMANENT', async () => {
    const { pc1 } = await buildTwoRouterTopology();

    await pc1.executeCommand('sudo ip neigh add 192.168.1.254 lladdr aa:bb:cc:dd:ee:ff dev eth0');

    const neigh = await pc1.executeCommand('ip neigh show');
    expect(neigh).toContain('192.168.1.254');
    expect(neigh).toContain('PERMANENT');
  });
});

// ─── 8.02 – Gratuitous ARP ──────────────────────────────────────────────────

describe('Gratuitous ARP', () => {

  it('8.02 – configuring IP sends gratuitous ARP; router learns MAC immediately', async () => {
    const r1 = new CiscoRouter('R1');
    const pc1 = new LinuxPC('linux-pc', 'PC1');

    new Cable('lan').connect(pc1.getPort('eth0')!, r1.getPort('GigabitEthernet0/0')!);

    await r1.executeCommand('enable');
    await r1.executeCommand('configure terminal');
    await r1.executeCommand('interface GigabitEthernet0/0');
    await r1.executeCommand('ip address 192.168.1.1 255.255.255.0');
    await r1.executeCommand('no shutdown');
    await r1.executeCommand('exit');
    await r1.executeCommand('end');

    // Configuring pc1's IP triggers gratuitous ARP → R1 should learn pc1's MAC
    await pc1.executeCommand('sudo ip addr add 192.168.1.10/24 dev eth0');

    // Verify: R1's ARP table has pc1's IP without pc1 having sent a regular ARP request
    const arpR1 = await r1.executeCommand('show arp');
    expect(arpR1).toContain('192.168.1.10');
  });

  it('8.02b – gratuitous ARP does not break echo-reply (sendEchoReply queues via ARP)', async () => {
    // Regression test: before the sendEchoReply fix, the gratuitous ARP caused
    // R2 to skip ARPing for pc2, so pc2 never learned R2's MAC and silently
    // dropped its echo-reply (sendEchoReply checked arpTable and returned early).
    const { pc1 } = await buildTwoRouterTopology();

    const ping = await pingOnSimulatedClock(pc1, 'ping -c 3 192.168.2.10');
    expect(ping).toContain('3 received');
    expect(ping).toContain('0% packet loss');
  });
});

// ─── 8.03 – ICMP Redirect ───────────────────────────────────────────────────

describe('ICMP Redirect', () => {

  it('8.03 – ICMP redirect toward an unknown gateway: the host probes it and keeps its route', async () => {
    const r1 = new CiscoRouter('R1');
    const pc1 = new LinuxPC('linux-pc', 'PC1');

    new Cable('pc1-r1').connect(pc1.getPort('eth0')!, r1.getPort('GigabitEthernet0/0')!);

    await r1.executeCommand('enable');
    await r1.executeCommand('configure terminal');
    await r1.executeCommand('interface GigabitEthernet0/0');
    await r1.executeCommand('ip address 192.168.1.1 255.255.255.0');
    await r1.executeCommand('no shutdown');
    await r1.executeCommand('exit');
    await r1.executeCommand('ip route 10.0.0.99 255.255.255.255 192.168.1.2');
    await r1.executeCommand('end');

    await pc1.executeCommand('sudo ip addr add 192.168.1.10/24 dev eth0');
    await pc1.executeCommand('sudo ip route add default via 192.168.1.1');

    const probed: string[] = [];
    const stop = pc1.getBus().subscribe('host.arp.request-sent', (event) => { probed.push(event.payload.targetIp); });
    await pingOnSimulatedClock(pc1, 'ping -c 1 10.0.0.99');
    stop();

    expect(probed).toContain('192.168.1.2');
    expect(await pc1.executeCommand('ip route show')).not.toContain('10.0.0.99');
    expect(await pc1.executeCommand('ip route get 10.0.0.99')).toMatch(/^10\.0\.0\.99 via 192\.168\.1\.1 dev eth0 /);
  });
});

// ─── 8.04 – ip neigh add ────────────────────────────────────────────────────

describe('ip neigh add', () => {

  it('8.04 – ip neigh add inserts a PERMANENT entry', async () => {
    const { pc1 } = await buildTwoRouterTopology();

    const out = await pc1.executeCommand('sudo ip neigh add 10.0.0.99 lladdr de:ad:be:ef:ca:fe dev eth0');
    expect(out).toBe('');

    const neigh = await pc1.executeCommand('ip neigh show');
    expect(neigh).toContain('10.0.0.99');
    expect(neigh).toContain('de:ad:be:ef:ca:fe');
    expect(neigh).toContain('PERMANENT');
  });

  it('8.04b – ip neigh add with invalid MAC returns error', async () => {
    const { pc1 } = await buildTwoRouterTopology();

    const out = await pc1.executeCommand('sudo ip neigh add 10.0.0.1 lladdr notamac dev eth0');
    expect(out).toContain('Invalid argument');
  });
});

// ─── 8.05 – ip neigh del ────────────────────────────────────────────────────

describe('ip neigh del', () => {

  it('8.05 – ip neigh del removes a specific entry', async () => {
    const { pc1 } = await buildTwoRouterTopology();

    // First add an entry
    await pc1.executeCommand('sudo ip neigh add 10.0.0.99 lladdr de:ad:be:ef:ca:fe dev eth0');

    // Then delete it
    const out = await pc1.executeCommand('sudo ip neigh del 10.0.0.99 dev eth0');
    expect(out).toBe('');

    const neigh = await pc1.executeCommand('ip neigh show');
    expect(neigh).not.toContain('10.0.0.99');
  });

  it('8.05b – ip neigh del non-existent entry returns error', async () => {
    const { pc1 } = await buildTwoRouterTopology();

    const out = await pc1.executeCommand('sudo ip neigh del 99.99.99.99 dev eth0');
    expect(out).toContain('No such');
  });
});

// ─── 8.06 – ip neigh flush ──────────────────────────────────────────────────

describe('ip neigh flush', () => {

  it('8.06 – ip neigh flush clears all neighbors', async () => {
    const { pc1 } = await buildTwoRouterTopology();

    // Populate ARP table via ping
    await pingOnSimulatedClock(pc1, 'ping -c 1 192.168.1.1');

    let neigh = await pc1.executeCommand('ip neigh show');
    expect(neigh).toContain('192.168.1.1');

    // Flush all
    await pc1.executeCommand('sudo ip neigh flush');
    neigh = await pc1.executeCommand('ip neigh show');
    expect(neigh).not.toContain('192.168.1.1');
  });

  it('8.06b – ip neigh flush dev removes dynamic entries but spares PERMANENT', async () => {
    const { pc1 } = await buildTwoRouterTopology();

    await pc1.executeCommand('sudo ip neigh add 192.168.1.100 lladdr 11:22:33:44:55:66 dev eth0');
    await pc1.executeCommand('sudo ip neigh flush dev eth0');

    const neigh = await pc1.executeCommand('ip neigh show');
    expect(neigh).toContain('192.168.1.100');
    expect(neigh).toContain('PERMANENT');
  });
});
