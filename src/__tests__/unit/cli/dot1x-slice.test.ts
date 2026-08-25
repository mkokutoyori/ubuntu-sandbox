/**
 * La famille 802.1X du Catalyst.
 *
 * Elle vit dans TROIS modes — configuration globale, configuration
 * d'interface, EXEC privilegie — ce qui en fait le premier essai d'une
 * migration a portee mixte : une famille dont les chemins n'ont pas tous
 * la meme joignabilite.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { MACAddress, resetCounters } from '@/network/core/types';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  EquipmentRegistry.resetInstance();
});

interface Cli {
  powerOn(): void;
  executeCommand(command: string): Promise<string>;
  cliHelp(input: string): string;
  getPortNames(): string[];
}

let serial = 0;

async function commutateur(...lignes: string[]): Promise<Cli> {
  const sw = new CiscoSwitch('switch-cisco', `SW${serial++}`, 8, 0, 0) as unknown as Cli;
  sw.powerOn();
  for (const c of ['enable', 'configure terminal', ...lignes]) await sw.executeCommand(c);
  return sw;
}

async function surUnPort(...lignes: string[]): Promise<Cli> {
  const sw = new CiscoSwitch('switch-cisco', `SW${serial++}`, 8, 0, 0) as unknown as Cli;
  sw.powerOn();
  for (const c of ['enable', 'configure terminal', 'dot1x system-auth-control',
    `interface ${sw.getPortNames()[0]}`, ...lignes]) {
    await sw.executeCommand(c);
  }
  return sw;
}

const REFUS = /Invalid input|Incomplete command|Unrecognized/;
const refuse = (sortie: string): boolean => REFUS.test(sortie);

async function configuration(cli: Cli): Promise<string> {
  await cli.executeCommand('end');
  return cli.executeCommand('show running-config');
}

describe('la commutation globale', () => {
  it('`dot1x system-auth-control` est accepte et RENDU', async () => {
    const cli = await commutateur('dot1x system-auth-control');

    expect(await configuration(cli)).toContain('dot1x system-auth-control');
  });

  it('`no dot1x system-auth-control` le retire de la configuration', async () => {
    const cli = await commutateur('dot1x system-auth-control',
      'no dot1x system-auth-control');

    expect(await configuration(cli)).not.toContain('dot1x system-auth-control');
  });

  /*
   * Ce simulateur laisse un sous-mode de configuration atteindre les
   * commandes GLOBALES — `hostname` comme `dot1x system-auth-control` —
   * ce qu'un vrai IOS refuse. C'est une regle de toute la CLI et non de
   * cette famille : le cas fige donc ce que la machine FAIT, et la
   * question est ecrite dans `TODO.md` avec sa mesure.
   */
  it('la commutation globale reste atteignable depuis un sous-mode ici', async () => {
    const cli = await surUnPort();

    expect(refuse(await cli.executeCommand('dot1x system-auth-control'))).toBe(false);
  });
});

describe('les reglages du PORT', () => {
  it.each([
    ['dot1x pae authenticator', 'dot1x pae authenticator'],
    ['dot1x port-control auto', 'dot1x port-control auto'],
    ['dot1x port-control force-authorized', 'dot1x port-control force-authorized'],
    ['dot1x port-control force-unauthorized', 'dot1x port-control force-unauthorized'],
  ])('`%s` est accepte et rendu', async (ligne, attendu) => {
    const cli = await surUnPort('dot1x pae authenticator', ligne);

    expect(await configuration(cli), ligne).toContain(attendu);
  });

  it('`no dot1x pae authenticator` retire le role', async () => {
    const cli = await surUnPort('dot1x pae authenticator', 'no dot1x pae authenticator');

    expect(await configuration(cli)).not.toContain('dot1x pae authenticator');
  });

  it.each([
    'dot1x port-control zorglub',
    'dot1x pae zorglub',
  ])('`%s` est refuse', async (ligne) => {
    const cli = await surUnPort();

    expect(await cli.executeCommand(ligne), ligne).not.toBe('');
  });

  it('les reglages du port n existent PAS en configuration globale', async () => {
    const cli = await commutateur();

    expect(refuse(await cli.executeCommand('dot1x port-control auto'))).toBe(true);
  });
});

describe('la vue', () => {
  it('`show dot1x` repond en EXEC privilegie', async () => {
    const cli = await surUnPort('dot1x pae authenticator', 'dot1x port-control auto');
    await cli.executeCommand('end');

    expect(refuse(await cli.executeCommand('show dot1x'))).toBe(false);
  });

  it('`show dot1x` repond aussi en configuration, sans `do`', async () => {
    const cli = await commutateur();

    expect(refuse(await cli.executeCommand('show dot1x'))).toBe(false);
  });
});

describe('l aide decrit chaque place', () => {
  it('`dot1x ?` en configuration d interface annonce les places du PORT', async () => {
    const cli = await surUnPort();
    const aide = cli.cliHelp('dot1x ');

    for (const mot of ['pae', 'port-control']) expect(aide, mot).toContain(mot);
    expect(aide).not.toContain('system-auth-control');
  });

  it('`dot1x port-control ?` annonce les TROIS modes', async () => {
    const cli = await surUnPort();
    const aide = cli.cliHelp('dot1x port-control ');

    for (const mode of ['auto', 'force-authorized', 'force-unauthorized']) {
      expect(aide, mode).toContain(mode);
    }
  });

  it('aucune ligne d aide de la famille ne reste sans description', async () => {
    const cli = await surUnPort();
    const nues: string[] = [];
    for (const amont of ['dot1x ', 'dot1x pae ', 'dot1x port-control ']) {
      for (const ligne of cli.cliHelp(amont).split('\n')) {
        const texte = ligne.trim();
        if (texte === '' || texte === '<cr>') continue;
        if (!/\s{2,}\S/.test(texte)) nues.push(`${amont}-> ${texte}`);
      }
    }
    expect(nues).toEqual([]);
  });
});
