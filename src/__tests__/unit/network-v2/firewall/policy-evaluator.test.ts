/**
 * `PolicyEvaluator` — la recherche de politique.
 *
 * BRD-Firewall §11.3. Trois invariants structurants :
 *
 * — I-P1 : PREMIERE correspondance gagnante. Aucun des quatre constructeurs
 *   n'evalue toutes les regles ; chercher « la meilleure » serait faux pour
 *   les quatre.
 * — I-P2 : l'ORDRE est la semantique. Deplacer une regle change le
 *   comportement.
 * — I-P3 : le compteur s'incremente a la CORRESPONDANCE, pas a l'evaluation.
 *   Une regle traversee sans correspondre ne compte pas, sinon le compteur
 *   ne servirait a rien pour le diagnostic.
 *
 * DIVERGENCE DELIBEREE avec `ACLEngine`, mesuree et ecrite ici plutot que
 * decouverte plus tard : `evaluateACL` rend `null` pour une ACL absente ou
 * VIDE — « aucune ACL appliquee, pas deny-all », ce qui est le vrai
 * comportement d'IOS. Un pare-feu fait l'inverse : une politique vide REFUSE
 * (P8). Copier la semantique de l'ACL ici ouvrirait le pare-feu en grand le
 * jour ou la politique est vide.
 *
 * L'autre piege est §11.4.5 : une regle qui reference un utilisateur ne
 * correspond JAMAIS si aucun mappage n'existe — et surtout pas « a tout ».
 * L'inverse serait une faille enseignee.
 */

import { describe, it, expect } from 'vitest';
import { PolicyEvaluator } from '@/network/devices/firewall/policy/PolicyEvaluator';
import { makeRule, type SecurityRule } from '@/network/devices/firewall/model/SecurityRule';
import { ObjectStore } from '@/network/devices/firewall/model/ObjectStore';
import { hostAddress, subnetAddress } from '@/network/devices/firewall/model/AddressObject';
import { tcpService } from '@/network/devices/firewall/model/ServiceObject';
import { IP_PROTO_TCP } from '@/network/core/types';
import type { PolicyProbe } from '@/network/devices/firewall/policy/PolicyProbe';

function objects(): ObjectStore {
  const s = new ObjectStore();
  s.addAddress(hostAddress('SRV_WEB', '192.168.50.10'));
  s.addAddress(subnetAddress('LAN', '192.168.1.0', 24));
  s.addService(tcpService('HTTP', 80));
  s.addService(tcpService('SSH', 22));
  return s;
}

function probe(over: Partial<PolicyProbe> = {}): PolicyProbe {
  return {
    ingressZone: 'trust', egressZone: 'untrust',
    ingressInterface: 'port1', egressInterface: 'port2',
    sourceIP: '192.168.1.10', destIP: '203.0.113.5',
    protocol: IP_PROTO_TCP, sourcePort: 54321, destPort: 80,
    ...over,
  };
}

function evaluator(over: Partial<ConstructorParameters<typeof PolicyEvaluator>[0]> = {}) {
  return new PolicyEvaluator({ objects: objects(), ...over });
}

function rule(over: Partial<SecurityRule> = {}): SecurityRule {
  return makeRule({
    id: 'R', seq: 1, from: ['trust'], to: ['untrust'],
    source: ['any'], destination: ['any'], service: ['any'],
    action: 'allow', ...over,
  });
}

describe('PolicyEvaluator — I-P1, premiere correspondance', () => {
  it('retient la premiere regle qui correspond', () => {
    const e = evaluator();
    const first = rule({ id: 'R1', seq: 1, action: 'allow' });
    const second = rule({ id: 'R2', seq: 2, action: 'deny' });

    const decision = e.evaluate([first, second], probe());

    expect(decision.rule.id).toBe('R1');
    expect(decision.action).toBe('allow');
  });

  it('I-P2 : deplacer une regle — changer sa SEQUENCE — inverse le verdict', () => {
    const e = evaluator();

    const permetDevant = [rule({ id: 'R1', seq: 1, action: 'allow' }), rule({ id: 'R2', seq: 2, action: 'deny' })];
    expect(e.evaluate(permetDevant, probe()).action).toBe('allow');

    const refuseDevant = [rule({ id: 'R1', seq: 2, action: 'allow' }), rule({ id: 'R2', seq: 1, action: 'deny' })];
    expect(e.evaluate(refuseDevant, probe()).action).toBe('deny');
  });

  it('saute une regle desactivee', () => {
    const e = evaluator();
    const desactivee = rule({ id: 'R1', seq: 1, action: 'deny', enabled: false });
    const active = rule({ id: 'R2', seq: 2, action: 'allow' });

    expect(e.evaluate([desactivee, active], probe()).rule.id).toBe('R2');
  });

  it('evalue dans l\'ordre des sequences, pas celui du tableau', () => {
    const e = evaluator();
    const tardive = rule({ id: 'R9', seq: 9, action: 'deny' });
    const precoce = rule({ id: 'R1', seq: 1, action: 'allow' });

    expect(e.evaluate([tardive, precoce], probe()).rule.id).toBe('R1');
  });
});

describe('PolicyEvaluator — I-P3, compteurs', () => {
  it('incremente le compteur de la regle QUI CORRESPOND', () => {
    const e = evaluator();
    const r = rule();

    e.evaluate([r], probe());

    expect(r.hitCount).toBe(1);
  });

  it('n\'incremente PAS le compteur d\'une regle traversee sans correspondre', () => {
    const e = evaluator();
    const traversee = rule({ id: 'R1', seq: 1, service: ['SSH'] });
    const correspond = rule({ id: 'R2', seq: 2 });

    e.evaluate([traversee, correspond], probe({ destPort: 80 }));

    expect(traversee.hitCount).toBe(0);
    expect(correspond.hitCount).toBe(1);
  });

  it('cumule les octets sur la regle qui correspond', () => {
    const e = evaluator();
    const r = rule();

    e.evaluate([r], probe(), 1500);
    e.evaluate([r], probe(), 500);

    expect(r.hitCount).toBe(2);
    expect(r.byteCount).toBe(2000);
  });
});

describe('PolicyEvaluator — P8, refus implicite', () => {
  it('une politique VIDE refuse — et ne rend surtout pas « aucune politique »', () => {
    const decision = evaluator().evaluate([], probe());

    expect(decision.action).toBe('deny');
    expect(decision.implicit).toBe(true);
  });

  it('aucune regle correspondante refuse implicitement', () => {
    const e = evaluator();

    const decision = e.evaluate([rule({ service: ['SSH'] })], probe({ destPort: 80 }));

    expect(decision.action).toBe('deny');
    expect(decision.implicit).toBe(true);
  });

  it('la regle implicite porte son propre compteur', () => {
    const e = evaluator();

    e.evaluate([], probe());
    e.evaluate([], probe());

    expect(e.implicitRule().hitCount).toBe(2);
  });
});

describe('PolicyEvaluator — zones et interfaces', () => {
  it('ne correspond pas quand la zone source differe', () => {
    const e = evaluator();

    const decision = e.evaluate([rule({ from: ['dmz'] })], probe({ ingressZone: 'trust' }));

    expect(decision.implicit).toBe(true);
  });

  it('ne correspond pas quand la zone destination differe', () => {
    const e = evaluator();

    expect(e.evaluate([rule({ to: ['dmz'] })], probe()).implicit).toBe(true);
  });

  it('`any` en zone correspond a tout', () => {
    const e = evaluator();

    const decision = e.evaluate([rule({ from: ['any'], to: ['any'] })], probe({
      ingressZone: 'peu-importe', egressZone: 'autre',
    }));

    expect(decision.action).toBe('allow');
  });

  it('correspond par INTERFACE quand le profil le declare — le modele ASA', () => {
    const e = evaluator({ policyKeyedBy: 'interface' });

    const decision = e.evaluate([rule({ from: ['port1'], to: ['port2'] })], probe());

    expect(decision.action).toBe('allow');
  });

  it('en mode interface, la zone n\'est pas consultee', () => {
    const e = evaluator({ policyKeyedBy: 'interface' });

    const decision = e.evaluate([rule({ from: ['trust'], to: ['untrust'] })], probe());

    expect(decision.implicit).toBe(true);
  });
});

describe('PolicyEvaluator — adresses et services', () => {
  it('correspond par objet adresse', () => {
    const e = evaluator();

    expect(e.evaluate([rule({ source: ['LAN'] })], probe({ sourceIP: '192.168.1.99' })).action).toBe('allow');
    expect(e.evaluate([rule({ source: ['LAN'] })], probe({ sourceIP: '10.0.0.1' })).implicit).toBe(true);
  });

  it('correspond par objet service', () => {
    const e = evaluator();

    expect(e.evaluate([rule({ service: ['HTTP'] })], probe({ destPort: 80 })).action).toBe('allow');
    expect(e.evaluate([rule({ service: ['HTTP'] })], probe({ destPort: 22 })).implicit).toBe(true);
  });

  it('I-P4 : la negation porte sur l\'ensemble APLATI, pas membre par membre', () => {
    const e = evaluator();
    const r = rule({ source: ['LAN', 'SRV_WEB'], sourceNegated: true });

    expect(e.evaluate([r], probe({ sourceIP: '192.168.1.10' })).implicit).toBe(true);
    expect(e.evaluate([r], probe({ sourceIP: '192.168.50.10' })).implicit).toBe(true);
    expect(e.evaluate([r], probe({ sourceIP: '10.0.0.1' })).action).toBe('allow');
  });

  it('nie aussi le service', () => {
    const e = evaluator();
    const r = rule({ service: ['HTTP'], serviceNegated: true });

    expect(e.evaluate([r], probe({ destPort: 80 })).implicit).toBe(true);
    expect(e.evaluate([r], probe({ destPort: 22 })).action).toBe('allow');
  });

  it('une regle dont un objet n\'existe pas ne correspond a rien', () => {
    const e = evaluator();

    expect(e.evaluate([rule({ source: ['FANTOME'] })], probe()).implicit).toBe(true);
  });
});

describe('PolicyEvaluator — niveaux de securite, le modele ASA', () => {
  const levels = { trust: 100, dmz: 50, untrust: 0 };
  function asa() {
    return evaluator({
      implicitPolicy: 'security-level',
      policyKeyedBy: 'interface',
      securityLevelOf: (zone: string) => levels[zone as keyof typeof levels],
    });
  }

  it('haut vers bas est autorise SANS aucune regle', () => {
    const decision = asa().evaluate([], probe({ ingressZone: 'trust', egressZone: 'untrust' }));

    expect(decision.action).toBe('allow');
    expect(decision.implicit).toBe(true);
  });

  it('bas vers haut est refuse sans regle', () => {
    const decision = asa().evaluate([], probe({ ingressZone: 'untrust', egressZone: 'trust' }));

    expect(decision.action).toBe('deny');
  });

  it('meme niveau vers meme niveau est refuse', () => {
    const decision = asa().evaluate([], probe({ ingressZone: 'dmz', egressZone: 'dmz' }));

    expect(decision.action).toBe('deny');
  });

  it('une regle explicite l\'emporte sur le niveau de securite', () => {
    const e = asa();
    const r = rule({ from: ['port1'], to: ['port2'], action: 'deny' });

    const decision = e.evaluate([r], probe({ ingressZone: 'trust', egressZone: 'untrust' }));

    expect(decision.action).toBe('deny');
    expect(decision.implicit).toBe(false);
  });

  it('le temoin : sous deny-all, haut vers bas est refuse', () => {
    const decision = evaluator().evaluate([], probe({ ingressZone: 'trust', egressZone: 'untrust' }));

    expect(decision.action).toBe('deny');
  });

  it('APPLIQUER une ACL a l\'interface ANNULE le permit implicite haut vers bas', () => {
    const e = evaluator({
      implicitPolicy: 'security-level',
      policyKeyedBy: 'interface',
      securityLevelOf: (zone: string) => levels[zone as keyof typeof levels],
      interfaceHasBoundPolicy: (iface: string) => iface === 'port1',
    });

    const decision = e.evaluate([], probe({
      ingressZone: 'trust', egressZone: 'untrust', ingressInterface: 'port1',
    }));

    expect(decision.action).toBe('deny');
  });

  it('le temoin : la MEME topologie sans ACL liee autorise haut vers bas', () => {
    const e = evaluator({
      implicitPolicy: 'security-level',
      policyKeyedBy: 'interface',
      securityLevelOf: (zone: string) => levels[zone as keyof typeof levels],
      interfaceHasBoundPolicy: () => false,
    });

    const decision = e.evaluate([], probe({
      ingressZone: 'trust', egressZone: 'untrust', ingressInterface: 'port1',
    }));

    expect(decision.action).toBe('allow');
  });

  it('l\'annulation est PAR INTERFACE, pas globale', () => {
    const e = evaluator({
      implicitPolicy: 'security-level',
      policyKeyedBy: 'interface',
      securityLevelOf: (zone: string) => levels[zone as keyof typeof levels],
      interfaceHasBoundPolicy: (iface: string) => iface === 'port1',
    });

    const liee = e.evaluate([], probe({
      ingressZone: 'trust', egressZone: 'untrust', ingressInterface: 'port1',
    }));
    const libre = e.evaluate([], probe({
      ingressZone: 'dmz', egressZone: 'untrust', ingressInterface: 'port9',
    }));

    expect(liee.action).toBe('deny');
    expect(libre.action).toBe('allow');
  });

  it('une ACL liee qui AUTORISE explicitement laisse passer', () => {
    const e = evaluator({
      implicitPolicy: 'security-level',
      policyKeyedBy: 'interface',
      securityLevelOf: (zone: string) => levels[zone as keyof typeof levels],
      interfaceHasBoundPolicy: () => true,
    });
    const r = rule({ from: ['port1'], to: ['port2'], action: 'allow' });

    expect(e.evaluate([r], probe({ ingressZone: 'trust', egressZone: 'untrust' })).action)
      .toBe('allow');
  });

  it('sous deny-all, la liaison d\'ACL ne change rien — elle ne concerne que le modele ASA', () => {
    const e = evaluator({ interfaceHasBoundPolicy: () => true });

    expect(e.evaluate([], probe()).action).toBe('deny');
  });
});

describe('PolicyEvaluator — horaire', () => {
  it('correspond quand l\'horaire est actif', () => {
    const e = evaluator({ scheduleActive: () => true });

    expect(e.evaluate([rule({ schedule: 'OUVRE' })], probe()).action).toBe('allow');
  });

  it('ne correspond pas quand l\'horaire est inactif', () => {
    const e = evaluator({ scheduleActive: () => false });

    expect(e.evaluate([rule({ schedule: 'OUVRE' })], probe()).implicit).toBe(true);
  });

  it('une regle sans horaire correspond toujours', () => {
    const e = evaluator({ scheduleActive: () => false });

    expect(e.evaluate([rule()], probe()).action).toBe('allow');
  });
});

describe('PolicyEvaluator — §11.4.5, utilisateur', () => {
  it('correspond quand le mappage donne l\'utilisateur attendu', () => {
    const e = evaluator({ userOf: () => 'alice' });

    expect(e.evaluate([rule({ user: ['alice'] })], probe()).action).toBe('allow');
  });

  it('ne correspond pas pour un autre utilisateur', () => {
    const e = evaluator({ userOf: () => 'bob' });

    expect(e.evaluate([rule({ user: ['alice'] })], probe()).implicit).toBe(true);
  });

  it('SANS identification, une regle utilisateur ne correspond JAMAIS — pas « a tout »', () => {
    const e = evaluator();

    expect(e.evaluate([rule({ user: ['alice'] })], probe()).implicit).toBe(true);
  });

  it('une regle sans critere utilisateur correspond meme sans identification', () => {
    const e = evaluator();

    expect(e.evaluate([rule()], probe()).action).toBe('allow');
  });
});

describe('PolicyEvaluator — §11.5, application ternaire', () => {
  it('correspond quand l\'application est identifiee et attendue', () => {
    const e = evaluator();

    const decision = e.evaluate([rule({ application: ['web-browsing'] })],
      probe({ application: 'web-browsing' }));

    expect(decision.action).toBe('allow');
  });

  it('ne correspond pas quand l\'application identifiee differe', () => {
    const e = evaluator();

    const decision = e.evaluate([rule({ application: ['ssh'] })],
      probe({ application: 'web-browsing' }));

    expect(decision.implicit).toBe(true);
  });

  it('application INCONNUE : la regle est en attente, pas en correspondance', () => {
    const e = evaluator({ applicationShift: true });

    const decision = e.evaluate([rule({ application: ['web-browsing'] })], probe());

    expect(decision.implicit).toBe(true);
    expect(decision.sawPending).toBe(true);
  });

  it('sans application-shift, une regle applicative ne correspond pas sans identification', () => {
    const e = evaluator({ applicationShift: false });

    const decision = e.evaluate([rule({ application: ['web-browsing'] })], probe());

    expect(decision.implicit).toBe(true);
    expect(decision.sawPending).toBe(false);
  });

  it('sawPending est faux quand aucune regle applicative n\'a ete traversee', () => {
    const e = evaluator({ applicationShift: true });

    expect(e.evaluate([rule()], probe()).sawPending).toBe(false);
  });
});
