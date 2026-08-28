/**
 * OSPFv3 travels the wire.
 *
 * Starting measurement: OSPFv3 was the ONLY protocol here forming state
 * without a single packet. `v3FormAdjacency` built a Hello and called
 * `processHello` on the NEIGHBOUR's engine, after comparing the two
 * configurations by a topology walk — an adjacency real to the FSM and
 * fictional to the network.
 *
 * Three links were missing, none of them inside OSPF: `enableOSPFv3`
 * never called `setSendCallback`, `IPv6DataPlane.processPacket` knew
 * neither ff02::5 nor ff02::6, and nothing dispatched next header 89.
 *
 * What this file checks is not that the adjacency forms — it already
 * did — but that it forms THROUGH THE WIRE.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { Cable } from '@/network/hardware/Cable';
import { IPv6Packet } from '@/network/core/types';

const IP_PROTO_OSPF = 89;

interface V3Frame {
  deviceId: string;
  portName: string;
  dstMAC: string;
  destinationIP: string;
  sourceIP: string;
  hopLimit: number;
  packetType: number;
}

/** What was ACTUALLY sent, read off each device's own bus rather than the engine. */
function observeWire(...devices: CiscoRouter[]): { sent: V3Frame[]; receivedFrames: V3Frame[] } {
  const sent: V3Frame[] = [];
  const receivedFrames: V3Frame[] = [];

  const lire = (e: { payload: unknown }, dans: V3Frame[]): void => {
    const p = e.payload as {
      deviceId: string; portName: string;
      frame: { dstMAC: { toString(): string }; payload: unknown };
    };
    const ip = p.frame?.payload as IPv6Packet | undefined;
    if (!ip || ip.type !== 'ipv6' || ip.nextHeader !== IP_PROTO_OSPF) return;
    const ospf = ip.payload as { packetType?: number };
    dans.push({
      deviceId: p.deviceId,
      portName: p.portName,
      dstMAC: p.frame.dstMAC.toString(),
      destinationIP: ip.destinationIP.toString(),
      sourceIP: ip.sourceIP.toString(),
      hopLimit: ip.hopLimit,
      packetType: ospf?.packetType ?? -1,
    });
  };

  for (const device of devices) {
    const bus = device.getBus();
    bus.subscribe('port.frame.tx-requested', (e) => lire(e, sent));
    bus.subscribe('port.frame.received', (e) => lire(e, receivedFrames));
  }
  return { sent, receivedFrames };
}

async function setUpOspfv3(
  r: CiscoRouter, routerId: string, ipv6: string,
  options: { passive?: boolean; hello?: number; ipsec?: boolean } = {},
): Promise<void> {
  await r.executeCommand('enable');
  await r.executeCommand('configure terminal');
  await r.executeCommand('ipv6 unicast-routing');
  await r.executeCommand('interface GigabitEthernet0/0');
  await r.executeCommand(`ipv6 address ${ipv6}/64`);
  await r.executeCommand('no shutdown');
  if (options.hello) await r.executeCommand(`ipv6 ospf hello-interval ${options.hello}`);
  if (options.ipsec) {
    await r.executeCommand('ipv6 ospf authentication ipsec spi 500 md5 0123456789abcdef0123456789abcdef');
  }
  await r.executeCommand('exit');
  await r.executeCommand('ipv6 router ospf 1');
  await r.executeCommand(`router-id ${routerId}`);
  if (options.passive) await r.executeCommand('passive-interface GigabitEthernet0/0');
  await r.executeCommand('exit');
  await r.executeCommand('interface GigabitEthernet0/0');
  await r.executeCommand('ipv6 ospf 1 area 0');
  await r.executeCommand('end');
}

async function twoRouterLab(
  options: { passiveSurR2?: boolean; ipsecSurR1?: boolean } = {},
): Promise<{ r1: CiscoRouter; r2: CiscoRouter; wire: ReturnType<typeof observeWire> }> {
  const r1 = new CiscoRouter('R1');
  const r2 = new CiscoRouter('R2');
  await setUpOspfv3(r1, '1.1.1.1', '2001:db8:12::1', { ipsec: options.ipsecSurR1 });
  await setUpOspfv3(r2, '1.1.1.2', '2001:db8:12::2', { passive: options.passiveSurR2 });
  new Cable('c12').connect(r1.getPort('GigabitEthernet0/0')!, r2.getPort('GigabitEthernet0/0')!);
  // Observation starts AFTER cabling: what is counted is what the
  // convergence triggered by the next command produces.
  const wire = observeWire(r1, r2);
  await r1.executeCommand('show ipv6 ospf neighbor');
  return { r1, r2, wire };
}

function neighbours(r: CiscoRouter): string[] {
  const eng = r._getOSPFv3EngineInternal();
  if (!eng) return [];
  return eng.getNeighbors().map((n) => n.routerId);
}

beforeEach(() => {
  // The shared resets come from setupGlobalState.ts.
});

describe('an OSPFv3 Hello really travels', () => {
  it('packets leave, and others arrive', async () => {
    const { wire } = await twoRouterLab();
    expect(wire.sent.length).toBeGreaterThan(0);
    expect(wire.receivedFrames.length).toBeGreaterThan(0);
  });

  it('both routers send, and each receives from the other', async () => {
    const { wire } = await twoRouterLab();
    const emetteurs = new Set(wire.sent.map((t) => t.deviceId));
    const recepteurs = new Set(wire.receivedFrames.map((t) => t.deviceId));
    expect(emetteurs.size).toBe(2);
    expect(recepteurs.size).toBe(2);
  });

  it('the adjacency reaches Full, and the packet made it', async () => {
    const { r1, r2 } = await twoRouterLab();
    expect(neighbours(r1)).toContain('1.1.1.2');
    expect(neighbours(r2)).toContain('1.1.1.1');
  });
});

describe('what the packet carries is what the RFC says', () => {
  it('the destination is ff02::5 (RFC 5340 appendix A.1)', async () => {
    const { wire } = await twoRouterLab();
    // `every` on an empty array is true: without this line the case
    // would pass with no packet sent at all.
    expect(wire.sent.length).toBeGreaterThan(0);
    expect(wire.sent.every((t) => t.destinationIP === 'ff02::5')).toBe(true);
  });

  it('the Ethernet destination is 33:33:00:00:00:05 (RFC 2464 section 7)', async () => {
    const { wire } = await twoRouterLab();
    const macs = new Set(wire.sent.map((t) => t.dstMAC.toLowerCase()));
    expect([...macs]).toEqual(['33:33:00:00:00:05']);
  });

  it('the hop limit is 1: this packet does not leave the link', async () => {
    const { wire } = await twoRouterLab();
    // `every` on an empty array is true: without this line the case
    // would pass with no packet sent at all.
    expect(wire.sent.length).toBeGreaterThan(0);
    expect(wire.sent.every((t) => t.hopLimit === 1)).toBe(true);
  });

  it('the source is the link-local address (RFC 5340 section 2.5)', async () => {
    const { wire } = await twoRouterLab();
    expect(wire.sent.length).toBeGreaterThan(0);
    expect(wire.sent.every((t) => t.sourceIP.startsWith('fe80'))).toBe(true);
  });

  it('these are Hellos, so packet type 1', async () => {
    const { wire } = await twoRouterLab();
    // `every` on an empty array is true: without this line the case
    // would pass with no packet sent at all.
    expect(wire.sent.length).toBeGreaterThan(0);
    expect(wire.sent.every((t) => t.packetType === 1)).toBe(true);
  });
});

describe('what stops a packet stops the adjacency', () => {
  it('a passive interface sends nothing and is seen by nobody', async () => {
    const { r1, r2, wire } = await twoRouterLab({ passiveSurR2: true });
    const emetteurs = new Set(wire.sent.map((t) => t.deviceId));
    expect(emetteurs.has(r2.getId())).toBe(false);
    // R1 still sends; R2 is the silent one, so R1 stays without a neighbour.
    expect(neighbours(r1)).not.toContain('1.1.1.2');
  });

  it('a Hello protected by IPsec on one side only is not acceptable', async () => {
    // RFC 4552 §3: without a matching security association the packet is
    // dropped before reaching OSPF. The packets DO leave — reception is
    // what refuses, not sending.
    const { r1, r2, wire } = await twoRouterLab({ ipsecSurR1: true });
    expect(wire.sent.length).toBeGreaterThan(0);
    expect(neighbours(r1)).not.toContain('1.1.1.2');
    expect(neighbours(r2)).not.toContain('1.1.1.1');
  });

  it('a passive interface ACCEPTS no more than it sends', async () => {
    // The rule cuts both ways (IOS behaviour, already written in the v2
    // engine). It was missing from v3 and invisible while nothing
    // arrived on the wire.
    const r1 = new CiscoRouter('R1');
    const r2 = new CiscoRouter('R2');
    await setUpOspfv3(r1, '1.1.1.1', '2001:db8:12::1', { passive: true });
    await setUpOspfv3(r2, '1.1.1.2', '2001:db8:12::2');
    new Cable('c12').connect(r1.getPort('GigabitEthernet0/0')!, r2.getPort('GigabitEthernet0/0')!);
    const wire = observeWire(r1, r2);
    await r1.executeCommand('show ipv6 ospf neighbor');

    // R2 does send: the Hello ARRIVES on R1's passive interface.
    expect(wire.sent.some((t) => t.deviceId === r2.getId())).toBe(true);
    expect(neighbours(r1)).toEqual([]);
  });

  it('mismatched timers refuse the neighbour, and the Hello is what refusals', async () => {
    // `ipv6 ospf hello-interval` was refused by the CLI for a sound
    // reason: nothing read the value. Now that adjacency forms on real
    // frames, `processHello` reads it and a mismatch really bites.
    const r1 = new CiscoRouter('R1');
    const r2 = new CiscoRouter('R2');
    await setUpOspfv3(r1, '1.1.1.1', '2001:db8:12::1', { hello: 30 });
    await setUpOspfv3(r2, '1.1.1.2', '2001:db8:12::2');
    new Cable('c12').connect(r1.getPort('GigabitEthernet0/0')!, r2.getPort('GigabitEthernet0/0')!);
    const wire = observeWire(r1, r2);
    await r1.executeCommand('show ipv6 ospf neighbor');

    // Both send: RECEPTION is what refuses, not sending.
    expect(new Set(wire.sent.map((t) => t.deviceId)).size).toBe(2);
    expect(neighbours(r1)).toEqual([]);
    expect(neighbours(r2)).toEqual([]);
  });

  it('with no cable, no packet and no neighbour', async () => {
    const r1 = new CiscoRouter('R1');
    const r2 = new CiscoRouter('R2');
    await setUpOspfv3(r1, '1.1.1.1', '2001:db8:12::1');
    await setUpOspfv3(r2, '1.1.1.2', '2001:db8:12::2');
    const wire = observeWire(r1, r2);
    await r1.executeCommand('show ipv6 ospf neighbor');
    expect(wire.sent).toEqual([]);
    expect(neighbours(r1)).toEqual([]);
  });
});

describe('the command that carries the timer', () => {
  it('with no value it is incomplete, with an absurd value it is refused', async () => {
    const r = new CiscoRouter('R1');
    await r.executeCommand('enable');
    await r.executeCommand('configure terminal');
    await r.executeCommand('interface GigabitEthernet0/0');
    expect(await r.executeCommand('ipv6 ospf hello-interval')).toContain('Incomplete');
    // `% Invalid value` n'est pas une phrase d'IOS : c'est le refus que
    // le gestionnaire rendait a la main, faute de plage declaree. La
    // plage vit desormais sur l'argument, donc le refus est celui d'IOS
    // et il MONTRE ou l'on s'est trompe.
    expect(await r.executeCommand('ipv6 ospf hello-interval 0'))
      .toContain('% Invalid input detected');
    expect(await r.executeCommand('ipv6 ospf dead-interval 40')).toBe('');
  });
});

describe('no regression', () => {
  it('OSPFv2 still converges on the same lab', async () => {
    const r1 = new CiscoRouter('R1');
    const r2 = new CiscoRouter('R2');
    for (const [r, ip, rid] of [[r1, '10.0.12.1', '1.1.1.1'], [r2, '10.0.12.2', '1.1.1.2']] as const) {
      await r.executeCommand('enable');
      await r.executeCommand('configure terminal');
      await r.executeCommand('interface GigabitEthernet0/0');
      await r.executeCommand(`ip address ${ip} 255.255.255.0`);
      await r.executeCommand('no shutdown');
      await r.executeCommand('exit');
      await r.executeCommand('router ospf 1');
      await r.executeCommand(`router-id ${rid}`);
      await r.executeCommand('network 10.0.12.0 0.0.0.255 area 0');
      await r.executeCommand('end');
    }
    new Cable('c12').connect(r1.getPort('GigabitEthernet0/0')!, r2.getPort('GigabitEthernet0/0')!);
    const output = await r1.executeCommand('show ip ospf neighbor');
    expect(output).toContain('1.1.1.2');
  });
});
