/*
 * Le sous-mode des cartes d'acces VLAN refusait avec une phrase
 * INVENTEE, promettait `<cr>` deux fois pour rien, et laissait un mot
 * sans description.
 *
 * Mesure, avant correctif :
 *
 *   action zorglub     ->  % Invalid action
 *   action             ->  % Invalid action
 *   action ?           ->  drop / forward / <cr>
 *   match ip address ? ->  WORD / <cr>
 *   ?                  ->  « match » seul, sans description
 *
 * Quatre defauts, de trois familles differentes.
 *
 * `% Invalid action` n'existe pas sur IOS : une valeur hors de ce que la
 * commande accepte est refusee au CARET, comme partout ailleurs. Le
 * gestionnaire l'ecrivait a la main, et c'est la variante
 * « repondu-par-une-phrase-inventee » que cette campagne ferme partout.
 *
 * Le meme message servait aussi pour `action` TOUT SEUL, ou la bonne
 * reponse est `% Incomplete command.` — le mot manquant n'est pas une
 * valeur fautive. Le gestionnaire ne distinguait pas les deux cas parce
 * qu'il lisait `args[0]` sans regarder s'il y en avait un.
 *
 * Les deux `<cr>` MENTENT : l'aide promet qu'on peut valider la, et la
 * validation repond par un refus dans les deux cas. C'est l'invariant
 * que cette campagne tient depuis le debut — `?` n'annonce `<cr>` que la
 * ou la frappe VALIDE.
 *
 * Et `match` etait annonce NU. Tout mot que `?` propose doit porter une
 * description ; celui-la n'en avait pas parce qu'aucun noeud
 * intermediaire ne le declarait, seulement ses deux enfants.
 *
 * La negation manquait aussi : `no match ip address LISTE` etait refuse,
 * alors que c'est la facon documentee de retirer une liste d'une carte.
 * Elle est declaree ici et retire les listes NOMMEES. `action` n'en
 * recoit pas : sa valeur par defaut est rendue inconditionnellement
 * (`action forward` apparait des la creation de la carte), donc « ne
 * plus avoir d'action » n'est pas un etat que ce moteur distingue, et
 * inventer la semantique de `no action` demanderait une source que ce
 * reseau ne peut pas atteindre — cisco.com est bloque au telechargement
 * par le mandataire de sortie.
 *
 * Discriminee contre l'etat d'avant (`git stash`) : 7 des 16 cas
 * tombent — les deux refus au caret, le refus « incomplete », les deux
 * `<cr>` menteurs, la description de `match`, et la negation. Les 9
 * autres sont des NON-REGRESSIONS : les deux actions et les deux formes
 * de `match` se posent et se relisent, une liste multiple est gardee en
 * entier, et les refus qui MARCHAIENT deja (un mot de trop, un mot-cle
 * inconnu) continuent de marcher. Sans eux, tout refuser passerait pour
 * un succes.
 */
import { describe, it, expect } from 'vitest';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';

type Cli = {
  executeCommand: (c: string) => Promise<string>;
  cliHelp: (s: string) => string;
  powerOn: () => void;
};

const MOT = /^\s\s(\S+)/;
const annonceCr = (aide: string): boolean =>
  aide.split('\n').some((l) => /^\s\s<cr>\s*$/.test(l));
const descriptionDe = (aide: string, mot: string): string | undefined => {
  for (const ligne of aide.split('\n')) {
    if (MOT.exec(ligne)?.[1] === mot) return ligne.trim().split(/\s{2,}/)[1];
  }
  return undefined;
};

let serie = 0;

async function carte(...prelude: string[]): Promise<Cli> {
  const d = new CiscoSwitch('switch-cisco', `S${serie++}`, 8) as unknown as Cli;
  d.powerOn();
  for (const c of ['enable', 'configure terminal', 'vlan access-map CARTE 10', ...prelude]) {
    await d.executeCommand(c);
  }
  return d;
}

async function configuration(d: Cli): Promise<string> {
  await d.executeCommand('end');
  return String(await d.executeCommand('show running-config'));
}

describe('la carte d\'acces VLAN refuse comme IOS refuse', () => {
  describe('plus de phrase inventee', () => {
    it('`action zorglub` est refuse au CARET', async () => {
      const d = await carte();
      const sortie = await d.executeCommand('action zorglub');
      expect(sortie, 'la phrase inventee survit').not.toMatch(/Invalid action/);
      expect(sortie).toMatch(/Invalid input/);
    });

    it('`action` nu est INCOMPLETE, pas invalide', async () => {
      const d = await carte();
      expect(await d.executeCommand('action')).toMatch(/Incomplete command/);
    });
  });

  describe('les `<cr>` annonces sont tenus', () => {
    it.each(['action', 'match ip address', 'match mac address'])(
      '`%s ?` ne promet pas `<cr>`', async (frappe) => {
        const d = await carte();
        expect(annonceCr(d.cliHelp(`${frappe} `)), `${frappe} ? promet <cr>`).toBe(false);
      });
  });

  it('`match` porte une description', async () => {
    const d = await carte();
    expect(descriptionDe(d.cliHelp(''), 'match')).toBeTruthy();
  });

  describe('la negation retire ce que la pose a mis', () => {
    it('`no match ip address LISTE` retire la liste', async () => {
      const d = await carte('match ip address LISTE');
      expect(await d.executeCommand('no match ip address LISTE'))
        .not.toMatch(/Invalid input|Incomplete/);
      expect(await configuration(d), 'la liste survit a son retrait')
        .not.toMatch(/match ip address LISTE/);
    });
  });

  describe('ce qui marchait marche encore — les TEMOINS', () => {
    it.each([
      ['action forward', /action forward/],
      ['action drop', /action drop/],
      ['match ip address LISTE', /match ip address LISTE/],
      ['match mac address MACL', /match mac address MACL/],
    ] as Array<[string, RegExp]>)('`%s` se pose et se relit', async (ligne, attendu) => {
      const d = await carte(ligne);
      expect(await configuration(d)).toMatch(attendu);
    });

    it('une liste MULTIPLE est gardee en entier', async () => {
      const d = await carte('match ip address LISTE AUTRE');
      expect(await configuration(d)).toMatch(/match ip address LISTE AUTRE/);
    });

    it.each([
      'action forward zorglub',
      'match ip zorglub',
      'match zorglub',
      'match ip address',
    ])('`%s` est refuse', async (ligne) => {
      const d = await carte();
      expect(await d.executeCommand(ligne), ligne)
        .toMatch(/Invalid input|Incomplete command/);
    });
  });
});
