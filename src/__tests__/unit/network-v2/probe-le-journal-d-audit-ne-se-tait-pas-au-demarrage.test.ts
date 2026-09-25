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
 *
 * REVISION. Les cas 3 et 7 affirmaient que `show logging` porte
 * `%SEC_LOGIN-6-CONFIG_CHANGE: Account … created`. Ce mnemonique n'est
 * source par aucune documentation Cisco joignable d'ici ; les messages
 * `SEC_LOGIN` documentes sont ceux de Login Enhancements (reussite, echec,
 * mode silencieux), et un changement de configuration s'ecrit
 * `%SYS-5-CONFIG_I`. La ligne n'arrivait au journal que par un pont
 * `SecurityAuditLog -> syslog` qui doublait aussi `%SEC_LOGIN-5-LOGIN_SUCCESS`
 * (deux lignes, deux formulations, pour une ouverture mesuree) ; ce pont
 * est supprime. Les deux cas mesurent donc le REGISTRE d'audit, ou ces
 * entrees vivent, et affirment que le journal ne les invente pas.
 * Mesure contre l'etat d'avant la suppression : les cas 3 et 7 tombent,
 * par leur moitie « le journal ne l'invente pas ». Sans le pont, plus rien
 * ne jette pendant la construction : les cas 1 et 2 passent des deux
 * cotes et restent comme non-regressions ; 4 a 6 gardent le port.
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

  it('the factory accounts reach the audit ledger, and show logging invents no line for them', async () => {
    const r = new CiscoRouter('R3');
    r.powerOn();
    await r.executeCommand('enable');
    await r.executeCommand('configure terminal');
    await r.executeCommand('logging buffered 100000 debug');
    await r.executeCommand('end');

    const audited = r.getSecurityAuditLog().entries().map(e => e.message);
    for (const user of ['alice', 'bob', 'carl', 'dave']) {
      expect(audited).toContain(`Account ${user} created with privilege 1`);
    }
    expect(await r.executeCommand('show logging')).not.toContain('%SEC_LOGIN-6-CONFIG_CHANGE');
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

  it('an account created after boot reaches the audit ledger, and show logging says CONFIG_I', async () => {
    const r = new CiscoRouter('R4');
    r.powerOn();
    await r.executeCommand('enable');
    await r.executeCommand('configure terminal');
    await r.executeCommand('logging buffered 100000 debug');
    await r.executeCommand('username zoe privilege 15 secret Zoe12345');
    await r.executeCommand('end');

    expect(r.getSecurityAuditLog().entries().map(e => e.message))
      .toContain('Account zoe created with privilege 15');
    const log = await r.executeCommand('show logging');
    expect(log).toMatch(/%SYS-5-CONFIG_I: Configured from console/);
    expect(log).not.toContain('%SEC_LOGIN-6-CONFIG_CHANGE');
  });
});
