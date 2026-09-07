/*
 * Sonde ECRITE A L'AVEUGLE sur le sous-mode `route-map`, avant toute
 * lecture de ses declarations.
 *
 * LA REFERENCE N'A PAS PU ETRE ATTEINTE : cisco.com est bloque par le
 * mandataire de sortie de ce reseau. Rien n'est donc invente. L'autorite
 * employee ici est la TABLE que le moteur evalue —
 * `ROUTE_MAP_MATCH_CLAUSES` et `ROUTE_MAP_SET_CLAUSES`, qui portent les
 * mots de chaque clause, la phrase d'IOS qui la decrit, et le juge qui
 * tranche sa queue. La sonde la LIT plutot que de la recopier : une
 * seconde ecriture des trente et une clauses finirait par diverger de
 * celle que la machine applique, et c'est precisement ce qu'on mesure.
 *
 * Ce que la sonde exige ne demande donc aucune reference exterieure :
 *   - un mot que `?` propose a une place s'execute a cette place ;
 *   - `?` ne promet un `<cr>` que la ou le juge accepte une queue vide ;
 *   - une clause de DEUX mots doit pouvoir se decouvrir : apres `match
 *     ip`, l'aide nomme `address`, `next-hop` et `route-source`.
 *
 * POURQUOI CELA COUTE CHER : une route-map decide ce qui entre dans la
 * table de routage. Une clause acceptee de travers ne se voit pas —
 * elle filtre autre chose que ce qu'on a voulu — et une clause qu'on ne
 * peut pas decouvrir ne se pose jamais.
 *
 * Discriminee contre l'etat d'avant : 73 des 148 cas tombent. Les 75
 * autres sont nommes ici plutot que laisses a decouvrir.
 *   - les vingt POSEES et les onze REFUSEES passaient presque toutes,
 *     et le doivent : c'est le JUGE de la table qui les tranche, et la
 *     migration ne le deplace pas. Elles sont les TEMOINS — sans elles,
 *     un correctif qui rendrait l'aide juste en cassant l'analyse
 *     passerait pour une correction. La seule qui tombe est `set ip
 *     zorglub`, ou le moteur repondait `% Incomplete command.` pour un
 *     mot FAUTIF : il cherchait la profondeur du groupe `ip` au lieu de
 *     refuser le mot qui n'en fait pas partie ;
 *   - les trois `no` passaient : le gestionnaire filtrait deja par
 *     prefixe ;
 *   - la tete `route-map` passait pour tout sauf son aide : le
 *     gestionnaire glouton lisait son action et son numero, avec la
 *     plage. C'est `route-map RM ?` qui n'annoncait ni `permit` ni
 *     `deny`, la place n'etant declaree nulle part ;
 *   - `match ?` et `set ?` annoncaient deja la bonne liste de tetes :
 *     l'aide la tirait des ALTERNATIVES d'une place `REST`. C'est
 *     precisement ce `REST` qui rendait tout le reste faux — il avale
 *     la suite, donc l'aide n'avait plus rien a descendre et
 *     reproposait les memes mots a toutes les profondeurs.
 */
import { describe, it, expect } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import {
  ROUTE_MAP_MATCH_CLAUSES, ROUTE_MAP_SET_CLAUSES,
  type RouteMapClauseSpec,
} from '@/network/devices/router/policy/routeMapClauses';

type Cli = {
  executeCommand: (c: string) => Promise<string>;
  cliHelp: (s: string) => string;
};

const MOT = /^\s\s(\S+)/;
const mots = (aide: string): string[] =>
  aide.split('\n').map((l) => MOT.exec(l)?.[1]).filter((m): m is string => !!m);
const annonceCr = (aide: string): boolean =>
  aide.split('\n').some((l) => /^\s\s<cr>\s*$/.test(l));

let serie = 0;
async function dansLaCarte(): Promise<Cli> {
  const r = new CiscoRouter(`RM${serie++}`) as unknown as Cli;
  for (const c of ['enable', 'configure terminal', 'route-map RM permit 10']) {
    await r.executeCommand(c);
  }
  return r;
}

async function conf(d: Cli): Promise<string> {
  await d.executeCommand('end');
  return d.executeCommand('show running-config');
}

const FAMILLES: ReadonlyArray<readonly [string, readonly RouteMapClauseSpec[]]> = [
  ['match', ROUTE_MAP_MATCH_CLAUSES],
  ['set', ROUTE_MAP_SET_CLAUSES],
];

/** Les groupes de clauses qui partagent leur PREMIER mot et en ont un second. */
function groupesProfonds(
  clauses: readonly RouteMapClauseSpec[],
): Map<string, string[]> {
  const par = new Map<string, string[]>();
  for (const c of clauses) {
    if (c.words.length < 2) continue;
    const liste = par.get(c.words[0]) ?? [];
    liste.push(c.words[1]);
    par.set(c.words[0], liste);
  }
  return par;
}

for (const [genre, clauses] of FAMILLES) {
  describe(`\`${genre}\` annonce ce qu'il execute`, () => {
    it('la tete annonce toutes les clauses de la table', async () => {
      const d = await dansLaCarte();
      const tetes = [...new Set(clauses.map((c) => c.words[0]))];
      expect(mots(d.cliHelp(`${genre} `))).toEqual(expect.arrayContaining(tetes));
    });

    it('la tete seule est INCOMPLETE — le TEMOIN', async () => {
      const d = await dansLaCarte();
      expect(await d.executeCommand(genre)).toMatch(/Incomplete command/);
      expect(annonceCr(d.cliHelp(`${genre} `))).toBe(false);
    });

    for (const [premier, seconds] of groupesProfonds(clauses)) {
      it(`\`${genre} ${premier} ?\` nomme ses seconds mots`, async () => {
        const d = await dansLaCarte();
        expect(mots(d.cliHelp(`${genre} ${premier} `)).sort())
          .toEqual([...seconds].sort());
      });

      it(`\`${genre} ${premier}\` seul est INCOMPLET`, async () => {
        const d = await dansLaCarte();
        expect(await d.executeCommand(`${genre} ${premier}`))
          .toMatch(/Incomplete command/);
        expect(annonceCr(d.cliHelp(`${genre} ${premier} `))).toBe(false);
      });
    }

    for (const clause of clauses) {
      const chemin = `${genre} ${clause.words.join(' ')}`;
      const queueVide = clause.judge([]) === null;

      it(`\`${chemin} ?\` ne propose aucune clause SOEUR`, async () => {
        const d = await dansLaCarte();
        const soeurs = clauses
          .map((c) => c.words[0])
          .filter((m) => m !== clause.words[0]);
        const rendus = mots(d.cliHelp(`${chemin} `));
        for (const soeur of soeurs) {
          expect(rendus, `${chemin} ? propose ${soeur}`).not.toContain(soeur);
        }
      });

      it(`\`${chemin} ?\` ${queueVide ? 'promet' : 'ne promet pas'} \`<cr>\``, async () => {
        const d = await dansLaCarte();
        expect(annonceCr(d.cliHelp(`${chemin} `))).toBe(queueVide);
      });

      it(`\`${chemin}\` seul est ${queueVide ? 'accepte' : 'INCOMPLET'}`, async () => {
        const d = await dansLaCarte();
        const reponse = await d.executeCommand(chemin);
        if (queueVide) expect(reponse).not.toMatch(/Incomplete|Invalid/);
        else expect(reponse).toMatch(/Incomplete command/);
      });
    }
  });
}

describe('les clauses se posent et se relisent', () => {
  const POSEES: readonly string[] = [
    'match as-path 1',
    'match ip address ACL1',
    'match ipv6 next-hop LISTE',
    'match metric 100',
    'match route-type internal',
    'match tag 7',
    'match length 100 200',
    'set as-path prepend 65001',
    'set automatic-tag',
    'set community 100:1',
    'set ip next-hop 10.0.0.1',
    'set ip precedence critical',
    'set ipv6 next-hop 2001:db8::1',
    'set level level-1',
    'set local-preference 200',
    'set metric 50',
    'set metric-type type-1',
    'set origin igp',
    'set tag 9',
    'set weight 100',
  ];
  for (const ligne of POSEES) {
    it(`\`${ligne}\``, async () => {
      const d = await dansLaCarte();
      expect(await d.executeCommand(ligne)).not.toMatch(/Incomplete|Invalid/);
      expect(await conf(d)).toContain(` ${ligne}`);
    });
  }
});

describe('les clauses fautives sont refusees', () => {
  const REFUSEES: readonly string[] = [
    'match zorglub',
    'match as-path zorglub',
    'match as-path community',
    'match ip zorglub',
    'match route-type zorglub',
    'set zorglub',
    'set origin zorglub',
    'set metric-type zorglub',
    'set level zorglub',
    'set ip zorglub',
    'set automatic-tag zorglub',
  ];
  for (const ligne of REFUSEES) {
    it(`\`${ligne}\``, async () => {
      const d = await dansLaCarte();
      expect(await d.executeCommand(ligne)).toMatch(/Invalid input/);
      expect(await conf(d)).not.toContain('zorglub');
    });
  }
});

describe('`no` retire la clause', () => {
  it('`no match as-path` retire ce que `match as-path` a pose', async () => {
    const d = await dansLaCarte();
    await d.executeCommand('match as-path 1');
    expect(await d.executeCommand('no match as-path')).not.toMatch(/Invalid|Incomplete/);
    expect(await conf(d)).not.toContain('match as-path');
  });

  it('`no set community` retire ce que `set community` a pose', async () => {
    const d = await dansLaCarte();
    await d.executeCommand('set community 100:1');
    expect(await d.executeCommand('no set community')).not.toMatch(/Invalid|Incomplete/);
    expect(await conf(d)).not.toContain('set community');
  });

  it('`no match ip address` retire la clause a DEUX mots', async () => {
    const d = await dansLaCarte();
    await d.executeCommand('match ip address ACL1');
    expect(await d.executeCommand('no match ip address'))
      .not.toMatch(/Invalid|Incomplete/);
    expect(await conf(d)).not.toContain('match ip address');
  });
});

describe('la tete `route-map`', () => {
  const routeur = async (): Promise<Cli> => {
    const r = new CiscoRouter(`RT${serie++}`) as unknown as Cli;
    for (const c of ['enable', 'configure terminal']) await r.executeCommand(c);
    return r;
  };

  it('`route-map RM permit 10` se pose et se relit', async () => {
    const d = await routeur();
    expect(await d.executeCommand('route-map RM permit 10'))
      .not.toMatch(/Invalid|Incomplete/);
    expect(await conf(d)).toContain('route-map RM permit 10');
  });

  it('`route-map RM` seul vaut `permit 10`', async () => {
    const d = await routeur();
    expect(await d.executeCommand('route-map RM')).not.toMatch(/Invalid|Incomplete/);
    expect(await conf(d)).toContain('route-map RM permit 10');
  });

  it('`route-map` seul est INCOMPLET', async () => {
    const d = await routeur();
    expect(await d.executeCommand('route-map')).toMatch(/Incomplete command/);
  });

  it('une action inventee est refusee', async () => {
    const d = await routeur();
    expect(await d.executeCommand('route-map RM zorglub')).toMatch(/Invalid input/);
  });

  it('un numero hors plage est refuse', async () => {
    const d = await routeur();
    expect(await d.executeCommand('route-map RM permit 99999')).toMatch(/Invalid input/);
  });

  it('`route-map RM ?` annonce `permit` et `deny`', async () => {
    const d = await routeur();
    expect(mots(d.cliHelp('route-map RM ')))
      .toEqual(expect.arrayContaining(['permit', 'deny']));
  });

  it('`no route-map RM` retire la carte', async () => {
    const d = await routeur();
    await d.executeCommand('route-map RM permit 10');
    await d.executeCommand('exit');
    expect(await d.executeCommand('no route-map RM')).not.toMatch(/Invalid|Incomplete/);
    expect(await conf(d)).not.toContain('route-map RM');
  });
});
