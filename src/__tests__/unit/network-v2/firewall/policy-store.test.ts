/**
 * `PolicyStore` — la politique ordonnee et ses manipulations.
 *
 * BRD-Firewall §11.7. L'invariant qui gouverne tout ce fichier est I-P5 :
 * `seq` N'EST PAS l'identifiant. FortiOS numerote ses politiques par un
 * identifiant stable (`edit 3`) tout en les ordonnant separement — `move 3
 * after 7` change l'ordre, pas l'identifiant. Confondre les deux rendrait
 * `move` impossible a simuler, et c'est la manipulation la plus courante
 * d'une politique en production.
 *
 * Ce magasin ferme aussi la boucle des references : il sait dire quelles
 * zones et quels objets ses regles citent, ce qui alimente le
 * `referenceChecker` de `ZoneTable` (I-Z5) et les `externalReferences` de
 * `ObjectStore` (I-A1). Sans ce bouclage, supprimer une zone utilisee par
 * une regle serait accepte — et la regle pointerait dans le vide.
 */

import { describe, it, expect } from 'vitest';
import { PolicyStore } from '@/network/devices/firewall/model/PolicyStore';

function store(): PolicyStore {
  return new PolicyStore();
}

function withRules(...ids: string[]): PolicyStore {
  const s = store();
  for (const id of ids) s.append({ id, from: ['trust'], to: ['untrust'], action: 'allow' });
  return s;
}

function order(s: PolicyStore): string[] {
  return s.ordered().map(r => r.id);
}

describe('PolicyStore — ajout et ordre', () => {
  it('ajoute en fin de politique', () => {
    const s = withRules('R1', 'R2', 'R3');

    expect(order(s)).toEqual(['R1', 'R2', 'R3']);
  });

  it('refuse un identifiant deja pris', () => {
    const s = withRules('R1');

    const result = s.append({ id: 'R1', action: 'deny' });

    expect(result.ok === false && result.error.kind).toBe('duplicate-rule');
  });

  it('insere a une position donnee', () => {
    const s = withRules('R1', 'R3');

    s.insertAt(1, { id: 'R2', action: 'allow' });

    expect(order(s)).toEqual(['R1', 'R2', 'R3']);
  });

  it('la regle implicite n\'est PAS dans la liste ordinaire', () => {
    const s = withRules('R1');

    expect(order(s)).toEqual(['R1']);
    expect(s.implicitRule().implicit).toBe(true);
  });

  it('la regle implicite est rendue en queue par orderedWithImplicit', () => {
    const s = withRules('R1');

    const ids = s.orderedWithImplicit().map(r => r.id);

    expect(ids).toHaveLength(2);
    expect(ids[1]).toBe(s.implicitRule().id);
  });
});

describe('PolicyStore — I-P5, seq n\'est pas l\'identifiant', () => {
  it('deplacer une regle change son rang, PAS son identifiant', () => {
    const s = withRules('R1', 'R2', 'R3');

    s.move('R3', 'before', 'R1');

    expect(order(s)).toEqual(['R3', 'R1', 'R2']);
    expect(s.byId('R3')?.id).toBe('R3');
  });

  it('deplace apres une cible', () => {
    const s = withRules('R1', 'R2', 'R3');

    s.move('R1', 'after', 'R3');

    expect(order(s)).toEqual(['R2', 'R3', 'R1']);
  });

  it('deplace en tete', () => {
    const s = withRules('R1', 'R2', 'R3');

    s.moveTop('R3');

    expect(order(s)).toEqual(['R3', 'R1', 'R2']);
  });

  it('deplace en queue', () => {
    const s = withRules('R1', 'R2', 'R3');

    s.moveBottom('R1');

    expect(order(s)).toEqual(['R2', 'R3', 'R1']);
  });

  it('les sequences restent croissantes apres deplacement', () => {
    const s = withRules('R1', 'R2', 'R3');

    s.move('R3', 'before', 'R1');

    const seqs = s.ordered().map(r => r.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(3);
  });

  it('refuse de deplacer une regle inconnue', () => {
    expect(withRules('R1').move('FANTOME', 'before', 'R1').ok).toBe(false);
  });

  it('refuse de deplacer vers une cible inconnue', () => {
    expect(withRules('R1').move('R1', 'before', 'FANTOME').ok).toBe(false);
  });

  it('deplacer une regle sur elle-meme ne change rien', () => {
    const s = withRules('R1', 'R2');

    expect(s.move('R1', 'before', 'R1').ok).toBe(true);
    expect(order(s)).toEqual(['R1', 'R2']);
  });
});

describe('PolicyStore — activation, clonage, suppression', () => {
  it('desactive sans supprimer', () => {
    const s = withRules('R1');

    s.disable('R1');

    expect(s.byId('R1')?.enabled).toBe(false);
    expect(order(s)).toEqual(['R1']);
  });

  it('reactive', () => {
    const s = withRules('R1');
    s.disable('R1');

    s.enable('R1');

    expect(s.byId('R1')?.enabled).toBe(true);
  });

  it('clone une regle sous un nouvel identifiant, juste apres l\'originale', () => {
    const s = withRules('R1', 'R2');

    s.clone('R1', 'R1_COPIE');

    expect(order(s)).toEqual(['R1', 'R1_COPIE', 'R2']);
  });

  it('le clone porte les memes criteres mais des compteurs a zero', () => {
    const s = store();
    s.append({ id: 'R1', from: ['trust'], to: ['dmz'], service: ['HTTP'], action: 'allow' });
    s.byId('R1')!.hitCount = 42;

    s.clone('R1', 'R1_COPIE');

    const copie = s.byId('R1_COPIE')!;
    expect(copie.to).toEqual(['dmz']);
    expect(copie.service).toEqual(['HTTP']);
    expect(copie.hitCount).toBe(0);
  });

  it('supprime une regle', () => {
    const s = withRules('R1', 'R2');

    expect(s.remove('R1').ok).toBe(true);
    expect(order(s)).toEqual(['R2']);
  });

  it('refuse de supprimer la regle implicite', () => {
    const s = store();

    expect(s.remove(s.implicitRule().id).ok).toBe(false);
  });

  it('remet les compteurs a zero, globalement', () => {
    const s = withRules('R1', 'R2');
    s.byId('R1')!.hitCount = 5;
    s.byId('R2')!.byteCount = 900;

    s.resetCounters();

    expect(s.byId('R1')?.hitCount).toBe(0);
    expect(s.byId('R2')?.byteCount).toBe(0);
  });

  it('remet les compteurs d\'une seule regle', () => {
    const s = withRules('R1', 'R2');
    s.byId('R1')!.hitCount = 5;
    s.byId('R2')!.hitCount = 7;

    s.resetCounters('R1');

    expect(s.byId('R1')?.hitCount).toBe(0);
    expect(s.byId('R2')?.hitCount).toBe(7);
  });
});

describe('PolicyStore — bouclage des references', () => {
  it('nomme les regles qui citent une zone', () => {
    const s = store();
    s.append({ id: 'R1', name: 'Allow-Web', from: ['trust'], to: ['untrust'], action: 'allow' });

    expect(s.zoneReferents('trust')).toContain('security rule "Allow-Web"');
    expect(s.zoneReferents('untrust')).toHaveLength(1);
    expect(s.zoneReferents('dmz')).toHaveLength(0);
  });

  it('designe une regle sans nom par son identifiant', () => {
    const s = store();
    s.append({ id: 'R1', from: ['trust'], action: 'allow' });

    expect(s.zoneReferents('trust')).toContain('security rule "R1"');
  });

  it('nomme les regles qui citent un objet adresse', () => {
    const s = store();
    s.append({ id: 'R1', source: ['LAN'], destination: ['SRV_WEB'], action: 'allow' });

    expect(s.objectReferents('LAN')).toHaveLength(1);
    expect(s.objectReferents('SRV_WEB')).toHaveLength(1);
    expect(s.objectReferents('AUTRE')).toHaveLength(0);
  });

  it('nomme les regles qui citent un objet service', () => {
    const s = store();
    s.append({ id: 'R1', service: ['HTTP'], action: 'allow' });

    expect(s.objectReferents('HTTP')).toHaveLength(1);
  });

  it('ne compte PAS `any` comme une reference — il est predefini et indestructible', () => {
    const s = store();
    s.append({ id: 'R1', source: ['any'], destination: ['any'], service: ['any'], action: 'allow' });

    expect(s.objectReferents('any')).toHaveLength(0);
  });

  it('une regle DESACTIVEE reference toujours — elle peut etre reactivee', () => {
    const s = store();
    s.append({ id: 'R1', from: ['trust'], action: 'allow' });
    s.disable('R1');

    expect(s.zoneReferents('trust')).toHaveLength(1);
  });

  it('la suppression de la regle libere la reference', () => {
    const s = store();
    s.append({ id: 'R1', from: ['trust'], action: 'allow' });

    s.remove('R1');

    expect(s.zoneReferents('trust')).toHaveLength(0);
  });
});

describe('PolicyStore — vue', () => {
  it('la vue lit le magasin reel', () => {
    const s = withRules('R1', 'R2');

    expect(s.view().ordered()).toHaveLength(2);
    expect(s.view().byId('R1')?.id).toBe('R1');
  });

  it('la liste rendue ne laisse pas muter le magasin', () => {
    const s = withRules('R1');

    expect(() => (s.ordered() as unknown[]).push({})).toThrow();
    expect(order(s)).toEqual(['R1']);
  });

  it('les statistiques comptent les regles actives et desactivees', () => {
    const s = withRules('R1', 'R2', 'R3');
    s.disable('R2');

    const stats = s.view().statistics();

    expect(stats.total).toBe(3);
    expect(stats.enabled).toBe(2);
    expect(stats.disabled).toBe(1);
  });
});
