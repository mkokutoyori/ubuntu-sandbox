/**
 * `isTimeRangeActive` lisait `getDay()` / `getHours()` d'un `Date` : le fuseau du PROCESSUS
 * (celui du navigateur en production), pas celui du routeur, et il ignorait `clock timezone` et
 * `clock summer-time`. Une plage `periodic weekdays 8:00 to 18:00` sur un routeur en CET (UTC+1)
 * s'ouvrait donc a 08:00 heure de l'utilisateur, pas a 08:00 heure du routeur ; et la borne
 * `absolute` comparait un instant a un horodatage mural.
 *
 * MESURE : routeur `clock timezone CET 1`, plage 08:00-18:00 en semaine, origine mardi
 * 2026-10-06 06:30 UTC (07:30 CET : fermee), puis +45 min (08:15 CET : ouverte). Sous un
 * processus en `Pacific/Auckland`, `show time-range` rendait l'inverse : 06:30 UTC = 19:30 a
 * Auckland (ouverte), 07:15 UTC = 20:15 (fermee). Corrige : la plage est evaluee sur l'horloge
 * MURALE du routeur (`DeviceClockStore.readingAt`), et le moteur d'ACL recoit la meme.
 *
 * Discriminee contre l'etat d'avant : 5 des 6 cas tombent, y compris sous un processus UTC (le
 * decalage CET du routeur etait ignore). Seul passe des deux cotes, et NOMME, le temoin « une plage
 * sans periode est toujours active ».
 */
import { describe, it, expect, afterEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { SimulationClock, installSimulationClock, __resetSimulationClock } from '@/events/SimulationClock';
import { MACAddress, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

const ORIGINAL_TZ = process.env.TZ;

async function lab(processZone: string, routerSetup: string[]) {
  process.env.TZ = processZone;
  EquipmentRegistry.resetInstance(); resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();
  const clock = installSimulationClock(new SimulationClock({
    startPump: () => () => undefined,
    originMs: Date.UTC(2026, 9, 6, 6, 30, 0),
  }));
  const router = new CiscoRouter('R1');
  for (const line of ['enable', 'configure terminal', ...routerSetup, 'end']) await router.executeCommand(line);
  return { router, clock };
}

const WORK_HOURS = ['clock timezone CET 1', 'time-range WORK', 'periodic weekdays 8:00 to 18:00', 'exit'];

afterEach(() => {
  if (ORIGINAL_TZ === undefined) delete process.env.TZ; else process.env.TZ = ORIGINAL_TZ;
  __resetSimulationClock();
});

describe('a time-range follows the clock of the router that owns it', () => {
  it.each(['UTC', 'Pacific/Auckland', 'America/New_York'])('is closed at 07:30 CET and open at 08:15 CET under a %s process', async (zone) => {
    const { router, clock } = await lab(zone, WORK_HOURS);
    expect(await router.executeCommand('show time-range')).toContain('WORK (inactive)');
    await clock.advance(45 * 60_000);
    expect(await router.executeCommand('show time-range')).toContain('WORK (active)');
  });

  it('closes again at 18:00 of the router, not of the process', async () => {
    const { router, clock } = await lab('Pacific/Auckland', WORK_HOURS);
    await clock.advance(10 * 3600_000);
    expect(await router.executeCommand('show clock')).toContain('17:30:00');
    expect(await router.executeCommand('show time-range')).toContain('WORK (active)');
    await clock.advance(45 * 60_000);
    expect(await router.executeCommand('show time-range')).toContain('WORK (inactive)');
  });

  it('witness: a range with no period is always active', async () => {
    const { router } = await lab('Pacific/Auckland', ['time-range ALWAYS', 'exit']);
    expect(await router.executeCommand('show time-range')).toContain('ALWAYS (active)');
  });

  it('keeps summer time in the evaluation of the range', async () => {
    const { router, clock } = await lab('Pacific/Auckland', [
      'clock timezone CET 1', 'clock summer-time CEST recurring last Sun Mar 2:00 last Sun Oct 3:00',
      'time-range WORK', 'periodic weekdays 8:00 to 18:00', 'exit',
    ]);
    await clock.advance(45 * 60_000);
    expect(await router.executeCommand('show clock')).toContain('CEST');
    expect(await router.executeCommand('show time-range')).toContain('WORK (active)');
  });
});
