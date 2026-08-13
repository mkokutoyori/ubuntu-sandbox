/**
 * Une abreviation ne contourne pas un niveau de privilege.
 *
 * Defaut mesure (audit §2.1) : l'autorisation comparait la chaine TAPEE
 * a la chaine de la regle. `privilege exec level 15 show version`
 * refusait donc `show version` au niveau 1 — et laissait passer
 * `sh ver`, qui est LA MEME COMMANDE. Le contournement demandait trois
 * lettres de moins que la commande elle-meme.
 *
 * Le meme defaut cassait la DELEGATION dans l'autre sens : un operateur
 * de niveau 5 a qui l'on avait donne `show running-config` recevait le
 * caret sur `sh run`, l'abreviation la plus tapee d'IOS. Les deux
 * directions comptent, et une seule des deux serait passee inapercue.
 *
 * Les cas de non-regression en fin de fichier sont la parce que le
 * correctif touche le chemin que TOUTE commande emprunte : ils fixent
 * qu'une machine sans aucune regle ne traverse aucune logique nouvelle.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
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

type Machine = CiscoRouter | CiscoSwitch;
const PLATEFORMES: Array<[string, () => Machine]> = [
  ['routeur', () => new CiscoRouter('R1', MACAddress.generate())],
  ['commutateur', () => new CiscoSwitch('SW1', MACAddress.generate())],
];

async function jouer(m: Machine, cmds: string[]): Promise<string> {
  let derniere = '';
  for (const c of cmds) derniere = await m.executeCommand(c);
  return derniere;
}

describe.each(PLATEFORMES)('abreviation et niveaux — %s', (_nom, fabrique) => {
  it('une commande HISSEE est refusee sous son abreviation', async () => {
    const m = fabrique();
    await jouer(m, [
      'enable', 'configure terminal',
      'privilege exec level 15 show version',
      'end', 'disable',
    ]);
    expect(await m.executeCommand('show version')).toContain(REFUS);
    expect(await m.executeCommand('sh ver')).toContain(REFUS);
    expect(await m.executeCommand('sh vers')).toContain(REFUS);
    expect(await m.executeCommand('sho version')).toContain(REFUS);
  });

  it('une commande DELEGUEE est accordee sous son abreviation', async () => {
    const m = fabrique();
    await jouer(m, [
      'enable', 'configure terminal',
      'privilege exec level 5 show running-config',
      'privilege exec level 5 show',
      'end', 'disable', 'enable 5',
    ]);
    expect(await m.executeCommand('show privilege')).toContain('level is 5');
    expect(await m.executeCommand('show running-config')).toContain('Building configuration');
    expect(await m.executeCommand('sh run')).toContain('Building configuration');
    expect(await m.executeCommand('sh runn')).toContain('Building configuration');
  });

  it('la CASSE de la regle ne change pas son effet', async () => {
    const m = fabrique();
    await jouer(m, [
      'enable', 'configure terminal',
      'privilege exec level 15 SHOW VERSION',
      'end', 'disable',
    ]);
    expect(await m.executeCommand('show version')).toContain(REFUS);
    expect(await m.executeCommand('sh ver')).toContain(REFUS);
  });

  it('la complétion par tabulation ne propose pas ce que l exécution refuse', async () => {
    const m = fabrique();
    await jouer(m, [
      'enable', 'configure terminal',
      'privilege exec level 15 show version',
      'end', 'disable',
    ]);
    const d = m as unknown as {
      cliTabComplete: (s: string) => string | null;
      cliTabCandidates: (s: string) => string[];
    };
    expect(d.cliTabComplete('sh vers')).toBeNull();
    expect(d.cliTabCandidates('sh vers')).toEqual([]);
  });

  it('l aide ne propose pas ce que l exécution refuse, même sur préfixe abrégé', async () => {
    const m = fabrique();
    await jouer(m, [
      'enable', 'configure terminal',
      'privilege exec level 15 show version',
      'end', 'disable',
    ]);
    const d = m as unknown as { cliHelp: (s: string) => string };
    const propose = (s: string) => /^ {2}version\b/m.test(d.cliHelp(s));
    expect(propose('show ')).toBe(false);
    expect(propose('sh ')).toBe(false);
    expect(propose('sho ')).toBe(false);
    expect(propose('show ver')).toBe(false);
    expect(propose('sh ver')).toBe(false);
  });

  it('une abreviation AMBIGUE reste ambigue, elle ne devient pas une autorisation', async () => {
    const m = fabrique();
    await jouer(m, [
      'enable', 'configure terminal',
      'privilege exec level 15 show version',
      'end', 'disable',
    ]);
    const sortie = await m.executeCommand('sh v');
    expect(sortie).not.toContain('Cisco IOS Software');
  });

  // ── Non-régression : sans règle, rien ne change ────────────────────
  it('sans aucune regle, une abreviation fonctionne comme avant', async () => {
    const m = fabrique();
    expect(await m.executeCommand('sh ver')).toContain('Cisco IOS Software');
    expect(await m.executeCommand('show version')).toContain('Cisco IOS Software');
  });

  it('sans aucune regle, l aide et la complétion restent inchangées', async () => {
    const m = fabrique();
    const d = m as unknown as {
      cliHelp: (s: string) => string;
      cliTabComplete: (s: string) => string | null;
    };
    expect(/^ {2}version\b/m.test(d.cliHelp('sh '))).toBe(true);
    expect(d.cliTabComplete('sh vers')).toBe('show version ');
  });
});

describe('abreviation dans une vue', () => {
  it('une vue accorde l abreviation de ce qu elle inclut, et refuse le reste', async () => {
    const r = new CiscoRouter('R1', MACAddress.generate());
    await jouer(r, [
      'enable', 'configure terminal', 'aaa new-model',
      'parser view V', 'commands exec include show version', 'exit', 'end',
      'enable view V',
    ]);
    expect(await r.executeCommand('show version')).toContain('Cisco IOS Software');
    expect(await r.executeCommand('sh ver')).toContain('Cisco IOS Software');
    expect(await r.executeCommand('show ip route')).toContain(REFUS);
    expect(await r.executeCommand('sh ip ro')).toContain(REFUS);
  });

  it('une commande EXCLUE le reste sous son abreviation', async () => {
    const r = new CiscoRouter('R1', MACAddress.generate());
    await jouer(r, [
      'enable', 'configure terminal', 'aaa new-model',
      'parser view V',
      'commands exec include show',
      'commands exec exclude show running-config',
      'exit', 'end',
      'enable view V',
    ]);
    expect(await r.executeCommand('sh ver')).toContain('Cisco IOS Software');
    expect(await r.executeCommand('show running-config')).toContain(REFUS);
    expect(await r.executeCommand('sh run')).toContain(REFUS);
  });
});
