/**
 * Timers EIGRP — RFC 7868 §5.3.1 (Neighbor Discovery/Recovery) et
 * §5.3.6 (Goodbye).
 *
 * Le moteur n'avait aucun timer : la liveness d'un voisin était décidée
 * par un compteur de tours de convergence, donc un voisin muet n'était
 * déclaré down que si quelqu'un tapait une commande. Un vrai routeur
 * émet un Hello toutes les 5 s et abandonne un voisin quand le hold
 * time que CE voisin a annoncé s'écoule sans nouvelle.
 *
 * Horloge virtuelle partout : ces tests mesurent du temps, pas des
 * appels.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { EIGRPEngine } from '@/network/eigrp/EIGRPEngine';
import {
  EIGRP_MULTICAST_IP, EIGRP_DEFAULT_HELLO_SEC, EIGRP_DEFAULT_HOLD_SEC,
  type EigrpPacket,
} from '@/network/eigrp/packets';
import type { ConnectedNetwork } from '@/network/routing/RoutingPeerLocator';
import { VirtualTimeScheduler } from '@/events/Scheduler';
import { IPAddress, SubnetMask, resetCounters } from '@/network/core/types';

beforeEach(() => resetCounters());

interface Sent { iface: string; destIp: string; packet: EigrpPacket }

/** Un moteur seul, dont on observe ce qui sort du fil. */
function rig(ifaces: Array<{ iface: string; ip: string }>) {
  const clock = new VirtualTimeScheduler();
  const sent: Sent[] = [];
  const eng = new EIGRPEngine('R1');
  eng.setScheduler(clock);
  eng.setDeviceContext({
    connectedNetworks: (): ConnectedNetwork[] => ifaces.map((i) => ({
      network: new IPAddress(i.ip.replace(/\.\d+$/, '.0')),
      mask: SubnetMask.fromCIDR(24),
      iface: i.iface,
      localIp: new IPAddress(i.ip),
    })),
    ribRoutes: () => [],
  });
  eng.setWire({
    send: (iface, destIp, packet) => { sent.push({ iface, destIp, packet }); },
  });
  return { clock, sent, eng };
}

const hellos = (sent: Sent[], iface?: string) =>
  sent.filter((s) => s.packet.opcode === 'hello'
    && (iface === undefined || s.iface === iface));

describe('timer Hello (RFC 7868 §5.3.1)', () => {
  it('émet un Hello multicast toutes les 5 s, sans que personne ne le demande', () => {
    const { clock, sent, eng } = rig([{ iface: 'Gi0/0', ip: '10.0.0.1' }]);
    eng.enable({ asn: 100, networks: [{ network: '10.0.0.0' }] });
    sent.length = 0;

    clock.advance(EIGRP_DEFAULT_HELLO_SEC * 1000);
    expect(hellos(sent)).toHaveLength(1);
    expect(sent[0].destIp).toBe(EIGRP_MULTICAST_IP);

    clock.advance(EIGRP_DEFAULT_HELLO_SEC * 1000 * 3);
    expect(hellos(sent)).toHaveLength(4);
  });

  it("annonce dans son Hello le hold time de l'interface", () => {
    const { clock, sent, eng } = rig([{ iface: 'Gi0/0', ip: '10.0.0.1' }]);
    eng.enable({ asn: 100, networks: [{ network: '10.0.0.0' }] });
    sent.length = 0;
    clock.advance(EIGRP_DEFAULT_HELLO_SEC * 1000);
    expect((hellos(sent)[0].packet as { holdTimeSec: number }).holdTimeSec)
      .toBe(EIGRP_DEFAULT_HOLD_SEC);
  });

  it('`ip hello-interval eigrp` change réellement la cadence', () => {
    const { clock, sent, eng } = rig([{ iface: 'Gi0/0', ip: '10.0.0.1' }]);
    eng.enable({ asn: 100, networks: [{ network: '10.0.0.0' }] });
    eng.setInterfaceTiming('Gi0/0', { helloSec: 1 });
    sent.length = 0;
    clock.advance(3000);
    expect(hellos(sent)).toHaveLength(3);
  });

  it('`ip hold-time eigrp` est indépendant du Hello, comme sur IOS', () => {
    const { eng } = rig([{ iface: 'Gi0/0', ip: '10.0.0.1' }]);
    eng.enable({ asn: 100, networks: [{ network: '10.0.0.0' }] });
    eng.setInterfaceTiming('Gi0/0', { helloSec: 20 });
    // Monter le Hello ne monte PAS le hold : c'est exactement ainsi
    // qu'une mauvaise configuration casse une adjacence.
    expect(eng.getInterfaceTiming('Gi0/0'))
      .toEqual({ helloSec: 20, holdSec: EIGRP_DEFAULT_HOLD_SEC });
    eng.setInterfaceTiming('Gi0/0', { holdSec: 60 });
    expect(eng.getInterfaceTiming('Gi0/0')).toEqual({ helloSec: 20, holdSec: 60 });
  });

  it("n'émet plus rien une fois le protocole désactivé", () => {
    const { clock, sent, eng } = rig([{ iface: 'Gi0/0', ip: '10.0.0.1' }]);
    eng.enable({ asn: 100, networks: [{ network: '10.0.0.0' }] });
    eng.disable();
    sent.length = 0;
    clock.advance(EIGRP_DEFAULT_HELLO_SEC * 1000 * 5);
    expect(sent).toHaveLength(0);
  });
});

describe('hold timer par voisin (RFC 7868 §5.3.1)', () => {
  /** Injecte un Hello venu de `srcIp` avec le hold time annoncé. */
  function heardFrom(eng: EIGRPEngine, srcIp: string, holdTimeSec: number) {
    eng.processPacket('Gi0/0', srcIp, {
      type: 'eigrp', opcode: 'hello', asn: 100,
      kValues: { k1: 1, k2: 0, k3: 1, k4: 0, k5: 0 },
      holdTimeSec,
    } as EigrpPacket, false);
  }

  it('abandonne un voisin devenu muet, sans aucune commande', () => {
    const { clock, eng } = rig([{ iface: 'Gi0/0', ip: '10.0.0.1' }]);
    eng.enable({ asn: 100, networks: [{ network: '10.0.0.0' }] });
    heardFrom(eng, '10.0.0.2', EIGRP_DEFAULT_HOLD_SEC);
    expect(eng.getNeighbors()).toHaveLength(1);

    clock.advance((EIGRP_DEFAULT_HOLD_SEC - 1) * 1000);
    expect(eng.getNeighbors()).toHaveLength(1);
    clock.advance(2000);
    expect(eng.getNeighbors()).toHaveLength(0);
  });

  it("utilise le hold time annoncé par le voisin, pas le sien", () => {
    const { clock, eng } = rig([{ iface: 'Gi0/0', ip: '10.0.0.1' }]);
    eng.enable({ asn: 100, networks: [{ network: '10.0.0.0' }] });
    // Le voisin annonce 60 s alors que notre défaut est 15 s.
    heardFrom(eng, '10.0.0.2', 60);
    clock.advance(30_000);
    expect(eng.getNeighbors()).toHaveLength(1);   // 15 s ne suffisent pas
    clock.advance(31_000);
    expect(eng.getNeighbors()).toHaveLength(0);
  });

  it('chaque paquet reçu réarme le timer : un voisin bavard ne meurt jamais', () => {
    const { clock, eng } = rig([{ iface: 'Gi0/0', ip: '10.0.0.1' }]);
    eng.enable({ asn: 100, networks: [{ network: '10.0.0.0' }] });
    heardFrom(eng, '10.0.0.2', EIGRP_DEFAULT_HOLD_SEC);
    for (let i = 0; i < 10; i++) {
      clock.advance(EIGRP_DEFAULT_HELLO_SEC * 1000);
      heardFrom(eng, '10.0.0.2', EIGRP_DEFAULT_HOLD_SEC);
    }
    expect(eng.getNeighbors()).toHaveLength(1);
  });

  it("converger ne prouve rien : ça ne tue pas un voisin vivant", () => {
    const { eng } = rig([{ iface: 'Gi0/0', ip: '10.0.0.1' }]);
    eng.enable({ asn: 100, networks: [{ network: '10.0.0.0' }] });
    heardFrom(eng, '10.0.0.2', EIGRP_DEFAULT_HOLD_SEC);
    // L'ancienne règle par compteur de tours le déclarait down ici.
    eng.converge();
    eng.converge();
    eng.converge();
    expect(eng.getNeighbors()).toHaveLength(1);
  });
});

describe('descentes immédiates — sans attendre le hold time', () => {
  function heardFrom(eng: EIGRPEngine, iface: string, srcIp: string, hold = EIGRP_DEFAULT_HOLD_SEC) {
    eng.processPacket(iface, srcIp, {
      type: 'eigrp', opcode: 'hello', asn: 100,
      kValues: { k1: 1, k2: 0, k3: 1, k4: 0, k5: 0 },
      holdTimeSec: hold,
    } as EigrpPacket, false);
  }

  it("une interface qui tombe descend ses voisins tout de suite", () => {
    const { eng } = rig([
      { iface: 'Gi0/0', ip: '10.0.0.1' },
      { iface: 'Gi0/1', ip: '10.0.1.1' },
    ]);
    eng.enable({ asn: 100, networks: [{ network: '10.0.0.0' }, { network: '10.0.1.0' }] });
    heardFrom(eng, 'Gi0/0', '10.0.0.2');
    heardFrom(eng, 'Gi0/1', '10.0.1.2');
    expect(eng.getNeighbors()).toHaveLength(2);

    eng.onInterfaceDown('Gi0/0');
    // Seul le voisin de l'interface morte part ; l'autre est intact.
    expect(eng.getNeighbors().map((n) => n.address)).toEqual(['10.0.1.2']);
  });

  it('un Goodbye (hold time 0) descend le voisin sur-le-champ (§5.3.6)', () => {
    const { eng } = rig([{ iface: 'Gi0/0', ip: '10.0.0.1' }]);
    eng.enable({ asn: 100, networks: [{ network: '10.0.0.0' }] });
    heardFrom(eng, 'Gi0/0', '10.0.0.2');
    expect(eng.getNeighbors()).toHaveLength(1);
    heardFrom(eng, 'Gi0/0', '10.0.0.2', 0);
    expect(eng.getNeighbors()).toHaveLength(0);
  });

  it("quitter l'AS émet un Goodbye plutôt que de laisser les voisins attendre", () => {
    const { sent, eng } = rig([{ iface: 'Gi0/0', ip: '10.0.0.1' }]);
    eng.enable({ asn: 100, networks: [{ network: '10.0.0.0' }] });
    sent.length = 0;
    eng.disable();
    const goodbye = sent.find((s) => s.packet.opcode === 'hello'
      && (s.packet as { holdTimeSec: number }).holdTimeSec === 0);
    expect(goodbye).toBeDefined();
    expect(goodbye!.destIp).toBe(EIGRP_MULTICAST_IP);
  });
});
