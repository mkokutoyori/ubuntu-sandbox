/*
 * `archive` etait declaree DEUX fois, une par plateforme, pour la meme
 * porte vers le meme sous-mode.
 *
 *   CiscoSwitchShell            configTrie.register('archive', …)
 *   CiscoEemNetflowArchiveCommands  trie.register('archive', …)
 *
 * Les deux faisaient la meme chose — poser `config-archive` — et les
 * sous-modes derriere, eux, etaient DEJA partages : le commentaire du
 * commutateur le dit, « la meme famille que sur le routeur, construite
 * par le meme module plutot que recopiee ». Seule la PORTE restait
 * ecrite deux fois. Elle est maintenant declaree une seule fois au
 * socle, dans `globalHeadSpecs`, que les deux plateformes lisent — et
 * c'est le socle qui pose le mode, par `enters`, au lieu de deux
 * gestionnaires qui l'ecrivent a la main.
 *
 * cisco.com est bloque au telechargement par le mandataire de sortie de
 * ce reseau. Ce que la sonde exige ne demande aucune citation : une
 * porte MENE a son sous-mode, ce qu'on y pose se relit, et les deux
 * plateformes repondent la MEME chose.
 *
 * C'est le tour COMPLET qui vaut la sonde, et la lecon vient du lot
 * EEM : une porte declaree qui n'entrerait plus dans son sous-mode
 * REUSSIRAIT en silence — la commande rendrait la chaine vide, et la
 * premiere ligne qu'on croit poser dans l'archive serait refusee en
 * configuration globale. Le laboratoire fait donc le tour : entrer,
 * poser deux lignes, sortir, relire.
 *
 * Discriminee contre l'etat d'avant (`git stash`) : AUCUN cas ne tombe,
 * et c'est le resultat attendu d'une de-duplication pure. La sonde ne
 * prouve pas un correctif, elle prouve que le deplacement n'a rien
 * perdu — la porte, son aide, son `<cr>`, son sous-mode et sa
 * relecture. Sans elle, retirer les deux declarations du trie serait un
 * changement non mesure.
 */
import { describe, it, expect } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';

type Cli = {
  executeCommand: (c: string) => Promise<string>;
  cliHelp: (s: string) => string;
  powerOn: () => void;
};

const annonceCr = (aide: string): boolean =>
  aide.split('\n').some((l) => /^\s\s<cr>\s*$/.test(l));

let serie = 0;

const PLATEFORMES: Array<[string, () => Cli]> = [
  ['routeur', () => new CiscoRouter(`R${serie++}`, 2, 2) as unknown as Cli],
  ['commutateur', () => new CiscoSwitch('switch-cisco', `S${serie++}`, 8) as unknown as Cli],
];

async function config(make: () => Cli, ...prelude: string[]): Promise<Cli> {
  const d = make();
  d.powerOn();
  for (const c of ['enable', 'configure terminal', ...prelude]) await d.executeCommand(c);
  return d;
}

describe.each(PLATEFORMES)('%s — la porte `archive` vient du socle', (_nom, make) => {
  it('`archive` est accepte et annonce son `<cr>`', async () => {
    const d = await config(make);
    expect(annonceCr(d.cliHelp('archive ')), 'archive ? ne promet pas <cr>').toBe(true);
    expect(await d.executeCommand('archive')).not.toMatch(/Invalid|Incomplete/);
  });

  it('le tour complet : entrer, poser, sortir, relire', async () => {
    const d = await config(make, 'archive');
    expect(await d.executeCommand('path flash:sauvegarde'), 'path est refuse')
      .not.toMatch(/Invalid|Incomplete/);
    expect(await d.executeCommand('maximum 7'), 'maximum est refuse')
      .not.toMatch(/Invalid|Incomplete/);
    await d.executeCommand('end');
    const cfg = String(await d.executeCommand('show running-config'));
    expect(cfg, 'le bloc archive ne se relit pas').toMatch(/^archive$/m);
    expect(cfg, 'path ne se relit pas').toMatch(/path flash:sauvegarde/);
    expect(cfg, 'maximum ne se relit pas').toMatch(/maximum 7/);
  });

  it('le sous-mode refuse un mot qui ne lui appartient pas', async () => {
    const d = await config(make, 'archive');
    expect(await d.executeCommand('zorglub')).toMatch(/Invalid input/);
  });

  it('`exit` revient en configuration globale', async () => {
    const d = await config(make, 'archive', 'exit');
    expect(await d.executeCommand('hostname ESSAI')).not.toMatch(/Invalid|Incomplete/);
  });
});
