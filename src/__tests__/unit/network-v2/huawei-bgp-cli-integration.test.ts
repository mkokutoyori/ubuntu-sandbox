/**
 * TDD — Huawei VRP `bgp <asn>` config is wired into the real BGPEngine
 * (audit 02, constat critique: `display bgp peer`/`display bgp
 * routing-table` used to read a passive config-only facade
 * (`HuaweiRoutingExtras`) that no engine ever updated — always "Idle",
 * zero counters, `0.0.0.0` next-hop, regardless of real peering state.
 * Huawei routers already own a real BGPEngine (shared `Router` base
 * class via `RouterDynamicRouting`, same as Cisco) — the VRP CLI just
 * never drove it.
 *
 * Mirrors `eigrp-bgp-cli-integration.test.ts`'s Cisco pattern: two
 * genuinely cabled routers, configured through the real CLI, must
 * reach a real Established session and exchange real routes — first
 * Huawei↔Huawei, then the headline case, Cisco↔Huawei eBGP.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { HuaweiRouter } from '@/network/devices/HuaweiRouter';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { Cable } from '@/network/hardware/Cable';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

async function huaweiBaseAddrs(r: HuaweiRouter, lan: string, wan: string) {
  await r.executeCommand('system-view');
  await r.executeCommand('interface GE0/0/0');
  await r.executeCommand(`ip address ${lan} 255.255.255.0`);
  await r.executeCommand('quit');
  await r.executeCommand('interface GE0/0/1');
  await r.executeCommand(`ip address ${wan} 255.255.255.252`);
  await r.executeCommand('quit');
  await r.executeCommand('quit');
}

async function ciscoBaseAddrs(r: CiscoRouter, lan: string, wan: string) {
  await r.executeCommand('enable');
  await r.executeCommand('configure terminal');
  await r.executeCommand('interface GigabitEthernet0/0');
  await r.executeCommand(`ip address ${lan} 255.255.255.0`);
  await r.executeCommand('no shutdown');
  await r.executeCommand('exit');
  await r.executeCommand('interface GigabitEthernet0/1');
  await r.executeCommand(`ip address ${wan} 255.255.255.252`);
  await r.executeCommand('no shutdown');
  await r.executeCommand('exit');
  await r.executeCommand('end');
}

function wireHuaweiWan(r1: HuaweiRouter, r2: HuaweiRouter) {
  new Cable('wan').connect(r1.getPort('GE0/0/1')!, r2.getPort('GE0/0/1')!);
}

function wireCiscoHuaweiWan(cisco: CiscoRouter, huawei: HuaweiRouter) {
  new Cable('wan').connect(cisco.getPort('GigabitEthernet0/1')!, huawei.getPort('GE0/0/1')!);
}

describe('Huawei↔Huawei eBGP via CLI — real engine, not the config facade', () => {
  it('reciprocal peers reach Established and exchange routes', async () => {
    const r1 = new HuaweiRouter('R1');
    const r2 = new HuaweiRouter('R2');
    await huaweiBaseAddrs(r1, '192.168.1.1', '10.0.0.1');
    await huaweiBaseAddrs(r2, '192.168.2.1', '10.0.0.2');
    wireHuaweiWan(r1, r2);

    await r1.executeCommand('system-view');
    await r1.executeCommand('bgp 65001');
    await r1.executeCommand('peer 10.0.0.2 as-number 65002');
    await r1.executeCommand('network 192.168.1.0 255.255.255.0');
    await r1.executeCommand('quit');
    await r1.executeCommand('quit');

    await r2.executeCommand('system-view');
    await r2.executeCommand('bgp 65002');
    await r2.executeCommand('peer 10.0.0.1 as-number 65001');
    await r2.executeCommand('network 192.168.2.0 255.255.255.0');
    await r2.executeCommand('quit');
    await r2.executeCommand('quit');

    const peer = await r1.executeCommand('display bgp peer');
    expect(peer).toMatch(/10\.0\.0\.2/);
    expect(peer).toMatch(/Established/);
    expect(peer).toMatch(/Peers in established state\s*:\s*1/);

    const rt = await r1.executeCommand('display bgp routing-table');
    expect(rt).toContain('192.168.2.0');

    const route = await r1.executeCommand('display ip routing-table');
    expect(route).toMatch(/192\.168\.2\.0/);
  });

  it('no reciprocal peer ⇒ stays Idle (true state, not fabricated)', async () => {
    const r1 = new HuaweiRouter('R1');
    const r2 = new HuaweiRouter('R2');
    await huaweiBaseAddrs(r1, '192.168.1.1', '10.0.0.1');
    await huaweiBaseAddrs(r2, '192.168.2.1', '10.0.0.2');
    wireHuaweiWan(r1, r2);

    await r1.executeCommand('system-view');
    await r1.executeCommand('bgp 65001');
    await r1.executeCommand('peer 10.0.0.2 as-number 65002');
    await r1.executeCommand('quit');
    await r1.executeCommand('quit');
    // R2 never configures BGP back.

    const peer = await r1.executeCommand('display bgp peer');
    expect(peer).toMatch(/10\.0\.0\.2/);
    expect(peer).toMatch(/Idle/);
    expect(peer).not.toMatch(/Established/);
    expect(peer).toMatch(/Peers in established state\s*:\s*0/);
  });
});

describe('Cisco↔Huawei eBGP via CLI — cross-vendor lab (audit headline case)', () => {
  it('a Cisco router and a Huawei router reach Established and exchange routes', async () => {
    const cisco = new CiscoRouter('CR1');
    const huawei = new HuaweiRouter('HR1');
    await ciscoBaseAddrs(cisco, '192.168.1.1', '10.0.0.1');
    await huaweiBaseAddrs(huawei, '192.168.2.1', '10.0.0.2');
    wireCiscoHuaweiWan(cisco, huawei);

    await cisco.executeCommand('enable');
    await cisco.executeCommand('configure terminal');
    await cisco.executeCommand('router bgp 65001');
    await cisco.executeCommand('neighbor 10.0.0.2 remote-as 65002');
    await cisco.executeCommand('network 192.168.1.0 mask 255.255.255.0');
    await cisco.executeCommand('end');

    await huawei.executeCommand('system-view');
    await huawei.executeCommand('bgp 65002');
    await huawei.executeCommand('peer 10.0.0.1 as-number 65001');
    await huawei.executeCommand('network 192.168.2.0 255.255.255.0');
    await huawei.executeCommand('quit');
    await huawei.executeCommand('quit');

    const ciscoSummary = await cisco.executeCommand('show ip bgp summary');
    expect(ciscoSummary).toMatch(/10\.0\.0\.2.*Established/);

    const huaweiPeer = await huawei.executeCommand('display bgp peer');
    expect(huaweiPeer).toMatch(/10\.0\.0\.1/);
    expect(huaweiPeer).toMatch(/Established/);

    const ciscoRoutes = await cisco.executeCommand('show ip route');
    expect(ciscoRoutes).toMatch(/B\s+192\.168\.2\.0\/24/);

    const huaweiRoutes = await huawei.executeCommand('display ip routing-table');
    expect(huaweiRoutes).toMatch(/192\.168\.1\.0/);
  });
});
