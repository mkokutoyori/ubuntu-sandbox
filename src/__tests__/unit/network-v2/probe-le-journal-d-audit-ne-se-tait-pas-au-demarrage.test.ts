/**
 * Le journal d'audit se taisait au demarrage, et l'exception etait avalee.
 *
 * `Router` appelle `getCredentialStore()` depuis le constructeur de la
 * classe de BASE. Cet appel monte le `SecurityAuditLog` puis insere les
 * quatre comptes d'usine, donc quatre `router.aaa.account.created`
 * traversent le bus AVANT que `CiscoRouter` ait affecte son `ntpAgent`
 * — un champ de la classe DERIVEE, initialise apres. `deviceClockSource`
 * ecrivait `dev.getNtpAgent?.().isSynced?.()` : le `?.` protege l'absence
 * de la METHODE, pas le `undefined` qu'elle rend. Le formateur
 * d'horodatage jetait, l'`EventBus` avalait, et les quatre lignes
 * `%SEC_LOGIN-6-CONFIG_CHANGE` n'atteignaient jamais `show logging`.
 *
 * Discrimination (`git stash -u`) : 6 cas sur 7 tombent avant correctif.
 * Le septieme est le TEMOIN et passe des deux cotes — il prouve que la
 * chaine d'audit fonctionne une fois la construction finie, donc que les
 * six refus mesurent la fenetre de construction et non un labo muet.
 * Une sonde faite de six refus seuls ne prouverait rien.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { HuaweiRouter } from '@/network/devices/HuaweiRouter';
import { deviceClockSource } from '@/network/devices/inspection/config/LoggingConfig';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

function countBusHandlerThrows(build: () => void): number {
  const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    build();
    return spy.mock.calls.filter(c => String(c[0]).includes('threw')).length;
  } finally {
    spy.mockRestore();
  }
}

describe('le journal d audit ne se tait pas au demarrage', () => {
  beforeEach(() => { EquipmentRegistry.resetInstance(); });

  it('building a Cisco router throws no bus handler', () => {
    expect(countBusHandlerThrows(() => { new CiscoRouter('R1'); })).toBe(0);
  });

  it('building a Huawei router throws no bus handler', () => {
    expect(countBusHandlerThrows(() => { new HuaweiRouter('R2'); })).toBe(0);
  });

  it('the factory accounts reach show logging', async () => {
    const r = new CiscoRouter('R3');
    r.powerOn();
    await r.executeCommand('enable');
    await r.executeCommand('configure terminal');
    await r.executeCommand('logging buffered 100000 debug');
    await r.executeCommand('end');

    const log = await r.executeCommand('show logging');
    for (const user of ['alice', 'bob', 'carl', 'dave']) {
      expect(log).toContain(`%SEC_LOGIN-6-CONFIG_CHANGE: Account ${user} created`);
    }
  });

  it('the clock source answers when the NTP agent is absent', () => {
    const source = deviceClockSource({ getNtpAgent: () => undefined });
    expect(source.authoritative()).toBe(false);
  });

  it('the clock source answers when NTP logging is asked of an absent agent', () => {
    const source = deviceClockSource({ getNtpAgent: () => undefined });
    expect(source.ntpEventsLogged?.()).toBe(false);
  });

  it('the clock source answers when the management service is absent', () => {
    const source = deviceClockSource({ getManagementService: () => undefined });
    expect(source.zone()).toEqual({ name: 'UTC', offsetMin: 0 });
  });

  it('an account created after boot reaches show logging', async () => {
    const r = new CiscoRouter('R4');
    r.powerOn();
    await r.executeCommand('enable');
    await r.executeCommand('configure terminal');
    await r.executeCommand('logging buffered 100000 debug');
    await r.executeCommand('username zoe privilege 15 secret Zoe12345');
    await r.executeCommand('end');

    const log = await r.executeCommand('show logging');
    expect(log).toContain('%SEC_LOGIN-6-CONFIG_CHANGE: Account zoe created with privilege 15');
  });
});
