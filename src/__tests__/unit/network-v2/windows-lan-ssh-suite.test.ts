/**
 * Windows LAN SSH suite — end-to-end exploratory tests.
 *
 * The Windows counterpart of `linux-lan-ssh-suite.test.ts`: it exercises
 * OpenSSH-for-Windows behaviour on a small LAN of Windows machines. Like
 * the Linux suite it is written as an oracle of how a *real* Windows LAN
 * should behave — any failure pinpoints a feature gap to fill.
 *
 * The suite is built section by section, mirroring the Linux sections.
 *
 * Topology (built fresh per test):
 *
 *     win1 ─┐
 *     win2 ─┼─ switch ─ (10.0.0.0/24)
 *     win3 ─┤
 *     win4 ─┘
 *
 * Conventions:
 *   - win1=10.0.0.1 win2=10.0.0.2 win3=10.0.0.3 win4=10.0.0.4
 *   - Tests use the built-in `User` account unless a section needs more.
 */

import { describe, expect, beforeEach, test } from 'vitest';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, SubnetMask } from '@/network/core/types';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

// ─── LAN fixture ────────────────────────────────────────────────────

export interface WinLan {
  win1: WindowsPC; win2: WindowsPC; win3: WindowsPC; win4: WindowsPC;
  sw: GenericSwitch;
  ipOf: Record<string, string>;
}

function buildWinLan(): WinLan {
  EquipmentRegistry.getInstance().clear();
  const win1 = new WindowsPC('windows-pc', 'win1', 0, 0);
  const win2 = new WindowsPC('windows-pc', 'win2', 0, 0);
  const win3 = new WindowsPC('windows-pc', 'win3', 0, 0);
  const win4 = new WindowsPC('windows-pc', 'win4', 0, 0);
  const sw = new GenericSwitch('switch', 'core-sw', 0, 0);
  const all = [win1, win2, win3, win4];
  all.forEach((d, i) => { new Cable(d.getPorts()[0], sw.getPorts()[i]); });

  const mask = new SubnetMask('255.255.255.0');
  win1.getPorts()[0].configureIP(new IPAddress('10.0.0.1'), mask);
  win2.getPorts()[0].configureIP(new IPAddress('10.0.0.2'), mask);
  win3.getPorts()[0].configureIP(new IPAddress('10.0.0.3'), mask);
  win4.getPorts()[0].configureIP(new IPAddress('10.0.0.4'), mask);

  return {
    win1, win2, win3, win4, sw,
    ipOf: { win1: '10.0.0.1', win2: '10.0.0.2', win3: '10.0.0.3', win4: '10.0.0.4' },
  };
}

// ─── Row helpers ────────────────────────────────────────────────────

interface Row {
  name: string;
  setup?: (lan: WinLan) => Promise<void> | void;
  on: (lan: WinLan) => WindowsPC;
  cmd: string;
  contains?: (string | RegExp)[];
  excludes?: (string | RegExp)[];
}

async function runRow(lan: WinLan, row: Row): Promise<string> {
  if (row.setup) await row.setup(lan);
  return row.on(lan).executeCommand(row.cmd);
}

function assertRow(out: string, row: Row): void {
  for (const c of row.contains ?? []) {
    if (c instanceof RegExp) expect(out).toMatch(c);
    else expect(out).toContain(c);
  }
  for (const e of row.excludes ?? []) {
    if (e instanceof RegExp) expect(out).not.toMatch(e);
    else expect(out).not.toContain(e);
  }
}

// ─── Section 1 — SSH happy path ─────────────────────────────────────

describe('§1 — Windows SSH happy path across the LAN', () => {
  let lan: WinLan;
  beforeEach(() => { lan = buildWinLan(); });

  const rows: Row[] = [
    {
      name: 'PC→PC: ssh User@win2 connects and shows the command prompt banner',
      on: l => l.win1,
      cmd: 'ssh User@10.0.0.2',
      contains: ['Microsoft Windows', /Connection to 10\.0\.0\.2 closed/],
      excludes: [/refused/i, /denied/i, /Could not resolve/],
    },
    {
      name: 'a different client reaches the same host',
      on: l => l.win3,
      cmd: 'ssh User@10.0.0.2',
      contains: ['Microsoft Windows'],
      excludes: [/refused/i],
    },
    {
      name: 'ssh with no user defaults to the local user',
      on: l => l.win1,
      cmd: 'ssh 10.0.0.4',
      contains: ['Microsoft Windows', /Connection to 10\.0\.0\.4 closed/],
      excludes: [/denied/i],
    },
    {
      name: 'ssh -l User host is equivalent to User@host',
      on: l => l.win1,
      cmd: 'ssh -l User 10.0.0.2',
      contains: ['Microsoft Windows'],
      excludes: [/refused/i, /denied/i],
    },
    {
      name: 'the Administrator account may log in over SSH',
      on: l => l.win1,
      cmd: 'ssh Administrator@10.0.0.3',
      contains: ['Microsoft Windows'],
      excludes: [/denied/i, /refused/i],
    },
  ];

  test.each(rows)('$name', async (row) => {
    assertRow(await runRow(lan, row), row);
  });
});
