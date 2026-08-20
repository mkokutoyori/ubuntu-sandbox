/**
 * La résolution de conflit de réplication AD, et l'instabilité qu'elle
 * causait.
 *
 * `scenario-ad-replication-topology.test.ts` échouait environ une fois
 * sur vingt en suite complète, sur un cas — « les rôles FSMO restent sur
 * DC01 » — qui passait toujours quand on le lançait seul. Le coupable
 * n'était ni l'ordre des tests, ni un singleton mal réinitialisé, ni un
 * dépassement de délai : c'était **l'horloge**.
 *
 * `EntryReplMeta.timestamp` est en SECONDES — comme l'« originating
 * time » du vrai AD, ce n'est donc pas le défaut — et
 * `applyReplicatedEntry` ne comparait QUE cela. Pendant
 * `Install-ADDSDomainController`, le contrôleur promu crée une racine
 * locale vide puis tire celle de son partenaire ; quand les deux
 * créations tombaient dans deux secondes différentes, la racine locale
 * passait pour « plus récente », l'entrée entrante était refusée, et les
 * attributs FSMO n'arrivaient jamais. Le laboratoire construit en ~50 ms,
 * d'où une chance sur vingt environ de franchir une seconde.
 *
 * La vraie règle d'AD compare **la version d'abord**, puis l'heure
 * d'origine, puis le DSA d'origine ; la version manquait tout
 * simplement. Elle est le critère principal chez Microsoft précisément
 * parce que l'heure a une résolution d'une seconde.
 *
 * Ces cas tiennent le MÉCANISME et pas le symptôme : ils imposent les
 * horodatages au lieu d'espérer tomber sur le bon découpage de secondes.
 */
import { describe, it, expect } from 'vitest';
import { DirectoryTree, type EntryReplMeta } from '@/network/devices/windows/server/ad/ldap/DirectoryTree';

/** Un arbre qui participe à la réplication, avec son identité de DSA. */
function arbre(invocationId: string): DirectoryTree {
  let usn = 0;
  return new DirectoryTree('DC=mandeng,DC=lan', { dc: ['mandeng'] }, {
    invocationId,
    nextUsn: () => ++usn,
  });
}

const stamp = (o: Partial<EntryReplMeta> & { version?: number }): EntryReplMeta => ({
  originatingInvocationId: o.originatingInvocationId ?? 'DSA-DISTANT',
  originatingUsn: o.originatingUsn ?? 1,
  timestamp: o.timestamp ?? 1_000_000,
  version: o.version,
});

/** L'entrée racine et sa version courante. */
function versionRacine(t: DirectoryTree): number | undefined {
  return t.getByDn(t.getRootDn())?.replMeta?.version;
}

describe('chaque écriture locale incrémente la version de l\'entrée', () => {
  it('la racine naît en version 1', () => {
    expect(versionRacine(arbre('DSA-A'))).toBe(1);
  });

  it('une modification la fait monter', () => {
    const t = arbre('DSA-A');
    const dn = t.getRootDn();
    t.modifyEntry(dn, [{ op: 'replace', type: 'fsmoPdcEmulator', values: ['DC01'] }]);
    expect(versionRacine(t)).toBe(2);
    t.modifyEntry(dn, [{ op: 'replace', type: 'fsmoRidMaster', values: ['DC01'] }]);
    expect(versionRacine(t)).toBe(3);
  });
});

describe('la version l\'emporte sur l\'heure — la règle d\'AD, dans son ordre', () => {
  /**
   * Le cas EXACT du défaut : la copie locale est plus récente d'une
   * seconde, l'entrante porte une version plus élevée. C'est l'entrante
   * qui doit gagner.
   */
  it('une entrée entrante de version supérieure est acceptée même si la locale est plus récente', () => {
    const t = arbre('DSA-LOCAL');
    const dn = t.getRootDn();
    // La racine locale, écrite « maintenant », version 1.
    const local = t.getByDn(dn)!;
    local.replMeta = stamp({ originatingInvocationId: 'DSA-LOCAL', timestamp: 1_000_001, version: 1 });

    t.applyReplicatedEntry(dn, { fsmopdcemulator: ['DC01'] },
      stamp({ originatingInvocationId: 'DSA-DC01', timestamp: 1_000_000, version: 2 }));

    expect(t.getByDn(dn)!.attributes.get('fsmopdcemulator')).toEqual(['DC01']);
  });

  it('à version égale, c\'est l\'heure qui tranche', () => {
    const t = arbre('DSA-LOCAL');
    const dn = t.getRootDn();
    t.getByDn(dn)!.replMeta = stamp({ originatingInvocationId: 'DSA-LOCAL', timestamp: 1_000_005, version: 3 });

    // Plus ancienne, même version : refusée.
    t.applyReplicatedEntry(dn, { marque: ['ancienne'] },
      stamp({ originatingInvocationId: 'DSA-DC01', timestamp: 1_000_000, version: 3 }));
    expect(t.getByDn(dn)!.attributes.get('marque')).toBeUndefined();

    // Plus récente, même version : acceptée.
    t.applyReplicatedEntry(dn, { marque: ['recente'] },
      stamp({ originatingInvocationId: 'DSA-DC01', timestamp: 1_000_009, version: 3 }));
    expect(t.getByDn(dn)!.attributes.get('marque')).toEqual(['recente']);
  });

  /**
   * À égalité parfaite, le vrai AD tranche par le DSA d'origine —
   * arbitrairement, mais de façon STABLE. C'est le point : les deux
   * contrôleurs doivent trancher pareil, sinon ils divergent au lieu de
   * converger.
   */
  it('à version ET heure égales, le DSA d\'origine tranche, et toujours dans le même sens', () => {
    const faire = (invocationLocal: string, invocationEntrant: string): string[] | undefined => {
      const t = arbre('X');
      const dn = t.getRootDn();
      t.getByDn(dn)!.replMeta = stamp({ originatingInvocationId: invocationLocal, timestamp: 1_000_000, version: 3 });
      t.applyReplicatedEntry(dn, { marque: ['entrante'] },
        stamp({ originatingInvocationId: invocationEntrant, timestamp: 1_000_000, version: 3 }));
      return t.getByDn(dn)!.attributes.get('marque');
    };
    // Le plus grand identifiant gagne, quel que soit le côté où il est.
    expect(faire('DSA-A', 'DSA-B')).toEqual(['entrante']);
    expect(faire('DSA-B', 'DSA-A')).toBeUndefined();
    // Et deux appels identiques donnent le même résultat.
    expect(faire('DSA-A', 'DSA-B')).toEqual(faire('DSA-A', 'DSA-B'));
  });

  it('une entrée sans version compte pour zéro, donc n\'écrase jamais une version déclarée', () => {
    const t = arbre('DSA-LOCAL');
    const dn = t.getRootDn();
    t.getByDn(dn)!.replMeta = stamp({ timestamp: 1_000_000, version: 2 });
    t.applyReplicatedEntry(dn, { marque: ['sans-version'] },
      { originatingInvocationId: 'DSA-VIEUX', originatingUsn: 9, timestamp: 1_000_099 });
    expect(t.getByDn(dn)!.attributes.get('marque')).toBeUndefined();
  });
});

/**
 * La non-régression qui compte : l'heure seule ne doit plus décider.
 * Avant le correctif, ce cas échouait — la locale, plus récente d'une
 * seconde, gagnait.
 */
describe('l\'instabilité elle-même', () => {
  it('un écart d\'une seconde ne renverse plus le résultat', () => {
    for (const ecart of [0, 1, 2, 60, 3600]) {
      const t = arbre('DSA-LOCAL');
      const dn = t.getRootDn();
      // La racine locale est créée APRÈS celle du partenaire — c'est
      // exactement l'ordre d'une promotion de contrôleur.
      t.getByDn(dn)!.replMeta = stamp({ originatingInvocationId: 'DSA-DC02', timestamp: 1_000_000 + ecart, version: 1 });
      t.applyReplicatedEntry(dn, { fsmopdcemulator: ['DC01'] },
        stamp({ originatingInvocationId: 'DSA-DC01', timestamp: 1_000_000, version: 2 }));
      expect(t.getByDn(dn)!.attributes.get('fsmopdcemulator'), `écart de ${ecart} s`).toEqual(['DC01']);
    }
  });
});
