/**
 * IOS ecrit une duree ecoulee d'une seule facon, quelle que soit la vue :
 * `hh:mm:ss` le premier jour, `1d01h` la premiere semaine, `2w5d` la
 * premiere annee, puis `1y17w`.
 *
 * Mesure de depart (361ca6a6) : cinq fonctions ecrivaient cette duree —
 * iosUptime (`show ip eigrp neighbors`), formatRouteAge (`show ip route`
 * et son detail), formatRipAge (`show ip rip database`, `show ip
 * protocols`), l'horodatage `uptime` du journal et le compte a rebours
 * de `show ip ospf neighbor`. formatRipAge n'avait que `hh:mm:ss`, et
 * aucune n'avait la forme annee : 1 an 17 semaines s'ecrivait `69w4d`,
 * 3 ans 20 semaines `176w6d`.
 *
 * Autorite : les sorties capturees d'IOS conservees par ntc-templates —
 * `show ip eigrp neighbors` (colonne Uptime : `00:12:45`, `1d01h`,
 * `1w6d`, `2w5d`, `13w3d`, `1y17w`, `2y33w`, `3y20w`), `show ip route`
 * (`1d05h`, `1w1d`, `2w0d`) et `show ip bgp summary` (Up/Down : `3w0d`,
 * `19w5d`, `22w0d`, `1y10w`, `1y50w`).
 *
 * Discrimination, mesuree sur le commit de base (361ca6a6) avec ce
 * fichier copie : 2 des 5 cas tombent — les deux formes annee. Passent
 * des deux cotes le TEMOIN (`hh:mm:ss` le premier jour) et les
 * NON-REGRESSIONS des formes jour et semaine, deja justes dans cette vue.
 */
import { describe, it, expect } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { VirtualTimeScheduler, __setDefaultScheduler } from '@/events/Scheduler';

const SECOND = 1_000;
const HOUR = 3_600 * SECOND;
const DAY = 24 * HOUR;

async function router() {
  const clock = new VirtualTimeScheduler();
  __setDefaultScheduler(clock);
  const r1 = new CiscoRouter('R1', 0, 0);
  for (const command of ['enable', 'configure terminal', 'service timestamps log uptime',
    'logging buffered', 'interface Loopback0', 'ip address 10.9.9.9 255.255.255.255', 'end']) {
    await r1.executeCommand(command);
  }
  return { clock, r1 };
}

async function stampAfter(elapsedMs: number): Promise<string | undefined> {
  const { clock, r1 } = await router();
  clock.jump(elapsedMs);
  for (const command of ['configure terminal', 'interface Loopback0', 'shutdown', 'end']) {
    await r1.executeCommand(command);
  }
  const lines = (await r1.executeCommand('show logging')).split('\n')
    .filter((line) => line.includes('%LINK-5-CHANGED: Interface Loopback0'));
  return lines.at(-1)?.split(': %')[0].replace(/^\*?/, '');
}

describe('an elapsed time reads the same in every IOS view', () => {
  it('WITNESS: within the first day the log stamp reads hh:mm:ss', async () => {
    expect(await stampAfter(100 * SECOND)).toMatch(/^00:01:4\d$/);
  });

  it('within the first week it reads days and hours', async () => {
    expect(await stampAfter(DAY + HOUR)).toBe('1d01h');
  });

  it('within the first year it reads weeks and days', async () => {
    expect(await stampAfter(19 * DAY + HOUR)).toBe('2w5d');
  });

  it('past one year it reads years and weeks: 1y17w', async () => {
    expect(await stampAfter(487 * DAY)).toBe('1y17w');
  });

  it('past three years: 3y20w', async () => {
    expect(await stampAfter(1_238 * DAY)).toBe('3y20w');
  });
});
