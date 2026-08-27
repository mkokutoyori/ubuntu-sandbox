/**
 * Le nom, le secret d'activation et le demarrage — sur les deux
 * plateformes.
 *
 * `hostname` est la commande la plus tapee de tous les cours, et
 * `enable secret` celle dont une erreur enferme dehors. Les deux vivent
 * dans le socle COMMUN : ce que cette suite mesure vaut du routeur comme
 * du commutateur, et une divergence entre les deux ne se verrait pas
 * autrement.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
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
  getPrompt?(): string;
}

let serial = 0;

const PLATEFORMES: ReadonlyArray<readonly [string, () => Cli]> = [
  ['routeur', () => new CiscoRouter(`R${serial++}`, 0, 0) as unknown as Cli],
  ['commutateur', () =>
    new CiscoSwitch('switch-cisco', `SW${serial++}`, 8, 0, 0) as unknown as Cli],
];

async function enConfig(fabrique: () => Cli, ...lignes: string[]): Promise<Cli> {
  const cli = fabrique();
  cli.powerOn();
  for (const c of ['enable', 'configure terminal', ...lignes]) await cli.executeCommand(c);
  return cli;
}

const REFUS = /Invalid input|Incomplete command|Unrecognized/;
const refuse = (sortie: string): boolean => REFUS.test(sortie);

async function configuration(cli: Cli): Promise<string> {
  await cli.executeCommand('end');
  return cli.executeCommand('show running-config');
}

describe.each(PLATEFORMES)('%s', (_nom, fabrique) => {
  it('`hostname` renomme la machine, et l INVITE suit', async () => {
    const cli = await enConfig(fabrique, 'hostname CAMPUS');

    expect(await configuration(cli)).toContain('hostname CAMPUS');
    expect(cli.getPrompt?.() ?? '').toContain('CAMPUS');
  });

  it('`no hostname` rend le nom par defaut', async () => {
    const cli = await enConfig(fabrique, 'hostname CAMPUS', 'no hostname');
    const cfg = await configuration(cli);

    expect(cfg).not.toContain('hostname CAMPUS');
    expect(cfg).toMatch(/hostname (Router|Switch)/);
  });

  it('`hostname` sans nom est incomplet', async () => {
    const cli = await enConfig(fabrique);

    expect(await cli.executeCommand('hostname')).toContain('Incomplete');
  });

  it('`enable secret` est RENDU chiffre, jamais en clair', async () => {
    const cli = await enConfig(fabrique, 'enable secret MonSecret');
    const cfg = await configuration(cli);

    expect(cfg).toMatch(/enable secret \d/);
    expect(cfg).not.toContain('MonSecret');
  });

  it('`enable password` est rendu, et le secret l EMPORTE sur lui', async () => {
    const cli = await enConfig(fabrique, 'enable password Motdepasse');

    expect(await configuration(cli)).toContain('enable password Motdepasse');
  });

  it('`enable secret level 5` porte son niveau', async () => {
    const cli = await enConfig(fabrique, 'enable secret level 5 SecretCinq');

    expect(await configuration(cli)).toMatch(/enable secret level 5 \d/);
  });

  it('`enable algorithm-type scrypt secret X` ne range pas un MD5', async () => {
    const cli = await enConfig(fabrique, 'enable algorithm-type scrypt secret Scrypte');
    const cfg = await configuration(cli);

    expect(cfg).toMatch(/enable secret 9/);
    expect(cfg).not.toContain('Scrypte');
  });

  it('`no enable secret` et `no enable password` les retirent', async () => {
    const cli = await enConfig(fabrique,
      'enable secret MonSecret', 'enable password Motdepasse',
      'no enable secret', 'no enable password');
    const cfg = await configuration(cli);

    expect(cfg).not.toMatch(/^enable secret/m);
    expect(cfg).not.toMatch(/^enable password/m);
  });

  it('`boot system` est accepte sur les deux plateformes', async () => {
    const cli = await enConfig(fabrique);

    expect(refuse(await cli.executeCommand('boot system flash:c2900.bin'))).toBe(false);
  });

  it('`enable ?` decrit ses places, et aucune ne reste nue', async () => {
    const cli = await enConfig(fabrique);
    const aide = cli.cliHelp('enable ');

    for (const mot of ['password', 'secret']) expect(aide, mot).toContain(mot);
    const nues = aide.split('\n').map(l => l.trim())
      .filter(l => l !== '' && l !== '<cr>' && !/\s{2,}\S/.test(l));
    expect(nues).toEqual([]);
  });

  it('`boot ?` decrit ses places', async () => {
    const cli = await enConfig(fabrique);
    const aide = cli.cliHelp('boot ');

    for (const mot of ['system']) expect(aide, mot).toContain(mot);
  });
});

/*
 * Le demarrage ne se regle pas pareil des deux cotes, et c'est FIDELE :
 * un routeur a un registre de configuration, un Catalyst a un chargeur
 * d'amorce. Chaque plateforme porte donc son propre cas, plutot qu'un
 * cas commun qui obligerait l'une a accepter la commande de l'autre.
 */
describe('le routeur a un REGISTRE de configuration', () => {
  it('`config-register` est rendu et relu par `show version`', async () => {
    const cli = await enConfig(PLATEFORMES[0][1], 'config-register 0x2142');
    await cli.executeCommand('end');

    expect(await cli.executeCommand('show version')).toContain('0x2142');
  });

  it('et il ne connait pas le chargeur d amorce du Catalyst', async () => {
    const cli = await enConfig(PLATEFORMES[0][1]);

    for (const ligne of ['boot manual', 'boot enable-break']) {
      expect(refuse(await cli.executeCommand(ligne)), ligne).toBe(true);
    }
  });
});

describe('le Catalyst a un CHARGEUR d amorce', () => {
  it.each(['boot manual', 'boot enable-break'])('`%s` est accepte', async (ligne) => {
    const cli = await enConfig(PLATEFORMES[1][1]);

    expect(refuse(await cli.executeCommand(ligne)), ligne).toBe(false);
  });

  it('et il n a pas de registre de configuration', async () => {
    const cli = await enConfig(PLATEFORMES[1][1]);

    expect(refuse(await cli.executeCommand('config-register 0x2102'))).toBe(true);
  });
});
