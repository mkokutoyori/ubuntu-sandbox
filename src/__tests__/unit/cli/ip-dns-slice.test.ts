/**
 * La famille DNS d'IOS, sur les deux plateformes.
 *
 * La question centrale n'est pas l'acceptation mais la RELECTURE : une
 * ligne acceptee et absente de la configuration rendue est perdue au
 * rechargement d'une topologie, qui rejoue cette configuration. C'est le
 * defaut que `CLAUDE.md` signale sur `no ip domain-lookup`.
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

async function configuration(cli: Cli): Promise<string> {
  await cli.executeCommand('end');
  return cli.executeCommand('show running-config');
}

const ACCEPTEES: readonly string[] = [
  'ip domain-lookup',
  'ip domain lookup',
  'no ip domain-lookup',
  'ip domain-name exemple.local',
  'ip domain name exemple.local',
  'no ip domain-name',
  'ip domain-list autre.local',
  'ip name-server 8.8.8.8',
  'ip name-server 8.8.8.8 1.1.1.1',
  'no ip name-server 8.8.8.8',
  'ip domain timeout 5',
  'no ip domain timeout',
  'ip domain retry 4',
  'no ip domain retry',
  'ip domain round-robin',
  'no ip domain round-robin',
  'ip host r2 10.0.0.2',
  'no ip host r2',
];

const RENDUES: ReadonlyArray<readonly [string, RegExp]> = [
  ['ip domain-name exemple.local', /ip domain[- ]name exemple\.local/],
  ['ip name-server 8.8.8.8', /ip name-server 8\.8\.8\.8/],
  ['ip host r2 10.0.0.2', /ip host r2 10\.0\.0\.2/],
  ['ip domain timeout 5', /ip domain timeout 5/],
  ['ip domain retry 4', /ip domain retry 4/],
  ['ip domain round-robin', /ip domain round-robin/],
  ['no ip domain-lookup', /no ip domain[- ]lookup/],
];

describe.each(PLATEFORMES)('%s', (_nom, fabrique) => {
  it.each(ACCEPTEES)('`%s` est accepte', async (ligne) => {
    const cli = await enConfig(fabrique);
    expect(refuse(await cli.executeCommand(ligne)), ligne).toBe(false);
  });

  it.each(RENDUES)('`%s` FIGURE dans la configuration rendue', async (ligne, motif) => {
    const cli = await enConfig(fabrique, ligne);

    expect(await configuration(cli), ligne).toMatch(motif);
  });

  it('les deux ORTHOGRAPHES de la resolution donnent le meme etat', async () => {
    const avecTiret = await enConfig(fabrique, 'no ip domain-lookup');
    const avecEspace = await enConfig(fabrique, 'no ip domain lookup');

    const ligne = (texte: string): string | undefined =>
      texte.split('\n').map(l => l.trim()).find(l => /^no ip domain[- ]lookup$/.test(l));

    expect(ligne(await configuration(avecTiret)))
      .toBe(ligne(await configuration(avecEspace)));
  });

  it('une adresse de serveur MALFORMEE est refusee', async () => {
    const cli = await enConfig(fabrique);
    expect(refuse(await cli.executeCommand('ip name-server 999.1.1.1'))).toBe(true);
  });

  it('`ip host` sans adresse est incomplet', async () => {
    const cli = await enConfig(fabrique);
    expect(await cli.executeCommand('ip host r2')).toContain('Incomplete');
  });

  it('la configuration rendue se RELIT sans rien perdre', async () => {
    const pose = RENDUES.map(([ligne]) => ligne);
    const cli = await enConfig(fabrique, ...pose);
    const avant = await configuration(cli);

    const rejoue = await enConfig(fabrique,
      ...avant.split('\n').map(l => l.trim()).filter(l => /^(no )?ip (domain|name-server|host)/.test(l)));

    const apres = await configuration(rejoue);
    for (const [ligne, motif] of RENDUES) expect(apres, ligne).toMatch(motif);
  });

  it('`ip domain ?` decrit chacune de ses places', async () => {
    const cli = await enConfig(fabrique);
    const aide = cli.cliHelp('ip domain ');

    for (const mot of ['lookup', 'name', 'retry', 'round-robin', 'timeout']) {
      expect(aide, mot).toContain(mot);
    }
    const nues = aide.split('\n').map(l => l.trim())
      .filter(l => l !== '' && l !== '<cr>' && !/\s{2,}\S/.test(l));
    expect(nues).toEqual([]);
  });

  it('`ip name-server ?` annonce une ADRESSE, pas un mot', async () => {
    const cli = await enConfig(fabrique);

    expect(cli.cliHelp('ip name-server ')).toMatch(/A\.B\.C\.D/);
  });
});
