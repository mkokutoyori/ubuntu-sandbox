/**
 * Les vues NetFlow et EEM d'EXEC passent au socle.
 *
 * Huit chemins d'un seul constructeur, propres au routeur. Ils ont tous
 * la meme forme : une vue qui prend un NOM facultatif et filtre sa
 * liste. Le nom n'est pas typable — une reserve, un enregistreur, un
 * moniteur portent un nom libre — donc la place le NOMME et laisse la
 * vue dire elle-meme qu'elle n'a rien a montrer.
 *
 * Le releve est pris AVANT : les cas d'acceptation sont verts des deux
 * cotes, les cas d'aide sont ce que la migration apporte.
 *
 * PORTEE MESUREE : le constructeur est branche sur les DEUX arbres
 * d'EXEC, donc les huit repondent avant `enable` comme apres. Ce lot
 * DEPLACE et ne change pas — `modes: ['user','privileged']` reproduit
 * exactement ce que la machine faisait.
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

describe('les vues NetFlow disent ce qu elles ont', () => {
  it.each([
    ['show flow exporter', 'No flow exporters configured'],
    ['show flow record', 'No flow records configured'],
    ['show flow monitor', 'No flow monitors configured'],
    ['show ip flow export', 'Flow export is not configured'],
  ] as ReadonlyArray<readonly [string, string]>)(
    '`%s` sans configuration rend `%s`', async (commande, attendu) => {
      expect(await (await privilegie()).executeCommand(commande)).toBe(attendu);
    });

  it('`show flow exporter <nom>` filtre la liste', async () => {
    const d = await configure([
      'flow exporter EXP1', 'destination 10.0.0.9', 'exit',
      'flow exporter EXP2', 'destination 10.0.0.8', 'exit',
    ]);
    const un = await d.executeCommand('show flow exporter EXP1');
    expect(un).toContain('Flow Exporter EXP1:');
    expect(un).not.toContain('EXP2');
    expect(await d.executeCommand('show flow exporter')).toContain('EXP2');
  });

  it('`show flow exporter <inconnu>` le dit sans se plaindre de la syntaxe', async () => {
    const d = await configure(['flow exporter EXP1', 'destination 10.0.0.9', 'exit']);
    expect(await d.executeCommand('show flow exporter ZORGLUB'))
      .toBe('No flow exporters configured');
  });

  it('`show flow record <nom>` filtre aussi', async () => {
    const d = await configure(['flow record REC1', 'match ipv4 source address', 'exit']);
    expect(await d.executeCommand('show flow record REC1')).toContain('Flow Record REC1:');
  });

  it('`show flow monitor <nom>` filtre, et `cache` n est pas un nom', async () => {
    const d = await configure(['flow monitor MON1', 'exit']);
    expect(await d.executeCommand('show flow monitor MON1')).toContain('Flow Monitor MON1:');
    expect(await d.executeCommand('show flow monitor cache')).toContain('Flow Monitor MON1:');
  });

  it('`show ip cache flow` rend la distribution', async () => {
    expect(await (await privilegie()).executeCommand('show ip cache flow'))
      .toContain('IP packet size distribution');
  });
});

describe('les vues EEM et le declenchement manuel', () => {
  it('`show event manager environment` sans variable le dit', async () => {
    expect(await (await privilegie()).executeCommand('show event manager environment'))
      .toBe('No EEM environment variables');
  });

  it('`show event manager policy registered` sans applet le dit', async () => {
    expect(await (await privilegie()).executeCommand('show event manager policy registered'))
      .toBe('No EEM policies registered');
  });

  it('`event manager run` seul est INCOMPLET', async () => {
    expect(await (await privilegie()).executeCommand('event manager run'))
      .toContain('Incomplete command');
  });

  it('`event manager run <inconnu>` nomme la politique absente', async () => {
    expect(await (await privilegie()).executeCommand('event manager run ZORGLUB'))
      .toBe("% Policy 'ZORGLUB' not found");
  });

  it('`event manager run <applet>` declenche sans se plaindre', async () => {
    const d = await configure([
      'event manager applet TEST', 'event none', 'action 1.0 syslog msg bonjour', 'exit',
    ]);
    expect(await d.executeCommand('event manager run TEST')).toBe('');
    expect(await d.executeCommand('show event manager policy registered'))
      .toContain('applet TEST');
  });

  it('les huit repondent AUSSI en EXEC utilisateur', async () => {
    const d = new CiscoRouter('R2', 0, 0) as unknown as Machine;
    for (const c of ['show flow exporter', 'show flow record', 'show flow monitor',
      'show ip cache flow', 'show ip flow export', 'show event manager environment',
      'show event manager policy registered', 'event manager run TEST']) {
      expect(await d.executeCommand(c), c).not.toContain('Invalid input');
    }
  });
});

describe('ce que `?` annonce de ces vues', () => {
  it('`show flow ?` annonce ses trois branches', async () => {
    const mots = motsAides((await privilegie()).cliHelp('show flow '));
    for (const attendu of ['exporter', 'monitor', 'record']) {
      expect(mots, attendu).toContain(attendu);
    }
  });

  it('`show flow exporter ?` annonce un nom FACULTATIF', async () => {
    const mots = motsAides((await privilegie()).cliHelp('show flow exporter '));
    expect(mots).toContain('WORD');
    expect(mots).toContain('<cr>');
  });

  it('`show flow monitor ?` annonce `cache` a cote du nom', async () => {
    const mots = motsAides((await privilegie()).cliHelp('show flow monitor '));
    expect(mots).toContain('cache');
  });

  it('`event manager run ?` annonce un nom EXIGE', async () => {
    const mots = motsAides((await privilegie()).cliHelp('event manager run '));
    expect(mots).toContain('WORD');
    expect(mots).not.toContain('<cr>');
  });

  it('`show ip cache flow ?` ne prend rien', async () => {
    expect(motsAides((await privilegie()).cliHelp('show ip cache flow ')))
      .toEqual(['<cr>']);
  });
});
