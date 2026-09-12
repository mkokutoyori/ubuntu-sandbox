/*
 * La famille `key chain` quitte l'arbre en ENTIER — sa porte, sa vue, et
 * ses deux sous-modes qui l'avaient deja quitte.
 *
 * Les sous-modes `config-keychain` et `config-keychain-key` etaient
 * migres depuis un lot anterieur ; restaient la PORTE qui y mene
 * (`key chain <nom>`), sa negation, et la vue qui les relit
 * (`show key chain`). Une famille a moitie migree est le pire des deux
 * etats : elle oblige a se demander, pour chaque frappe, quel moteur
 * repond.
 *
 * cisco.com est bloque au telechargement par le mandataire de sortie de
 * ce reseau. Ce que la sonde exige ne demande aucune citation :
 *
 *   1. `?` n'annonce `<cr>` que la ou la frappe VALIDE — la porte exige
 *      un nom ;
 *   2. la porte MENE au sous-mode, et ce qu'on y pose se relit ;
 *   3. la vue se lit aux deux portees d'EXEC, avec et sans nom ;
 *   4. l'arbre ne porte plus aucun des trois chemins.
 *
 * Le point 2 est celui qui vaut la sonde. Une porte declaree au socle
 * qui n'entrerait plus dans son sous-mode laisserait la commande
 * REUSSIR et le mode inchange : `key 1` serait alors refuse en
 * configuration globale, et l'operateur verrait une chaine creee et
 * inutilisable. Le cas complet — creer, entrer, poser une cle, la
 * relire — est ce qui distingue une porte d'une commande.
 *
 * Discriminee contre l'etat d'avant : 3 des 11 cas tombent, un par mode,
 * et ce sont les trois qui interrogent l'inventaire. Les huit autres
 * sont des TEMOINS, et c'est le compte qu'on attend d'un DEPLACEMENT :
 * la porte exigeait deja son nom, le sous-mode s'ouvrait deja, la
 * negation retirait deja la chaine, et la vue repondait deja aux deux
 * portees. La migration ne devait rien changer de tout cela — elle
 * devait seulement retirer les chemins de l'ancien moteur — et ces huit
 * temoins sont ce qui le prouve, la ou trois assertions d'inventaire
 * seules se satisferaient d'une famille cassee.
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
const annonceCr = (aide: string): boolean =>
  aide.split('\n').some((l) => /^\s\s<cr>\s*$/.test(l));

let serie = 0;

async function routeur(...prelude: string[]): Promise<Cli> {
  const d = new CiscoRouter(`X${serie++}`, 2, 2) as unknown as Cli;
  d.powerOn();
  for (const c of prelude) await d.executeCommand(c);
  return d;
}

describe('la porte exige son nom', () => {
  it('`key chain ?` ne promet pas `<cr>`', async () => {
    const d = await routeur('enable', 'configure terminal');
    expect(annonceCr(d.cliHelp('key chain '))).toBe(false);
    expect(await d.executeCommand('key chain')).toMatch(/Incomplete command/);
  });

  it('`key chain ?` annonce le nom', async () => {
    const d = await routeur('enable', 'configure terminal');
    expect(nomsAnnonces(d.cliHelp('key chain '))).toContain('WORD');
  });
});

describe('la porte MENE au sous-mode — le TEMOIN', () => {
  it('creer, entrer, poser une cle, la relire', async () => {
    const d = await routeur('enable', 'configure terminal');
    expect(await d.executeCommand('key chain RIP-KEYS'))
      .not.toMatch(/Invalid|Incomplete/);
    expect(await d.executeCommand('key 1'), 'le sous-mode n a pas ete atteint')
      .not.toMatch(/Invalid|Incomplete/);
    expect(await d.executeCommand('key-string s3cr3t'))
      .not.toMatch(/Invalid|Incomplete/);
    await d.executeCommand('end');
    const vue = String(await d.executeCommand('show key chain'));
    expect(vue, 'la chaine posee ne se relit pas').toMatch(/RIP-KEYS/);
    expect(vue, 'la cle posee ne se relit pas').toMatch(/s3cr3t/);
  });

  it('`no key chain RIP-KEYS` la retire', async () => {
    const d = await routeur('enable', 'configure terminal',
      'key chain RIP-KEYS', 'exit');
    expect(String(await d.executeCommand('do show key chain'))).toMatch(/RIP-KEYS/);
    expect(await d.executeCommand('no key chain RIP-KEYS'))
      .not.toMatch(/Invalid|Incomplete/);
    expect(String(await d.executeCommand('do show key chain')),
      'la chaine survit a son retrait').not.toMatch(/RIP-KEYS/);
  });
});

for (const [portee, prelude] of
  [['utilisateur', []], ['privilegie', ['enable']]] as Array<[string, string[]]>) {
  describe(`la vue se lit en EXEC ${portee} — les TEMOINS`, () => {
    it('`show key chain` sans chaine posee', async () => {
      const d = await routeur(...prelude);
      expect(String(await d.executeCommand('show key chain')))
        .toMatch(/No key chains configured/);
    });

    it('`show key chain ZORGLUB` nomme l absence', async () => {
      const d = await routeur(...prelude);
      expect(String(await d.executeCommand('show key chain ZORGLUB')))
        .toMatch(/not found/);
    });
  });
}

describe('l arbre ne porte plus la famille', () => {
  it.each([
    ['config', ['enable', 'configure terminal'], ['key chain', 'no key chain']],
    ['privilegie', ['enable'], ['show key chain']],
    ['utilisateur', [], ['show key chain']],
  ] as Array<[string, string[], string[]]>)('en %s', async (_nom, prelude, chemins) => {
    const d = await routeur(...prelude);
    const portes = d.getShell().getActiveTrie().enumerateExecutablePaths();
    for (const chemin of chemins) {
      expect(portes, `${chemin} est encore dans l arbre`).not.toContain(chemin);
    }
  });
});
