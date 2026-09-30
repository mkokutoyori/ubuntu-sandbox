/*
 * PowerShell : un mot nu qui COMMENCE par des chiffres et se poursuit par des
 * lettres (`00030001aabbccddeeff`, un DUID ou un identifiant hexadecimal) est une
 * chaine, pas un nombre suivi de restes. Le lexeur le scindait : la commande
 * recevait `30001` (le nombre) au lieu du mot. Les suffixes numeriques valides
 * (kb, mb, gb, tb, pb, l, d, u, ul, s, y, exposant, 0x) restent des nombres.
 *
 * Avant le correctif : « 00030001aabbccddeeff » et « 12abc » tombent (2 cas) ;
 * les cinq cas de suffixes et de nombres purs sont des temoins qui passent avant
 * comme apres.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters } from '@/network/core/types';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { PowerShellSubShell } from '@/terminal/subshells/PowerShellSubShell';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.reset();
});

const ps = async (line: string) => {
  const shell = PowerShellSubShell.create(new WindowsPC('windows-pc', 'PC1')).subShell;
  return (await shell.processLine(line)).output.join('\n').trim();
};

describe('mot nu commencant par des chiffres', () => {
  it('un DUID hexadecimal reste entier', async () => {
    expect(await ps('Write-Output 00030001aabbccddeeff')).toBe('00030001aabbccddeeff');
  });

  it('un identifiant court melant chiffres et lettres reste entier', async () => {
    expect(await ps('Write-Output 12abc')).toBe('12abc');
  });
});

describe('temoins : les nombres restent des nombres', () => {
  it('nombre entier', async () => { expect(await ps('Write-Output 42')).toBe('42'); });
  it('suffixe kb', async () => { expect(await ps('Write-Output 1kb')).toBe('1024'); });
  it('exposant', async () => { expect(await ps('Write-Output 1e3')).toBe('1000'); });
  it('hexadecimal', async () => { expect(await ps('Write-Output 0x1F')).toBe('31'); });
  it('addition', async () => { expect(await ps('Write-Output (2+3)')).toBe('5'); });
});
