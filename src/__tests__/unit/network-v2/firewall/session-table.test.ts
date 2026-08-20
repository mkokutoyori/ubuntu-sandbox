/**
 * `SessionTable` — le coeur du module.
 *
 * BRD-Firewall §10. Tout le reste en depend : c'est l'existence de la
 * session qui autorise le retour (UC-1), c'est elle qui porte la traduction
 * NAT (I-N1), c'est elle que le chemin rapide consulte (UC-4), et c'est
 * elle que `show conn` LIT (P1 — une session est une mesure, pas un
 * affichage).
 *
 * §10.2 — la table est indexee par FLUX DIRECTIONNEL : deux entrees d'index
 * pointent vers un meme objet session. C'est ce qui permet de repondre en
 * un temps constant a « ce paquet appartient-il a un flux connu, et dans
 * quel sens ? ». `LinuxIptablesManager` porte deja cet index mais SANS
 * objet session derriere, d'ou l'impossibilite de rendre une vue sans
 * replier les deux entrees a la lecture.
 *
 * §10.6.1 — l'expiration est un BALAYAGE et non un minuteur par session.
 * Consequence assumee et verifiee : une session expire A OU APRES son
 * echeance, pas a la seconde.
 *
 * §10.3 — l'etat `discard` n'est pas un raffinement. Un flux refuse installe
 * quand meme une session, precisement pour ne pas reevaluer la politique a
 * chaque paquet d'un scan.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { SessionTable } from '@/network/devices/firewall/session/SessionTable';
import { makeFlowKey } from '@/network/devices/firewall/session/FlowKey';
import { IP_PROTO_TCP, IP_PROTO_UDP } from '@/network/core/types';

const C2S = makeFlowKey('192.168.1.10', 54321, '203.0.113.5', 80, IP_PROTO_TCP);
const OTHER = makeFlowKey('192.168.1.11', 40000, '203.0.113.9', 443, IP_PROTO_TCP);
const UDP_FLOW = makeFlowKey('192.168.1.10', 40000, '8.8.8.8', 53, IP_PROTO_UDP);

let clock = 1_000_000;
function now(): number { return clock; }
function advance(ms: number): void { clock += ms; }

function table(): SessionTable {
  return new SessionTable({ now });
}

function install(t: SessionTable, key = C2S) {
  return t.install(key, {
    ingressZone: 'trust', egressZone: 'untrust',
    ingressInterface: 'port1', egressInterface: 'port2',
    timeoutSec: 3600,
  });
}

beforeEach(() => { clock = 1_000_000; });

describe('SessionTable — installation et recherche', () => {
  it('installe une session et la retrouve dans le sens aller', () => {
    const t = table();
    const session = install(t);

    const found = t.lookup(C2S);

    expect(found?.session.id).toBe(session.id);
    expect(found?.direction).toBe('c2s');
  });

  it('UC-1 : le RETOUR est reconnu par l\'existence de la session', () => {
    const t = table();
    const session = install(t);
    const reply = makeFlowKey('203.0.113.5', 80, '192.168.1.10', 54321, IP_PROTO_TCP);

    const found = t.lookup(reply);

    expect(found?.session.id).toBe(session.id);
    expect(found?.direction).toBe('s2c');
  });

  it('les deux entrees d\'index pointent vers le MEME objet session', () => {
    const t = table();
    install(t);
    const reply = makeFlowKey('203.0.113.5', 80, '192.168.1.10', 54321, IP_PROTO_TCP);

    expect(t.lookup(C2S)?.session).toBe(t.lookup(reply)?.session);
  });

  it('ne trouve rien pour un flux inconnu', () => {
    const t = table();
    install(t);

    expect(t.lookup(OTHER)).toBeUndefined();
  });

  it('attribue des identifiants croissants et distincts', () => {
    const t = table();

    const a = install(t, C2S);
    const b = install(t, OTHER);

    expect(b.id).toBeGreaterThan(a.id);
  });

  it('porte les zones et interfaces decidees a l\'installation', () => {
    const t = table();
    const session = install(t);

    expect(session.ingressZone).toBe('trust');
    expect(session.egressZone).toBe('untrust');
    expect(session.ingressInterface).toBe('port1');
    expect(session.egressInterface).toBe('port2');
  });

  it('compte les sessions actives', () => {
    const t = table();
    install(t, C2S);
    install(t, OTHER);

    expect(t.count()).toBe(2);
  });
});

describe('SessionTable — compteurs', () => {
  it('compte paquets et octets PAR DIRECTION', () => {
    const t = table();
    const session = install(t);

    t.recordTraffic(session, 'c2s', 100);
    t.recordTraffic(session, 'c2s', 200);
    t.recordTraffic(session, 's2c', 1500);

    expect(session.counters.packetsC2S).toBe(2);
    expect(session.counters.bytesC2S).toBe(300);
    expect(session.counters.packetsS2C).toBe(1);
    expect(session.counters.bytesS2C).toBe(1500);
  });

  it('demarre a zero dans les deux sens', () => {
    const session = install(table());

    expect(session.counters.packetsC2S).toBe(0);
    expect(session.counters.bytesS2C).toBe(0);
  });
});

describe('SessionTable — expiration par balayage', () => {
  it('une session non touchee expire apres son delai', () => {
    const t = table();
    install(t);

    advance(3601_000);
    const purged = t.sweep();

    expect(purged).toBe(1);
    expect(t.lookup(C2S)).toBeUndefined();
  });

  it('une session touchee AVANT l\'echeance survit', () => {
    const t = table();
    const session = install(t);

    advance(3000_000);
    t.refresh(session);
    advance(3000_000);

    expect(t.sweep()).toBe(0);
    expect(t.lookup(C2S)).toBeDefined();
  });

  it('le balayage ne touche pas une session encore valide', () => {
    const t = table();
    install(t);

    advance(60_000);

    expect(t.sweep()).toBe(0);
    expect(t.count()).toBe(1);
  });

  it('l\'expiration a lieu A OU APRES l\'echeance, jamais avant', () => {
    const t = table();
    install(t);

    advance(3599_000);
    expect(t.sweep()).toBe(0);

    advance(2_000);
    expect(t.sweep()).toBe(1);
  });

  it('le balayage retire les DEUX entrees d\'index', () => {
    const t = table();
    install(t);
    const reply = makeFlowKey('203.0.113.5', 80, '192.168.1.10', 54321, IP_PROTO_TCP);

    advance(3601_000);
    t.sweep();

    expect(t.lookup(C2S)).toBeUndefined();
    expect(t.lookup(reply)).toBeUndefined();
  });

  it('n\'expire que ce qui doit l\'etre', () => {
    const t = table();
    const courte = t.install(UDP_FLOW, {
      ingressZone: 'trust', egressZone: 'untrust',
      ingressInterface: 'port1', egressInterface: 'port2', timeoutSec: 30,
    });
    install(t, C2S);

    advance(31_000);

    expect(t.sweep()).toBe(1);
    expect(t.lookup(C2S)).toBeDefined();
    expect(t.byId(courte.id)).toBeUndefined();
  });
});

describe('SessionTable — etats', () => {
  it('une session installee est active', () => {
    expect(install(table()).state).toBe('active');
  });

  it('§10.3 : un flux refuse installe une session en discard', () => {
    const t = table();

    const session = t.installDiscard(C2S, {
      ingressZone: 'trust', egressZone: 'untrust',
      ingressInterface: 'port1', egressInterface: 'port2', timeoutSec: 5,
    });

    expect(session.state).toBe('discard');
    expect(t.lookup(C2S)?.session.state).toBe('discard');
  });

  it('une session en discard est trouvee — c\'est tout son interet', () => {
    const t = table();
    t.installDiscard(C2S, {
      ingressZone: 'trust', egressZone: 'untrust',
      ingressInterface: 'port1', egressInterface: 'port2', timeoutSec: 5,
    });

    expect(t.lookup(C2S)).toBeDefined();
  });

  it('ferme une session', () => {
    const t = table();
    const session = install(t);

    t.close(session, 'tcp-fin');

    expect(session.state).toBe('closed');
    expect(t.lookup(C2S)).toBeUndefined();
  });
});

describe('SessionTable — purge', () => {
  it('purge tout', () => {
    const t = table();
    install(t, C2S);
    install(t, OTHER);

    expect(t.clear()).toBe(2);
    expect(t.count()).toBe(0);
  });

  it('purge selectivement par adresse source', () => {
    const t = table();
    install(t, C2S);
    install(t, OTHER);

    const removed = t.clearMatching(s => s.c2s.sourceIP === '192.168.1.10');

    expect(removed).toBe(1);
    expect(t.lookup(OTHER)).toBeDefined();
  });

  it('une purge selective qui ne correspond a rien ne retire rien', () => {
    const t = table();
    install(t, C2S);

    expect(t.clearMatching(s => s.c2s.sourceIP === '10.9.9.9')).toBe(0);
    expect(t.count()).toBe(1);
  });
});

describe('SessionTable — limites', () => {
  it('refuse une nouvelle session quand la table est pleine', () => {
    const t = new SessionTable({ now, limits: { maxSessions: 1 } });
    install(t, C2S);

    expect(t.hasRoom()).toBe(false);
    expect(() => install(t, OTHER)).toThrow();
  });

  it('accepte a nouveau apres liberation', () => {
    const t = new SessionTable({ now, limits: { maxSessions: 1 } });
    const session = install(t, C2S);
    t.close(session, 'clear');

    expect(t.hasRoom()).toBe(true);
    expect(() => install(t, OTHER)).not.toThrow();
  });

  it('sans limite declaree, la table accepte', () => {
    const t = table();
    for (let i = 0; i < 50; i++) {
      install(t, makeFlowKey('10.0.0.1', 1000 + i, '10.0.0.2', 80, IP_PROTO_TCP));
    }

    expect(t.hasRoom()).toBe(true);
    expect(t.count()).toBe(50);
  });
});

describe('SessionTable — sessions filles et pinholes', () => {
  it('une session fille porte son parent', () => {
    const t = table();
    const parent = install(t);

    const child = t.installPinhole(UDP_FLOW, {
      ingressZone: 'trust', egressZone: 'untrust',
      ingressInterface: 'port1', egressInterface: 'port2', timeoutSec: 30,
    }, parent.id, 'ftp');

    expect(child.parentSessionId).toBe(parent.id);
    expect(child.isPinhole).toBe(true);
    expect(child.algName).toBe('ftp');
  });

  it('I-S7 : fermer le parent ferme les pinholes non consommes', () => {
    const t = table();
    const parent = install(t);
    const child = t.installPinhole(UDP_FLOW, {
      ingressZone: 'trust', egressZone: 'untrust',
      ingressInterface: 'port1', egressInterface: 'port2', timeoutSec: 30,
    }, parent.id, 'ftp');

    t.close(parent, 'tcp-fin');

    expect(t.byId(child.id)).toBeUndefined();
  });

  it('un pinhole CONSOMME survit a la fermeture de son parent', () => {
    const t = table();
    const parent = install(t);
    const child = t.installPinhole(UDP_FLOW, {
      ingressZone: 'trust', egressZone: 'untrust',
      ingressInterface: 'port1', egressInterface: 'port2', timeoutSec: 30,
    }, parent.id, 'ftp');
    t.consumePinhole(child);

    t.close(parent, 'tcp-fin');

    expect(t.byId(child.id)).toBeDefined();
    expect(child.isPinhole).toBe(false);
  });
});

describe('SessionTable — vue de lecture', () => {
  it('P1 : la vue LIT la table reelle', () => {
    const t = table();
    install(t, C2S);
    install(t, OTHER);

    expect(t.view().count()).toBe(2);
    expect(t.view().all()).toHaveLength(2);
  });

  it('la vue est vide quand la table l\'est — et c\'est correct', () => {
    expect(table().view().all()).toHaveLength(0);
  });

  it('la vue filtre', () => {
    const t = table();
    install(t, C2S);
    install(t, OTHER);

    const found = t.view().find(s => s.c2s.destPort === 80);

    expect(found).toHaveLength(1);
  });

  it('la vue retrouve par identifiant', () => {
    const t = table();
    const session = install(t);

    expect(t.view().byId(session.id)?.id).toBe(session.id);
  });

  it('la liste rendue par la vue ne laisse pas muter la table', () => {
    const t = table();
    install(t);

    expect(() => (t.view().all() as unknown[]).push({})).toThrow();
    expect(t.count()).toBe(1);
  });
});
