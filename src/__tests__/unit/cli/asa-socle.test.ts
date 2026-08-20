/**
 * L'ASA rejoint le socle — une machine Cisco n'a pas deux moteurs de
 * commandes selon qu'elle route ou qu'elle filtre.
 *
 * DEUX constats, mesures contre un TEMOIN (le routeur, ou les deux
 * portes s'accordent) avant d'ecrire une ligne.
 *
 * 1. `?` n'avait qu'UNE porte sur deux. La sequence d'amorcage de l'ASA
 *    dit mot pour mot « Type help or '?' for a list of available
 *    commands. », `AsaFirewall.cliHelp()` est ecrite et le terminal
 *    graphique l'appelle — mais `executeCommand('?')` repondait
 *    `% Invalid input detected`. Donc la meme machine, au meme instant,
 *    decrivait ses commandes a la frappe et les niait a l'execution : un
 *    script, une session SSH ou un test recevaient un refus la ou
 *    l'onglet recevait la liste. Le routeur, lui, repond la meme chose
 *    des deux cotes — c'est ce qui prouve que c'est un defaut de l'ASA
 *    et non une convention de ce depot. Meme constat sur le FortiGate,
 *    corrige avec.
 *
 * 2. `ASA_VOCABULARY` et `ASA_COMMAND_HELP` etaient DEUX magasins tenus
 *    a la main, a cote d'un troisieme qui decide vraiment : les `switch`
 *    de `AsaShell`. Rien ne les tenait ensemble. Une commande ajoutee au
 *    `switch` et oubliee dans la liste est invisible a `?` ; une commande
 *    listee et retiree du `switch` est annoncee et refusee. C'est la
 *    forme exacte du defaut que ce depot passe son temps a refermer.
 *
 * Le socle supprime la question : la table EST le vocabulaire. Ce qui y
 * est declare s'execute, se decrit et se complete, parce que c'est le
 * meme objet — il n'y a plus deux listes a tenir d'accord.
 *
 * Ce fichier fixe la tranche migree ET l'invariant qui la borne : ce que
 * le socle declare, les trois portes le connaissent.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { createDevice, resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { resetCounters, MACAddress } from '@/network/core/types';
import { CommandTable } from '@/cli/CommandTable';
import { newSession } from '@/cli/CliSession';
import { ASA_MODES, ASA_PROMPTS } from '@/cli/vendors/asa/asaModes';
import { ASA_SHOW_FAMILY, ASA_SOCLE_PATHS } from '@/cli/vendors/asa/asaShowFamily';

interface Cli {
  executeCommand(command: string): Promise<string>;
  cliHelp(inputBeforeQuestion: string): string;
  cliTabCandidates(input: string): string[];
}

async function asa(): Promise<Cli> {
  const device = createDevice('firewall-cisco', 0, 0) as unknown as Cli;
  await device.executeCommand('enable');
  return device;
}

beforeEach(() => {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter();
});

describe('`?` a les MEMES deux portes que sur un routeur', () => {
  it('l\'ASA repond a `?` par l\'execution, comme a la frappe', async () => {
    const fw = await asa();

    const parExecution = await fw.executeCommand('?');
    const parFrappe = fw.cliHelp('');

    expect(parExecution).not.toContain('Invalid input');
    expect(parExecution).toBe(parFrappe);
  });

  it('`show ?` decrit les vues au lieu de les refuser', async () => {
    const fw = await asa();

    const aide = await fw.executeCommand('show ?');

    expect(aide).not.toContain('Invalid input');
    expect(aide).toContain('conn');
    expect(aide).toContain('xlate');
  });

  it('le FortiGate avait le meme defaut, corrige avec', async () => {
    const fg = createDevice('firewall-fortinet', 0, 0) as unknown as Cli;

    const parExecution = await fg.executeCommand('?');

    expect(parExecution).not.toContain('Command fail');
    expect(parExecution).toBe(fg.cliHelp(''));
  });

  it('le routeur est le TEMOIN : il repondait deja pareil des deux cotes', async () => {
    const r = createDevice('router-cisco', 0, 0) as unknown as Cli;
    await r.executeCommand('enable');

    expect(await r.executeCommand('?')).toBe(r.cliHelp(''));
  });

  it('une commande inconnue reste refusee — le pont n\'invente rien', async () => {
    const fw = await asa();

    expect(await fw.executeCommand('zorglub')).toContain('Invalid input');
  });
});

describe('la table EST le vocabulaire', () => {
  it('chaque commande du socle porte une description non vide', () => {
    expect(ASA_SHOW_FAMILY.length).toBeGreaterThan(0);
    expect(ASA_SHOW_FAMILY.every(spec => spec.description.trim().length > 0)).toBe(true);
  });

  it('ce que le socle declare, `?` le decrit', async () => {
    const fw = await asa();

    const aide = await fw.executeCommand('show ?');

    for (const path of ASA_SOCLE_PATHS) {
      const dernier = path.split(' ').slice(-1)[0];
      expect(aide).toContain(dernier);
    }
  });

  it('ce que le socle declare, l\'execution le SERT', async () => {
    const fw = await asa();

    for (const path of ASA_SOCLE_PATHS) {
      expect(await fw.executeCommand(path)).not.toContain('Invalid input');
    }
  });

  it('ce que le socle declare, la tabulation le propose', async () => {
    const fw = await asa();

    const candidats = fw.cliTabCandidates('show c');

    expect(candidats.some(c => c.trim().endsWith('conn'))).toBe(true);
  });

  it('une declaration en double est REFUSEE, comme partout ailleurs', () => {
    const table = new CommandTable();
    for (const spec of ASA_SHOW_FAMILY) table.declare(spec);

    expect(() => table.declare(ASA_SHOW_FAMILY[0])).toThrow();
  });
});

describe('les modes de l\'ASA sont une DONNEE, plus un `switch`', () => {
  it('l\'invite de chaque mode vient de `PromptBuilder`, pas d\'un cas a la main', () => {
    const rendu = (mode: string): string =>
      newSession('FW1', {}, { hierarchy: ASA_MODES, prompts: ASA_PROMPTS, initialMode: mode }).prompt();

    expect(rendu('exec')).toBe('FW1>');
    expect(rendu('privileged')).toBe('FW1#');
    expect(rendu('config')).toBe('FW1(config)#');
    expect(rendu('config-if')).toBe('FW1(config-if)#');
  });

  it('l\'invite rendue par la machine est celle du socle — un seul calcul', async () => {
    const fw = await asa();
    const device = fw as unknown as { getPrompt(): string };

    expect(device.getPrompt()).toBe('FW1#');

    await fw.executeCommand('configure terminal');

    expect(device.getPrompt()).toBe('FW1(config)#');
  });

  it('`exit` remonte d\'UN niveau, la hierarchie le dit', async () => {
    const fw = await asa();
    const device = fw as unknown as { getPrompt(): string };
    await fw.executeCommand('configure terminal');
    await fw.executeCommand('interface GigabitEthernet0/0');

    expect(device.getPrompt()).toBe('FW1(config-if)#');

    await fw.executeCommand('exit');

    expect(device.getPrompt()).toBe('FW1(config)#');
  });

  it('`end` redescend en EXEC privilegie d\'un coup', async () => {
    const fw = await asa();
    const device = fw as unknown as { getPrompt(): string };
    await fw.executeCommand('configure terminal');
    await fw.executeCommand('interface GigabitEthernet0/0');

    await fw.executeCommand('end');

    expect(device.getPrompt()).toBe('FW1#');
  });
});
