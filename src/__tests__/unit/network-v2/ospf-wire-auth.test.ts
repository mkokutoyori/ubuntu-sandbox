// RFC 2328 §8.2 — OSPF auth validated at ingress, stamped at egress (entrée 13).

import { describe, it, expect, beforeEach } from 'vitest';
import { OSPFEngine } from '@/network/ospf/OSPFEngine';
import type { OSPFHelloPacket } from '@/network/ospf/types';
import { resetCounters } from '@/network/core/types';
import { signOspfPacket } from '@/network/ospf/OspfCryptographicAuth';

beforeEach(() => { resetCounters(); });

function makeHello(routerId: string, overrides: Partial<OSPFHelloPacket> = {}): OSPFHelloPacket {
  return {
    type: 'ospf',
    version: 2,
    packetType: 1,
    routerId,
    areaId: '0.0.0.0',
    networkMask: '255.255.255.0',
    helloInterval: 10,
    options: 0x02,
    priority: 1,
    deadInterval: 40,
    designatedRouter: '0.0.0.0',
    backupDesignatedRouter: '0.0.0.0',
    neighbors: [],
    ...overrides,
  };
}

function makeEngine(authType: number, authKey?: string, md5Keys: ReadonlyMap<number, string> = new Map()): OSPFEngine {
  const engine = new OSPFEngine(1);
  engine.setRouterId('1.1.1.1');
  engine.activateInterface('Gi0/0', '10.0.0.1', '255.255.255.0', '0.0.0.0', {});
  const iface = engine.getInterface('Gi0/0')!;
  iface.authType = authType;
  iface.authKey = authKey;
  iface.md5Keys = new Map(md5Keys);
  return engine;
}

describe('OSPF wire authentication (RFC 2328 §8.2)', () => {
  it('accepts a hello whose auth fields match the interface', () => {
    const engine = makeEngine(1, 'SECRET');
    engine.processPacket('Gi0/0', '10.0.0.2',
      makeHello('2.2.2.2', { authType: 1, authKey: 'SECRET' }));
    expect(engine.getInterface('Gi0/0')!.neighbors.has('2.2.2.2')).toBe(true);
  });

  it('drops a hello with a wrong password before any FSM processing', () => {
    const engine = makeEngine(1, 'SECRET');
    engine.processPacket('Gi0/0', '10.0.0.2',
      makeHello('2.2.2.2', { authType: 1, authKey: 'WRONG' }));
    expect(engine.getInterface('Gi0/0')!.neighbors.size).toBe(0);
  });

  it('drops a hello with a mismatched AuType (null vs simple)', () => {
    const engine = makeEngine(1, 'SECRET');
    engine.processPacket('Gi0/0', '10.0.0.2',
      makeHello('2.2.2.2')); // no auth fields at all (AuType 0)
    expect(engine.getInterface('Gi0/0')!.neighbors.size).toBe(0);
  });

  it('drops an authenticated hello arriving on an unauthenticated interface', () => {
    const engine = makeEngine(0);
    engine.processPacket('Gi0/0', '10.0.0.2',
      makeHello('2.2.2.2', { authType: 2, authKey: 'K' }));
    expect(engine.getInterface('Gi0/0')!.neighbors.size).toBe(0);
  });

  it('stamps outgoing simple-password packets with the interface key at egress', () => {
    const engine = makeEngine(1, 'SIMPLE');
    const sent: Array<{ packet: { authType?: number; authKey?: string } }> = [];
    engine.setSendCallback((_iface, packet) => { sent.push({ packet }); });
    engine.sendHelloOnInterface('Gi0/0');
    expect(sent.length).toBeGreaterThan(0);
    expect(sent[0].packet.authType).toBe(1);
    expect(sent[0].packet.authKey).toBe('SIMPLE');
  });

  it('signs outgoing MD5 packets with the key id and a digest, and never puts the key on the wire', () => {
    const engine = makeEngine(2, undefined, new Map([[5, 'MD5KEY']]));
    const sent: Array<{ packet: { authType?: number; authKey?: string; authKeyId?: number; authDigest?: string } }> = [];
    engine.setSendCallback((_iface, packet) => { sent.push({ packet }); });
    engine.sendHelloOnInterface('Gi0/0');
    expect(sent.length).toBeGreaterThan(0);
    expect(sent[0].packet.authType).toBe(2);
    expect(sent[0].packet.authKeyId).toBe(5);
    expect(sent[0].packet.authDigest).toMatch(/^[0-9a-f]{32}$/);
    expect(JSON.stringify(sent[0].packet)).not.toContain('MD5KEY');
  });

  it('sends nothing on an MD5 interface that has no key yet', () => {
    const engine = makeEngine(2);
    const sent: unknown[] = [];
    engine.setSendCallback((_iface, packet) => { sent.push(packet); });
    engine.sendHelloOnInterface('Gi0/0');
    expect(sent).toEqual([]);
  });
});

describe('OSPF cryptographic authentication (RFC 2328 Appendix D)', () => {
  const keys = new Map([[1, 'SECRET']]);
  const signed = (secret: string, keyId: number, sequence: number, routerId = '2.2.2.2'): OSPFHelloPacket =>
    signOspfPacket(makeHello(routerId), keyId, secret, sequence);

  it('accepts a hello signed under a key id the interface holds', () => {
    const engine = makeEngine(2, undefined, keys);
    engine.processPacket('Gi0/0', '10.0.0.2', signed('SECRET', 1, 10));
    expect(engine.getInterface('Gi0/0')!.neighbors.has('2.2.2.2')).toBe(true);
  });

  it('drops a hello signed with another secret under the same key id', () => {
    const engine = makeEngine(2, undefined, keys);
    engine.processPacket('Gi0/0', '10.0.0.2', signed('OTHER', 1, 10));
    expect(engine.getInterface('Gi0/0')!.neighbors.size).toBe(0);
  });

  it('drops a hello signed under a key id the interface does not hold', () => {
    const engine = makeEngine(2, undefined, keys);
    engine.processPacket('Gi0/0', '10.0.0.2', signed('SECRET', 2, 10));
    expect(engine.getInterface('Gi0/0')!.neighbors.size).toBe(0);
  });

  it('drops a hello whose content was altered after it was signed', () => {
    const engine = makeEngine(2, undefined, keys);
    const hello = signed('SECRET', 1, 10);
    engine.processPacket('Gi0/0', '10.0.0.2', { ...hello, priority: 200 });
    expect(engine.getInterface('Gi0/0')!.neighbors.size).toBe(0);
  });

  it('drops a packet whose sequence number went backwards, and keeps accepting equal or newer ones', () => {
    const engine = makeEngine(2, undefined, keys);
    engine.processPacket('Gi0/0', '10.0.0.2', signed('SECRET', 1, 10));
    const neighbor = engine.getInterface('Gi0/0')!.neighbors.get('2.2.2.2')!;
    expect(neighbor.authSequence).toBe(10);
    engine.processPacket('Gi0/0', '10.0.0.2', signed('SECRET', 1, 9));
    expect(neighbor.authSequence).toBe(10);
    engine.processPacket('Gi0/0', '10.0.0.2', signed('SECRET', 1, 10));
    engine.processPacket('Gi0/0', '10.0.0.2', signed('SECRET', 1, 11));
    expect(neighbor.authSequence).toBe(11);
  });
});
