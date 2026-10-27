/**
 * Sonde — la valeur d'une option n'est pas un fichier : `head -n 2`, `tail -n +2`, `cut -d ' ' -f 2`, `sort -k 2`, `grep -m 1 x`,
 * `sed -e s/a/b/`, `awk -F: ...` lisent leur entrée standard dans un tube.
 *
 * Mesure d'origine (sur mandeng, apres le commit « Une commande qui ne lit pas l'entree standard ne la consomme plus ») :
 * `ignoresStandardInput` comptait comme opérande tout mot qui ne commence pas par `-`, donc la valeur d'une option (`2` de
 * `head -n 2`, `+2` de `tail -n +2`, `1` de `grep -m 1 x`) passait pour un nom de fichier. La commande était jugée « ne lit pas
 * l'entree » et le tube arrivait vide : `printf 'a\nb\nc\n' | tail -n +2` n'imprimait rien, et avec lui tout `ls -l | tail -n +2 | awk ...`,
 * ce qui fait tomber six labos de sockets UNIX et plusieurs suites de tubes.
 *
 * Le classement lit désormais la table des options qui prennent une valeur, par commande, et traite `-e` / `-f` comme le programme
 * de `grep`, `sed` et `awk` (un seul opérande de moins).
 *
 * Discrimination `git stash` : 6 cas tombent avant le correctif — « head -n N », « tail -n N et tail -n +N », « cut -d X -f N »,
 * « sort -k N », « grep -m N PATTERN » et « nl -ba | head -n 1 » (le `head -n 1` final).
 *
 * Passent des deux côtés, et pourquoi :
 *  - « cat lit son entrée » et « tail FICHIER ne consomme pas l'entrée » — TÉMOINS : le premier est le classement de base ; le second
 *    est le comportement que le commit d'origine voulait et que le correctif préserve.
 *  - « grep -e », « sed -e », « awk -F: » — NON-RÉGRESSION : ces formes n'ont aucun opérande (le programme vient de l'option, ou la valeur
 *    est collée à `-F`), l'ancien classement les rangeait déjà parmi les lecteurs.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { MACAddress, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
  EquipmentRegistry.resetInstance();
});

async function run(command: string): Promise<string> {
  const pc = new LinuxPC('linux-pc', 'PC1');
  pc.powerOn();
  return pc.executeCommand(command);
}

const THREE = "printf 'a\\nb\\nc\\n'";

describe('Probe — an option value is not a file operand', () => {
  it('TEMOIN: cat reads its standard input', async () => {
    expect(await run(`${THREE} | cat`)).toBe('a\nb\nc');
  });

  it('TEMOIN: tail FILE does not consume the standard input', async () => {
    expect(await run(`printf 'x\\ny\\n' > /tmp/f; ${THREE} | tail -n 1 /tmp/f`)).toBe('y');
  });

  it('head -n N reads the pipe', async () => {
    expect(await run(`${THREE} | head -n 2`)).toBe('a\nb');
  });

  it('tail -n N and tail -n +N read the pipe', async () => {
    expect(await run(`${THREE} | tail -n 2`)).toBe('b\nc');
    expect(await run(`${THREE} | tail -n +2`)).toBe('b\nc');
  });

  it('cut -d X -f N reads the pipe', async () => {
    expect(await run("printf 'a b\\n' | cut -d ' ' -f 2")).toBe('b');
  });

  it('sort -k N reads the pipe', async () => {
    expect(await run("printf '1 b\\n2 a\\n' | sort -k 2")).toBe('2 a\n1 b');
  });

  it('grep -m N PATTERN reads the pipe', async () => {
    expect(await run(`${THREE} | grep -m 1 '[abc]'`)).toBe('a');
  });

  it('grep -e PATTERN reads the pipe', async () => {
    expect(await run(`${THREE} | grep -e b`)).toBe('b');
  });

  it('sed -e SCRIPT reads the pipe', async () => {
    expect(await run(`${THREE} | sed -e 's/a/z/'`)).toBe('z\nb\nc');
  });

  it('awk -F X reads the pipe', async () => {
    expect(await run("printf 'u:v\\n' | awk -F: '{print $2}'")).toBe('v');
  });

  it('nl -ba reads the pipe', async () => {
    expect(await run(`${THREE} | nl -ba | head -n 1`)).toMatch(/1\s+a/);
  });
});
