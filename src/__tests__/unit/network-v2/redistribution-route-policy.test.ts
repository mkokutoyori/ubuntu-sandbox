/**
 * route-policy/ip-prefix filtering into redistribution (rapport 02, item
 * #44). `RoutePolicyStore`/`IpPrefixListStore` were pure config storage —
 * `import-route ... route-policy <name>` (RIP) and `filter-policy ip-prefix
 * <name> export` (OSPF) were accepted syntax with zero behavioral wiring,
 * so every redistributed route leaked through regardless of the configured
 * filter. `RoutePolicy.evaluate()`'s match support is intentionally
 * narrow — only ip-prefix/tag/route-type, since those are the only match
 * kinds with real data on a redistributed route today; apply-clause
 * mutation (cost/tag/next-hop rewriting) is not implemented.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { HuaweiRouter } from '@/network/devices/HuaweiRouter';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, SubnetMask, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { IpPrefixListStore } from '@/network/devices/router/policy/IpPrefixList';
import { RoutePolicyStore } from '@/network/devices/router/policy/RoutePolicy';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.reset();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('RoutePolicy.evaluate() (unit)', () => {
  it('permits a route matching an if-match ip-prefix node, denies everything else', () => {
    const prefixLists = new IpPrefixListStore();
    prefixLists.upsert('P1', 'ipv4').upsert({ action: 'permit', network: '10.1.1.0', prefixLength: 24 });

    const policies = new RoutePolicyStore();
    const rp = policies.upsert('RP');
    rp.upsertNode(10, 'permit').ifMatch({ ipPrefix: 'P1' });

    expect(rp.evaluate({ network: '10.1.1.0', prefixLength: 24 }, prefixLists))
      .toEqual({ action: 'permit', apply: {} });
    expect(rp.evaluate({ network: '10.2.2.0', prefixLength: 24 }, prefixLists).action).toBe('deny');
  });

  it('a node with no if-match clause matches every route unconditionally', () => {
    const prefixLists = new IpPrefixListStore();
    const policies = new RoutePolicyStore();
    const rp = policies.upsert('RP');
    rp.upsertNode(10, 'deny');
    expect(rp.evaluate({ network: '192.168.1.0', prefixLength: 24 }, prefixLists).action).toBe('deny');
  });
});

describe('RIP: import-route route-policy actually filters redistribution', () => {
  it('only the ip-prefix-permitted static route is advertised to a RIP neighbor', async () => {
    const r1 = new HuaweiRouter('router-huawei', 'R1');
    const r2 = new HuaweiRouter('router-huawei', 'R2');
    new Cable('c1').connect(r1.getPort('GE0/0/0')!, r2.getPort('GE0/0/0')!);

    for (const [r, ip] of [[r1, '10.0.9.1'], [r2, '10.0.9.2']] as const) {
      await r.executeCommand('system-view');
      await r.executeCommand('interface GE0/0/0');
      await r.executeCommand(`ip address ${ip} 255.255.255.0`);
      await r.executeCommand('undo shutdown');
      await r.executeCommand('quit');
    }

    await r1.executeCommand('ip route-static 10.1.1.0 255.255.255.0 NULL0');
    await r1.executeCommand('ip route-static 10.2.2.0 255.255.255.0 NULL0');
    await r1.executeCommand('ip ip-prefix P1 permit 10.1.1.0 24');
    await r1.executeCommand('route-policy RP permit node 10');
    await r1.executeCommand('if-match ip-prefix P1');
    await r1.executeCommand('quit');

    await r1.executeCommand('rip');
    await r1.executeCommand('network 10.0.9.0');
    await r1.executeCommand('import-route static route-policy RP');
    await r1.executeCommand('return');
    await r2.executeCommand('rip');
    await r2.executeCommand('network 10.0.9.0');
    await r2.executeCommand('return');

    expect(r1.getRIPConfig().redistribute.get('static')).toEqual({ metric: undefined, routePolicy: 'RP' });

    vi.advanceTimersByTime(30100);

    const r2Rip = r2.getRoutingTable().filter(r => r.type === 'rip');
    expect(r2Rip.some(r => r.network.toString() === '10.1.1.0')).toBe(true);
    expect(r2Rip.some(r => r.network.toString() === '10.2.2.0')).toBe(false);
  });
});

describe('OSPF: filter-policy ip-prefix export actually filters redistribution', () => {
  it('only the ip-prefix-permitted static route reaches an OSPF neighbor as an external route', async () => {
    const r1 = new HuaweiRouter('router-huawei', 'R1');
    const r2 = new HuaweiRouter('router-huawei', 'R2');
    new Cable('c1').connect(r1.getPort('GE0/0/0')!, r2.getPort('GE0/0/0')!);

    for (const [r, ip] of [[r1, '10.0.2.1'], [r2, '10.0.2.2']] as const) {
      await r.executeCommand('system-view');
      await r.executeCommand('interface GE0/0/0');
      await r.executeCommand(`ip address ${ip} 255.255.255.0`);
      await r.executeCommand('undo shutdown');
      await r.executeCommand('quit');
    }

    await r1.executeCommand('ip route-static 10.1.1.0 255.255.255.0 NULL0');
    await r1.executeCommand('ip route-static 10.2.2.0 255.255.255.0 NULL0');
    await r1.executeCommand('ip ip-prefix P1 permit 10.1.1.0 24');

    await r1.executeCommand('ospf 1');
    await r1.executeCommand('area 0');
    await r1.executeCommand('network 10.0.2.0 0.0.0.255');
    await r1.executeCommand('quit');
    await r1.executeCommand('filter-policy ip-prefix P1 export static');
    await r1.executeCommand('import-route static');
    await r1.executeCommand('return');

    await r2.executeCommand('ospf 1');
    await r2.executeCommand('area 0');
    await r2.executeCommand('network 10.0.2.0 0.0.0.255');
    await r2.executeCommand('return');
    await r2.executeCommand('display ospf interface');

    const r2Ospf = r2.getRoutingTable().filter(r => r.type === 'ospf');
    expect(r2Ospf.some(r => r.network.toString() === '10.1.1.0')).toBe(true);
    expect(r2Ospf.some(r => r.network.toString() === '10.2.2.0')).toBe(false);
  });
});
