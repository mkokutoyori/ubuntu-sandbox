/**
 * L'identifiant d'une spec derivee du trie (`trieAdapter.specsFromTrieRegistrations`) etait bati en joignant les elements du
 * chemin, places d'argument COMPRISES, pour les suites declarees `afterArguments` : une place (objet) s'ecrivait « [object
 * Object] », donc le routeur portait `config-if-ip-rip-receive-version-[object Object]-1` et ses pareils (TODO [socle]). Un
 * identifiant est cense NOMMER une commande ; celui-ci nommait sa place par le mot que JavaScript ecrit pour un objet, si bien que
 * deux commandes qui ne different que par le type de leur place portaient le meme nom. Corrige : une place s'ecrit `<nom>`.
 *
 * Discrimine par `git stash` sur src : 2 des 3 cas tombent avant (un routeur et un Catalyst portent des identifiants « [object
 * Object] »). TEMOIN : la table du routeur compte plus de mille specs, donc l'absence d'objet n'est pas due a une table vide.
 */
import { describe, it, expect } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import type { CommandSpec } from '@/cli/CommandTable';

async function specsOf(device: CiscoRouter | CiscoSwitch): Promise<readonly CommandSpec[]> {
  await device.executeCommand('show version');
  const shell = (device as unknown as { shell: { socleTable(): { specs(): Iterable<CommandSpec> } | null } }).shell;
  return [...(shell.socleTable()?.specs() ?? [])];
}

describe('spec ids derived from the trie', () => {
  it('WITNESS — the router table is not empty', async () => {
    expect((await specsOf(new CiscoRouter('R1'))).length).toBeGreaterThan(1000);
  });

  it('no router spec id contains an object rendered as text', async () => {
    const bad = (await specsOf(new CiscoRouter('R1'))).map((spec) => spec.id).filter((id) => id.includes('[object'));
    expect(bad).toEqual([]);
  });

  it('no Catalyst spec id contains an object rendered as text', async () => {
    const bad = (await specsOf(new CiscoSwitch('switch-cisco', 'S1'))).map((spec) => spec.id).filter((id) => id.includes('[object'));
    expect(bad).toEqual([]);
  });
});
