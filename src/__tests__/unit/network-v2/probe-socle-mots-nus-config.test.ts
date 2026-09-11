/*
 * Sonde ECRITE A L'AVEUGLE sur les QUATRE mots nus que les deux
 * plateformes gardent encore sur leur trie en configuration globale :
 * `archive`, `clock`, `crypto`, `ntp`.
 *
 * Ce sont les TETES de familles par ailleurs entierement declarees au
 * socle. Une tete gloutonne posee a cote d'une famille declaree est la
 * situation que ce depot traque : deux moteurs pour un mot, donc deux
 * reponses possibles a la meme frappe — et c'est le glouton, plus
 * permissif, qui gagne quand il gagne.
 *
 * cisco.com est bloque au telechargement par le mandataire de sortie de
 * ce reseau. Ce que la sonde exige ne demande aucune citation :
 *
 *   1. `?` n'annonce `<cr>` que la ou la frappe VALIDE ;
 *   2. chaque mot que `?` annonce s'EXECUTE ;
 *   3. un routeur et un Catalyst sont la MEME CLI ;
 *   4. un mot qui n'est qu'une TETE de famille rend « % Incomplete
 *      command. » — pas le caret, qui dit « ce mot n'existe pas », et
 *      surtout pas un succes silencieux.
 *
 * La seule chose qui vienne d'IOS est le statut de chacun des quatre, et
 * il se lit sur la machine elle-meme plutot que sur une reference :
 * `archive` OUVRE un sous-mode — c'est une commande a part entiere —
 * tandis que `clock`, `crypto` et `ntp` ne nomment qu'un sous-systeme.
 * La sonde mesure ce que la machine en fait plutot que de l'affirmer.
 *
 * `crypto zorglub` est le SEUL des quatre a ne pas etre exige au caret,
 * et c'est delibere : le glouton `crypto` existe pour RETENIR une ligne
 * que ce simulateur ne sait pas honorer, afin qu'un import de topologie
 * ne la perde pas — la nuance que la regle « ne jamais ranger un critere
 * qu'on n'evalue pas » prevoit explicitement pour ce cas. Ce qui n'en
 * releve pas, en revanche, c'est le mot NU : `crypto` seul n'est une
 * ligne d'aucune machine, et rien ne peut en etre retenu.
 *
 * Discriminee contre l'etat d'avant : 3 des 24 cas tombent — `crypto` nu
 * sur les deux plateformes, et l'invite de `archive` sur le Catalyst.
 * Les 21 qui passent des deux cotes sont nommes :
 *
 *   - `clock` et `ntp` nus rendaient deja « % Incomplete command. » sans
 *     promettre `<cr>`, et refusaient deja `zorglub` au caret. Ce sont
 *     les TEMOINS : ils prouvent que le laboratoire mesure quelque chose
 *     et que la forme attendue de `crypto` existe deja a cote de lui ;
 *   - « chaque mot que `?` annonce s EXECUTE » passait deja pour les
 *     quatre mots, sur les deux plateformes : le vocabulaire annonce
 *     etait juste, c'est la TETE qui mentait ;
 *   - `archive` ouvrait deja son sous-mode sur le ROUTEUR, et ses
 *     commandes repondaient deja sur le Catalyst. Le defaut n'etait ni
 *     le mode ni la famille : c'etait l'INVITE, qui rendait `S1>` — une
 *     invite d'EXEC utilisateur — a une session assise dans
 *     `config-archive`. Deux vues de la meme machine se contredisaient
 *     sur ou elle se trouve ;
 *   - les trois comparaisons entre plateformes passaient deja pour
 *     `clock` et `ntp` ; celle d'`archive` est celle qui tombe.
 */
import { describe, it, expect } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';

type Cli = {
  executeCommand: (c: string) => Promise<string>;
  cliHelp: (s: string) => string;
  getPrompt: () => string;
  powerOn: () => void;
};

const MOT = /^\s\s(\S+)/;
const mots = (aide: string): string[] =>
  aide.includes('Invalid input') ? []
    : aide.split('\n').map((l) => MOT.exec(l)?.[1]).filter((m): m is string => !!m);
const annonceCr = (aide: string): boolean =>
  aide.split('\n').some((l) => /^\s\s<cr>\s*$/.test(l));
const substitut = (mot: string): boolean =>
  mot.startsWith('<') || /^[A-Z0-9.:$/-]+$/.test(mot);

let serie = 0;

const FABRIQUES: ReadonlyArray<readonly [string, () => Cli]> = [
  ['routeur', () => new CiscoRouter(`X${serie++}`, 0, 0) as unknown as Cli],
  ['commutateur',
    () => new CiscoSwitch('switch-cisco', `X${serie++}`, 8, 0, 0) as unknown as Cli],
];

async function enConfig(fabrique: () => Cli): Promise<Cli> {
  const d = fabrique();
  d.powerOn();
  for (const c of ['enable', 'configure terminal']) await d.executeCommand(c);
  return d;
}

/** Les trois mots qui NOMMENT un sous-systeme sans etre une commande. */
const TETES: readonly string[] = ['clock', 'crypto', 'ntp'];

for (const [plateforme, fabrique] of FABRIQUES) {
  describe(`les mots nus de configuration, sur un ${plateforme}`, () => {
    for (const tete of TETES) {
      it(`\`${tete}\` seul est INCOMPLET, et \`?\` ne promet pas de \`<cr>\``, async () => {
        const d = await enConfig(fabrique);
        expect(annonceCr(d.cliHelp(`${tete} `)), `${tete} ? promet <cr>`).toBe(false);
        expect(await d.executeCommand(tete), tete).toMatch(/Incomplete command/);
      });

      it(`chaque mot que \`${tete} ?\` annonce s EXECUTE`, async () => {
        const d = await enConfig(fabrique);
        const offerts = mots(d.cliHelp(`${tete} `));
        expect(offerts.length, `${tete} ? n annonce rien`).toBeGreaterThan(0);
        for (const mot of offerts) {
          if (substitut(mot)) continue;
          const essai = await enConfig(fabrique);
          expect(await essai.executeCommand(`${tete} ${mot}`), `${tete} ${mot}`)
            .not.toMatch(/Invalid input/);
        }
      });

      if (tete !== 'crypto') {
        it(`\`${tete} zorglub\` est refuse au caret`, async () => {
          const d = await enConfig(fabrique);
          expect(await d.executeCommand(`${tete} zorglub`)).toMatch(/Invalid input/);
        });
      }
    }

    it('`archive` OUVRE son sous-mode — le TEMOIN', async () => {
      const d = await enConfig(fabrique);
      expect(await d.executeCommand('archive')).not.toMatch(/Invalid|Incomplete/);
      expect(d.getPrompt()).toMatch(/config-archive/);
    });

    it('chaque mot que `archive ?` annonce s EXECUTE', async () => {
      const d = await enConfig(fabrique);
      for (const mot of mots(d.cliHelp('archive '))) {
        if (substitut(mot)) continue;
        const essai = await enConfig(fabrique);
        expect(await essai.executeCommand(`archive ${mot}`), `archive ${mot}`)
          .not.toMatch(/Invalid input/);
      }
    });
  });
}

describe('les deux plateformes decrivent ces quatre mots pareil', () => {
  for (const place of ['clock ', 'ntp ', 'archive ']) {
    it(`\`${place}?\``, async () => {
      const r = await enConfig(FABRIQUES[0][1]);
      const s = await enConfig(FABRIQUES[1][1]);
      expect(s.cliHelp(place)).toBe(r.cliHelp(place));
    });
  }

  /*
   * `crypto` n'entre PAS dans la comparaison mot pour mot : un routeur
   * porte IPSec, IKEv2, PKI et les cartes de chiffrement, un Catalyst
   * n'a que `crypto key`. Ce qui doit se ressembler est la REPONSE au
   * mot nu, pas la liste qui le suit.
   */
  it('`crypto` seul rend le meme mot des deux cotes', async () => {
    const r = await enConfig(FABRIQUES[0][1]);
    const s = await enConfig(FABRIQUES[1][1]);
    expect(await s.executeCommand('crypto')).toBe(await r.executeCommand('crypto'));
  });
});
