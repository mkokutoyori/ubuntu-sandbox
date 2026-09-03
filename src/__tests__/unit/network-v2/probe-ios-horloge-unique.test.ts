/**
 * Un routeur IOS n'a qu'UNE horloge, et toutes ses vues de date la
 * lisent.
 *
 * Signale sur transcription : au meme instant, sur la meme machine,
 * `%SYS-5-CONFIG_I` horodatait « *Sep  3 11:19:19.075 » pendant que
 * `show running-config` ecrivait « ! Last configuration change at
 * 12:19:19 UTC Thu Sep 3 2026 ». Une heure d'ecart pour le MEME
 * changement, et le mot « UTC » sur celle des deux qui n'y etait pas.
 *
 * La cause : `horodatageIos` lisait `new Date(ms).getHours()`,
 * c'est-a-dire l'heure LOCALE de la machine qui fait tourner le
 * navigateur, et ecrivait ` UTC ` en dur derriere. Elle ignorait donc
 * les deux commandes qui gouvernent l'heure d'un routeur — `clock set`
 * la deplace, `clock timezone` la decale et la NOMME — alors que
 * `show clock` les honore depuis toujours. C'etaient deux ecritures d'un
 * meme fait, et c'est la seconde qui avait diverge.
 *
 * `dir flash:` portait le meme defaut sur la meme machine, mesure en
 * chemin : un fichier ecrit par `archive config` etait date a l'heure du
 * navigateur, et sa date ne suivait ni `clock set` ni `clock timezone`.
 * Le systeme de fichiers avait pourtant DEJA une ecoutille d'horloge
 * (`now`) que ses trois constructeurs laissaient vide.
 *
 * Il n'y a plus qu'un lecteur — `ciscoClockReading` — et une seule table
 * de noms de jours et de mois, la ou il y en avait trois. La date de
 * naissance des fichiers d'usine est construite en UTC plutot qu'en
 * heure locale, sans quoi elle aurait suivi le fuseau de l'hote alors
 * que c'est un fait de l'equipement.
 *
 * **Ce que ce lot ne fait PAS, et c'est voulu** : il n'aligne pas
 * l'horodatage syslog sur les autres. `service timestamps log datetime`
 * SANS `localtime` horodate en UTC sur un vrai IOS — c'est a cela que
 * sert le mot-cle `localtime` — donc un routeur en `clock timezone CET 1`
 * ecrit bien 12:59 dans son journal et 13:59 dans sa configuration. Un
 * cas l'epingle, sans quoi une « correction » ulterieure les ferait
 * coincider a tort.
 *
 * Discrimine par `git stash push` : 6 des 12 cas tombent, et le compte
 * est ce qu'il faut retenir : **le defaut est INVISIBLE sur un hote en
 * UTC**, ou lire l'horloge du navigateur et celle de l'equipement donne
 * le meme resultat. C'est pour cela qu'aucun test ne l'avait attrape et
 * qu'il a fallu une transcription d'utilisateur pour le voir. Les six
 * cas qui passent des deux cotes sont nommes plutot que laisses a
 * decouvrir : « la configuration et le journal datent le meme
 * changement pareil » reproduit le transcript signale et ne discrimine
 * que hors UTC ;
 * « `clock set` deplace la ligne », « la ligne NVRAM » et « la date
 * d'usine » coincident pour la meme raison ; les deux derniers sont les
 * NON-REGRESSIONS de `show clock` et `show calendar`, dont l'extraction
 * du lecteur commun aurait pu changer le rendu. Ce qui discrimine
 * partout, ce sont les trois cas a `clock timezone` — le fuseau de
 * l'equipement n'est jamais celui de l'hote — et les trois dates de
 * fichier, que l'ecoutille d'horloge laissee vide rendait etrangeres a
 * `clock set`.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

async function taper(r: CiscoRouter, ...lignes: string[]): Promise<string> {
  let derniere = '';
  for (const ligne of lignes) derniere = await r.executeCommand(ligne);
  return derniere;
}

async function banc(...prologue: string[]): Promise<CiscoRouter> {
  const r = new CiscoRouter('Router1', 0, 0);
  await taper(r, 'enable', ...prologue);
  return r;
}

const HEURE = /(\d{2}:\d{2}:\d{2})/;
const DATE_IOS = /(\w{3} \w{3} \d{1,2} \d{4})/;

function heure(texte: string): string {
  return HEURE.exec(texte)?.[1] ?? '';
}

describe('l\'horloge d\'un routeur IOS', () => {
  it('la configuration et le journal datent le MEME changement pareil', async () => {
    const r = await banc('configure terminal', 'hostname Router1', 'end');

    const ligne = heure(await r.executeCommand(
      'show running-config | include Last configuration'));
    expect(ligne).not.toBe('');
    expect(heure(await r.executeCommand(
      'show logging | include CONFIG_I'))).toBe(ligne);
  });

  it('`clock set` deplace la ligne de la configuration', async () => {
    const r = await banc('clock set 08:00:00 1 January 2020',
      'configure terminal', 'hostname Router1', 'end');

    const ligne = await r.executeCommand(
      'show running-config | include Last configuration');
    expect(ligne).toContain('08:00:00');
    expect(DATE_IOS.exec(ligne)?.[1]).toBe('Wed Jan 1 2020');
  });

  it('`clock timezone` la decale ET la nomme', async () => {
    const r = await banc('clock set 08:00:00 1 January 2020',
      'configure terminal', 'clock timezone CET 1', 'hostname Router1', 'end');

    const ligne = await r.executeCommand(
      'show running-config | include Last configuration');
    expect(ligne).toContain('09:00:00 CET');
    expect(ligne).not.toContain('UTC');
  });

  it('les quatre vues nomment le MEME fuseau', async () => {
    const r = await banc('configure terminal', 'clock timezone CET 1',
      'hostname Router1', 'end');

    for (const vue of ['show clock', 'show calendar',
      'show running-config | include Last configuration']) {
      expect(await r.executeCommand(vue), vue).toContain(' CET ');
      expect(await r.executeCommand(vue), vue).not.toContain('UTC');
    }
  });

  it('la ligne NVRAM lit la meme horloge', async () => {
    const r = await banc('clock set 08:00:00 1 January 2020',
      'configure terminal', 'hostname Router1', 'end',
      'copy running-config startup-config', '');

    const ligne = await r.executeCommand('show running-config | include NVRAM');
    expect(ligne).toContain('08:00:00');
    expect(ligne).toContain('Wed Jan 1 2020');
  });

  it('`dir` date un fichier sur l\'horloge de l\'equipement', async () => {
    const r = await banc('clock set 08:00:00 1 January 2020',
      'configure terminal', 'archive', 'path flash:cfg', 'end',
      'archive config');

    expect(await r.executeCommand('dir flash:')).toContain('Jan 01 2020 08:00:00');
  });

  it('la date d\'un fichier suit `clock timezone`', async () => {
    const r = await banc('clock set 08:00:00 1 January 2020',
      'configure terminal', 'clock timezone CET 1', 'archive', 'path flash:cfg',
      'end', 'archive config');

    expect(await r.executeCommand('dir flash:')).toContain('Jan 01 2020 09:00:00');
  });

  it('`show flash:` et `dir flash:` datent le meme fichier pareil', async () => {
    const r = await banc('clock set 08:00:00 1 January 2020',
      'configure terminal', 'archive', 'path flash:cfg', 'end', 'archive config');

    const dansDir = /cfg-1/.exec(await r.executeCommand('dir flash:'));
    expect(dansDir).not.toBeNull();
    expect(await r.executeCommand('show flash:')).toContain('Jan 01 2020 08:00:00');
  });

  it('la date d\'usine des fichiers est un fait de l\'equipement', async () => {
    const r = await banc();
    expect(await r.executeCommand('dir flash:'))
      .toContain('Mar 01 2024 00:00:00');
  });

  it('NON-REGRESSION : `show clock` garde son etoile et ses millisecondes',
    async () => {
      const r = await banc();
      expect(await r.executeCommand('show clock'))
        .toMatch(/^\*\d{2}:\d{2}:\d{2}\.000 UTC \w{3} \w{3} \d{1,2} \d{4}$/);
    });

  it('NON-REGRESSION : `show calendar` n\'a ni etoile ni millisecondes',
    async () => {
      const r = await banc();
      expect(await r.executeCommand('show calendar'))
        .toMatch(/^\d{2}:\d{2}:\d{2} UTC \w{3} \w{3} \d{1,2} \d{4}$/);
    });

  it('le journal reste en UTC sans `localtime`, comme sur un vrai IOS',
    async () => {
      const r = await banc('clock set 08:00:00 1 January 2020',
        'configure terminal', 'clock timezone CET 1', 'hostname Router1', 'end');

      expect(await r.executeCommand('show logging | include CONFIG_I'))
        .toContain('08:00:00');
      expect(await r.executeCommand(
        'show running-config | include Last configuration'))
        .toContain('09:00:00');
    });
});
