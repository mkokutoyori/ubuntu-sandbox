/**
 * Un seul système de fichiers, une seule vérité
 * (docs/PRD-CLI-Fidelite-IOS.md §2.8).
 *
 * `show file systems` annonçait `-` en taille comme en place libre, alors
 * que le même équipement, au même instant, répondait des octets à
 * `show flash:` et `dir nvram:`. La place libre EXISTE — elle est
 * calculée depuis les fichiers réellement stockés — et c'est cette vue-là
 * qui refusait de la lire.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { MACAddress, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

async function enabled(device: CiscoRouter | CiscoSwitch) {
  await device.executeCommand('enable');
  return device;
}

function nombresDe(ligne: string): number[] {
  return [...ligne.matchAll(/\d+/g)].map((m) => Number(m[0]));
}

function ligneDe(sortie: string, prefixe: string): string {
  return sortie.split('\n').find((l) => l.includes(prefixe)) ?? '';
}

describe('show file systems lit le système de fichiers', () => {
  it('flash: annonce une taille et une place libre, pas un tiret', async () => {
    const r = await enabled(new CiscoRouter('R1'));
    const ligne = ligneDe(await r.executeCommand('show file systems'), 'flash:');

    expect(ligne).not.toMatch(/-\s+-/);
    const [taille, libre] = nombresDe(ligne);
    expect(taille).toBeGreaterThan(0);
    expect(libre).toBeGreaterThan(0);
    expect(libre).toBeLessThan(taille);
  });

  it('la place libre est celle que `show flash:` annonce', async () => {
    const r = await enabled(new CiscoRouter('R1'));
    const flash = await r.executeCommand('show flash:');
    const [total, libre] = nombresDe(
      flash.split('\n').find((l) => l.includes('bytes total')) ?? '');

    const ligne = ligneDe(await r.executeCommand('show file systems'), 'flash:');
    expect(nombresDe(ligne)).toEqual([total, libre]);
  });

  it('écrire dans flash: fait baisser la place libre des DEUX vues ensemble', async () => {
    const r = await enabled(new CiscoRouter('R1'));
    const avant = nombresDe(ligneDe(await r.executeCommand('show file systems'), 'flash:'))[1];

    await r.executeCommand('configure terminal');
    await r.executeCommand('archive');
    await r.executeCommand('path flash:cfg');
    await r.executeCommand('end');
    await r.executeCommand('archive config');

    const apres = nombresDe(ligneDe(await r.executeCommand('show file systems'), 'flash:'))[1];
    expect(apres).toBeLessThan(avant);

    const flash = await r.executeCommand('show flash:');
    const libreFlash = nombresDe(
      flash.split('\n').find((l) => l.includes('bytes total')) ?? '')[1];
    expect(libreFlash).toBe(apres);
  });

  it('le système de fichiers courant porte son astérisque', async () => {
    const r = await enabled(new CiscoRouter('R1'));
    const sortie = await r.executeCommand('show file systems');
    expect(ligneDe(sortie, 'flash:').startsWith('*')).toBe(true);
    expect(ligneDe(sortie, 'nvram:').startsWith('*')).toBe(false);
  });

  it('un switch répond aussi, avec SA propre capacité de flash', async () => {
    const sw = await enabled(new CiscoSwitch('SW1'));
    const r = await enabled(new CiscoRouter('R1'));

    const tailleSw = nombresDe(ligneDe(await sw.executeCommand('show file systems'), 'flash:'))[0];
    const tailleR = nombresDe(ligneDe(await r.executeCommand('show file systems'), 'flash:'))[0];

    expect(tailleSw).toBeGreaterThan(0);
    expect(tailleSw).not.toBe(tailleR);
  });
});

describe('La NVRAM a une seule taille', () => {
  it('dir nvram: et show file systems annoncent le même total', async () => {
    const r = await enabled(new CiscoRouter('R1'));
    const dir = await r.executeCommand('dir nvram:');
    const totalDir = nombresDe(
      dir.split('\n').find((l) => l.includes('bytes total')) ?? '')[0];

    const totalFs = nombresDe(ligneDe(await r.executeCommand('show file systems'), 'nvram:'))[0];
    expect(totalFs).toBe(totalDir);
  });

  it('show startup-config compte dans la même NVRAM', async () => {
    const r = await enabled(new CiscoRouter('R1'));
    await r.executeCommand('write memory');
    const startup = await r.executeCommand('show startup-config');
    const annonce = /Using \d+ out of (\d+) bytes/.exec(startup);
    expect(annonce).not.toBeNull();

    const totalFs = nombresDe(ligneDe(await r.executeCommand('show file systems'), 'nvram:'))[0];
    expect(Number(annonce![1])).toBe(totalFs);
  });

  it('la NVRAM du switch n\'est pas celle du routeur', async () => {
    const sw = await enabled(new CiscoSwitch('SW1'));
    const r = await enabled(new CiscoRouter('R1'));
    const totalSw = nombresDe(ligneDe(await sw.executeCommand('show file systems'), 'nvram:'))[0];
    const totalR = nombresDe(ligneDe(await r.executeCommand('show file systems'), 'nvram:'))[0];
    expect(totalSw).not.toBe(totalR);
  });

  it('sauvegarder une configuration réduit la place libre en NVRAM', async () => {
    const r = await enabled(new CiscoRouter('R1'));
    const vide = nombresDe(ligneDe(await r.executeCommand('show file systems'), 'nvram:'))[1];

    await r.executeCommand('configure terminal');
    await r.executeCommand('hostname UN-NOM-PLUTOT-LONG-POUR-OCCUPER-LA-NVRAM');
    await r.executeCommand('end');
    await r.executeCommand('write memory');

    const plein = nombresDe(ligneDe(await r.executeCommand('show file systems'), 'nvram:'))[1];
    expect(plein).toBeLessThan(vide);
  });
});
