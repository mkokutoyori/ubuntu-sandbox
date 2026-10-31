/**
 * Le magasin de comptes locaux d'un routeur ou d'un switch (`NetworkOsCredentialStore`) datait par defaut ses
 * evenements (connexion reussie, echec, verrouillage, deverrouillage) sur `simulationNowMs()` : apres `clock set`, la
 * date du dernier succes d'un compte et l'instant du verrouillage restaient sur l'heure globale du simulateur, alors que
 * `show clock` annoncait la date posee. Corrige : le magasin recoit l'horloge de l'equipement (`getSystemClockMs()`), comme
 * celui des vdoms du pare-feu (`deps.now`).
 *
 * Discrimine par `git stash` sur src/network : 1 des 2 cas tombe avant (routeur dont l'horloge a avance de 400 jours). Le
 * TEMOIN (horloge intacte, la date enregistree est l'heure courante) passe des deux cotes.
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

describe('les comptes d un routeur sont dates sur son horloge', () => {
  it('TEMOIN — a l heure, la date du dernier succes est l instant courant', () => {
    const router = new CiscoRouter('R1');
    const store = router.getCredentialStore();
    store.recordLoginSuccess('alice', 'console', 'password');
    expect(Math.abs((store.get('alice')?.lastLoginAt ?? 0) - router.getSystemClockMs())).toBeLessThan(5_000);
  });

  it('un routeur avance de 400 jours date la connexion de sa propre horloge', () => {
    const router = new CiscoRouter('R1');
    router._stepSystemClock(400 * DAY);
    const store = router.getCredentialStore();
    store.recordLoginSuccess('alice', 'console', 'password');
    expect(Math.abs((store.get('alice')?.lastLoginAt ?? 0) - router.getSystemClockMs())).toBeLessThan(5_000);
  });
});
