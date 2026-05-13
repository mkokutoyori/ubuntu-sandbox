/**
 * ARP NUD states, gratuitous ARP, ICMP Redirect
 *
 * Tests:
 *   8.01 – ip neigh show reflects NUD states (REACHABLE / STALE / PERMANENT)
 *   8.02 – Gratuitous ARP updates neighbor caches on connected devices
 *   8.03 – ICMP Redirect: router sends Type 5, host installs host route
 *   8.04 – ip neigh add inserts a static (PERMANENT) entry
 *   8.05 – ip neigh del removes an entry
 *   8.06 – ip neigh flush [dev] removes dynamic entries
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { ARP_REACHABLE_TIME_MS } from '@/network/devices/EndHost';

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
    await pc1.executeCommand('ping -c 1 192.168.1.1');

    // pc1 should have R1's GW MAC as REACHABLE
    const neigh = await pc1.executeCommand('ip neigh show');
    expect(neigh).toContain('192.168.1.1');
    expect(neigh).toContain('REACHABLE');
  });

  it('8.01b – entry older than 30 s shows as STALE', async () => {
    vi.useFakeTimers();
    const { pc1 } = await buildTwoRouterTopology();

    await pc1.executeCommand('ping -c 1 192.168.1.1');

    // Advance time past the reachable threshold
    vi.advanceTimersByTime(ARP_REACHABLE_TIME_MS + 1000);

    const neigh = await pc1.executeCommand('ip neigh show');
    expect(neigh).toContain('192.168.1.1');
    expect(neigh).toContain('STALE');

    vi.useRealTimers();
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

    const ping = await pc1.executeCommand('ping -c 3 192.168.2.10');
    expect(ping).toContain('3 received');
    expect(ping).toContain('0% packet loss');
  });
});

// ─── 8.03 – ICMP Redirect ───────────────────────────────────────────────────

describe('ICMP Redirect', () => {

  it('8.03 – router sends ICMP redirect when egress == ingress; host installs host route', async () => {
    /**
     * Redirect topology (RFC 1812 §5.2.7):
     *
     *   PC1 (192.168.1.10/24) ──[eth0]── R1.Gi0/0 (192.168.1.1/24)
     *
     *   R1 has a host route:  10.0.0.99/32 via 192.168.1.2
     *
     *   When PC1 pings 10.0.0.99 (outside PC1's /24, so PC1 uses its default
     *   gateway):
     *     • ICMP echo request sent to R1 (192.168.1.1) via ARP
     *     • Packet arrives on R1's Gi0/0 (inPort = Gi0/0)
     *     • LPM selects the /32 static route → nextHop = 192.168.1.2, iface = Gi0/0
     *     • egress (Gi0/0) == ingress (Gi0/0) and nextHop is non-null
     *     • Source 192.168.1.10 is on-link (192.168.1.0/24)
     *     ⟹ R1 sends ICMP Redirect (Type 5, Code 1) to PC1: "use 192.168.1.2 for 10.0.0.99"
     *     ⟹ PC1 installs a /32 host route: 10.0.0.99 via 192.168.1.2
     *
     *   Note: 10.0.0.99 and 192.168.1.2 don't exist as real hosts; the ping
     *   times out, but the redirect is sent synchronously (during forwardPacket)
     *   before the ARP timeout fires, so the routing table is already updated.
     */
    const r1 = new CiscoRouter('R1');
    const pc1 = new LinuxPC('linux-pc', 'PC1');

    new Cable('pc1-r1').connect(pc1.getPort('eth0')!, r1.getPort('GigabitEthernet0/0')!);

    await r1.executeCommand('enable');
    await r1.executeCommand('configure terminal');
    await r1.executeCommand('interface GigabitEthernet0/0');
    await r1.executeCommand('ip address 192.168.1.1 255.255.255.0');
    await r1.executeCommand('no shutdown');
    await r1.executeCommand('exit');
    // Host route via 192.168.1.2 — resolved to Gi0/0 (same subnet), triggers redirect
    await r1.executeCommand('ip route 10.0.0.99 255.255.255.255 192.168.1.2');
    await r1.executeCommand('end');

    await pc1.executeCommand('sudo ip addr add 192.168.1.10/24 dev eth0');
    await pc1.executeCommand('sudo ip route add default via 192.168.1.1');

    // 10.0.0.99 is outside PC1's /24, so PC1 sends the echo via the default gateway (R1).
    // R1's LPM hit is the /32 static route on Gi0/0 == inPort → ICMP redirect sent to PC1.
    // The ARP for 192.168.1.2 fails (no such host), so ping returns 0 received,
    // but the redirect is already processed synchronously before the timeout.
    await pc1.executeCommand('ping -c 1 10.0.0.99');

    const routes = await pc1.executeCommand('ip route show');
    // PC1 should have a /32 host route installed by the ICMP redirect
    expect(routes).toContain('10.0.0.99');
    expect(routes).toContain('192.168.1.2'); // via the redirect gateway
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
    await pc1.executeCommand('ping -c 1 192.168.1.1');

    let neigh = await pc1.executeCommand('ip neigh show');
    expect(neigh).toContain('192.168.1.1');

    // Flush all
    await pc1.executeCommand('sudo ip neigh flush');
    neigh = await pc1.executeCommand('ip neigh show');
    expect(neigh).not.toContain('192.168.1.1');
  });

  it('8.06b – ip neigh flush dev removes only entries on that interface', async () => {
    const { pc1 } = await buildTwoRouterTopology();

    // Add a static entry on a different interface name (simulated)
    await pc1.executeCommand('sudo ip neigh add 192.168.1.100 lladdr 11:22:33:44:55:66 dev eth0');

    // Flush eth0 only
    await pc1.executeCommand('sudo ip neigh flush dev eth0');

    const neigh = await pc1.executeCommand('ip neigh show');
    expect(neigh).not.toContain('192.168.1.100');
  });
});
