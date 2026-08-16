/**
 * `FirewallNatEngine` — le NAT de PARE-FEU, distinct de celui du routeur.
 *
 * BRD-Firewall §12.1. La difference n'est pas de degre : le NAT d'un routeur
 * se declenche depuis des regles liees a des interfaces `inside`/`outside`,
 * celui d'un pare-feu depuis une POLITIQUE ORDONNEE avec ses propres
 * criteres — zones, adresses, services. C'est pourquoi l'audit de phase 2 a
 * conclu « primitives partagees, moteur distinct » (A6 du carnet) : les
 * fonctions de reecriture sont desormais en un seul exemplaire dans
 * `src/network/nat/rewrite.ts`, et ce moteur les consomme.
 *
 * Les deux invariants qui font la difference avec le routeur :
 *
 * — I-N1 : la traduction est decidee au PREMIER paquet et MEMORISEE sur la
 *   session. Les suivants la reappliquent sans reevaluer la politique NAT,
 *   ce qui garantit qu'un flux PAT garde le meme port traduit toute sa vie.
 * — I-N2 : le retour applique la traduction INVERSE, lue sur la MEME
 *   session. C'est le defaut exact que `PRD-Port-Forwarding.md` a du
 *   corriger deux fois cote routeur — et que ce modele rend impossible,
 *   puisque la traduction vit sur la session et non sur la regle.
 */

import { describe, it, expect } from 'vitest';
import { FirewallNatEngine } from '@/network/devices/firewall/nat/FirewallNatEngine';
import { NatPolicyStore } from '@/network/devices/firewall/nat/NatPolicyStore';
import { ObjectStore } from '@/network/devices/firewall/model/ObjectStore';
import { hostAddress, subnetAddress } from '@/network/devices/firewall/model/AddressObject';
import { IPAddress, IP_PROTO_TCP, type IPv4Packet, type TCPPacket } from '@/network/core/types';

function objects(): ObjectStore {
  const s = new ObjectStore();
  s.addAddress(subnetAddress('LAN', '192.168.1.0', 24));
  s.addAddress(hostAddress('SRV_WEB', '192.168.50.10'));
  s.addAddress(hostAddress('PUB_WEB', '203.0.113.10'));
  return s;
}

function engine(store = new NatPolicyStore()) {
  return {
    nat: new FirewallNatEngine({
      objects: objects(),
      policy: store,
      interfaceAddress: (iface) => (iface === 'port2' ? '203.0.113.1' : '192.168.1.1'),
    }),
    store,
  };
}

function tcp(src: string, dst: string, sport = 54321, dport = 80): IPv4Packet {
  const segment: TCPPacket = {
    type: 'tcp', sourcePort: sport, destinationPort: dport,
    sequenceNumber: 0, acknowledgementNumber: 0,
    flags: { syn: true, ack: false, fin: false, rst: false, psh: false, urg: false },
    windowSize: 65535, checksum: 0, payload: null,
  } as TCPPacket;
  return {
    type: 'ipv4', version: 4, ihl: 5, tos: 0, totalLength: 60,
    identification: 1, flags: 0, fragmentOffset: 0, ttl: 64,
    protocol: IP_PROTO_TCP, headerChecksum: 0,
    sourceIP: new IPAddress(src), destinationIP: new IPAddress(dst),
    payload: segment,
  } as IPv4Packet;
}

const CTX = {
  ingressZone: 'trust', egressZone: 'untrust',
  ingressInterface: 'port1', egressInterface: 'port2',
};

function srcPortOf(p: IPv4Packet): number { return (p.payload as TCPPacket).sourcePort; }
function dstPortOf(p: IPv4Packet): number { return (p.payload as TCPPacket).destinationPort; }

describe('FirewallNatEngine — NAT source vers l\'adresse d\'interface', () => {
  function withPat() {
    const { nat, store } = engine();
    store.append({
      id: 'S1', type: 'dynamic-pat',
      fromZone: ['trust'], toZone: ['untrust'], originalSource: ['LAN'],
      sourceTranslation: { kind: 'interface-address' },
    });
    return { nat, store };
  }

  it('traduit la source vers l\'adresse de l\'interface de sortie', () => {
    const { nat } = withPat();

    const result = nat.translateOutbound(tcp('192.168.1.10', '203.0.113.5'), CTX);

    expect(result.packet.sourceIP.toString()).toBe('203.0.113.1');
  });

  it('PRESERVE le port source quand il est libre — ce que fait un vrai PAT', () => {
    const { nat } = withPat();

    const result = nat.translateOutbound(tcp('192.168.1.10', '203.0.113.5', 54321), CTX);

    expect(srcPortOf(result.packet)).toBe(54321);
    expect(result.translation?.translatedSourcePort).toBe(54321);
  });

  it('n\'en CHANGE que sur collision — deux flux, deux ports traduits distincts', () => {
    const { nat } = withPat();

    const a = nat.translateOutbound(tcp('192.168.1.10', '203.0.113.5', 40000), CTX);
    const b = nat.translateOutbound(tcp('192.168.1.11', '203.0.113.5', 40000), CTX);

    expect(srcPortOf(a.packet)).toBe(40000);
    expect(srcPortOf(b.packet)).not.toBe(40000);
  });

  it('un port source HORS de la plage PAT ne peut pas etre preserve', () => {
    const { nat } = withPat();

    const result = nat.translateOutbound(tcp('192.168.1.10', '203.0.113.5', 1000), CTX);

    expect(srcPortOf(result.packet)).toBeGreaterThanOrEqual(1024);
  });

  it('la traduction rendue porte toujours le port effectivement retenu', () => {
    const { nat } = withPat();
    nat.translateOutbound(tcp('192.168.1.10', '203.0.113.5', 40000), CTX);

    const collision = nat.translateOutbound(tcp('192.168.1.11', '203.0.113.5', 40000), CTX);

    expect(collision.translation?.translatedSourcePort).toBe(srcPortOf(collision.packet));
  });

  it('ne traduit PAS une source hors du critere', () => {
    const { nat } = withPat();

    const result = nat.translateOutbound(tcp('10.9.9.9', '203.0.113.5'), CTX);

    expect(result.translation).toBeUndefined();
    expect(result.packet.sourceIP.toString()).toBe('10.9.9.9');
  });

  it('ne traduit PAS un flux venant d\'une autre zone', () => {
    const { nat } = withPat();

    const result = nat.translateOutbound(tcp('192.168.1.10', '203.0.113.5'),
      { ...CTX, ingressZone: 'dmz' });

    expect(result.translation).toBeUndefined();
  });

  it('recalcule la somme de controle du segment', () => {
    const { nat } = withPat();

    const result = nat.translateOutbound(tcp('192.168.1.10', '203.0.113.5'), CTX);

    expect((result.packet.payload as TCPPacket).checksum).not.toBe(0);
  });
});

describe('FirewallNatEngine — NAT destination, la publication de serveur', () => {
  function withDnat() {
    const { nat, store } = engine();
    store.append({
      id: 'D1', type: 'static',
      fromZone: ['untrust'], toZone: ['untrust'], originalDestination: ['PUB_WEB'],
      destinationTranslation: { kind: 'static-ip', translatedAddress: '192.168.50.10' },
    });
    return { nat, store };
  }

  it('reecrit la destination vers l\'adresse reelle', () => {
    const { nat } = withDnat();

    const result = nat.translateInbound(tcp('198.51.100.7', '203.0.113.10'),
      { ...CTX, ingressZone: 'untrust', egressZone: 'untrust' });

    expect(result.packet.destinationIP.toString()).toBe('192.168.50.10');
  });

  it('traduit aussi le port quand la regle le demande', () => {
    const { nat, store } = engine();
    store.append({
      id: 'D1', type: 'static',
      fromZone: ['untrust'], toZone: ['untrust'], originalDestination: ['PUB_WEB'],
      destinationTranslation: {
        kind: 'static-ip', translatedAddress: '192.168.50.10', translatedPort: 8080,
      },
    });

    const result = nat.translateInbound(tcp('198.51.100.7', '203.0.113.10', 40000, 443),
      { ...CTX, ingressZone: 'untrust', egressZone: 'untrust' });

    expect(dstPortOf(result.packet)).toBe(8080);
  });

  it('ne touche pas une destination hors du critere', () => {
    const { nat } = withDnat();

    const result = nat.translateInbound(tcp('198.51.100.7', '203.0.113.99'),
      { ...CTX, ingressZone: 'untrust', egressZone: 'untrust' });

    expect(result.translation).toBeUndefined();
  });
});

describe('FirewallNatEngine — I-N1 et I-N2, la traduction vit sur la session', () => {
  function patEngine() {
    const { nat, store } = engine();
    store.append({
      id: 'S1', type: 'dynamic-pat',
      fromZone: ['trust'], toZone: ['untrust'], originalSource: ['LAN'],
      sourceTranslation: { kind: 'interface-address' },
    });
    return nat;
  }

  it('I-N1 : la traduction decidee est rendue pour etre memorisee', () => {
    const nat = patEngine();

    const result = nat.translateOutbound(tcp('192.168.1.10', '203.0.113.5', 54321), CTX);

    expect(result.translation).toBeDefined();
    expect(result.translation?.originalSource).toBe('192.168.1.10');
    expect(result.translation?.originalSourcePort).toBe(54321);
    expect(result.translation?.translatedSource).toBe('203.0.113.1');
  });

  it('I-N1 : reappliquer une traduction memorisee ne consulte PAS la politique', () => {
    const nat = patEngine();
    const first = nat.translateOutbound(tcp('192.168.1.10', '203.0.113.5', 54321), CTX);
    const hits = nat.statistics().rulesEvaluated;

    const again = nat.reapply(tcp('192.168.1.10', '203.0.113.5', 54321), first.translation!, 'c2s');

    expect(nat.statistics().rulesEvaluated).toBe(hits);
    expect(srcPortOf(again)).toBe(first.translation!.translatedSourcePort);
  });

  it('I-N1 : le port traduit reste le MEME sur toute la vie du flux', () => {
    const nat = patEngine();
    const first = nat.translateOutbound(tcp('192.168.1.10', '203.0.113.5', 54321), CTX);

    const a = nat.reapply(tcp('192.168.1.10', '203.0.113.5', 54321), first.translation!, 'c2s');
    const b = nat.reapply(tcp('192.168.1.10', '203.0.113.5', 54321), first.translation!, 'c2s');

    expect(srcPortOf(a)).toBe(srcPortOf(b));
  });

  it('I-N2 : le RETOUR applique la traduction INVERSE', () => {
    const nat = patEngine();
    const first = nat.translateOutbound(tcp('192.168.1.10', '203.0.113.5', 54321), CTX);
    const translated = first.translation!;

    const reply = tcp('203.0.113.5', translated.translatedSource, 80, translated.translatedSourcePort);
    const back = nat.reapply(reply, translated, 's2c');

    expect(back.destinationIP.toString()).toBe('192.168.1.10');
    expect(dstPortOf(back)).toBe(54321);
  });

  it('I-N2 : le retour d\'une publication retrouve l\'adresse publique en SOURCE', () => {
    const { nat, store } = engine();
    store.append({
      id: 'D1', type: 'static',
      fromZone: ['untrust'], toZone: ['untrust'], originalDestination: ['PUB_WEB'],
      destinationTranslation: { kind: 'static-ip', translatedAddress: '192.168.50.10' },
    });
    const forward = nat.translateInbound(tcp('198.51.100.7', '203.0.113.10'),
      { ...CTX, ingressZone: 'untrust', egressZone: 'untrust' });

    const reply = tcp('192.168.50.10', '198.51.100.7', 80, 54321);
    const back = nat.reapply(reply, forward.translation!, 's2c');

    expect(back.sourceIP.toString()).toBe('203.0.113.10');
  });
});

describe('FirewallNatEngine — politique ordonnee', () => {
  it('premiere correspondance gagnante', () => {
    const { nat, store } = engine();
    store.append({
      id: 'S1', type: 'dynamic-pat', fromZone: ['trust'], toZone: ['untrust'],
      originalSource: ['LAN'], sourceTranslation: { kind: 'interface-address' },
    });
    store.append({
      id: 'S2', type: 'dynamic-pat', fromZone: ['trust'], toZone: ['untrust'],
      originalSource: ['LAN'],
      sourceTranslation: { kind: 'static-ip', translatedAddress: ['198.51.100.1'] },
    });

    const result = nat.translateOutbound(tcp('192.168.1.10', '203.0.113.5'), CTX);

    expect(result.packet.sourceIP.toString()).toBe('203.0.113.1');
    expect(result.matchedRuleId).toBe('S1');
  });

  it('une regle `no-nat` EXEMPTE, et son ordre compte', () => {
    const { nat, store } = engine();
    store.append({
      id: 'X1', type: 'no-nat', fromZone: ['trust'], toZone: ['untrust'],
      originalSource: ['LAN'], originalDestination: ['SRV_WEB'], noTranslation: true,
    });
    store.append({
      id: 'S1', type: 'dynamic-pat', fromZone: ['trust'], toZone: ['untrust'],
      originalSource: ['LAN'], sourceTranslation: { kind: 'interface-address' },
    });

    const exempte = nat.translateOutbound(tcp('192.168.1.10', '192.168.50.10'), CTX);
    const traduit = nat.translateOutbound(tcp('192.168.1.10', '203.0.113.5'), CTX);

    expect(exempte.packet.sourceIP.toString()).toBe('192.168.1.10');
    expect(exempte.translation).toBeUndefined();
    expect(traduit.packet.sourceIP.toString()).toBe('203.0.113.1');
  });

  it('une politique VIDE ne traduit rien — et ne refuse rien', () => {
    const { nat } = engine();

    const result = nat.translateOutbound(tcp('192.168.1.10', '203.0.113.5'), CTX);

    expect(result.translation).toBeUndefined();
    expect(result.packet.sourceIP.toString()).toBe('192.168.1.10');
  });

  it('une regle desactivee est sautee', () => {
    const { nat, store } = engine();
    store.append({
      id: 'S1', type: 'dynamic-pat', fromZone: ['trust'], toZone: ['untrust'],
      originalSource: ['LAN'], sourceTranslation: { kind: 'interface-address' },
      enabled: false,
    });

    expect(nat.translateOutbound(tcp('192.168.1.10', '203.0.113.5'), CTX).translation)
      .toBeUndefined();
  });

  it('compte les correspondances par regle', () => {
    const { nat, store } = engine();
    store.append({
      id: 'S1', type: 'dynamic-pat', fromZone: ['trust'], toZone: ['untrust'],
      originalSource: ['LAN'], sourceTranslation: { kind: 'interface-address' },
    });

    nat.translateOutbound(tcp('192.168.1.10', '203.0.113.5', 40000), CTX);
    nat.translateOutbound(tcp('192.168.1.11', '203.0.113.5', 40001), CTX);

    expect(store.byId('S1')?.hitCount).toBe(2);
  });
});

describe('FirewallNatEngine — epuisement du pool de ports', () => {
  it('refuse une nouvelle traduction quand plus aucun port n\'est libre', () => {
    const store = new NatPolicyStore();
    const nat = new FirewallNatEngine({
      objects: objects(), policy: store,
      interfaceAddress: () => '203.0.113.1',
      portRange: { from: 40000, to: 40001 },
    });
    store.append({
      id: 'S1', type: 'dynamic-pat', fromZone: ['trust'], toZone: ['untrust'],
      originalSource: ['LAN'], sourceTranslation: { kind: 'interface-address' },
    });

    nat.translateOutbound(tcp('192.168.1.10', '203.0.113.5', 40000), CTX);
    nat.translateOutbound(tcp('192.168.1.11', '203.0.113.5', 40001), CTX);
    const third = nat.translateOutbound(tcp('192.168.1.12', '203.0.113.5', 1002), CTX);

    expect(third.translation).toBeUndefined();
    expect(third.failure).toBe('nat-port-exhausted');
  });

  it('l\'epuisement est un motif DISTINCT de « aucune regle »', () => {
    const { nat } = engine();

    const aucuneRegle = nat.translateOutbound(tcp('192.168.1.10', '203.0.113.5'), CTX);

    expect(aucuneRegle.failure).toBeUndefined();
  });

  it('liberer une traduction rend son port disponible', () => {
    const store = new NatPolicyStore();
    const nat = new FirewallNatEngine({
      objects: objects(), policy: store,
      interfaceAddress: () => '203.0.113.1',
      portRange: { from: 40000, to: 40000 },
    });
    store.append({
      id: 'S1', type: 'dynamic-pat', fromZone: ['trust'], toZone: ['untrust'],
      originalSource: ['LAN'], sourceTranslation: { kind: 'interface-address' },
    });
    const first = nat.translateOutbound(tcp('192.168.1.10', '203.0.113.5', 1000), CTX);

    nat.release(first.translation!);

    expect(nat.translateOutbound(tcp('192.168.1.11', '203.0.113.5', 1001), CTX).translation)
      .toBeDefined();
  });
});
