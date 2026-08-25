/**
 * `switchport port-security` — la tranche migree vers le socle.
 *
 * Les formes viennent de la reference Catalyst, relevees AVANT de lire
 * l'implementation. Le comportement de la famille est deja mesure par
 * `switch-port-security.test.ts` (apprentissage, violation, viellissement,
 * aller-retour dans la configuration) : cette suite-ci ne le redouble pas.
 * Elle pose les questions que le trie ne savait pas tenir — l'aide de
 * chaque place, l'abreviation, et le refus AVEC son caret.
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

async function surUnPort(): Promise<{ cli: Cli; port: string }> {
  const sw = new CiscoSwitch('switch-cisco', `SW${serial++}`, 8, 0, 0) as unknown as Cli;
  sw.powerOn();
  const port = sw.getPortNames()[0];
  for (const c of ['enable', 'configure terminal', `interface ${port}`,
    'switchport mode access']) {
    await sw.executeCommand(c);
  }
  return { cli: sw, port };
}

const REFUS = /Invalid input|Incomplete command|Unrecognized|% Invalid/;
const refuse = (sortie: string): boolean => REFUS.test(sortie);

const FORMES: ReadonlyArray<readonly [string, string]> = [
  ['switchport port-security', 'switchport port-security'],
  ['switchport port-security maximum 3', 'switchport port-security maximum 3'],
  ['switchport port-security violation restrict', 'switchport port-security violation restrict'],
  ['switchport port-security violation protect', 'switchport port-security violation protect'],
  ['switchport port-security mac-address sticky', 'switchport port-security mac-address sticky'],
  ['switchport port-security mac-address 0011.2233.4455',
    'switchport port-security mac-address 0011.2233.4455'],
  ['switchport port-security aging time 10', 'switchport port-security aging time 10'],
  ['switchport port-security aging type inactivity',
    'switchport port-security aging type inactivity'],
  ['switchport port-security aging static', 'switchport port-security aging static'],
];

describe('chaque forme reste acceptee et rendue', () => {
  it.each(FORMES)('`%s`', async (ligne, attendu) => {
    const { cli } = await surUnPort();
    await cli.executeCommand('switchport port-security');
    const sortie = await cli.executeCommand(ligne);
    expect(refuse(sortie), `${ligne} -> ${sortie}`).toBe(false);

    await cli.executeCommand('end');
    const cfg = await cli.executeCommand('show running-config');
    expect(cfg, ligne).toContain(attendu);
  });
});

describe('les formes en `no` defont ce que la positive a pose', () => {
  it('`no switchport port-security` retire tout le bloc', async () => {
    const { cli } = await surUnPort();
    await cli.executeCommand('switchport port-security');
    await cli.executeCommand('switchport port-security maximum 3');
    expect(refuse(await cli.executeCommand('no switchport port-security'))).toBe(false);

    await cli.executeCommand('end');
    expect(await cli.executeCommand('show running-config'))
      .not.toContain('switchport port-security maximum 3');
  });

  it('`no switchport port-security mac-address sticky` retire le collant', async () => {
    const { cli } = await surUnPort();
    await cli.executeCommand('switchport port-security');
    await cli.executeCommand('switchport port-security mac-address sticky');
    expect(refuse(await cli.executeCommand('no switchport port-security mac-address sticky')))
      .toBe(false);

    await cli.executeCommand('end');
    expect(await cli.executeCommand('show running-config'))
      .not.toContain('switchport port-security mac-address sticky');
  });

  it('`no switchport port-security aging static` exempte les entrees fixes', async () => {
    const { cli } = await surUnPort();
    await cli.executeCommand('switchport port-security');
    await cli.executeCommand('switchport port-security aging static');
    expect(refuse(await cli.executeCommand('no switchport port-security aging static')))
      .toBe(false);

    await cli.executeCommand('end');
    expect(await cli.executeCommand('show running-config'))
      .not.toContain('switchport port-security aging static');
  });
});

describe('une valeur hors domaine est REFUSEE, pas rangee', () => {
  it.each([
    'switchport port-security maximum 0',
    'switchport port-security maximum zorglub',
    'switchport port-security violation zorglub',
    'switchport port-security aging type zorglub',
    'switchport port-security mac-address ZZZZ.ZZZZ.ZZZZ',
  ])('`%s`', async (ligne) => {
    const { cli } = await surUnPort();
    await cli.executeCommand('switchport port-security');
    const sortie = await cli.executeCommand(ligne);
    expect(sortie.length > 0, `${ligne} a ete accepte en silence`).toBe(true);

    await cli.executeCommand('end');
    const cfg = await cli.executeCommand('show running-config');
    expect(cfg, ligne).not.toContain(ligne);
  });
});

describe('l aide DECRIT chaque place de la famille', () => {
  it('`switchport port-security ?` annonce les quatre sous-commandes', async () => {
    const { cli } = await surUnPort();
    const aide = cli.cliHelp('switchport port-security ');

    for (const mot of ['aging', 'mac-address', 'maximum', 'violation']) {
      expect(aide, mot).toContain(mot);
    }
  });

  it('`switchport port-security violation ?` annonce les TROIS modes', async () => {
    const { cli } = await surUnPort();
    const aide = cli.cliHelp('switchport port-security violation ');

    for (const mode of ['protect', 'restrict', 'shutdown']) {
      expect(aide, mode).toContain(mode);
    }
  });

  it('`switchport port-security aging ?` annonce ses trois places', async () => {
    const { cli } = await surUnPort();
    const aide = cli.cliHelp('switchport port-security aging ');

    for (const mot of ['static', 'time', 'type']) expect(aide, mot).toContain(mot);
  });

  it('`switchport port-security maximum ?` annonce une PLAGE, pas un mot', async () => {
    const { cli } = await surUnPort();
    const aide = cli.cliHelp('switchport port-security maximum ');

    expect(aide).toMatch(/<1-\d+>/);
    expect(aide).not.toContain('WORD');
  });

  it('`switchport port-security mac-address ?` annonce l adresse ET `sticky`', async () => {
    const { cli } = await surUnPort();
    const aide = cli.cliHelp('switchport port-security mac-address ');

    expect(aide).toContain('sticky');
    expect(aide).toMatch(/H\.H\.H/);
  });

  it('aucune ligne d aide de la famille ne reste sans description', async () => {
    const { cli } = await surUnPort();
    const nues: string[] = [];
    for (const amont of ['switchport port-security ', 'switchport port-security aging ',
      'switchport port-security violation ', 'switchport port-security mac-address ']) {
      for (const ligne of cli.cliHelp(amont).split('\n')) {
        const texte = ligne.trim();
        if (texte === '' || texte === '<cr>') continue;
        if (!/\s{2,}\S/.test(texte)) nues.push(`${amont}-> ${texte}`);
      }
    }
    expect(nues).toEqual([]);
  });
});

describe('l abreviation d IOS vaut pour toute la famille', () => {
  it('`ma 4` est tranche par la SUITE — seul `maximum` prend un nombre', async () => {
    const { cli } = await surUnPort();
    await cli.executeCommand('switchport port-security');
    expect(refuse(await cli.executeCommand('switchport port-security ma 4'))).toBe(false);

    await cli.executeCommand('end');
    expect(await cli.executeCommand('show running-config'))
      .toContain('switchport port-security maximum 4');
  });

  it('`ma` SEUL reste ambigu — rien ne le tranche', async () => {
    const { cli } = await surUnPort();
    expect(await cli.executeCommand('switchport port-security ma')).toContain('Ambiguous');
  });

  it.each([
    ['sw po max 4', 'switchport port-security maximum 4'],
    ['switchport port-sec viol restrict', 'switchport port-security violation restrict'],
    ['sw po ag ti 7', 'switchport port-security aging time 7'],
  ])('`%s` vaut `%s`', async (abrege, complet) => {
    const { cli } = await surUnPort();
    await cli.executeCommand('switchport port-security');
    const sortie = await cli.executeCommand(abrege);
    expect(refuse(sortie), `${abrege} -> ${sortie}`).toBe(false);

    await cli.executeCommand('end');
    expect(await cli.executeCommand('show running-config')).toContain(complet);
  });
});
