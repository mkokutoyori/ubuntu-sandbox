import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { MACAddress, resetCounters } from '@/network/core/types';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { createDevice, resetDeviceCounters } from '@/network/devices/DeviceFactory';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  EquipmentRegistry.resetInstance();
});

type Cli = { cliHelp(input: string): string; executeCommand(line: string): Promise<string> };

let serial = 0;

function freshRouter(): Cli {
  return new CiscoRouter(`R${serial++}`) as unknown as Cli;
}

async function privileged(): Promise<Cli> {
  const device = freshRouter();
  await device.executeCommand('enable');
  return device;
}

describe('les niveaux sont ceux d\'avant la migration, mesures un par un', () => {
  it.each(['clear history', 'clear host toto'])(
    '`%s` reste accessible en EXEC utilisateur', async (command) => {
      expect(await freshRouter().executeCommand(command)).not.toContain('Invalid input');
    });

  it.each(['clear arp-cache', 'clear ipv6 neighbors', 'clear ipv6 traffic'])(
    '`%s` reste refusee en EXEC utilisateur', async (command) => {
      expect(await freshRouter().executeCommand(command)).toContain('Invalid input');
    });

  it.each(['clear arp-cache', 'clear ipv6 neighbors', 'clear ipv6 traffic'])(
    'et acceptee en EXEC privilegie — `%s`', async (command) => {
      expect(await (await privileged()).executeCommand(command)).toBe('');
    });
});

describe('elles effacent pour de bon, elles ne font pas qu\'analyser', () => {
  it('`clear host <nom>` retire l\'entree de la table', async () => {
    const device = await privileged();
    await device.executeCommand('configure terminal');
    await device.executeCommand('ip host serveur 10.0.0.9');
    await device.executeCommand('end');

    expect(await device.executeCommand('show hosts')).toContain('serveur');

    await device.executeCommand('clear host serveur');

    expect(await device.executeCommand('show hosts')).not.toContain('serveur');
  });

  it('`clear history` vide le tampon des commandes', async () => {
    const device = await privileged();
    await device.executeCommand('show version');
    await device.executeCommand('show clock');

    expect((await device.executeCommand('show history')).split('\n').length)
      .toBeGreaterThan(2);

    await device.executeCommand('clear history');

    expect((await device.executeCommand('show history')).split('\n').length)
      .toBeLessThan(3);
  });
});

describe('un mot en trop est refuse, pas avale', () => {
  it.each(['clear arp-cache zorglub', 'clear history zorglub'])(
    '`%s` recoit le caret', async (command) => {
      expect(await (await privileged()).executeCommand(command)).toContain('Invalid input');
    });

  it('`clear host` sans nom est incomplete', async () => {
    expect(await (await privileged()).executeCommand('clear host')).toContain('Incomplete');
  });
});

/**
 * PREMISSE CORRIGEE PAR LA MESURE.
 *
 * Ce bloc affirmait qu'un prefixe ambigu cesse de l'etre quand le mot
 * SUIVANT ne convient qu'a l'une des branches, et donnait cette
 * resolution pour « la regle d'IOS » — sans reference. Deux sources
 * independantes disent l'inverse : IOS rend `% Ambiguous command` sur
 * une saisie qui porte pourtant un mot de plus (`con t`, `co t`), et
 * decrit la reparation comme « trouver QUEL mot allonger », ce qui n'a
 * de sens que si la ligne entiere reste refusee.
 *
 * Ce que la resolution par la suite coutait, mesure : `ip rout` seul
 * etait refuse, et `ip rout 192.168.9.0 255.255.255.0 10.0.0.2` POSAIT
 * la route — `route` etant la seule des deux branches a accepter une
 * adresse. La meme frappe decidait ou non selon ce qu'on ecrivait
 * apres, et une faute de frappe appliquait une commande que personne
 * n'avait tapee. Entre perdre un raccourci et appliquer une commande
 * non tapee, ce depot choisit de refuser.
 *
 * Ce qui trancherait pour de bon : une transcription reelle ou le mot
 * suivant ne convient qu'a UNE branche. Ni `con t` ni `co t` ne sont ce
 * cas — `terminal` et un nom d'hote conviennent aux deux —, et aucune
 * n'est atteignable depuis ce reseau.
 */
describe('un prefixe ambigu le reste, quoi qu on ecrive apres', () => {
  it.each(['cl arp', 'cl arp-cache', 'cl hist'])(
    '`%s` est refuse — `cl` designe `clear` ET `clock`', async (command) => {
      expect(await (await privileged()).executeCommand(command))
        .toMatch(/% Ambiguous command/);
    });

  it('et `cl` SEUL est refuse de meme', async () => {
    const out = await (await privileged()).executeCommand('cl');

    expect(out).not.toBe('');
  });

  it('un caractere de plus suffit — `cle arp` designe `clear`', async () => {
    expect(await (await privileged()).executeCommand('cle arp-cache')).toBe('');
  });

  it('`clo set` designe `clock`, l\'autre branche — le temoin', async () => {
    const device = await privileged();

    expect(await device.executeCommand('clo set 10:00:00 1 January 2026'))
      .not.toContain('Invalid input');
  });
});

describe('le commutateur garde ce qu\'il avait, et rien de plus', () => {
  async function switchDevice(): Promise<Cli> {
    const device = createDevice('switch-cisco', 0, 0) as unknown as Cli;
    await device.executeCommand('enable');
    return device;
  }

  it.each(['clear arp-cache', 'clear history'])('`%s` y repond', async (command) => {
    expect(await (await switchDevice()).executeCommand(command)).toBe('');
  });

  it('`clear ipv6 neighbors` y reste refusee — elle est propre au routeur', async () => {
    expect(await (await switchDevice()).executeCommand('clear ipv6 neighbors'))
      .toContain('Invalid input');
  });
});
