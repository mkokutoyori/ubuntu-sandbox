/**
 * Un timer systemd `OnCalendar=` garde son echeance (`NEXT`) calculee sur l'horloge d'AVANT un saut. Mesure : sur une machine
 * fraichement demarree, `date -s "2027-01-05 10:00:00"` laissait `systemctl list-timers` annoncer `apt-daily.timer` pour
 * `Sat 2026-10-31 06:00:00` (dix semaines dans le passe, LEFT « n/a »), car `rearmTimers` n'etait appele que par
 * `timedatectl set-time` / set-timezone, jamais par le pas d'horloge lui-meme (`SystemClock.onStep`). Corrige : la machine
 * s'abonne aux pas d'horloge ; les echeances `OnCalendar` sont recalculees depuis la nouvelle date, et un timer
 * `Persistent=true` dont l'echeance tombait dans l'intervalle saute est rattrape (le service est lance, LAST renseigne),
 * comme systemd le fait avec son fichier d'horodatage.
 *
 * Discrimine par `git stash` sur src/network : 3 des 4 cas tombent avant. Le TEMOIN (le timer existe et annonce une echeance
 * future a l'heure) passe des deux cotes.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.reset();
  EquipmentRegistry.resetInstance();
});

const timerLine = (out: string, unit: string): string => out.split('\n').find((line) => line.includes(unit)) ?? '';

function machine(): LinuxServer {
  const srv = new LinuxServer('linux-server', 'srv', 0, 0);
  srv.powerOn();
  return srv;
}

describe('les timers systemd suivent un saut d horloge', () => {
  it('TEMOIN — a l heure, apt-daily.timer annonce une echeance future', async () => {
    const srv = machine();
    const line = timerLine(await srv.executeCommand('systemctl list-timers --no-pager'), 'apt-daily.timer');
    expect(line).toContain('apt-daily.timer');
    expect(line).toMatch(/^\w{3} \d{4}-\d{2}-\d{2} /);
  });

  it('apres date -s +66 jours, NEXT est dans le futur de la nouvelle date', async () => {
    const srv = machine();
    await srv.executeCommand('date -s "2027-01-05 10:00:00"');
    const line = timerLine(await srv.executeCommand('systemctl list-timers --no-pager'), 'apt-daily.timer');
    expect(line).toMatch(/^Tue 2027-01-05 (18|06):00:00 UTC/);
  });

  it('un timer Persistent=true saute par le pas est rattrape : LAST est renseigne', async () => {
    const srv = machine();
    await srv.executeCommand('date -s "2027-01-05 10:00:00"');
    const line = timerLine(await srv.executeCommand('systemctl list-timers --no-pager'), 'apt-daily.timer');
    expect(line).not.toMatch(/\s+n\/a\s+n\/a\s+apt-daily\.timer/);
  });

  it('le service active par le timer rattrape a ete lance', async () => {
    const srv = machine();
    await srv.executeCommand('date -s "2027-01-05 10:00:00"');
    const status = await srv.executeCommand('systemctl status apt-daily.service --no-pager');
    expect(status).toMatch(/since \w{3}, 05 Jan 2027/);
  });
});
