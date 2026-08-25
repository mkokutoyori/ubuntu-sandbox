/**
 * La famille ARP d'IOS, sur les deux plateformes.
 *
 * Quatre chemins seulement — `show arp`, `show ip arp`, `arp` et
 * `no arp` — mais ils sont declares dans le socle commun, donc ce que
 * cette suite mesure vaut du routeur ET du commutateur : c'est le genre
 * de famille ou une divergence entre les deux ne se verrait pas.
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

describe.each(PLATEFORMES)('%s', (_nom, fabrique) => {
  it('`arp <ip> <mac> arpa` pose une entree STATIQUE, et elle se relit', async () => {
    const cli = await enConfig(fabrique, 'arp 10.0.0.9 0011.2233.4455 arpa');
    await cli.executeCommand('end');

    expect(await cli.executeCommand('show arp')).toContain('10.0.0.9');
    expect(await cli.executeCommand('show ip arp')).toContain('10.0.0.9');
  });

  it('`no arp <ip>` la retire', async () => {
    const cli = await enConfig(fabrique,
      'arp 10.0.0.9 0011.2233.4455 arpa', 'no arp 10.0.0.9');
    await cli.executeCommand('end');

    expect(await cli.executeCommand('show arp')).not.toContain('10.0.0.9');
  });

  it('une ADRESSE malformee est refusee, et le dit', async () => {
    const cli = await enConfig(fabrique);

    expect(await cli.executeCommand('arp 999.1.1.1 0011.2233.4455 arpa'))
      .toMatch(/Invalid|Incomplete/);
  });

  it('une MAC malformee est refusee, et le dit', async () => {
    const cli = await enConfig(fabrique);

    expect(await cli.executeCommand('arp 10.0.0.9 ZZZZ.ZZZZ.ZZZZ arpa'))
      .toMatch(/Invalid|Incomplete/);
  });

  it('`arp` seul est incomplet', async () => {
    const cli = await enConfig(fabrique);

    expect(await cli.executeCommand('arp')).toContain('Incomplete');
  });

  it('`show arp` et `show ip arp` rendent la MEME table', async () => {
    const cli = await enConfig(fabrique, 'arp 10.0.0.9 0011.2233.4455 arpa');
    await cli.executeCommand('end');

    expect(await cli.executeCommand('show arp'))
      .toBe(await cli.executeCommand('show ip arp'));
  });

  it('`show arp` filtre sur l adresse qu on lui donne', async () => {
    const cli = await enConfig(fabrique,
      'arp 10.0.0.9 0011.2233.4455 arpa', 'arp 10.0.0.10 0011.2233.4466 arpa');
    await cli.executeCommand('end');

    const filtre = await cli.executeCommand('show arp 10.0.0.9');
    expect(filtre).toContain('10.0.0.9');
    expect(filtre).not.toContain('10.0.0.10');
  });

  it('`show arp` repond aussi en EXEC UTILISATEUR', async () => {
    const cli = fabrique();
    cli.powerOn();

    expect(refuse(await cli.executeCommand('show arp'))).toBe(false);
  });

  it('`arp ?` annonce une ADRESSE, pas un mot', async () => {
    const cli = await enConfig(fabrique);

    expect(cli.cliHelp('arp ')).toMatch(/A\.B\.C\.D/);
  });

  it('aucune ligne de `show arp ?` ne reste sans description', async () => {
    const cli = await enConfig(fabrique);
    await cli.executeCommand('end');

    const nues = cli.cliHelp('show arp ').split('\n').map(l => l.trim())
      .filter(l => l !== '' && l !== '<cr>' && !/\s{2,}\S/.test(l));
    expect(nues).toEqual([]);
  });
});
