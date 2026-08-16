/**
 * `ZoneTable` — les zones de securite et l'appartenance des interfaces.
 *
 * BRD-Firewall §9. Une zone n'a ni adresse, ni route, ni existence sur le
 * fil : son unique role est de rendre la politique independante du cablage.
 * C'est ce que fixe UC-2 — deplacer une interface d'une zone a l'autre
 * change la politique appliquee sans qu'aucune regle ne soit modifiee.
 *
 * Les six invariants I-Z1 a I-Z6 sont chacun un cas. Deux meritent d'etre
 * signales parce qu'ils sont des PIEGES PEDAGOGIQUES et non des details :
 *
 * — I-Z4 : une zone vide est LEGALE et ne correspond a RIEN. Un apprenant
 *   qui cree une zone, l'utilise dans une regle et oublie d'y mettre une
 *   interface doit voir sa regle ne jamais correspondre — pas correspondre
 *   a tout. L'inverse serait une faille enseignee.
 * — I-Z2 : une interface appartient a zero ou une zone, jamais deux. Le
 *   refus nomme la zone actuelle, sans quoi le diagnostic est impossible.
 *
 * Les deux dependances (verification de reference, mode d'interface) sont
 * INJECTEES : le magasin ne connait ni la politique ni la table
 * d'interfaces. C'est ce qui le rend testable seul, conformement a NFR-M4.
 */

import { describe, it, expect } from 'vitest';
import {
  ZoneTable,
  type ZoneTableDeps,
} from '@/network/devices/firewall/model/ZoneTable';
import type { ZoneType } from '@/network/devices/firewall/model/SecurityZone';

function table(deps: ZoneTableDeps = {}): ZoneTable {
  return new ZoneTable(deps);
}

function withZones(...names: string[]): ZoneTable {
  const t = table();
  for (const name of names) t.createZone(name);
  return t;
}

describe('ZoneTable — creation et suppression', () => {
  it('cree une zone et la retrouve', () => {
    const t = table();

    expect(t.createZone('trust').ok).toBe(true);
    expect(t.getZone('trust')?.name).toBe('trust');
  });

  it('I-Z1 : refuse une zone dont le nom existe deja', () => {
    const t = withZones('trust');

    const result = t.createZone('trust');

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error.kind).toBe('duplicate-name');
  });

  it('liste les zones dans l\'ordre de creation', () => {
    const t = withZones('trust', 'dmz', 'untrust');

    expect(t.list().map(z => z.name)).toEqual(['trust', 'dmz', 'untrust']);
  });

  it('supprime une zone que rien ne reference', () => {
    const t = withZones('trust');

    expect(t.deleteZone('trust').ok).toBe(true);
    expect(t.getZone('trust')).toBeUndefined();
  });

  it('refuse de supprimer une zone inconnue', () => {
    const result = table().deleteZone('fantome');

    expect(result.ok === false && result.error.kind).toBe('unknown-zone');
  });

  it('I-Z5 : refuse de supprimer une zone referencee, en NOMMANT le referent', () => {
    const t = withZones('trust');
    const referenced = table({ referenceChecker: () => ['security rule "Allow-Web"'] });
    referenced.createZone('trust');

    const result = referenced.deleteZone('trust');

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error.kind).toBe('zone-referenced');
    expect(result.ok === false && result.error.kind === 'zone-referenced'
      && result.error.referents).toEqual(['security rule "Allow-Web"']);
    expect(t.getZone('trust')).toBeDefined();
  });

  it('libere les interfaces d\'une zone supprimee', () => {
    const t = withZones('trust');
    t.assignInterface('trust', 'port1');

    t.deleteZone('trust');

    expect(t.zoneOf('port1')).toBeUndefined();
  });

  it('refuse de supprimer une zone predefinie', () => {
    const t = table();
    t.createZone('any', { predefined: true });

    const result = t.deleteZone('any');

    expect(result.ok === false && result.error.kind).toBe('predefined-zone');
  });
});

describe('ZoneTable — appartenance des interfaces', () => {
  it('affecte une interface a une zone', () => {
    const t = withZones('trust');

    expect(t.assignInterface('trust', 'port1').ok).toBe(true);
    expect(t.zoneOf('port1')).toBe('trust');
    expect(t.getZone('trust')?.interfaces).toEqual(['port1']);
  });

  it('affecte plusieurs interfaces a une meme zone', () => {
    const t = withZones('dmz');

    t.assignInterface('dmz', 'port2');
    t.assignInterface('dmz', 'port3');

    expect(t.getZone('dmz')?.interfaces).toEqual(['port2', 'port3']);
  });

  it('I-Z2 : refuse une interface deja membre d\'une AUTRE zone, en nommant celle-ci', () => {
    const t = withZones('trust', 'untrust');
    t.assignInterface('trust', 'port1');

    const result = t.assignInterface('untrust', 'port1');

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error.kind).toBe('interface-already-in-zone');
    expect(result.ok === false && result.error.kind === 'interface-already-in-zone'
      && result.error.zone).toBe('trust');
    expect(t.zoneOf('port1')).toBe('trust');
  });

  it('accepte sans broncher une interface reaffectee a SA PROPRE zone', () => {
    const t = withZones('trust');
    t.assignInterface('trust', 'port1');

    expect(t.assignInterface('trust', 'port1').ok).toBe(true);
    expect(t.getZone('trust')?.interfaces).toEqual(['port1']);
  });

  it('refuse d\'affecter une interface a une zone inconnue', () => {
    const result = table().assignInterface('fantome', 'port1');

    expect(result.ok === false && result.error.kind).toBe('unknown-zone');
  });

  it('retire une interface de sa zone', () => {
    const t = withZones('trust');
    t.assignInterface('trust', 'port1');

    expect(t.removeInterface('port1').ok).toBe(true);
    expect(t.zoneOf('port1')).toBeUndefined();
    expect(t.getZone('trust')?.interfaces).toEqual([]);
  });

  it('UC-2 : deplacer une interface change la zone SANS toucher aux zones elles-memes', () => {
    const t = withZones('trust', 'dmz');
    t.assignInterface('trust', 'port1');

    t.removeInterface('port1');
    t.assignInterface('dmz', 'port1');

    expect(t.zoneOf('port1')).toBe('dmz');
    expect(t.getZone('trust')?.interfaces).toEqual([]);
    expect(t.getZone('dmz')?.interfaces).toEqual(['port1']);
  });

  it('I-Z4 : une zone vide est legale et ne porte aucune interface', () => {
    const t = withZones('vide');

    expect(t.getZone('vide')?.interfaces).toEqual([]);
    expect(t.interfacesOf('vide')).toEqual([]);
  });

  it('I-Z4 : une interface hors zone n\'appartient a rien', () => {
    const t = withZones('trust');

    expect(t.zoneOf('port9')).toBeUndefined();
  });
});

describe('ZoneTable — I-Z6, compatibilite du type de zone et du mode d\'interface', () => {
  const modes: ZoneTableDeps = { interfaceModeOf: (iface) => (iface === 'port1' ? 'layer3' : 'layer2') };

  it('accepte une interface L3 dans une zone L3', () => {
    const t = table(modes);
    t.createZone('trust', { type: 'layer3' });

    expect(t.assignInterface('trust', 'port1').ok).toBe(true);
  });

  it('refuse une interface L2 dans une zone L3', () => {
    const t = table(modes);
    t.createZone('trust', { type: 'layer3' });

    const result = t.assignInterface('trust', 'port2');

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error.kind).toBe('incompatible-interface-mode');
  });

  it('accepte une interface L2 dans une zone L2', () => {
    const t = table(modes);
    t.createZone('pont', { type: 'layer2' });

    expect(t.assignInterface('pont', 'port2').ok).toBe(true);
  });

  it('n\'impose aucune contrainte quand le mode de l\'interface est inconnu', () => {
    const t = table({ interfaceModeOf: () => undefined });
    t.createZone('trust', { type: 'layer3' });

    expect(t.assignInterface('trust', 'port2').ok).toBe(true);
  });

  it('n\'impose aucune contrainte quand aucune table d\'interfaces n\'est injectee', () => {
    const t = table();
    t.createZone('trust', { type: 'layer3' });

    expect(t.assignInterface('trust', 'port2').ok).toBe(true);
  });
});

describe('ZoneTable — proprietes de zone', () => {
  it('donne le type layer3 par defaut', () => {
    const t = withZones('trust');

    expect(t.getZone('trust')?.type).toBe('layer3');
  });

  it('porte le type demande a la creation', () => {
    const t = table();
    t.createZone('cable', { type: 'virtual-wire' });

    expect(t.getZone('cable')?.type).toBe('virtual-wire');
  });

  it('refuse le trafic intra-zone par defaut', () => {
    const t = withZones('trust');

    expect(t.getZone('trust')?.intraZoneAction).toBe('deny');
  });

  it('honore le defaut intra-zone fourni par le profil', () => {
    const t = table({ defaultIntraZoneAction: 'allow' });
    t.createZone('trust');

    expect(t.getZone('trust')?.intraZoneAction).toBe('allow');
  });

  it('porte le niveau de securite quand il est fourni — le modele ASA', () => {
    const t = table();
    t.createZone('inside', { securityLevel: 100 });
    t.createZone('outside', { securityLevel: 0 });

    expect(t.getZone('inside')?.securityLevel).toBe(100);
    expect(t.getZone('outside')?.securityLevel).toBe(0);
  });

  it('laisse le niveau de securite indefini quand il n\'est pas fourni', () => {
    const t = withZones('trust');

    expect(t.getZone('trust')?.securityLevel).toBeUndefined();
  });

  it('modifie l\'action intra-zone d\'une zone existante', () => {
    const t = withZones('trust');

    expect(t.setIntraZoneAction('trust', 'allow').ok).toBe(true);
    expect(t.getZone('trust')?.intraZoneAction).toBe('allow');
  });

  it('refuse de modifier une zone inconnue', () => {
    expect(table().setIntraZoneAction('fantome', 'allow').ok).toBe(false);
  });

  it('modifie le niveau de securite d\'une zone existante', () => {
    const t = table();
    t.createZone('dmz', { securityLevel: 0 });

    expect(t.setSecurityLevel('dmz', 50).ok).toBe(true);
    expect(t.getZone('dmz')?.securityLevel).toBe(50);
  });

  it('pose un niveau sur une zone qui n\'en avait aucun', () => {
    const t = withZones('trust');

    t.setSecurityLevel('trust', 80);

    expect(t.getZone('trust')?.securityLevel).toBe(80);
  });

  it('refuse un niveau sur une zone inconnue', () => {
    expect(table().setSecurityLevel('fantome', 50).ok).toBe(false);
  });
});

describe('ZoneTable — immuabilite de la vue', () => {
  it('la vue rendue ne laisse pas muter la liste d\'interfaces du magasin', () => {
    const t = withZones('trust');
    t.assignInterface('trust', 'port1');

    const zone = t.getZone('trust');
    expect(() => (zone!.interfaces as string[]).push('port2')).toThrow();
    expect(t.interfacesOf('trust')).toEqual(['port1']);
  });

  it('la liste rendue par list() ne laisse pas ajouter une zone au magasin', () => {
    const t = withZones('trust');

    const zones = t.list();
    expect(() => (zones as unknown as ZoneType[]).push('layer3')).toThrow();
    expect(t.list()).toHaveLength(1);
  });
});
