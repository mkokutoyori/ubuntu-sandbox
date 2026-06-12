// RFC 2328 §8.2 — OSPF auth validated at ingress, stamped at egress (entrée 13).

import { describe, it, expect, beforeEach } from 'vitest';
import { OSPFEngine } from '@/network/ospf/OSPFEngine';
import type { OSPFHelloPacket } from '@/network/ospf/types';
import { resetCounters } from '@/network/core/types';

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

function makeEngine(authType: number, authKey?: string): OSPFEngine {
  const engine = new OSPFEngine(1);
  engine.setRouterId('1.1.1.1');
  engine.activateInterface('Gi0/0', '10.0.0.1', '255.255.255.0', '0.0.0.0', {});
  const iface = engine.getInterface('Gi0/0')!;
  iface.authType = authType;
  iface.authKey = authKey;
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

  it('stamps outgoing packets with the interface auth fields at egress', () => {
    const engine = makeEngine(2, 'MD5KEY');
    const sent: Array<{ packet: { authType?: number; authKey?: string } }> = [];
    engine.setSendCallback((_iface, packet) => { sent.push({ packet }); });
    engine.sendHelloOnInterface('Gi0/0');
    expect(sent.length).toBeGreaterThan(0);
    expect(sent[0].packet.authType).toBe(2);
    expect(sent[0].packet.authKey).toBe('MD5KEY');
  });
});
