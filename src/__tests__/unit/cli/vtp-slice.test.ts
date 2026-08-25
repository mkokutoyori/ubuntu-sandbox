/**
 * La famille VTP du Catalyst — celle qui decide si un commutateur
 * ANNONCE sa base de VLAN, l'ecoute, ou l'ignore.
 *
 * La propagation elle-meme est mesuree ailleurs (`vtp*.test.ts`) ; cette
 * suite pose les questions de la CLI : ce qui est accepte, ce qui est
 * refuse, ce que la configuration rend, et ce que `?` decrit.
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
}

let serial = 0;

async function commutateur(...lignes: string[]): Promise<Cli> {
  const sw = new CiscoSwitch('switch-cisco', `SW${serial++}`, 8, 0, 0) as unknown as Cli;
  sw.powerOn();
  for (const c of ['enable', 'configure terminal', ...lignes]) await sw.executeCommand(c);
  return sw;
}

const REFUS = /Invalid input|Incomplete command|Unrecognized|% Invalid/;
const refuse = (sortie: string): boolean => REFUS.test(sortie);

async function configuration(cli: Cli): Promise<string> {
  await cli.executeCommand('end');
  return cli.executeCommand('show running-config');
}

describe('ce que la commande POSE se relit', () => {
  it.each([
    ['vtp domain LABO', /vtp domain LABO/],
    ['vtp mode transparent', /vtp mode transparent/],
    ['vtp mode client', /vtp mode client/],
    ['vtp version 2', /vtp version 2/],
    ['vtp pruning', /vtp pruning/],
  ])('`%s` figure dans la configuration', async (ligne, motif) => {
    const cli = await commutateur(ligne);

    expect(await configuration(cli), ligne).toMatch(motif);
  });

  it('`show vtp password` relit le secret pose', async () => {
    const cli = await commutateur('vtp domain LABO', 'vtp password SECRET');
    await cli.executeCommand('end');

    expect(await cli.executeCommand('show vtp password')).toContain('SECRET');
  });

  it('`no vtp pruning` retire l elagage', async () => {
    const cli = await commutateur('vtp pruning', 'no vtp pruning');

    expect(await configuration(cli)).not.toMatch(/^vtp pruning$/m);
  });

  it('`show vtp status` lit ce que la commande a pose', async () => {
    const cli = await commutateur('vtp domain LABO', 'vtp mode transparent');
    await cli.executeCommand('end');
    const vue = await cli.executeCommand('show vtp status');

    expect(vue).toContain('LABO');
    expect(vue).toMatch(/Transparent/i);
  });
});

describe('une valeur hors domaine est REFUSEE', () => {
  it.each([
    'vtp mode zorglub',
    'vtp version 9',
    'vtp version zorglub',
  ])('`%s`', async (ligne) => {
    const cli = await commutateur();
    const sortie = await cli.executeCommand(ligne);

    expect(sortie.length > 0, `${ligne} a ete accepte en silence`).toBe(true);
    expect(await configuration(cli), ligne).not.toContain(ligne);
  });

  it('`vtp domain` sans nom est incomplet', async () => {
    const cli = await commutateur();

    expect(await cli.executeCommand('vtp domain')).toContain('Incomplete');
  });
});

describe('l aide decrit chaque place', () => {
  it('`vtp ?` annonce les cinq sous-commandes', async () => {
    const cli = await commutateur();
    const aide = cli.cliHelp('vtp ');

    for (const mot of ['domain', 'mode', 'password', 'pruning', 'version']) {
      expect(aide, mot).toContain(mot);
    }
  });

  it('`vtp mode ?` annonce les modes, pas un mot libre', async () => {
    const cli = await commutateur();
    const aide = cli.cliHelp('vtp mode ');

    for (const mode of ['client', 'server', 'transparent']) {
      expect(aide, mode).toContain(mode);
    }
  });

  it('`vtp version ?` annonce une PLAGE', async () => {
    const cli = await commutateur();

    expect(cli.cliHelp('vtp version ')).toMatch(/<1-3>/);
  });

  it('aucune ligne d aide de la famille ne reste sans description', async () => {
    const cli = await commutateur();
    const nues: string[] = [];
    for (const amont of ['vtp ', 'vtp mode ', 'vtp version ']) {
      for (const ligne of cli.cliHelp(amont).split('\n')) {
        const texte = ligne.trim();
        if (texte === '' || texte === '<cr>') continue;
        if (!/\s{2,}\S/.test(texte)) nues.push(`${amont}-> ${texte}`);
      }
    }
    expect(nues).toEqual([]);
  });
});
