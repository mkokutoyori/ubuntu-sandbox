/**
 * Les quatre commandes de DURCISSEMENT d'IOS, sur les deux plateformes.
 *
 * `no ip source-route`, `no ip bootp server`, `no ip gratuitous-arps` et
 * `no ip finger` sont les quatre lignes que toute liste de durcissement
 * fait taper en premier. La question posee ici n'est pas « la commande
 * est-elle acceptee » mais « la machine la GARDE-t-elle » : une ligne de
 * durcissement absente de la configuration rendue est perdue au
 * rechargement d'une topologie, et la machine se croit durcie sans
 * l'etre.
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

const DURCISSEMENT: readonly string[] = [
  'ip source-route', 'ip bootp server', 'ip gratuitous-arps', 'ip finger',
];

/**
 * IOS ne rend que ce qui S'ECARTE du defaut, et les quatre n'ont pas le
 * meme : le routage par la source, le serveur BOOTP et l'ARP gratuit
 * sont actifs d'origine, le service finger ne l'est pas. La ligne a
 * chercher dans la configuration est donc la NEGATION pour les trois
 * premiers et la forme positive pour le dernier.
 */
const LIGNE_NON_DEFAUT: ReadonlyArray<readonly [string, string]> = [
  ['ip source-route', 'no ip source-route'],
  ['ip bootp server', 'no ip bootp server'],
  ['ip gratuitous-arps', 'no ip gratuitous-arps'],
  ['ip finger', 'ip finger'],
];

describe.each(PLATEFORMES)('%s', (_nom, fabrique) => {
  it.each(DURCISSEMENT)('`no %s` est accepte', async (commande) => {
    const cli = await enConfig(fabrique);
    expect(refuse(await cli.executeCommand(`no ${commande}`)), commande).toBe(false);
  });

  it.each(DURCISSEMENT)('`%s` est accepte', async (commande) => {
    const cli = await enConfig(fabrique);
    expect(refuse(await cli.executeCommand(commande)), commande).toBe(false);
  });

  it.each(LIGNE_NON_DEFAUT)('ce qui s ecarte du defaut FIGURE — `%s`',
    async (_commande, ligne) => {
      const cli = await enConfig(fabrique, ligne);
      await cli.executeCommand('end');

      expect(await cli.executeCommand('show running-config'), ligne).toContain(ligne);
    });

  it.each(LIGNE_NON_DEFAUT)('et le DEFAUT ne figure pas — `%s`', async (commande, ligne) => {
    const inverse = ligne.startsWith('no ') ? commande : `no ${commande}`;
    const cli = await enConfig(fabrique, ligne, inverse);
    await cli.executeCommand('end');

    expect(await cli.executeCommand('show running-config'), inverse).not.toContain(ligne);
  });

  it.each(DURCISSEMENT)('un mot en trop derriere `%s` est refuse', async (commande) => {
    const cli = await enConfig(fabrique);
    expect(refuse(await cli.executeCommand(`${commande} zorglub`)), commande).toBe(true);
  });

  it('la configuration rendue se RELIT : le durcissement survit au rejeu', async () => {
    const attendues = LIGNE_NON_DEFAUT.map(([, ligne]) => ligne);
    const cli = await enConfig(fabrique, ...attendues);
    await cli.executeCommand('end');
    const avant = await cli.executeCommand('show running-config');

    const rejoue = await enConfig(fabrique,
      ...avant.split('\n').map(l => l.trim()).filter(l => attendues.includes(l)));
    await rejoue.executeCommand('end');

    const apres = await rejoue.executeCommand('show running-config');
    for (const ligne of attendues) expect(apres, ligne).toContain(ligne);
  });

  it('`ip ?` decrit les quatre, et aucune ligne ne reste sans description', async () => {
    const cli = await enConfig(fabrique);
    const aide = cli.cliHelp('ip ');

    for (const mot of ['bootp', 'finger', 'gratuitous-arps', 'source-route']) {
      expect(aide, mot).toContain(mot);
    }
    const nues = aide.split('\n').map(l => l.trim())
      .filter(l => l !== '' && l !== '<cr>' && !/\s{2,}\S/.test(l));
    expect(nues).toEqual([]);
  });
});
