/**
 * Les quatorze vues de securite d'EXEC passent au socle.
 *
 * Elles vivent dans un seul constructeur, branche sur les DEUX arbres
 * d'EXEC : vingt-huit chemins pour quatorze commandes, et c'est la
 * duplication que la declaration unique retire.
 *
 * Toutes ont la meme forme : un NOM facultatif qui filtre une liste. Le
 * nom est libre — un classificateur, une politique, une plage horaire ne
 * sont contraints par rien — donc la place le NOMME et laisse la vue
 * dire elle-meme qu'elle n'a rien a montrer.
 *
 * Le releve est pris AVANT : les cas d'acceptation sont verts des deux
 * cotes, les cas d'aide sont ce que la migration apporte.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { MACAddress, resetCounters } from '@/network/core/types';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  EquipmentRegistry.resetInstance();
  Logger.clear();
});

type Machine = { executeCommand(c: string): Promise<string>; cliHelp(i: string): string };

async function privilegie(): Promise<Machine> {
  const d = new CiscoRouter('R1', 0, 0) as unknown as Machine;
  await d.executeCommand('enable');
  return d;
}

async function configure(lignes: readonly string[]): Promise<Machine> {
  const d = await privilegie();
  await d.executeCommand('configure terminal');
  for (const l of lignes) await d.executeCommand(l);
  await d.executeCommand('end');
  return d;
}

const motsAides = (aide: string): string[] =>
  aide.split('\n').map(l => l.trim().split(/\s{2,}/)[0])
    .filter(m => m.length > 0 && !m.startsWith('%'));

const TOUTES = [
  'show crypto pki trustpoints',
  'show crypto pki certificates',
  'show crypto key mypubkey rsa',
  'show policy-map control-plane',
  'show parameter-map type inspect',
  'show zone security',
  'show zone-pair security',
  'show policy-map type inspect zone-pair',
  'show ip traffic',
  'show ip cef',
  'show policy-map interface',
  'show policy-map',
  'show class-map',
  'show time-range',
] as const;

describe('les quatorze vues repondent', () => {
  it.each(TOUTES)('`%s` n est pas refusee', async (commande) => {
    const out = await (await privilegie()).executeCommand(commande);
    expect(/Invalid input|Incomplete command|Unrecognized/.test(out), out).toBe(false);
  });

  it.each(TOUTES)('`%s` repond AUSSI en EXEC utilisateur', async (commande) => {
    const d = new CiscoRouter('R2', 0, 0) as unknown as Machine;
    const out = await d.executeCommand(commande);
    expect(/Invalid input|Unrecognized/.test(out), out).toBe(false);
  });

  it('`show zone security` sans zone le dit', async () => {
    expect(await (await privilegie()).executeCommand('show zone security'))
      .toBe('No zones configured');
  });

  it('`show ip cef` rend son en-tete — CEF est actif par defaut', async () => {
    expect(await (await privilegie()).executeCommand('show ip cef'))
      .toContain('Prefix');
  });

  it('`no ip cef` puis `show ip cef` le dit', async () => {
    const d = await configure(['no ip cef']);
    expect(await d.executeCommand('show ip cef')).toBe('IP CEF is not enabled');
  });

  it('`show parameter-map type inspect` rend la carte par defaut', async () => {
    expect(await (await privilegie()).executeCommand('show parameter-map type inspect'))
      .toContain('parameter-map type inspect default');
  });

  it('`show class-map <nom>` filtre la liste', async () => {
    const d = await configure([
      'class-map match-any C1', 'match any', 'exit',
      'class-map match-any C2', 'match any', 'exit',
    ]);
    const un = await d.executeCommand('show class-map C1');
    expect(un).toContain('Class Map match-any C1');
    expect(un).not.toContain('C2');
    expect(await d.executeCommand('show class-map')).toContain('C2');
  });

  it('`show class-map <inconnu>` ne se plaint pas de la syntaxe', async () => {
    const d = await configure(['class-map match-any C1', 'match any', 'exit']);
    expect(await d.executeCommand('show class-map ZORGLUB')).toBe('');
  });

  it('`show policy-map <nom>` filtre aussi', async () => {
    const d = await configure([
      'class-map match-any C1', 'match any', 'exit',
      'policy-map P1', 'class C1', 'exit', 'exit',
    ]);
    expect(await d.executeCommand('show policy-map P1')).toContain('Policy Map P1');
  });

  it('`show time-range <nom>` filtre aussi', async () => {
    const d = await configure(['time-range OUVERTURE', 'exit']);
    expect(await d.executeCommand('show time-range OUVERTURE'))
      .toContain('OUVERTURE');
  });

  it('`show parameter-map type inspect <nom>` filtre aussi', async () => {
    const d = await configure(['parameter-map type inspect PM1', 'exit']);
    expect(await d.executeCommand('show parameter-map type inspect PM1'))
      .toContain('parameter-map type inspect PM1');
  });
});

describe('ce que `?` annonce des vues de securite', () => {
  it('`show class-map ?` annonce un nom FACULTATIF', async () => {
    const mots = motsAides((await privilegie()).cliHelp('show class-map '));
    expect(mots).toContain('WORD');
    expect(mots).toContain('<cr>');
  });

  it('`show policy-map ?` annonce le nom ET ses branches', async () => {
    const mots = motsAides((await privilegie()).cliHelp('show policy-map '));
    expect(mots).toContain('WORD');
    expect(mots).toContain('control-plane');
    expect(mots).toContain('interface');
  });

  it('`show time-range ?` annonce un nom FACULTATIF', async () => {
    expect(motsAides((await privilegie()).cliHelp('show time-range ')))
      .toContain('WORD');
  });

  it('`show zone security ?` ne prend rien', async () => {
    expect(motsAides((await privilegie()).cliHelp('show zone security ')))
      .toEqual(['<cr>']);
  });

  it('`show crypto pki ?` annonce ses deux branches', async () => {
    const mots = motsAides((await privilegie()).cliHelp('show crypto pki '));
    expect(mots).toContain('certificates');
    expect(mots).toContain('trustpoints');
  });
});
