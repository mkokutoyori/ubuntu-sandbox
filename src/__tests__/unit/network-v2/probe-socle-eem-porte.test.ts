/*
 * `event manager environment FOO` etait accepte et ne posait rien.
 *
 *     if (args[0] && args[1] !== undefined) eem().setEnvironment(...)
 *     return '';
 *
 * Une variable sans valeur tombait donc dans le `return ''` final :
 * acceptee, oubliee, et la configuration relue n'en portait pas trace.
 * `no event manager applet` tout seul faisait de meme — il ne nommait
 * aucun applet et repondait comme s'il en avait retire un.
 *
 * Le SOUS-MODE des applets (`config-applet`) etait migre depuis un lot
 * anterieur ; sa PORTE, sa negation et la variable d'environnement
 * restaient a l'arbre. Une famille a moitie migree oblige a se
 * demander, pour chaque frappe, quel moteur repond — c'est la meme
 * situation que `key chain` plus tot dans cette campagne.
 *
 * Un troisieme mot manquait a l'aide : `authorization`. Le glouton le
 * cherchait n'importe ou dans la ligne et rangeait le mot suivant, donc
 * la forme EXISTE — elle n'etait annoncee nulle part, et
 * `event manager applet FOO bar baz` avalait `bar baz` en silence.
 *
 * cisco.com est bloque au telechargement par le mandataire de sortie de
 * ce reseau. Ce que la sonde exige ne demande aucune citation :
 *
 *   1. ce que le moteur n'evalue pas est REFUSE, pas ignore ;
 *   2. `?` n'annonce `<cr>` que la ou la frappe VALIDE ;
 *   3. l'aide NOMME ce que le moteur range ;
 *   4. une porte MENE a son sous-mode, et ce qu'on y pose se relit.
 *
 * Le point 4 est celui qui vaut la sonde. Une porte declaree qui
 * n'entrerait plus dans son sous-mode REUSSIRAIT en silence : l'applet
 * serait cree, et la premiere ligne d'action refusee en configuration
 * globale. Le laboratoire fait donc le tour complet — creer, entrer,
 * poser un declencheur et une action, sortir, relire.
 *
 * ET C'EST LUI QUI A TROUVE LE DEFAUT LE PLUS COUTEUX DU LOT.
 *
 * `event none` se RENDAIT vide : `renderTrigger` n'avait pas de cas
 * pour lui et retournait la chaine nulle, donc le serialiseur ecrivait
 * une ligne faite d'un seul espace. Une ligne blanche FERME le bloc de
 * l'applet, et toutes les actions qui la suivaient disparaissaient de
 * `show running-config`. Mesure, avant correctif :
 *
 *     event manager applet A          <- et rien d'autre
 *     event manager applet B
 *      event syslog pattern "UP"
 *      action 1.0 syslog msg "deux"   <- le meme applet, sans event none
 *
 * `event none` est la forme de tous les tutoriels EEM — un applet qu'on
 * declenche a la main — donc l'applet le plus courant revenait VIDE
 * d'un export de topologie, sans qu'un mot le dise, alors que l'agent
 * gardait bien ses actions. Le tour complet est la seule facon de voir
 * ce genre de chose : ni la pose, ni la vue, ni l'aide ne mentaient.
 *
 * Discriminee contre l'etat d'avant : 5 des 13 cas tombent. Les 8
 * temoins disent ce qui marchait deja — `event manager applet` exigeait
 * son nom, `event manager ?` nommait ses deux suites, `authorization` se
 * posait et se relisait, la variable aussi, et la negation nommee
 * retirait bien l'applet.
 */
import { describe, it, expect } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';

type Cli = {
  executeCommand: (c: string) => Promise<string>;
  cliHelp: (s: string) => string;
  powerOn: () => void;
};

const MOT = /^\s\s(\S+)/;
const nomsAnnonces = (aide: string): string[] =>
  aide.includes('Invalid input') ? []
    : aide.split('\n').map((l) => MOT.exec(l)?.[1])
      .filter((m): m is string => !!m && m !== '<cr>');
const annonceCr = (aide: string): boolean =>
  aide.split('\n').some((l) => /^\s\s<cr>\s*$/.test(l));

let serie = 0;

async function config(...prelude: string[]): Promise<Cli> {
  const d = new CiscoRouter(`X${serie++}`, 2, 2) as unknown as Cli;
  d.powerOn();
  for (const c of ['enable', 'configure terminal', ...prelude]) await d.executeCommand(c);
  return d;
}

describe('une frappe incomplete le dit, et son aide aussi', () => {
  it.each([
    'event manager applet',
    'event manager environment',
    'event manager environment SEUIL',
    'no event manager applet',
  ])('`%s ?`', async (frappe) => {
    const d = await config();
    expect(annonceCr(d.cliHelp(`${frappe} `)), `${frappe} ? promet <cr>`).toBe(false);
    expect(await d.executeCommand(frappe), frappe).toMatch(/Incomplete command/);
  });
});

describe('l aide NOMME ce que le moteur range', () => {
  it('`event manager ?` nomme ses deux suites', async () => {
    const d = await config();
    expect(nomsAnnonces(d.cliHelp('event manager ')))
      .toEqual(expect.arrayContaining(['applet', 'environment']));
  });

  it('`event manager applet NOM ?` annonce `authorization`', async () => {
    const d = await config();
    expect(nomsAnnonces(d.cliHelp('event manager applet SURVEILLE ')))
      .toContain('authorization');
  });

  it('`event manager applet NOM ?` garde son `<cr>`', async () => {
    const d = await config();
    expect(annonceCr(d.cliHelp('event manager applet SURVEILLE '))).toBe(true);
  });
});

describe('la porte MENE a son sous-mode, et ce qu on y pose se relit', () => {
  it('le tour complet : creer, entrer, poser, relire', async () => {
    const d = await config('event manager applet SURVEILLE');
    expect(await d.executeCommand('event none'), 'le declencheur est refuse')
      .not.toMatch(/Invalid|Incomplete/);
    expect(await d.executeCommand('action 1.0 syslog msg "essai"'),
      'l action est refusee').not.toMatch(/Invalid|Incomplete/);
    await d.executeCommand('end');
    const cfg = String(await d.executeCommand('show running-config'));
    expect(cfg, 'l applet ne se relit pas').toMatch(/event manager applet SURVEILLE/);
    expect(cfg, 'l action ne se relit pas').toMatch(/action 1\.0 syslog/);
  });

  it('`authorization` pose se relit', async () => {
    const d = await config('event manager applet SURVEILLE authorization bypass', 'exit');
    await d.executeCommand('end');
    expect(String(await d.executeCommand('show running-config')))
      .toMatch(/event manager applet SURVEILLE authorization bypass/);
  });

  it('la variable posee se relit', async () => {
    const d = await config('event manager environment SEUIL 80');
    await d.executeCommand('end');
    expect(String(await d.executeCommand('show running-config')))
      .toMatch(/event manager environment SEUIL 80/);
  });

  it('`no event manager applet NOM` retire l applet — le TEMOIN', async () => {
    const d = await config('event manager applet SURVEILLE', 'event none', 'exit');
    await d.executeCommand('end');
    expect(String(await d.executeCommand('show running-config')))
      .toMatch(/event manager applet SURVEILLE/);
    await d.executeCommand('configure terminal');
    expect(await d.executeCommand('no event manager applet SURVEILLE'))
      .not.toMatch(/Invalid|Incomplete/);
    await d.executeCommand('end');
    expect(String(await d.executeCommand('show running-config')),
      'l applet survit a son retrait').not.toMatch(/event manager applet SURVEILLE/);
  });
});

describe('un mot de trop est refuse', () => {
  it.each([
    'event manager applet SURVEILLE zorglub',
    'event manager zorglub',
  ])('`%s`', async (frappe) => {
    const d = await config();
    expect(await d.executeCommand(frappe), frappe).toMatch(/Invalid input/);
  });
});
