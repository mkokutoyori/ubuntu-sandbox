/**
 * TDD — real BGP engine. A session reaches Established only with a
 * genuinely cabled peer running BGP that points back reciprocally
 * with the right AS; otherwise Idle (no peer) / Active (peer, no
 * reciprocal). Routes learned only when Established. True state, no
 * fabricated "up".
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { BGPEngine } from '@/network/bgp/BGPEngine';
import type { RoutingPeer } from '@/network/routing';
import { IPAddress, SubnetMask, resetCounters } from '@/network/core/types';

beforeEach(() => resetCounters());

function ctx(net: string) {
  return {
    connectedNetworks: () => [{
      network: new IPAddress(net),
      mask: new SubnetMask('255.255.255.0'),
      iface: 'Gi0/1',
      localIp: new IPAddress(net.replace(/0$/, '1')),
    }],
  };
}

function link(a: BGPEngine, aIp: string, b: BGPEngine, bIp: string) {
  const mk = (eng: BGPEngine, localIp: string, remoteIp: string): RoutingPeer => ({
    deviceId: remoteIp, hostname: remoteIp,
    localIface: 'Gi0/0', localIp: new IPAddress(localIp),
    remoteIface: 'Gi0/0', remoteIp: new IPAddress(remoteIp),
    peerEngineFor: (p) => (p === 'bgp' ? eng : null),
  });
  a.setPeerLocator({ locatePeers: () => [mk(b, aIp, bIp)] });
  b.setPeerLocator({ locatePeers: () => [mk(a, bIp, aIp)] });
}

describe('BGPEngine — real config-driven', () => {
  it('configured neighbour with no real peer ⇒ Idle, no routes', () => {
    const r1 = new BGPEngine('R1');
    r1.setDeviceContext(ctx('192.168.1.0'));
    r1.enable({ asn: 65001 });
    r1.getConfig().neighbors.set('10.0.0.2', { ip: '10.0.0.2', remoteAs: 65002, activated: true });
    r1.getConfig().networks.push({ network: '192.168.1.0', mask: '255.255.255.0' });
    r1.converge();
    const n = r1.getNeighbors();
    expect(n).toHaveLength(1);
    expect(n[0].state).toBe('Idle');
    expect(n[0].isUp).toBe(false);
    expect(r1.getContributedRoutes()).toHaveLength(0);
  });

  it('reciprocal eBGP peers reach Established and exchange routes', () => {
    const r1 = new BGPEngine('R1');
    const r2 = new BGPEngine('R2');
    r1.setDeviceContext(ctx('192.168.1.0'));
    r2.setDeviceContext(ctx('192.168.2.0'));
    r1.enable({ asn: 65001 });
    r2.enable({ asn: 65002 });
    r1.getConfig().neighbors.set('10.0.0.2', { ip: '10.0.0.2', remoteAs: 65002, activated: true });
    r2.getConfig().neighbors.set('10.0.0.1', { ip: '10.0.0.1', remoteAs: 65001, activated: true });
    r1.getConfig().networks.push({ network: '192.168.1.0', mask: '255.255.255.0' });
    r2.getConfig().networks.push({ network: '192.168.2.0', mask: '255.255.255.0' });
    link(r1, '10.0.0.1', r2, '10.0.0.2');
    r1.converge(); r2.converge();

    expect(r1.getNeighbors()[0].state).toBe('Established');
    expect(r1.getNeighbors()[0].isUp).toBe(true);
    const routes = r1.getContributedRoutes();
    expect(routes).toHaveLength(1);
    expect(String(routes[0].network)).toBe('192.168.2.0');
    expect(routes[0].adminDistance).toBe(20);          // eBGP
    expect(String(routes[0].nextHop)).toBe('10.0.0.2');
  });

  it('peer present but not reciprocally configured ⇒ Active (no routes)', () => {
    const r1 = new BGPEngine('R1');
    const r2 = new BGPEngine('R2');
    r1.setDeviceContext(ctx('192.168.1.0'));
    r2.setDeviceContext(ctx('192.168.2.0'));
    r1.enable({ asn: 65001 });
    r2.enable({ asn: 65002 });
    r1.getConfig().neighbors.set('10.0.0.2', { ip: '10.0.0.2', remoteAs: 65002, activated: true });
    // R2 has NO neighbor pointing back.
    r2.getConfig().networks.push({ network: '192.168.2.0', mask: '255.255.255.0' });
    link(r1, '10.0.0.1', r2, '10.0.0.2');
    r1.converge();
    expect(r1.getNeighbors()[0].state).toBe('Active');
    expect(r1.getContributedRoutes()).toHaveLength(0);
  });

  it('iBGP (same AS) yields AD 200', () => {
    const r1 = new BGPEngine('R1');
    const r2 = new BGPEngine('R2');
    r1.setDeviceContext(ctx('192.168.1.0'));
    r2.setDeviceContext(ctx('192.168.2.0'));
    r1.enable({ asn: 65000 });
    r2.enable({ asn: 65000 });
    r1.getConfig().neighbors.set('10.0.0.2', { ip: '10.0.0.2', remoteAs: 65000, activated: true });
    r2.getConfig().neighbors.set('10.0.0.1', { ip: '10.0.0.1', remoteAs: 65000, activated: true });
    r2.getConfig().networks.push({ network: '192.168.2.0', mask: '255.255.255.0' });
    link(r1, '10.0.0.1', r2, '10.0.0.2');
    r1.converge();
    const routes = r1.getContributedRoutes();
    expect(routes[0].adminDistance).toBe(200);
  });
});
