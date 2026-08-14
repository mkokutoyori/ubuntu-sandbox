/**
 * `commands <mode> {include | include-exclusive | exclude} [all] <cmd>`.
 *
 * Deux defauts mesures (audit §3, M7 et M8).
 *
 * M7 — seul le mode `exec` etait accepte : `commands configure include
 * interface` repondait `% Invalid input`. Une vue ne pouvait donc
 * decrire aucun role qui CONFIGURE quoi que ce soit, ce qui est la
 * moitie de l'interet du mecanisme.
 *
 * M8 — `include-exclusive` etait traite comme `include`. Cisco distingue
 * les deux dans les memes mots depuis toujours : « include — adds a
 * command or an interface to the view and ALLOWS the same command or
 * interface to be added to an additional view. include-exclusive — adds
 * a command or an interface to the view and EXCLUDES the same command or
 * interface from being added to all other views. » Les confondre laisse
 * deux vues revendiquer la meme commande, ce qu'IOS refuse — et le
 * mot-cle produisait donc autre chose que ce qu'il promet, en silence.
 *
 * Le mot-cle `all` des vues est le pendant de celui des regles de
 * niveau : la documentation Cisco l'emploie elle-meme
 * (`commands exec include all show`). Sans lui, seule la commande
 * NOMMEE entre dans la vue.
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

const REFUS = '% Invalid input';

async function jouer(r: CiscoRouter, cmds: string[]): Promise<string> {
  let derniere = '';
  for (const c of cmds) derniere = await r.executeCommand(c);
  return derniere;
}

async function vue(lignes: string[]): Promise<CiscoRouter> {
  const r = new CiscoRouter('R1', MACAddress.generate());
  await jouer(r, [
    'enable', 'configure terminal', 'aaa new-model',
    'parser view V', ...lignes, 'exit', 'end',
    'enable view V',
  ]);
  return r;
}

describe('M8 — `all` dans une vue', () => {
  it('SANS `all`, seule la commande nommee entre dans la vue', async () => {
    const r = await vue(['commands exec include show ip']);
    expect(await r.executeCommand('show ip')).not.toContain('Invalid input');
    expect(await r.executeCommand('show ip route')).toContain(REFUS);
  });

  it('AVEC `all`, ce qui complete la commande entre aussi', async () => {
    const r = await vue(['commands exec include all show ip']);
    expect(await r.executeCommand('show ip route')).not.toContain(REFUS);
    expect(await r.executeCommand('show ip interface brief')).not.toContain(REFUS);
    expect(await r.executeCommand('show version')).toContain(REFUS);
  });

  it('`all` se rend tel qu il a ete tape', async () => {
    const r = await vue(['commands exec include all show ip']);
    await jouer(r, ['enable view']);
    const cfg = await r.executeCommand('show running-config');
    expect(cfg).toContain(' commands exec include all show ip');
  });
});

describe('M8 — `include-exclusive` reserve la commande', () => {
  it('une seconde vue ne peut pas revendiquer la meme commande', async () => {
    const r = new CiscoRouter('R1', MACAddress.generate());
    await jouer(r, [
      'enable', 'configure terminal', 'aaa new-model',
      'parser view A', 'commands exec include-exclusive show version', 'exit',
      'parser view B',
    ]);
    expect(await r.executeCommand('commands exec include show version'))
      .toContain('exclusive');
    // Et la vue B reste utilisable pour le reste.
    expect(await r.executeCommand('commands exec include show clock')).toBe('');
  });

  it('`include` ordinaire laisse deux vues partager la commande', async () => {
    const r = new CiscoRouter('R1', MACAddress.generate());
    await jouer(r, [
      'enable', 'configure terminal', 'aaa new-model',
      'parser view A', 'commands exec include show version', 'exit',
      'parser view B',
    ]);
    expect(await r.executeCommand('commands exec include show version')).toBe('');
  });

  it('la vue qui la reserve la garde bel et bien', async () => {
    const r = await vue(['commands exec include-exclusive show version']);
    expect(await r.executeCommand('show version')).toContain('Cisco IOS Software');
  });

  it('elle se rend sous son propre mot-cle', async () => {
    const r = await vue(['commands exec include-exclusive show version']);
    await jouer(r, ['enable view']);
    expect(await r.executeCommand('show running-config'))
      .toContain(' commands exec include-exclusive show version');
  });
});

describe('M7 — les autres modes d analyseur', () => {
  it('`commands configure include` est accepte', async () => {
    const r = new CiscoRouter('R1', MACAddress.generate());
    expect(await jouer(r, [
      'enable', 'configure terminal', 'aaa new-model', 'parser view V',
      'commands configure include hostname',
    ])).toBe('');
  });

  it('une vue gouverne aussi le mode CONFIGURATION', async () => {
    const r = await vue([
      'commands exec include configure terminal',
      'commands configure include hostname',
    ]);
    expect(await r.executeCommand('configure terminal'))
      .toContain('Enter configuration commands');
    expect(await r.executeCommand('hostname DANS-LA-VUE')).toBe('');
    // Ce que la vue n'inclut pas est ABSENT, meme en configuration.
    expect(await r.executeCommand('username evil privilege 15 secret evil'))
      .toContain(REFUS);
  });

  it('elle gouverne le mode INTERFACE de la meme facon', async () => {
    const r = await vue([
      'commands exec include configure terminal',
      'commands configure include interface',
      'commands interface include shutdown',
    ]);
    await jouer(r, ['configure terminal', 'interface GigabitEthernet0/0']);
    expect(await r.executeCommand('shutdown')).toBe('');
    expect(await r.executeCommand('ip address 1.1.1.1 255.255.255.0')).toContain(REFUS);
  });

  it('un mode d analyseur inconnu est refuse', async () => {
    const r = new CiscoRouter('R1', MACAddress.generate());
    expect(await jouer(r, [
      'enable', 'configure terminal', 'aaa new-model', 'parser view V',
      'commands nawak include hostname',
    ])).toContain(REFUS);
  });

  it('chaque mode se rend sous son propre nom', async () => {
    const r = await vue([
      'commands exec include show version',
      'commands configure include hostname',
      'commands interface include shutdown',
    ]);
    await jouer(r, ['enable view']);
    const cfg = await r.executeCommand('show running-config');
    expect(cfg).toContain(' commands exec include show version');
    expect(cfg).toContain(' commands configure include hostname');
    expect(cfg).toContain(' commands interface include shutdown');
  });

  // ── Non-régression ────────────────────────────────────────────────
  it('une vue qui ne parle que d exec se comporte comme avant', async () => {
    const r = await vue(['commands exec include show version']);
    expect(await r.executeCommand('show version')).toContain('Cisco IOS Software');
    expect(await r.executeCommand('show ip route')).toContain(REFUS);
  });

  it('`exclude` prime toujours sur `include`', async () => {
    const r = await vue([
      'commands exec include all show',
      'commands exec exclude show running-config',
    ]);
    expect(await r.executeCommand('show version')).toContain('Cisco IOS Software');
    expect(await r.executeCommand('show running-config')).toContain(REFUS);
  });
});
