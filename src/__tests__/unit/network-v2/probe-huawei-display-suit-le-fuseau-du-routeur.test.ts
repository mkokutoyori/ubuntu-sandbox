/**
 * `display cpu-usage` et `display memory-usage` (routeur ET commutateur ; `display logbuffer` en
 * partage le defaut, sans entree a horodater ici)
 * horodataient avec `getHours()` d'un `Date` : le fuseau du PROCESSUS (le navigateur, en
 * production), alors que `display clock` de la meme machine lisait deja `clock timezone`. Deux
 * lignes de la meme console, au meme instant, ne disaient pas la meme heure.
 *
 * MESURE : routeur en `clock timezone CET add 01:00:00`, origine 2026-10-06 18:25:00 UTC, +3 h 17.
 * `display clock` rendait 22:42:00 ; `display cpu-usage` rendait 21:42:00 sous un processus UTC et
 * 10:42:00 (le lendemain) sous `Pacific/Auckland`. Corrige : les horodatages passent par
 * `clockReadingAt`, comme `display clock`.
 *
 * Discriminee contre l'etat d'avant : 3 des 4 cas tombent. Passe des deux cotes, et NOMME : le
 * temoin « display clock » (deja correct, il prouve que le laboratoire pose bien CET).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { HuaweiRouter } from '@/network/devices/HuaweiRouter';
import { SimulationClock, installSimulationClock, __resetSimulationClock } from '@/events/SimulationClock';
import { MACAddress, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

const ORIGINAL_TZ = process.env.TZ;

async function lab(processZone: string) {
  process.env.TZ = processZone;
  EquipmentRegistry.resetInstance(); resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();
  const clock = installSimulationClock(new SimulationClock({
    startPump: () => () => undefined,
    originMs: Date.UTC(2026, 9, 6, 18, 25, 0),
  }));
  const router = new HuaweiRouter('AR1');
  for (const line of ['system-view', 'clock timezone CET add 01:00:00', 'quit']) await router.executeCommand(line);
  await clock.advance(3 * 3600_000 + 17 * 60_000);
  return router;
}

afterEach(() => {
  if (ORIGINAL_TZ === undefined) delete process.env.TZ; else process.env.TZ = ORIGINAL_TZ;
  __resetSimulationClock();
});

describe('Huawei display commands stamp with the clock of the device', () => {
  it('witness: display clock reads CET', async () => {
    const router = await lab('Pacific/Auckland');
    expect(await router.executeCommand('display clock')).toContain('2026-10-06 22:42:00');
  });

  it.each(['UTC', 'Pacific/Auckland'])('display cpu-usage prints 22:42:00 under a %s process', async (zone) => {
    const router = await lab(zone);
    expect(await router.executeCommand('display cpu-usage')).toContain('CPU Usage Stat. Time : 2026-10-06 22:42:00');
  });

  it('display memory-usage prints the router time', async () => {
    const router = await lab('Pacific/Auckland');
    expect(await router.executeCommand('display memory-usage')).toContain('statistics at 2026-10-06 22:42:00');
  });
});
