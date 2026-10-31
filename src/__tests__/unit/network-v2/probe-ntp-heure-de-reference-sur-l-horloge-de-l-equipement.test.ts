/**
 * `show ntp status` (IOS) et `display ntp-service status` (VRP) impriment « reference time », l'instant de la derniere
 * mise a jour de l'horloge, exprime sur l'horloge de l'equipement. Mesure de depart : a defaut de synchronisation la vue
 * prenait `simulationNowMs()` (l'heure globale du simulateur), donc apres `clock set` elle disait « 2026 » a cote d'un
 * `show clock` a « 2027 ». Quand une synchronisation a eu lieu, `lastSyncMs` est une heure globale (l'agent date ses
 * evenements avec l'ordonnanceur) et la vue l'imprimait telle quelle ; NtpAgent.referenceTimeMs() la ramene sur
 * l'horloge de la machine, que lisent aussi `w32tm /query /status` (Last Successful Sync Time).
 *
 * Discrimine par `git stash` sur src/network : 2 des 3 cas tombent avant (Cisco et Huawei non synchronises, apres le
 * reglage de l'horloge). Le TEMOIN (equipement intact : « reference time » et `show clock` partagent l'annee) passe
 * des deux cotes.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { HuaweiRouter } from '@/network/devices/HuaweiRouter';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

async function ciscoStatus(setClock: boolean): Promise<string> {
  const router = new CiscoRouter('R1');
  await router.executeCommand('enable');
  if (setClock) await router.executeCommand('clock set 10:00:00 5 January 2027');
  return String(await router.executeCommand('show ntp status'));
}

describe('l heure de reference NTP est lue sur l horloge de l equipement', () => {
  it('TEMOIN — equipement intact, la reference porte l annee courante', async () => {
    const year = String(new Date().getUTCFullYear());
    expect(await ciscoStatus(false)).toMatch(new RegExp(`reference time is .*${year}`));
  });

  it('IOS : apres clock set, un equipement non synchronise date sa reference de la date posee', async () => {
    expect(await ciscoStatus(true)).toMatch(/reference time is .*\(10:00:0\d\.\d+ UTC Tue Jan 5 2027\)/);
  });

  it('VRP : apres clock datetime, un equipement non synchronise date sa reference de la date posee', async () => {
    const router = new HuaweiRouter('H1');
    await router.executeCommand('system-view');
    await router.executeCommand('clock datetime 10:00:00 2027-01-05');
    await router.executeCommand('return');
    expect(String(await router.executeCommand('display ntp-service status'))).toMatch(/Reference time: 10:00:0\d\.\d+\s+Jan 5 2027/);
  });
});
