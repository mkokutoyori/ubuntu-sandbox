/**
 * TDD — real EIGRP engine. Two engines wired as genuine cabled peers
 * form an adjacency ONLY when the AS matches, and each learns the
 * other's really-originated connected networks (AD 90). A lone /
 * AS-mismatched engine has no neighbour and no routes (true state).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { EIGRPEngine } from '@/network/eigrp/EIGRPEngine';
import type { RoutingPeer } from '@/network/routing';
import {
  IPAddress, SubnetMask, resetCounters,
} from '@/network/core/types';

beforeEach(() => resetCounters());

/** Build a bidirectional real-peer link between two engines. */
function link(a: EIGRPEngine, aHost: string, aIp: string,
              b: EIGRPEngine, bHost: string, bIp: string) {
  const peerOf = (eng: EIGRPEngine, host: string, ip: string): RoutingPeer => ({
    deviceId: host, hostname: host,
    localIface: 'Gi0/0',
    localIp: new IPAddress(host === aHost ? aIp : bIp),
    remoteIface: 'Gi0/0',
    remoteIp: new IPAddress(ip),
    peerEngineFor: (p) => (p === 'eigrp' ? eng : null),
  });
  a.setPeerLocator({ locatePeers: () => [peerOf(b, bHost, bIp)] });
  b.setPeerLocator({ locatePeers: () => [peerOf(a, aHost, aIp)] });
}

function ctx(net: string, ip: string) {
  return {
    connectedNetworks: () => [{
      network: new IPAddress(net),
      mask: new SubnetMask('255.255.255.0'),
      iface: 'Gi0/1',
      localIp: new IPAddress(ip),
    }],
  };
}

describe('EIGRPEngine — real config-driven', () => {
  it('no peer ⇒ no neighbour, no contributed routes', () => {
    const e = new EIGRPEngine('R1');
    e.setDeviceContext(ctx('192.168.1.0', '192.168.1.1'));
    e.enable({ asn: 100, networks: [{ network: '192.168.1.0' }] });
    e.converge();
    expect(e.getNeighbors()).toHaveLength(0);
    expect(e.getContributedRoutes()).toHaveLength(0);
  });

  it('two cabled peers in the same AS form adjacency + exchange routes', () => {
    const r1 = new EIGRPEngine('R1');
    const r2 = new EIGRPEngine('R2');
    r1.setDeviceContext(ctx('192.168.1.0', '192.168.1.1'));
    r2.setDeviceContext(ctx('192.168.2.0', '192.168.2.1'));
    r1.enable({ asn: 100, networks: [{ network: '192.168.1.0' }, { network: '10.0.0.0' }] });
    r2.enable({ asn: 100, networks: [{ network: '192.168.2.0' }, { network: '10.0.0.0' }] });
    link(r1, 'R1', '10.0.0.1', r2, 'R2', '10.0.0.2');
    r1.converge(); r2.converge();

    expect(r1.getNeighbors()).toHaveLength(1);
    expect(r1.getNeighbors()[0].isUp).toBe(true);
    const routes = r1.getContributedRoutes();
    expect(routes).toHaveLength(1);
    expect(String(routes[0].network)).toBe('192.168.2.0');  // learned from R2
    expect(routes[0].adminDistance).toBe(90);
    expect(String(routes[0].nextHop)).toBe('10.0.0.2');
    expect(r2.getContributedRoutes().map((x) => String(x.network)))
      .toContain('192.168.1.0');
  });

  it('AS mismatch ⇒ no adjacency (true state, not a stub)', () => {
    const r1 = new EIGRPEngine('R1');
    const r2 = new EIGRPEngine('R2');
    r1.setDeviceContext(ctx('192.168.1.0', '192.168.1.1'));
    r2.setDeviceContext(ctx('192.168.2.0', '192.168.2.1'));
    r1.enable({ asn: 100, networks: [{ network: '10.0.0.0' }] });
    r2.enable({ asn: 200, networks: [{ network: '10.0.0.0' }] });
    link(r1, 'R1', '10.0.0.1', r2, 'R2', '10.0.0.2');
    r1.converge();
    expect(r1.getNeighbors()).toHaveLength(0);
    expect(r1.getContributedRoutes()).toHaveLength(0);
  });

  it('disable tears the adjacency down reactively', () => {
    const r1 = new EIGRPEngine('R1');
    const r2 = new EIGRPEngine('R2');
    r1.setDeviceContext(ctx('192.168.1.0', '192.168.1.1'));
    r2.setDeviceContext(ctx('192.168.2.0', '192.168.2.1'));
    r1.enable({ asn: 100, networks: [{ network: '10.0.0.0' }] });
    r2.enable({ asn: 100, networks: [{ network: '10.0.0.0' }] });
    link(r1, 'R1', '10.0.0.1', r2, 'R2', '10.0.0.2');
    r1.converge();
    expect(r1.getNeighbors()).toHaveLength(1);
    r2.disable();
    r1.converge();
    expect(r1.getNeighbors()).toHaveLength(0);
  });
});
