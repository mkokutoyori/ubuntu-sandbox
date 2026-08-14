/**
 * Une machine a UNE configuration NTP, et la running-config la rend UNE
 * fois.
 *
 * Mesure de depart, sur un routeur ou l'on vient de taper onze commandes
 * `ntp` : la configuration en rendait QUINZE lignes, et les deux copies
 * se contredisaient sur la meme machine au meme instant —
 *
 *     ntp master 8              ← premier rendu
 *     ntp server 10.0.0.9 prefer
 *     ntp master                ← second rendu, autre reponse
 *     ntp server 10.0.0.9 prefer
 *     ntp server 10.0.0.20      ← la MEME association que `sntp server 10.0.0.20`
 *
 * Deux rendus de la meme chose vivaient dans la meme fonction :
 * `ntpConfigLines(router)` et `NtpAgent.asRunningConfigLines()`. Le
 * premier ecrivait toujours le stratum, le second l'omet quand il vaut
 * son defaut — ce que fait IOS, verifie sur du texte capture
 * (`ciscoconfparse`, `tests/fixtures/configs/sample_01.ios`, ou la ligne
 * est `ntp master` toute seule).
 *
 * Ce n'est pas de l'affichage : cette configuration est rejouee a
 * l'import d'une topologie, donc chaque ligne y est TAPEE deux fois, et
 * la seconde efface ce que la premiere disait.
 *
 * Sur le COMMUTATEUR le meme partage produisait l'autre moitie du
 * defaut : il ne connaissait que le rendu pauvre, si bien que
 * `ntp authentication-key`, `ntp update-calendar` et `ntp access-group`
 * etaient acceptes, honores, et absents de sa propre configuration —
 * donc perdus au rechargement. Une cle d'authentification qui disparait
 * de la configuration est exactement ce qu'un auditeur cherche.
 *
 * Ce que le rendu unique devait garder de chaque cote : l'orthographe
 * `sntp` (que seul le rendu pauvre connaissait — c'est une AUTRE
 * commande, pas un synonyme d'affichage) et tout ce que seul le rendu
 * riche ecrivait.
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

type Machine = CiscoRouter | CiscoSwitch;

const REGLAGES = [
  'ntp master',
  'ntp server 10.0.0.9 prefer',
  'sntp server 10.0.0.20',
  'ntp authentication-key 1 md5 ClefNTP2026',
  'ntp trusted-key 1',
  'ntp authenticate',
  'ntp update-calendar',
  'ntp access-group peer 10',
];

async function machine(fabrique: () => Machine): Promise<Machine> {
  const m = fabrique();
  await m.executeCommand('enable');
  await m.executeCommand('configure terminal');
  for (const c of REGLAGES) await m.executeCommand(c);
  await m.executeCommand('end');
  return m;
}

async function lignesNtp(m: Machine): Promise<string[]> {
  return (await m.executeCommand('show running-config'))
    .split('\n').filter((l) => /^s?ntp\b/.test(l));
}

const PLATEFORMES: Array<[string, () => Machine]> = [
  ['routeur', () => new CiscoRouter('R1')],
  ['commutateur', () => new CiscoSwitch('switch-cisco', 'SW1')],
];

describe.each(PLATEFORMES)('une seule reponse par fait — %s', (_n, fabrique) => {
  it('aucune ligne n est rendue deux fois', async () => {
    const lignes = await lignesNtp(await machine(fabrique));
    expect(lignes.length).toBeGreaterThan(0);
    expect(new Set(lignes).size).toBe(lignes.length);
  });

  it('`ntp master` au stratum par defaut ne porte pas de nombre', async () => {
    const lignes = await lignesNtp(await machine(fabrique));
    expect(lignes).toContain('ntp master');
    expect(lignes).not.toContain('ntp master 8');
  });

  it('un stratum explicite, lui, est ecrit', async () => {
    const m = fabrique();
    await m.executeCommand('enable');
    await m.executeCommand('configure terminal');
    await m.executeCommand('ntp master 3');
    await m.executeCommand('end');
    expect(await lignesNtp(m)).toContain('ntp master 3');
  });

  it('`sntp server` garde son orthographe et ne parait pas AUSSI en `ntp server`', async () => {
    const lignes = await lignesNtp(await machine(fabrique));
    expect(lignes).toContain('sntp server 10.0.0.20');
    expect(lignes).not.toContain('ntp server 10.0.0.20');
  });

  it('tout ce qui a ete tape est rendu', async () => {
    const lignes = await lignesNtp(await machine(fabrique));
    for (const attendu of [
      'ntp server 10.0.0.9 prefer',
      'ntp authentication-key 1 md5 ClefNTP2026',
      'ntp trusted-key 1',
      'ntp authenticate',
      'ntp update-calendar',
      'ntp access-group peer 10',
    ]) expect(lignes, attendu).toContain(attendu);
  });

  it('la configuration rejouee redonne la meme configuration', async () => {
    const m = await machine(fabrique);
    const avant = await lignesNtp(m);

    const neuf = fabrique();
    await neuf.executeCommand('enable');
    await neuf.executeCommand('configure terminal');
    for (const l of avant) await neuf.executeCommand(l);
    await neuf.executeCommand('end');
    expect(await lignesNtp(neuf)).toEqual(avant);
  });
});

describe('les deux plateformes decrivent la meme configuration', () => {
  it('mot pour mot, pour la meme saisie', async () => {
    const r = await machine(() => new CiscoRouter('R1'));
    const s = await machine(() => new CiscoSwitch('switch-cisco', 'SW1'));
    expect(await lignesNtp(s)).toEqual(await lignesNtp(r));
  });
});
