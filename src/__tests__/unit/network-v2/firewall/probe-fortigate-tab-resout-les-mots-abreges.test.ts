/*
 * Sur un FortiGate, Tab developpe les mots abreges d'une ligne l'un apres
 * l'autre, et un mot ambigu tout seul se resout par ce qui le suit :
 * `sho fi ad` + Tab donne `show firewall address`.
 *
 * L'AUTORITE : le comportement decrit par l'operateur du FortiGate et
 * documente par Fortinet (FortiOS CLI Reference, « Using the CLI » : les
 * commandes et les mots s'abregent tant que l'abreviation est sans
 * ambiguite, Tab complete le mot courant et, repete, parcourt les
 * candidats). `fi` est ambigu SEUL sous `show` (file-filter, firewall) ;
 * seul `firewall` a un fils commencant par `ad`, donc la ligne entiere
 * n'a qu'une lecture.
 *
 * Ecrite a l'aveugle, avant de lire le resolveur de chemins. 4 des 9 cas
 * tombent avant le correctif : `sho fi ad`, `conf fi ad`, le second Tab et
 * `?`. Passent des deux cotes les TEMOINS : `g sy sta` (chaque mot est sans
 * ambiguite seul), le mot rendu sans ambiguite par le premier (`show fir
 * add`), l'ambigu `sho f` qui offre les deux candidats tour a tour, le
 * prefixe qui va aux deux branches, et le mot sans lecture laisse tel quel.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { FortiGate } from '@/network/devices/firewall/vendors/fortios/FortiGate';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { openFortiConsole, key, tick } from './fortiConsoleHarness';
import type { FortiTerminalSession } from '@/terminal/sessions';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.clear();
});

async function console_(): Promise<FortiTerminalSession> {
  const fgt = new FortiGate('firewall-fortinet', 'FGT-01', 0, 0);
  for (const c of ['config system admin', 'edit "admin"', 'set password "Fortinet123"', 'next', 'end']) {
    await fgt.executeCommand(c);
  }
  return openFortiConsole(fgt, 'Fortinet123');
}

async function tab(s: FortiTerminalSession, input: string, times = 1): Promise<string> {
  s.setInput(input);
  for (let i = 0; i < times; i++) {
    s.handleKey(key('Tab'));
    await tick();
  }
  return s.input;
}

describe('an abbreviated line expands word by word', () => {
  it('show: sho fi ad → show firewall address', async () => {
    expect(await tab(await console_(), 'sho fi ad')).toBe('show firewall address');
  });

  it('config: conf fi ad → config firewall address', async () => {
    expect(await tab(await console_(), 'conf fi ad')).toBe('config firewall address');
  });

  it('get: g sy sta → get system status', async () => {
    expect(await tab(await console_(), 'g sy sta')).toBe('get system status ');
  });

  it('a second Tab cycles to the next candidate', async () => {
    const s = await console_();

    expect(await tab(s, 'sho fi ad', 2)).toBe('show firewall address6');
  });

  it('a word made unambiguous by the FIRST word only is unchanged — WITNESS', async () => {
    expect(await tab(await console_(), 'show fir add')).toBe('show firewall address');
  });
});

describe('what stays ambiguous stays untouched', () => {
  it('sho f + Tab offers the two candidates in turn, as before — WITNESS', async () => {
    const s = await console_();

    expect(await tab(s, 'show f')).toBe('show file-filter');
    expect(await tab(s, 'show f', 2)).toBe('show firewall');
  });

  it('a prefix that fits BOTH branches is not guessed', async () => {
    const s = await console_();
    const first = await tab(s, 'sho fi p');

    expect(first.startsWith('sho fi p') || first.startsWith('show file-filter') || first.startsWith('show firewall')).toBe(true);
    expect(first).not.toBe('show firewall policy ');
  });

  it('a word with no reading is left as typed', async () => {
    expect(await tab(await console_(), 'sho zz ad')).toBe('sho zz ad');
  });
});

describe('? answers the same question as Tab', () => {
  it('sho fi ad? lists the firewall address objects', async () => {
    const s = await console_();
    s.setInput('sho fi ad');
    s.handleKey(key('?'));
    await tick();
    const shown = s.lines.slice(-12).map((l) => l.text).join('\n');

    expect(shown).toContain('address');
    expect(shown).not.toContain('file-filter');
  });
});
