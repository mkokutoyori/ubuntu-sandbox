import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { HuaweiRouter } from '@/network/devices/HuaweiRouter';
import { HuaweiSwitch } from '@/network/devices/HuaweiSwitch';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { getTerminalManager } from '@/terminal/sessions/TerminalManager';
import { MACAddress, resetCounters } from '@/network/core/types';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import type { Equipment } from '@/network/equipment/Equipment';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  EquipmentRegistry.resetInstance();
  Logger.clear();
  for (const id of [...getTerminalManager().getAllSessions().keys()]) {
    getTerminalManager().closeTerminal(id);
  }
});

function allume<T extends Equipment>(d: T): T {
  d.powerOn();
  return d;
}

const CLI: ReadonlyArray<readonly [string, () => Equipment]> = [
  ['routeur Cisco', () => allume(new CiscoRouter('R1', 0, 0))],
  ['commutateur Cisco', () => allume(new CiscoSwitch('switch-cisco', 'SW1', 24, 0, 0))],
  ['routeur Huawei', () => allume(new HuaweiRouter('H1', 0, 0))],
  ['commutateur Huawei', () => allume(new HuaweiSwitch('HSW1', 24, 0, 0))],
  ['commutateur generique', () => allume(new GenericSwitch('switch-generic', 'GSW', 8, 0, 0))],
];

const HOTES: ReadonlyArray<readonly [string, () => Equipment]> = [
  ['poste Linux', () => allume(new LinuxPC('linux-pc', 'PC1', 0, 0))],
  ['poste Windows', () => allume(new WindowsPC('windows-pc', 'W1', 0, 0))],
];

describe('un equipement reseau n\'a qu\'un port console', () => {
  it.each(CLI)('%s : le second terminal REND le premier', (_nom, faire) => {
    const d = faire();
    const tm = getTerminalManager();
    const a = tm.openTerminal(d, 'console');
    const b = tm.openTerminal(d, 'console');
    expect(a).toBeTruthy();
    expect(b, 'une seule console, donc une seule session').toBe(a);
    expect(tm.getSessionsForDevice(d.getId())).toHaveLength(1);
  });

  it.each(CLI)('%s : fermer le terminal libere la console', (_nom, faire) => {
    const d = faire();
    const tm = getTerminalManager();
    const a = tm.openTerminal(d, 'console')!;
    tm.closeTerminal(a);
    const b = tm.openTerminal(d, 'console');
    expect(b, 'la console est libre a nouveau').toBeTruthy();
    expect(b).not.toBe(a);
  });

  it.each(CLI)('%s : deux equipements gardent chacun sa console', (_nom, faire) => {
    const d1 = faire();
    const d2 = faire();
    const tm = getTerminalManager();
    const a = tm.openTerminal(d1);
    const b = tm.openTerminal(d2);
    expect(a).toBeTruthy();
    expect(b).toBeTruthy();
    expect(b, 'la contrainte est par machine').not.toBe(a);
  });

  it.each(CLI)('%s : la session rendue est bien vivante', (_nom, faire) => {
    const d = faire();
    const tm = getTerminalManager();
    const a = tm.openTerminal(d, 'console')!;
    const b = tm.openTerminal(d, 'console')!;
    expect(tm.getSession(b), 'ce n\'est pas un identifiant fantome').toBeTruthy();
    expect(tm.getSession(b)).toBe(tm.getSession(a));
  });
});

describe('un hote garde ses consoles multiples', () => {
  it.each(HOTES)('%s : deux terminaux sont deux sessions', (_nom, faire) => {
    const d = faire();
    const tm = getTerminalManager();
    const a = tm.openTerminal(d);
    const b = tm.openTerminal(d);
    expect(a).toBeTruthy();
    expect(b).toBeTruthy();
    expect(b, 'un PC a plusieurs consoles virtuelles').not.toBe(a);
    expect(tm.getSessionsForDevice(d.getId())).toHaveLength(2);
  });
});

describe('le registre de sessions et le terminal disent la meme chose', () => {
  it.each(CLI.slice(0, 4))('%s : une seule ligne console occupee', async (_nom, faire) => {
    const d = faire();
    const tm = getTerminalManager();
    tm.openTerminal(d);
    tm.openTerminal(d);
    const reg = (d as unknown as {
      getSshSessionRegistry?: () => {
        list(): ReadonlyArray<{ lineKind: string }>;
        open(i: Record<string, unknown>): unknown;
      };
    }).getSshSessionRegistry?.();
    if (!reg) return;
    reg.open({ user: 'alice', fromIp: 'console', transport: 'console' });
    const consoles = reg.list().filter((s) => s.lineKind === 'con');
    expect(consoles, 'le registre non plus n\'en tient qu\'une').toHaveLength(1);
  });
});

describe('un equipement eteint n\'ouvre aucune console', () => {
  it.each(CLI)('%s : refuse tant que la machine est hors tension', (_nom, faire) => {
    const d = faire();
    d.powerOff();
    const tm = getTerminalManager();
    expect(tm.openTerminal(d)).toBeNull();
  });
});

describe('une seconde fenetre est une VTY, pas une seconde console', () => {
  it.each(CLI)('%s : la vty est une session distincte', (_nom, faire) => {
    const d = faire();
    const tm = getTerminalManager();
    const console0 = tm.openTerminal(d, 'console');
    const vty0 = tm.openTerminal(d, 'vty');
    expect(console0).toBeTruthy();
    expect(vty0).toBeTruthy();
    expect(vty0, 'une ligne virtuelle n\'est pas le port console').not.toBe(console0);
    expect(tm.getSessionsForDevice(d.getId())).toHaveLength(2);
  });

  it.each(CLI)('%s : la console reste unique meme avec des vty ouvertes', (_nom, faire) => {
    const d = faire();
    const tm = getTerminalManager();
    const console0 = tm.openTerminal(d, 'console');
    tm.openTerminal(d, 'vty');
    tm.openTerminal(d, 'vty');
    expect(tm.openTerminal(d, 'console'),
      'le port console reste le meme').toBe(console0);
    expect(tm.getSessionsForDevice(d.getId())).toHaveLength(3);
  });

  it.each(CLI)('%s : plusieurs vty coexistent', (_nom, faire) => {
    const d = faire();
    const tm = getTerminalManager();
    const a = tm.openTerminal(d, 'vty');
    const b = tm.openTerminal(d, 'vty');
    expect(a).not.toBe(b);
  });

  /**
   * Ne rien demander, c'est ce que fait l'interface quand on ouvre un
   * terminal : elle branche un cable console. Ouvrir une vty est une
   * connexion RESEAU — SSH ou telnet, depuis une autre machine, avec une
   * adresse et une authentification — et l'interface graphique n'en
   * fabrique pas une au motif qu'une fenetre existe deja
   * (docs/PRD-Lignes-Terminal.md §2).
   */
  it.each(CLI)('%s : sans ligne demandee, on branche la console',
    (_nom, faire) => {
      const d = faire();
      const tm = getTerminalManager();
      const a = tm.openTerminal(d);
      const b = tm.openTerminal(d);
      expect(b, 'un chassis n\'a qu\'un port console').toBe(a);
      expect(tm.getSessionsForDevice(d.getId())).toHaveLength(1);
    });
});
