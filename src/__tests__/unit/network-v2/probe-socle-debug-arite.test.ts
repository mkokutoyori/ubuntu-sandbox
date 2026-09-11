/*
 * Sonde sur l'ARITE de la famille `debug`, dans ses TROIS orthographes
 * — `debug X`, `no debug X`, `undebug X` — et sur les DEUX plateformes.
 *
 * Ecrite a l'aveugle. cisco.com est bloque au telechargement par le
 * mandataire de sortie de ce reseau, et rien de ce qui suit n'en demande
 * la lecture : ce sont les invariants que ce depot applique partout.
 *
 *   1. `?` n'annonce `<cr>` que la ou la frappe VALIDE ;
 *   2. chaque mot que `?` annonce s'EXECUTE — `% Incomplete command.`
 *      est une bonne reponse, `% Invalid input` non ;
 *   3. chaque ligne d'aide porte une DESCRIPTION, pas le nom interne de
 *      la place qui la produit ;
 *   4. les trois orthographes decrivent le meme fait, donc rendent le
 *      meme texte a la meme profondeur.
 *
 * POURQUOI LA FAMILLE ENTIERE : `debug` est le seul endroit de la CLI ou
 * une frappe fausse coute une session. L'operateur qui valide sur la
 * promesse de `<cr>` croit avoir arme une trace et ne l'a pas armee ; et
 * `debug ip` arme sur un routeur de production ce que `debug ip packet`
 * arme, c'est-a-dire une ligne par paquet.
 *
 * Le balayage est un GARDE-FOU et non une liste de cas : il descend
 * l'arbre d'aide et valide sur une machine NEUVE chaque `<cr>` annonce.
 * Une machine neuve par validation, sans quoi un balayage qui arme les
 * traces qu'il mesure ne mesure plus rien.
 *
 * Discriminee contre l'etat d'avant : 13 des 20 cas tombent. Les 7 qui
 * passent des deux cotes sont nommes :
 *
 *   - « chaque mot annonce s execute » passait deja sur les TROIS
 *     orthographes du ROUTEUR, et sur `no debug` / `undebug` du
 *     COMMUTATEUR. Ce sont les TEMOINS : le vocabulaire declare etait
 *     deja juste, et le seul endroit qui mentait est celui ou une
 *     DECORATION d'aide doublait la declaration —
 *     `registerSuggestions('debug', ...)`, posee sur la classe partagee,
 *     annoncait `crypto`, `domain` et `ipv6` a un Catalyst qui refuse
 *     les trois. La decoration ne touchait pas `no debug`, d'ou un
 *     mensonge dans une seule des trois orthographes ;
 *   - « les trois orthographes rendent le meme texte » passe des deux
 *     cotes, et c'est voulu : cette egalite a ete rendue STRUCTURELLE au
 *     lot precedent, ou `undebug` est ne de la meme liste de paires que
 *     `no debug`. Elle est ici la NON-REGRESSION du present lot — une
 *     arite corrigee d'un seul cote la casserait aussitot, et c'est
 *     exactement ce qu'on veut voir echouer.
 */
import { describe, it, expect } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';

type Cli = {
  executeCommand: (c: string) => Promise<string>;
  cliHelp: (s: string) => string;
  powerOn: () => void;
};

const LIGNE = /^\s\s(\S+)\s\s+(\S.*?)\s*$/;
const MOT = /^\s\s(\S+)/;

const mots = (aide: string): string[] =>
  aide.includes('Invalid input') ? []
    : aide.split('\n').map((l) => MOT.exec(l)?.[1])
      .filter((m): m is string => !!m && m !== '<cr>');

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

async function privilegie(fabrique: () => Cli): Promise<Cli> {
  const d = fabrique();
  d.powerOn();
  await d.executeCommand('enable');
  return d;
}

async function balayer(
  fabrique: () => Cli, racine: string,
  juger: (guide: Cli, base: string, aide: string) => Promise<string[]>,
): Promise<string[]> {
  const guide = await privilegie(fabrique);
  const fautes: string[] = [];
  const vus = new Set<string>();
  let file = [racine];
  for (let profondeur = 0; profondeur < 4; profondeur++) {
    const suivant: string[] = [];
    for (const base of file) {
      const aide = guide.cliHelp(`${base} `);
      fautes.push(...await juger(guide, base, aide));
      for (const mot of mots(aide)) {
        if (substitut(mot)) continue;
        const chemin = `${base} ${mot}`;
        if (vus.has(chemin)) continue;
        vus.add(chemin);
        suivant.push(chemin);
      }
    }
    file = suivant;
  }
  return fautes;
}

for (const [plateforme, fabrique] of FABRIQUES) {
  for (const racine of ['debug', 'no debug', 'undebug']) {
    describe(`\`${racine}\`, sur un ${plateforme}`, () => {
      it('un `<cr>` annonce se valide vraiment', async () => {
        const fautes = await balayer(fabrique, racine, async (_g, base, aide) => {
          if (!annonceCr(aide)) return [];
          const essai = await privilegie(fabrique);
          const rendu = String(await essai.executeCommand(base));
          return /Incomplete command|Invalid input/.test(rendu)
            ? [`«${base} ?» annonce <cr>, «${base}» rend ${rendu.split('\n').pop()}`]
            : [];
        });
        expect(fautes, fautes.join('\n')).toEqual([]);
      }, 240_000);

      it('chaque mot annonce s execute', async () => {
        const fautes = await balayer(fabrique, racine, async (_g, base, aide) => {
          const tombes: string[] = [];
          for (const mot of mots(aide)) {
            if (substitut(mot)) continue;
            const essai = await privilegie(fabrique);
            const rendu = String(await essai.executeCommand(`${base} ${mot}`));
            if (rendu.includes('Invalid input')) tombes.push(`«${base} ${mot}» refuse`);
          }
          return tombes;
        });
        expect(fautes, fautes.join('\n')).toEqual([]);
      }, 240_000);

      it('chaque ligne d aide porte une description', async () => {
        const fautes = await balayer(fabrique, racine, async (_g, base, aide) => {
          if (aide.includes('Invalid input')) return [];
          return aide.split('\n')
            .filter((l) => l.trim() !== '' && l.trim() !== '<cr>')
            .filter((l) => {
              const m = LIGNE.exec(l);
              return m === null || m[2] === m[1] || m[2] === 'rest';
            })
            .map((l) => `«${base} ?» rend une ligne sans description : ${l.trim()}`);
        });
        expect(fautes, fautes.join('\n')).toEqual([]);
      }, 240_000);
    });
  }

  describe(`les trois orthographes, sur un ${plateforme}`, () => {
    it('`undebug X ?` EST `no debug X ?`, a toute profondeur', async () => {
      const d = await privilegie(fabrique);
      const ecarts: string[] = [];
      const vus = new Set<string>();
      let file = [''];
      for (let profondeur = 0; profondeur < 3; profondeur++) {
        const suivant: string[] = [];
        for (const queue of file) {
          const nie = d.cliHelp(`no debug ${queue} `.replace(/\s+/g, ' '));
          const und = d.cliHelp(`undebug ${queue} `.replace(/\s+/g, ' '));
          if (nie !== und) ecarts.push(`«${queue}» : no debug != undebug`);
          for (const mot of mots(nie)) {
            if (substitut(mot)) continue;
            const chemin = `${queue} ${mot}`.trim();
            if (vus.has(chemin)) continue;
            vus.add(chemin);
            suivant.push(chemin);
          }
        }
        file = suivant;
      }
      expect(ecarts, ecarts.join('\n')).toEqual([]);
    }, 240_000);
  });
}
