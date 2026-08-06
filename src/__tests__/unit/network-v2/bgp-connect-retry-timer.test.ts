/**
 * ConnectRetryTimer BGP — RFC 4271 §8.2.2 et §10.
 *
 * La FSM BGP a une horloge de reprise à elle : tant que le
 * ConnectRetryTimer court, un voisin dont la connexion de transport a
 * échoué reste en Active et n'est PAS recomposé. Rien d'autre ne cadence
 * ces tentatives.
 *
 * Le moteur n'en avait pas : `manageSessions()` composait chaque voisin
 * non appairé à chaque convergence. Comme une convergence a lieu à
 * chaque commande de configuration, chaque `show` et chaque évènement de
 * lien, un voisin injoignable était recomposé sans limite — c'est ce qui
 * a fini par noyer un routeur puis figer l'onglet du navigateur.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { BGPEngine, type BgpPeerLink } from '@/network/bgp/BGPEngine';
import { BGP_DEFAULT_CONNECT_RETRY_SEC } from '@/network/bgp/messages';
import { VirtualTimeScheduler } from '@/events/Scheduler';
import { IPAddress, SubnetMask, resetCounters } from '@/network/core/types';

beforeEach(() => resetCounters());

function ctx(network: string) {
  return {
    connectedNetworks: () => [{
      network: new IPAddress(network),
      mask: SubnetMask.fromCIDR(24),
      iface: 'Gi0/0',
      localIp: new IPAddress(network.replace(/\.0$/, '.1')),
    }],
    ribRoutes: () => [],
  };
}

/**
 * Un moteur dont le transport échoue toujours, et qui compte les
 * tentatives — c'est le voisin configuré mais injoignable.
 */
function unreachablePeer(connectRetrySec?: number) {
  const clock = new VirtualTimeScheduler();
  const eng = new BGPEngine('R1');
  let dials = 0;
  eng.setScheduler(clock);
  eng.setDeviceContext(ctx('192.168.1.0'));
  eng.setWire({
    connect: (): BgpPeerLink | null => { dials++; return null; },
  });
  eng.enable({ asn: 65001 });
  if (connectRetrySec !== undefined) eng.setConnectRetrySec(connectRetrySec);
  eng.getConfig().neighbors.set('10.0.0.2',
    { ip: '10.0.0.2', remoteAs: 65002, activated: true });
  return { clock, eng, dials: () => dials };
}

describe('ConnectRetryTimer — cadence des tentatives (§8.2.2)', () => {
  it('une convergence de plus ne recompose pas : seul le timer le fait', () => {
    const { clock, eng, dials } = unreachablePeer();
    eng.converge();
    expect(dials()).toBe(1);

    // Cinquante convergences — chaque `show`, chaque commande — ne
    // doivent produire aucune tentative supplémentaire.
    for (let i = 0; i < 50; i++) eng.converge();
    expect(dials()).toBe(1);

    // Le temps, lui, en produit une.
    clock.advance(BGP_DEFAULT_CONNECT_RETRY_SEC * 1000);
    expect(dials()).toBe(2);
  });

  it('réessaie à intervalle régulier, sans commande', () => {
    const { clock, eng, dials } = unreachablePeer();
    eng.converge();
    for (let i = 1; i <= 4; i++) {
      clock.advance(BGP_DEFAULT_CONNECT_RETRY_SEC * 1000);
      expect(dials()).toBe(1 + i);
    }
  });

  it('ne réessaie pas avant terme', () => {
    const { clock, eng, dials } = unreachablePeer();
    eng.converge();
    clock.advance((BGP_DEFAULT_CONNECT_RETRY_SEC - 1) * 1000);
    expect(dials()).toBe(1);
    clock.advance(2000);
    expect(dials()).toBe(2);
  });

  it('le défaut est bien 120 s (§10 BGP Timers)', () => {
    const { eng } = unreachablePeer();
    expect(eng.getConnectRetrySec()).toBe(BGP_DEFAULT_CONNECT_RETRY_SEC);
    expect(BGP_DEFAULT_CONNECT_RETRY_SEC).toBe(120);
  });

  it('`timers connect-retry` change réellement la cadence', () => {
    const { clock, eng, dials } = unreachablePeer(10);
    eng.converge();
    expect(dials()).toBe(1);
    clock.advance(10_000);
    expect(dials()).toBe(2);
    clock.advance(10_000);
    expect(dials()).toBe(3);
  });

  it('compte les tentatives échouées (ConnectRetryCounter)', () => {
    const { clock, eng } = unreachablePeer(10);
    eng.converge();
    expect(eng.getConnectRetryCounter('10.0.0.2')).toBe(1);
    clock.advance(10_000);
    clock.advance(10_000);
    expect(eng.getConnectRetryCounter('10.0.0.2')).toBe(3);
  });

  it('oublie le voisin retiré de la configuration', () => {
    const { clock, eng, dials } = unreachablePeer(10);
    eng.converge();
    eng.getConfig().neighbors.delete('10.0.0.2');
    eng.converge();
    const before = dials();
    clock.advance(60_000);
    expect(dials()).toBe(before);
    expect(eng.getConnectRetryCounter('10.0.0.2')).toBe(0);
  });

  it("n'arme plus rien une fois BGP désactivé", () => {
    const { clock, eng, dials } = unreachablePeer(10);
    eng.converge();
    eng.disable();
    const before = dials();
    clock.advance(60_000);
    expect(dials()).toBe(before);
  });
});

describe("l'état du voisin reste celui de la FSM", () => {
  it('injoignable (aucun transport) ⇒ Idle, et le reste entre deux essais', () => {
    const { clock, eng } = unreachablePeer(10);
    eng.converge();
    expect(eng.getNeighbors()[0].state).toBe('Idle');
    clock.advance(10_000);
    eng.converge();
    expect(eng.getNeighbors()[0].state).toBe('Idle');
  });

  it('joignable mais peering refusé ⇒ Active, et le reste entre deux essais', () => {
    // Le transport aboutit, puis le pair coupe : c'est le voisin câblé
    // qui n'a pas de `neighbor` en retour. La FSM retombe en Active.
    const clock = new VirtualTimeScheduler();
    const eng = new BGPEngine('R1');
    let dials = 0;
    eng.setScheduler(clock);
    eng.setDeviceContext(ctx('192.168.1.0'));
    eng.setWire({
      connect: (neighborIp): BgpPeerLink => {
        dials++;
        let closed: (() => void) | null = null;
        return {
          neighborIp, localIp: '10.0.0.1', localIface: 'Gi0/0',
          transport: {
            send: () => { closed?.(); },     // le pair refuse l'OPEN
            close: () => {},
            onMessage: () => {},
            onClose: (cb: () => void) => { closed = cb; },
          },
        };
      },
    });
    eng.enable({ asn: 65001 });
    eng.setConnectRetrySec(10);
    eng.getConfig().neighbors.set('10.0.0.2',
      { ip: '10.0.0.2', remoteAs: 65002, activated: true });

    eng.converge();
    expect(eng.getNeighbors()[0].state).toBe('Active');
    // Une convergence de plus ne doit ni rebasculer l'état ni recomposer.
    eng.converge();
    eng.converge();
    expect(eng.getNeighbors()[0].state).toBe('Active');
    expect(dials).toBe(1);
    // Le timer, lui, reprend la main.
    clock.advance(10_000);
    expect(dials).toBe(2);
  });
});
