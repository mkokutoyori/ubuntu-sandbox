/*
 * `sh ?` et `show ?` posent la MEME question et doivent couter le meme
 * ordre de grandeur.
 *
 * Mesure d'origine sur un routeur neuf : `cliHelp('show ')` 43 ms,
 * `cliHelp('sh ')` 3545 ms — quatre-vingts fois plus cher, la seule
 * difference etant que le premier mot est ABREGE. Le terminal appelle
 * cette porte a chaque `?`, donc un apprenant qui tape `sh ?` attendait
 * trois secondes et demie ; et la suite de tests, qui parcourt l'aide
 * entiere, y passait des minutes.
 *
 * Ce que la mesure a trouve : le pont d'ambiguite trie-vers-socle
 * n'est consulte QUE sur un mot abrege, et il jugeait la VISIBILITE de
 * chacune des mille commandes du socle avant de regarder si son chemin
 * avait seulement la bonne forme. `isReachable` interroge
 * l'autorisation, donc le canoniseur, donc la marche des arbres.
 *
 * Ce cas est un GARDE-FOU de cout, pas une mesure de performance : le
 * rapport, et non le temps absolu, est ce qui distingue « le pont est
 * consulte » de « le pont refait tout le travail a chaque mot ». La
 * borne est large exprès — une machine lente doit le passer, une
 * regression d'un facteur dix ne le doit pas.
 *
 * Discrimine par `git stash` sur `CiscoShellBase.ts` : les DEUX cas de
 * cout tombent avant correctif, et pas de peu — vingt secondes chacun
 * contre une fraction de seconde apres. Les trois autres passent des
 * deux cotes, et c'est leur objet : ils n'epinglent pas le cout mais la
 * CLE de la memoire, c'est-a-dire ce qu'un cache faux casserait.
 */
import { describe, it, expect } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';

type Cli = {
  executeCommand: (c: string) => Promise<string>;
  cliHelp: (s: string) => string;
  powerOn: () => void;
};

function chrono(f: () => unknown): number {
  const debut = Date.now();
  f();
  return Date.now() - debut;
}

/** La mediane de plusieurs releves, pour qu'un a-coup ne decide pas. */
function coutMedian(f: () => unknown, tours = 5): number {
  const releves = Array.from({ length: tours }, () => chrono(f));
  return releves.sort((a, b) => a - b)[Math.floor(tours / 2)];
}

function routeur(): Cli {
  const r = new CiscoRouter('R1', 0, 0) as unknown as Cli;
  r.powerOn();
  return r;
}

const FACTEUR_TOLERE = 8;

describe('l aide d un mot abrege coute le meme ordre que celle du mot entier', () => {
  it('sur une machine neuve, `sh ?` reste du meme ordre que `show ?`', () => {
    const r = routeur();
    r.cliHelp('show ');
    r.cliHelp('sh ');
    const entier = Math.max(1, coutMedian(() => r.cliHelp('show ')));
    const abrege = coutMedian(() => r.cliHelp('sh '));
    expect(abrege).toBeLessThan(entier * FACTEUR_TOLERE);
  });

  it('avec une regle de privilege posee, le rapport tient aussi', async () => {
    const r = routeur();
    for (const c of ['enable', 'configure terminal',
      'privilege exec level 15 show version', 'end', 'disable']) {
      await r.executeCommand(c);
    }
    r.cliHelp('show ');
    r.cliHelp('sh ');
    const entier = Math.max(1, coutMedian(() => r.cliHelp('show ')));
    const abrege = coutMedian(() => r.cliHelp('sh '));
    expect(abrege).toBeLessThan(entier * FACTEUR_TOLERE);
  });

  /*
   * La memoire des rivaux est indexee sur l'etat qui gouverne la
   * visibilite. Ces deux cas EPROUVENT la cle : sans le niveau dedans,
   * le premier repondrait sur les droits d'avant l'`enable` ; sans le
   * vidage a chaque commande, le second repondrait sur les regles
   * d'avant. Un cache faux serait pire que le cout qu'il economise.
   */
  it('la reponse suit le NIVEAU : ce qu un compte reduit ne voit pas, `enable` le montre', async () => {
    const r = routeur();
    for (const c of ['enable', 'configure terminal',
      'privilege exec level 15 show version', 'end', 'disable']) {
      await r.executeCommand(c);
    }
    const reduit = r.cliHelp('show ');
    await r.executeCommand('enable');
    const complet = r.cliHelp('show ');
    expect(/^\s+version\b/m.test(reduit)).toBe(false);
    expect(/^\s+version\b/m.test(complet)).toBe(true);
  });

  it('la reponse suit les REGLES : en poser une change l aide sans redemarrer', async () => {
    const r = routeur();
    await r.executeCommand('enable');
    const avant = r.cliHelp('show ');
    expect(/^\s+version\b/m.test(avant)).toBe(true);
    for (const c of ['configure terminal',
      'privilege exec level 15 show version', 'end', 'disable']) {
      await r.executeCommand(c);
    }
    expect(/^\s+version\b/m.test(r.cliHelp('show '))).toBe(false);
  });

  it('TEMOIN : l aide abregee rend la MEME liste que l aide entiere', () => {
    const r = routeur();
    const mots = (aide: string): string[] => aide.split('\n')
      .map((l) => l.trim().split(/\s+/)[0]).filter((m) => m.length > 0).sort();
    expect(mots(r.cliHelp('sh '))).toEqual(mots(r.cliHelp('show ')));
  });
});
