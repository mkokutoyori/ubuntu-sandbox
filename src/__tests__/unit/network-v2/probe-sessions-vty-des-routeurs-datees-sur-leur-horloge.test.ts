/**
 * Le registre des sessions VTY d'un routeur ou d'un switch (`SshSessionRegistry`, qui alimente `show users`, `show ssh`
 * et la comptabilite `aaa accounting exec`), le bloqueur de connexions (`login block-for`) et la comptabilite d'exec
 * (`start_time=` / `stop_time=` / `elapsed_time=` des enregistrements TACACS+) retombaient sur `simulationNowMs()` : apres
 * `clock set`, une session datait de l'heure globale du simulateur et la comptabilite envoyait au serveur AAA des heures
 * fausses. Corrige : Router et Switch donnent l'horloge de l'equipement (`getSystemClockMs()`) au registre ; le Router la donne
 * aussi au bloqueur de connexions et, par `AaaAuthenticator`, a la comptabilite d'exec.
 *
 * Discrimine par `git stash` sur src/network : 1 des 2 cas tombe avant (routeur avance de 200 jours). Le TEMOIN (a l'heure,
 * `loginAt` est l'instant courant) passe des deux cotes. Le bloqueur et la comptabilite partagent le mecanisme sans sonde propre.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

const DAY = 24 * 3600 * 1000;

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.reset();
  EquipmentRegistry.resetInstance();
});

describe('les sessions VTY d un routeur sont datees sur son horloge', () => {
  it('TEMOIN — a l heure, loginAt est l instant courant du routeur', () => {
    const router = new CiscoRouter('R1');
    const session = router.getSshSessionRegistry().open({ user: 'alice', fromIp: '10.0.0.1', authMethod: 'password' });
    expect(Math.abs((session?.loginAt ?? 0) - router.getSystemClockMs())).toBeLessThan(5_000);
  });

  it('un routeur avance de 200 jours date la session de sa propre horloge', () => {
    const router = new CiscoRouter('R1');
    router._stepSystemClock(200 * DAY);
    const session = router.getSshSessionRegistry().open({ user: 'alice', fromIp: '10.0.0.1', authMethod: 'password' });
    expect(Math.abs((session?.loginAt ?? 0) - router.getSystemClockMs())).toBeLessThan(5_000);
  });
});
