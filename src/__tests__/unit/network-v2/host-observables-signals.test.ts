/**
 * Regression — host observables must project the REAL device state.
 *
 * The actor-API refresh helpers used to reach their own fields through
 * `(this as unknown as { ndpCache?: … })` self-casts. Two of them had
 * silently drifted from the real field names:
 *   - `_refreshNdpSignal` read `this.ndpCache` — the field is
 *     `neighborCache` — so the NDP signal (and `ndpCacheSize`) never
 *     left their initial empty state;
 *   - `projectHostRoutes` expected `destination`/`gateway` while
 *     `HostRouteEntry` carries `network`/`nextHop`, so the routes
 *     signal projected the string "undefined" everywhere.
 * The casts are gone (direct field access — the compiler now guards
 * the contract); these tests pin the live behaviour.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { IPv6Address, MACAddress, resetCounters } from '@/network/core/types';
import { Logger } from '@/network/core/Logger';

describe('host observables reflect real device state', () => {
  beforeEach(() => {
    resetCounters();
    MACAddress.resetCounter();
    Logger.reset();
  });

  async function pingedPair() {
    const pc1 = new LinuxPC('PC1', 0, 0);
    const pc2 = new LinuxPC('PC2', 0, 0);
    const cable = new Cable('cable-1');
    cable.connect(pc1.getPort('eth0')!, pc2.getPort('eth0')!);
    await pc1.executeCommand('ifconfig eth0 192.168.1.10');
    await pc2.executeCommand('ifconfig eth0 192.168.1.20');
    await pc1.executeCommand('ping -c 1 192.168.1.20');
    return { pc1, pc2 };
  }

  it('ARP signal carries the genuinely learned neighbour', async () => {
    const { pc1 } = await pingedPair();
    pc1._refreshArpSignal();
    const arp = pc1.observables.arp.get();
    const peer = arp.find((e) => e.ip === '192.168.1.20');
    expect(peer).toBeDefined();
    expect(peer!.iface).toBe('eth0');
    expect(peer!.mac).toMatch(/^([0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}$/);
  });

  it('routes signal projects network/nextHop with real values (no "undefined")', async () => {
    const { pc1 } = await pingedPair();
    await pc1.executeCommand('route add default gw 192.168.1.20');
    pc1._refreshRoutesSignal();
    const routes = pc1.observables.routes.get();
    expect(routes.length).toBeGreaterThan(0);
    for (const r of routes) {
      expect(r.destination).not.toBe('undefined');
      expect(r.mask).not.toBe('undefined');
      expect(r.gateway).not.toBe('undefined');
    }
    const dflt = routes.find((r) => r.type === 'default');
    expect(dflt).toBeDefined();
    expect(dflt!.gateway).toBe('192.168.1.20');
  });

  it('stats signal counts the real ARP cache and routing table', async () => {
    const { pc1 } = await pingedPair();
    pc1._refreshHostStatsSignal();
    const stats = pc1.observables.stats.get();
    expect(stats.arpCacheSize).toBeGreaterThan(0);
    expect(stats.routeCount).toBeGreaterThan(0);
    expect(stats.icmpEchosSent).toBe(1);
  });

  it('NDP signal projects the neighbour cache (was: dead `ndpCache` lookup)', async () => {
    const pc1 = new LinuxPC('PC1', 0, 0);
    const pc2 = new LinuxPC('PC2', 0, 0);
    const cable = new Cable('cable-1');
    cable.connect(pc1.getPort('eth0')!, pc2.getPort('eth0')!);
    pc1.configureIPv6Interface('eth0', new IPv6Address('2001:db8::1'), 64);
    pc2.configureIPv6Interface('eth0', new IPv6Address('2001:db8::2'), 64);
    await pc1.executeCommand('ping6 -c 1 2001:db8::2');
    pc1._refreshNdpSignal();
    pc1._refreshHostStatsSignal();
    const ndp = pc1.observables.ndp.get();
    expect(ndp.find((e) => e.ip === '2001:db8::2')).toBeDefined();
    expect(pc1.observables.stats.get().ndpCacheSize).toBeGreaterThan(0);
  });
});
