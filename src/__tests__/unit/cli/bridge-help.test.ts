/**
 * Le pont est BIDIRECTIONNEL — ce qui s'execute se decrit.
 *
 * Le pont n'allait que dans un sens : `executeOnTrie` consultait le socle
 * avant les arbres, mais `?` et la tabulation lisaient les arbres SEULS.
 * Une famille migree etait donc elaguee du trie sans que rien la remette
 * dans l'aide, et la machine se contredisait elle-meme :
 *
 *   R1# show crypto ipsec sa
 *   IPSec not configured.              <- la commande existe
 *   R1# show crypto ipsec ?
 *     security-association             <- l'aide dit que non
 *
 * Sur la famille `tunnel`, entierement migree, c'etait pire : `tunnel ?`
 * en configuration d'interface repondait `% Invalid input detected`, le
 * message d'une commande qui n'existe pas, pour une commande qui marche.
 *
 * C'est exactement le defaut que ce depot passe son temps a refermer —
 * une vue qui nie ce qu'une autre fait sur la meme machine au meme
 * instant. Et il est PIRE que l'absence : un operateur qui ne trouve pas
 * `sa` dans `show crypto ipsec ?` conclut que sa version d'IOS ne l'a
 * pas, et cherche ailleurs.
 *
 * Ce fichier fixe les deux moities de l'invariant, pour chaque famille
 * deja migree : ce que le socle EXECUTE, l'aide le DECRIT, et la
 * tabulation le complete.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { createDevice, resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { resetCounters, MACAddress } from '@/network/core/types';

interface Cli {
  executeCommand(command: string): Promise<string>;
  getShell(): {
    getHelp(input: string, device?: unknown): string;
    tabCandidates(input: string, device: unknown): string[];
  };
}

async function router(): Promise<Cli> {
  const device = createDevice('router-cisco', 0, 0) as unknown as Cli;
  await device.executeCommand('enable');
  return device;
}

function help(device: Cli, input: string): string {
  return device.getShell().getHelp(input, device);
}

beforeEach(() => {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter();
});

describe('ce que le socle execute, l\'aide le decrit', () => {
  it('`show crypto ipsec ?` annonce `sa`, qui s\'execute', async () => {
    const r = await router();

    const execute = await r.executeCommand('show crypto ipsec sa');
    const aide = help(r, 'show crypto ipsec ');

    expect(execute).not.toContain('Invalid input');
    expect(aide).toContain('sa');
  });

  it('`clear crypto ?` annonce `session`, qui s\'execute', async () => {
    const r = await router();

    const execute = await r.executeCommand('clear crypto session');
    const aide = help(r, 'clear crypto ');

    expect(execute).not.toContain('Invalid input');
    expect(aide).toContain('session');
  });

  it('`tunnel ?` decrit la famille au lieu de la nier', async () => {
    const r = await router();
    await r.executeCommand('configure terminal');
    await r.executeCommand('interface Tunnel0');

    const execute = await r.executeCommand('tunnel source Loopback0');
    const aide = help(r, 'tunnel ');

    expect(execute).not.toContain('Invalid input');
    expect(aide).not.toContain('Invalid input');
    expect(aide).toContain('source');
    expect(aide).toContain('destination');
  });

  it('l\'aide du socle porte une DESCRIPTION, jamais une colonne vide', async () => {
    const r = await router();
    await r.executeCommand('configure terminal');
    await r.executeCommand('interface Tunnel0');

    const lignes = help(r, 'tunnel ').split('\n').filter(l => l.trim().length > 0);

    expect(lignes.length).toBeGreaterThan(0);
    expect(lignes.every(l => /^\s+\S+\s{2,}\S/.test(l))).toBe(true);
  });

  it('ce qui vient du TRIE reste decrit — le temoin', async () => {
    const r = await router();

    const aide = help(r, 'show crypto ');

    expect(aide).toContain('pki');
    expect(aide).toContain('ipsec');
  });
});

describe('la tabulation voit ce que le socle declare', () => {
  it('`show crypto ipsec s` propose `sa`', async () => {
    const r = await router();

    const candidats = r.getShell().tabCandidates('show crypto ipsec s', r);

    expect(candidats.some(c => c.trim().endsWith('sa'))).toBe(true);
  });

  it('`tunnel s` propose `source`', async () => {
    const r = await router();
    await r.executeCommand('configure terminal');
    await r.executeCommand('interface Tunnel0');

    const candidats = r.getShell().tabCandidates('tunnel s', r);

    expect(candidats.some(c => c.trim().endsWith('source'))).toBe(true);
  });
});

describe('le pont n\'invente rien', () => {
  it('une commande qu\'aucun des deux moteurs ne porte reste refusee', async () => {
    const r = await router();

    expect(help(r, 'zorglub ')).toContain('Invalid input');
  });

  it('l\'aide ne propose pas deux fois le meme mot-cle', async () => {
    const r = await router();

    const mots = help(r, 'show crypto ')
      .split('\n').map(l => l.trim().split(/\s+/)[0]).filter(Boolean);

    expect(new Set(mots).size).toBe(mots.length);
  });
});
