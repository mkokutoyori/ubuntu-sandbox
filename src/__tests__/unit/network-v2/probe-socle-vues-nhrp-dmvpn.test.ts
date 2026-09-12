/*
 * Les cinq vues NHRP/DMVPN d'un routeur passent au socle, par
 * l'adaptateur qui portait deja la famille `show crypto`.
 *
 * Elles vivaient dans le MEME constructeur que `show crypto`, et ce
 * constructeur etait deja collecte — mais son filtre ne prenait que les
 * chemins commencant par `show crypto`. Les vues de tunnel restaient
 * donc a l'arbre, a cote de leurs voisines immediates, pour une raison
 * qui ne tenait qu'a la premiere lettre du chemin. Elargir le filtre
 * suffit : l'elagage des chemins migres retire ensuite les noeuds des
 * deux arbres d'EXEC tout seul.
 *
 * Ce lot est un DEPLACEMENT, comme celui des vues d'un Catalyst, et il
 * se mesure pareil. Ces cinq-la sont enregistrees SANS argument, donc
 * `?` n'y promettait rien qu'elles ne tiennent ; ce qu'on leur reproche
 * est d'etre dans l'ancien moteur. Le cas qui DISCRIMINE est
 * l'inventaire : l'arbre ne les porte plus, et elles repondent quand
 * meme.
 *
 * Les TEMOINS gardent ce qu'un comptage de chemins ne verrait pas :
 * chaque vue rend sa table aux DEUX portees d'EXEC — ces commandes n'ont
 * jamais demande `enable` — et `show ip nhrp brief` reste DISTINCT de
 * `show ip nhrp`, ce qu'une declaration a place gloutonne aurait fondu
 * en une seule vue.
 *
 * cisco.com est bloque au telechargement par le mandataire de sortie de
 * ce reseau ; rien de ce qui est exige ici n'en depend.
 *
 * Discriminee contre l'etat d'avant : 2 des 17 cas tombent, un par
 * portee, et ce sont les deux qui interrogent l'inventaire. C'est le
 * compte attendu pour un deplacement : les quinze autres sont des
 * TEMOINS et disent que rien d'autre n'a bouge — les cinq vues rendent
 * leur table aux deux portees, `brief` et `summary` restent annonces
 * sous `show ip nhrp`, `detail` sous `show dmvpn`, le resume appelle
 * bien son gestionnaire et non celui de la table, et un mot de trop
 * reste refuse.
 */
import { describe, it, expect } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';

type Cli = {
  executeCommand: (c: string) => Promise<string>;
  cliHelp: (s: string) => string;
  powerOn: () => void;
  getShell: () => { getActiveTrie(): { enumerateExecutablePaths(): string[] } };
};

const MOT = /^\s\s(\S+)/;
const nomsAnnonces = (aide: string): string[] =>
  aide.includes('Invalid input') ? []
    : aide.split('\n').map((l) => MOT.exec(l)?.[1])
      .filter((m): m is string => !!m && m !== '<cr>');

let serie = 0;

async function routeur(...prelude: string[]): Promise<Cli> {
  const d = new CiscoRouter(`X${serie++}`, 2, 2) as unknown as Cli;
  d.powerOn();
  for (const c of prelude) await d.executeCommand(c);
  return d;
}

/*
 * Chaque vue est reconnue a SON en-tete, et non a l'absence d'un refus.
 *
 * Ecrit d'abord avec `not.toMatch(/Invalid|Incomplete/)`, comme les lots
 * precedents, ce fichier declarait `show ip nhrp summary` en echec : son
 * resume compte les entrees « Incomplete », qui est un ETAT du cache
 * NHRP et pas un message d'erreur. Un refus se reconnait au `%` d'IOS ;
 * chercher un mot anglais dans une table le confondait avec son contenu.
 */
const VUES: ReadonlyArray<readonly [string, RegExp]> = [
  ['show ip nhrp', /NHRP/i],
  ['show ip nhrp brief', /NHRP/i],
  ['show ip nhrp summary', /summary/i],
  ['show dmvpn', /DMVPN/i],
  ['show dmvpn detail', /DMVPN/i],
];

for (const [portee, prelude] of
  [['utilisateur', []], ['privilegie', ['enable']]] as Array<[string, string[]]>) {
  describe(`les vues repondent en EXEC ${portee} — les TEMOINS`, () => {
    it.each(VUES.map(([f]) => f))('`%s`', async (frappe) => {
      const attendu = VUES.find(([f]) => f === frappe)![1];
      const d = await routeur(...prelude);
      const out = String(await d.executeCommand(frappe));
      expect(out, `${frappe} est refuse`).not.toMatch(/^%/m);
      expect(out, `${frappe} ne rend pas sa vue`).toMatch(attendu);
    });

    it('l arbre ne porte plus ces chemins', async () => {
      const d = await routeur(...prelude);
      const chemins = d.getShell().getActiveTrie().enumerateExecutablePaths();
      for (const [frappe] of VUES) {
        expect(chemins, `${frappe} est encore dans l arbre`).not.toContain(frappe);
      }
    });
  });
}

describe('les sous-vues restent DISTINCTES — les TEMOINS', () => {
  it('`show ip nhrp ?` nomme `brief` et `summary`', async () => {
    const d = await routeur('enable');
    expect(nomsAnnonces(d.cliHelp('show ip nhrp ')))
      .toEqual(expect.arrayContaining(['brief', 'summary']));
  });

  it('`show dmvpn ?` nomme `detail`', async () => {
    const d = await routeur('enable');
    expect(nomsAnnonces(d.cliHelp('show dmvpn '))).toContain('detail');
  });

  /*
   * Ce que la sonde N'EXIGE PAS, et pourquoi : que `brief` et `detail`
   * rendent un texte DIFFERENT de leur vue nue. Sur une machine vierge
   * les deux rendent la meme phrase — « IP-NHRP table contains no
   * entries », « No DMVPN sessions » — parce qu'il n'y a rien a abreger
   * ni a detailler, et c'est juste. Ecrit a l'aveugle, ce fichier
   * l'exigeait ; la mesure l'a retire plutot que de monter un laboratoire
   * DMVPN pour prouver une chose que la migration ne touche pas.
   *
   * Ce qui est exige a la place tient au CHEMIN, et c'est ce que la
   * migration pouvait casser : trois vues NHRP et deux vues DMVPN, cinq
   * declarations distinctes, cinq gestionnaires distincts. Une place
   * gloutonne les aurait fondues en deux.
   */
  it('chaque vue appelle SON gestionnaire', async () => {
    const d = await routeur('enable');
    const resume = String(await d.executeCommand('show ip nhrp summary'));
    const cache = String(await d.executeCommand('show ip nhrp'));
    expect(resume, 'le resume rend la table').not.toBe(cache);
    expect(resume).toMatch(/summary/i);
  });
});

describe('un mot que la vue n evalue pas est refuse', () => {
  it.each(['show ip nhrp zorglub', 'show dmvpn zorglub'])('`%s`', async (frappe) => {
    const d = await routeur('enable');
    expect(await d.executeCommand(frappe), frappe).toMatch(/Invalid input/);
  });
});
