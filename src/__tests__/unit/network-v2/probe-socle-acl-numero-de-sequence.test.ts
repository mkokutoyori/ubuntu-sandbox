/*
 * Sonde ECRITE A L'AVEUGLE sur le NUMERO DE SEQUENCE et les mots qui
 * restent dans un sous-mode de liste nommee, avant toute lecture de
 * leur declaration.
 *
 * cisco.com est bloque au telechargement par le mandataire de sortie de
 * ce reseau ; la recherche, elle, passe. Ce que la documentation Cisco
 * donne pour ce sous-mode (« IP Access List Entry Sequence Numbering »,
 * et « Creating an IP Access List ») :
 *
 *   - le numero de sequence s'ecrit NU, en tete de l'entree —
 *     `10 deny tcp host 10.1.1.1 any eq 80` — et l'aide l'annonce comme
 *     une place, `<1-2147483647>  Sequence Number` ;
 *   - `remark` est decrit « Access list entry comment », et une remarque
 *     est bornee a cent caracteres ;
 *   - `permit` est decrit « Specify packets to forward ».
 *
 * L'invariant du depot fait le reste : ce que `?` annonce s'execute, ce
 * que la machine accepte est annonce, et `<cr>` n'est promis que la ou
 * la frappe est complete.
 *
 * POURQUOI CELA COMPTE : le numero de sequence est ce qui permet
 * d'INSERER une entree au milieu d'une liste. Un operateur qui ne le
 * trouve pas dans `?` reecrit la liste entiere, et une aide qui lui
 * propose un mot que la machine de reference n'a pas lui apprend une
 * syntaxe qu'il ne pourra pas rejouer.
 *
 * Discriminee contre l'etat d'avant : 18 des 62 cas tombent, NEUF par
 * plateforme — la symetrie exacte dit que le sous-mode est commun. Les
 * 44 autres sont nommes :
 *
 *   - la ligne NUMEROTEE fonctionnait deja, et c'est le point de ce
 *     lot : elle marchait par une REECRITURE de texte devant
 *     l'analyseur (`25 permit any` devenait `sequence 25 permit any`),
 *     invisible de `?`. Les cas qui la posent, la relisent, la trient
 *     et la retirent sont donc des TEMOINS — ils prouvent que le
 *     chemin declare rend exactement ce que la reecriture rendait ;
 *   - `remark` et sa borne a cent caracteres, `evaluate` et son nom,
 *     `no <numero>` : tous acceptes avant comme apres. Ce lot deplace
 *     la DECLARATION, pas la grammaire ;
 *   - `evaluate` refuse dans une liste STANDARD est le TEMOIN de la
 *     separation des deux sous-modes, acquise au lot precedent ;
 *   - les huit comparaisons entre plateformes passaient : les deux
 *     etaient fausses de la MEME facon, et elles restent parce que la
 *     refonte aurait pu les separer a nouveau.
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
const ligneDe = (aide: string, mot: string): string =>
  aide.split('\n').find((l) => MOT.exec(l)?.[1] === mot) ?? '';
const annonceCr = (aide: string): boolean =>
  aide.split('\n').some((l) => /^\s\s<cr>\s*$/.test(l));

let serie = 0;

const FABRIQUES: ReadonlyArray<readonly [string, () => Cli]> = [
  ['routeur', () => new CiscoRouter(`X${serie++}`, 0, 0) as unknown as Cli],
  ['commutateur',
    () => new CiscoSwitch('switch-cisco', `X${serie++}`, 8, 0, 0) as unknown as Cli],
];

const LISTES: ReadonlyArray<readonly ['standard' | 'etendue', string, string]> = [
  ['standard', 'ip access-list standard SL', 'permit any'],
  ['etendue', 'ip access-list extended EL', 'permit ip any any'],
];

async function entrer(fabrique: () => Cli, liste: string): Promise<Cli> {
  const d = fabrique();
  d.powerOn();
  for (const c of ['enable', 'configure terminal', liste]) await d.executeCommand(c);
  return d;
}

async function conf(d: Cli): Promise<string> {
  await d.executeCommand('end');
  return d.executeCommand('show running-config');
}

for (const [plateforme, fabrique] of FABRIQUES) {
  for (const [genre, liste, ace] of LISTES) {
    describe(`le NUMERO DE SEQUENCE d une liste ${genre}, sur un ${plateforme}`, () => {
      const dans = () => entrer(fabrique, liste);

      it('`?` annonce la PLACE du numero', async () => {
        const d = await dans();
        expect(mots(d.cliHelp(''))).toContain('<1-2147483647>');
      });

      it('la place du numero porte la phrase de Cisco', async () => {
        const d = await dans();
        expect(ligneDe(d.cliHelp(''), '<1-2147483647>')).toContain('Sequence Number');
      });

      it('un numero NU en tete range l entree a ce rang', async () => {
        const d = await dans();
        expect(await d.executeCommand(`25 ${ace}`)).not.toMatch(/Invalid|Incomplete/);
        expect(await conf(d)).toContain(`25 ${ace}`);
      });

      it('un numero seul est INCOMPLET, sans `<cr>` menteur', async () => {
        const d = await dans();
        expect(annonceCr(d.cliHelp('25 '))).toBe(false);
        expect(await d.executeCommand('25')).toMatch(/Incomplete command/);
      });

      it('`25 ?` annonce ce qu une entree peut etre', async () => {
        const d = await dans();
        const rendus = mots(d.cliHelp('25 '));
        expect(rendus).toContain('permit');
        expect(rendus).toContain('deny');
      });

      it('les entrees se relisent DANS L ORDRE de leurs numeros', async () => {
        const d = await dans();
        await d.executeCommand(`30 ${ace}`);
        await d.executeCommand(`20 ${ace.replace('permit', 'deny')}`);
        const texte = await conf(d);
        expect(texte.indexOf(' 20 ')).toBeLessThan(texte.indexOf(' 30 '));
      });

      it('`no <numero>` retire l entree de ce rang', async () => {
        const d = await dans();
        await d.executeCommand(`25 ${ace}`);
        expect(await d.executeCommand('no 25')).not.toMatch(/Invalid|Incomplete/);
        expect(await conf(d)).not.toContain(`25 ${ace}`);
      });
    });

    describe(`les MOTS restants d une liste ${genre}, sur un ${plateforme}`, () => {
      const dans = () => entrer(fabrique, liste);

      it('`remark` porte la phrase de Cisco', async () => {
        const d = await dans();
        expect(ligneDe(d.cliHelp(''), 'remark')).toContain('Access list entry comment');
      });

      it('`remark ?` annonce un TEXTE, pas un mot', async () => {
        const d = await dans();
        expect(mots(d.cliHelp('remark '))).toContain('LINE');
        expect(annonceCr(d.cliHelp('remark '))).toBe(false);
      });

      it('une remarque se pose et se relit', async () => {
        const d = await dans();
        expect(await d.executeCommand('remark trafic du site'))
          .not.toMatch(/Invalid|Incomplete/);
        expect(await conf(d)).toContain('remark trafic du site');
      });

      it('une remarque est bornee a cent caracteres', async () => {
        const d = await dans();
        await d.executeCommand(`remark ${'a'.repeat(150)}`);
        expect(await conf(d)).toContain(`remark ${'a'.repeat(100)}`);
        expect(await conf(d)).not.toContain('a'.repeat(101));
      });

      it('chaque mot que `?` annonce ici s EXECUTE', async () => {
        const d = await dans();
        for (const mot of mots(d.cliHelp(''))) {
          if (mot === '<cr>' || /^[<A-Z]/.test(mot)) continue;
          if (mot === 'end' || mot === 'exit' || mot === 'do') continue;
          const reponse = await d.executeCommand(mot);
          expect(reponse, `? offre ${mot}, refuse ensuite`)
            .not.toMatch(/Invalid input/);
        }
      });
    });
  }

  describe(`\`evaluate\` n existe que dans une liste ETENDUE, sur un ${plateforme}`, () => {
    it('la liste etendue l annonce avec la phrase de Cisco', async () => {
      const d = await entrer(fabrique, LISTES[1][1]);
      expect(ligneDe(d.cliHelp(''), 'evaluate')).toContain('Evaluate an access list');
    });

    it('`evaluate ?` demande un NOM, sans `<cr>` menteur', async () => {
      const d = await entrer(fabrique, LISTES[1][1]);
      expect(mots(d.cliHelp('evaluate '))).toContain('WORD');
      expect(annonceCr(d.cliHelp('evaluate '))).toBe(false);
      expect(await d.executeCommand('evaluate')).toMatch(/Incomplete command/);
    });

    it('la liste STANDARD ne l annonce pas et le refuse — le TEMOIN', async () => {
      const d = await entrer(fabrique, LISTES[0][1]);
      expect(mots(d.cliHelp(''))).not.toContain('evaluate');
      expect(await d.executeCommand('evaluate M')).toMatch(/Invalid input/);
    });
  });
}

describe('les deux plateformes decrivent le sous-mode avec les memes mots', () => {
  const PLACES: readonly string[] = ['', '25 ', 'remark ', 'no '];
  for (const [genre, liste] of LISTES) {
    for (const place of PLACES) {
      it(`liste ${genre} — \`${place}?\``, async () => {
        const r = await entrer(FABRIQUES[0][1], liste);
        const s = await entrer(FABRIQUES[1][1], liste);
        expect(s.cliHelp(place)).toBe(r.cliHelp(place));
      });
    }
  }
});
