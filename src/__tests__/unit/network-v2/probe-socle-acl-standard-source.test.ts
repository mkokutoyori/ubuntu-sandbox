/*
 * Sonde ECRITE A L'AVEUGLE sur `permit`/`deny` dans une liste
 * d'acces STANDARD, avant toute lecture de leur declaration.
 *
 * cisco.com est bloque au telechargement par le mandataire de sortie de
 * ce reseau. L'autorite employee ici est donc celle que le depot porte
 * et applique : la grammaire que `parseStandardAce` evalue —
 *
 *   `{permit | deny} {any | host <adresse> | <adresse> [<masque>]}
 *      [log | log-input | time-range <nom>]`
 *
 * — plus deux invariants qui se mesurent sur la machine seule, sans
 * rien citer :
 *
 *   1. tout mot que `?` propose a une place s'execute a cette place ;
 *   2. `?` n'annonce `<cr>` que la ou la frappe est complete.
 *
 * POURQUOI CELA COMPTE ICI : une liste standard ne filtre que sur la
 * SOURCE. C'est peu de chose a decrire, et c'est precisement pour cela
 * qu'une aide fausse y est trompeuse — l'operateur n'a pas d'autre
 * repere. `permit any host` n'est pas une commande, et l'annoncer
 * derriere `permit any` invite a l'ecrire.
 *
 * Discriminee contre l'etat d'avant : 16 des 59 cas tombent, HUIT par
 * plateforme — la symetrie exacte montre que le sous-mode est bien
 * devenu commun, et que le defaut l'etait donc aussi. Les 43 autres
 * sont nommes ici plutot que laisses a decouvrir.
 *   - les six formes ACCEPTEES et les quatre REFUSEES passaient deja :
 *     c'est `parseCiscoAce` qui les tranche, et ce lot ne le deplace
 *     pas. Elles sont les TEMOINS — un correctif qui rendrait l'aide
 *     juste en cassant l'analyse serait un echange, pas une
 *     correction. `permit 10.0.0.5` rendu `permit host 10.0.0.5` en
 *     est le meilleur : il prouve que la place nue garde son sens ;
 *   - `no permit any` et `sequence 25 permit any` passaient, et le
 *     doivent : ce sont les VOISINS du chemin migre, et rien ne dit
 *     mieux qu'on ne les a pas emportes ;
 *   - `permit ?` annoncait deja ses trois formes et refusait deja
 *     `permit` seul. C'est APRES la source que tout se defaisait —
 *     l'arbre glouton reproposait ses deux mots-cles a chaque
 *     profondeur, et promettait un `<cr>` la ou la frappe est refusee ;
 *   - les sept comparaisons entre plateformes passaient : les deux
 *     etaient fausses de la MEME facon, depuis que le sous-mode est
 *     bati une fois. Elles restent parce que la refonte aurait pu les
 *     separer a nouveau.
 */
import { describe, it, expect } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';

type Cli = {
  executeCommand: (c: string) => Promise<string>;
  cliHelp: (s: string) => string;
  powerOn: () => void;
};

const MOT = /^\s\s(\S+)/;
const mots = (aide: string): string[] =>
  aide.split('\n').map((l) => MOT.exec(l)?.[1]).filter((m): m is string => !!m);
const annonceCr = (aide: string): boolean =>
  aide.split('\n').some((l) => /^\s\s<cr>\s*$/.test(l));

const HOTE = 'X';

let serie = 0;

async function standard(fabrique: () => Cli): Promise<Cli> {
  const d = fabrique();
  d.powerOn();
  for (const c of ['enable', 'configure terminal', 'ip access-list standard SL']) {
    await d.executeCommand(c);
  }
  return d;
}

const FABRIQUES: ReadonlyArray<readonly [string, () => Cli]> = [
  ['routeur', () => new CiscoRouter(`${HOTE}${serie++}`, 0, 0) as unknown as Cli],
  ['commutateur',
    () => new CiscoSwitch('switch-cisco', `${HOTE}${serie++}`, 8, 0, 0) as unknown as Cli],
];

async function conf(d: Cli): Promise<string> {
  await d.executeCommand('end');
  return d.executeCommand('show running-config');
}

/** Les places ou `?` doit se taire sur `any` et `host` : elles sont prises. */
const APRES_LA_SOURCE: readonly string[] = [
  'permit any ',
  'permit host 10.0.0.1 ',
  'permit 10.0.0.0 0.0.0.255 ',
];

for (const [plateforme, fabrique] of FABRIQUES) {
  describe(`la SOURCE d une liste standard, sur un ${plateforme}`, () => {
    const liste = () => standard(fabrique);

    it('`permit ?` annonce ses trois formes, et rien de plus', async () => {
      const d = await liste();
      expect(mots(d.cliHelp('permit ')).sort()).toEqual(['A.B.C.D', 'any', 'host']);
    });

    it('`permit ?` ne promet pas de `<cr>` — il faut une source', async () => {
      const d = await liste();
      expect(annonceCr(d.cliHelp('permit '))).toBe(false);
      expect(await d.executeCommand('permit')).toMatch(/Incomplete command/);
    });

    for (const place of APRES_LA_SOURCE) {
      it(`\`${place}?\` ne repropose ni \`any\` ni \`host\``, async () => {
        const d = await liste();
        const rendus = mots(d.cliHelp(place));
        expect(rendus, `${place}? propose any`).not.toContain('any');
        expect(rendus, `${place}? propose host`).not.toContain('host');
      });

      it(`\`${place}?\` promet un \`<cr>\` qui tient`, async () => {
        const d = await liste();
        expect(annonceCr(d.cliHelp(place))).toBe(true);
        expect(await d.executeCommand(place.trim())).not.toMatch(/Invalid|Incomplete/);
      });
    }

    it('`permit host ?` demande une ADRESSE, pas un mot', async () => {
      const d = await liste();
      expect(mots(d.cliHelp('permit host '))).toEqual(['A.B.C.D']);
    });

    it('`permit host` seul est INCOMPLET, sans `<cr>` menteur', async () => {
      const d = await liste();
      expect(annonceCr(d.cliHelp('permit host '))).toBe(false);
      expect(await d.executeCommand('permit host')).toMatch(/Incomplete command/);
    });

    it('`permit <adresse> ?` annonce le MASQUE', async () => {
      const d = await liste();
      expect(mots(d.cliHelp('permit 10.0.0.0 '))).toContain('A.B.C.D');
    });

    it('`log` est annonce partout ou il s applique', async () => {
      const d = await liste();
      for (const place of APRES_LA_SOURCE) {
        expect(mots(d.cliHelp(place)), place).toContain('log');
      }
    });

    it('un protocole n existe pas dans une liste standard', async () => {
      const d = await liste();
      const rendus = mots(d.cliHelp('permit '));
      for (const proto of ['ip', 'tcp', 'udp', 'icmp']) {
        expect(rendus, `permit ? offre ${proto}`).not.toContain(proto);
      }
      expect(await d.executeCommand('permit tcp any any')).toMatch(/Invalid input/);
    });

    it('chaque mot annonce apres `permit` s EXECUTE', async () => {
      const d = await liste();
      for (const mot of mots(d.cliHelp('permit '))) {
        if (mot === '<cr>' || /^[A-Z]/.test(mot)) continue;
        const reponse = await d.executeCommand(`permit ${mot}`);
        expect(reponse, `permit ? offre ${mot}, refuse ensuite`)
          .not.toMatch(/Invalid input/);
      }
    });
  });

  describe(`les formes acceptees d une liste standard, sur un ${plateforme}`, () => {
    const POSEES: ReadonlyArray<readonly [string, string]> = [
      ['permit any', 'permit any'],
      ['deny any', 'deny any'],
      ['permit host 10.0.0.1', 'permit host 10.0.0.1'],
      ['permit 10.0.0.0 0.0.0.255', 'permit 10.0.0.0 0.0.0.255'],
      ['permit 10.0.0.5', 'permit host 10.0.0.5'],
      ['permit any log', 'permit any log'],
    ];
    for (const [saisie, rendu] of POSEES) {
      it(`\`${saisie}\` se pose et se relit \`${rendu}\``, async () => {
        const d = await standard(fabrique);
        expect(await d.executeCommand(saisie)).not.toMatch(/Invalid|Incomplete/);
        expect(await conf(d)).toContain(` ${rendu}`);
      });
    }

    const REFUSEES: readonly string[] = [
      'permit zorglub',
      'permit host zorglub',
      'permit any zorglub',
      'permit 10.0.0.0 zorglub',
    ];
    for (const saisie of REFUSEES) {
      it(`\`${saisie}\` est refusee au caret`, async () => {
        const d = await standard(fabrique);
        expect(await d.executeCommand(saisie))
          .toMatch(/Invalid input detected at '\^' marker/);
        expect(await conf(d)).not.toContain('zorglub');
      });
    }

    it('`no permit any` retire l entree — le TEMOIN de la negation', async () => {
      const d = await standard(fabrique);
      await d.executeCommand('permit any');
      expect(await d.executeCommand('no permit any')).not.toMatch(/Invalid|Incomplete/);
      expect(await conf(d)).not.toContain('permit any');
    });

    it('`sequence <n> permit any` garde son rang — le TEMOIN du voisin', async () => {
      const d = await standard(fabrique);
      expect(await d.executeCommand('sequence 25 permit any'))
        .not.toMatch(/Invalid|Incomplete/);
      expect(await conf(d)).toContain('25 permit any');
    });
  });
}

describe('les deux plateformes decrivent la SOURCE avec les memes mots', () => {
  const PLACES: readonly string[] = [
    'permit ', 'deny ', 'permit any ', 'permit host ', 'permit host 10.0.0.1 ',
    'permit 10.0.0.0 ', 'permit 10.0.0.0 0.0.0.255 ',
  ];
  for (const place of PLACES) {
    it(`\`${place}?\``, async () => {
      const r = await standard(FABRIQUES[0][1]);
      const s = await standard(FABRIQUES[1][1]);
      expect(s.cliHelp(place)).toBe(r.cliHelp(place));
    });
  }
});
