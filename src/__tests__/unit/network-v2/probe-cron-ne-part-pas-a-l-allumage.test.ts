/*
 * Sonde sur la MINUTE D'ALLUMAGE de cron.
 *
 * Un vrai `cron` s'aligne sur la minute suivante : il dort jusqu'au
 * prochain passage a zero seconde, puis lance ce qui est du. Demarrer a
 * 09:17:30 ne lance donc PAS la tache de 09:17 — elle est deja passee.
 * Seul `@reboot` part a l'allumage, et c'est justement ce qui le
 * distingue des autres.
 *
 * CE QUI L'A FAIT ECRIRE : `cron-n-ecrit-pas-dans-history` comptait
 * DEUX lignes CRON la ou il en attend une, une fois dans un balayage de
 * 1645 fichiers, et passait seul. La cause n'est pas le hasard :
 * `/etc/crontab` porte la ligne de Debian
 *
 *     17 *  * * *  root  cd / && run-parts --report /etc/cron.hourly
 *
 * et `startCronTicker()` lance un tour IMMEDIAT a l'allumage, date de
 * l'horloge de la machine. Un balayage d'une heure passe forcement par
 * la minute 17 : la tache horaire partait alors pendant l'allumage, et
 * sa ligne de journal s'ajoutait a celle que le cas mesurait. Le meme
 * mecanisme rendait `systemctl start cron` capable de lancer, dans la
 * seconde, tout ce qui est du a la minute courante.
 *
 * L'heure est FIXEE ici (`vi.setSystemTime`) : une sonde qui laisserait
 * le calendrier choisir mesurerait l'heure qu'il est, ce qui est
 * exactement le defaut qu'elle poursuit.
 *
 * Discriminee contre l'etat d'avant : 3 des 5 cas tombent. Les deux
 * premiers mesurent l'allumage lui-meme ; le troisieme — « une minute
 * sans rien de du ne journalise rien » — tombe pour la MEME raison et
 * le dit autrement : la ligne qu'il trouve n'est pas de sa minute, elle
 * est celle que l'allumage avait deja ecrite. Les 2 qui passent des
 * deux cotes sont nommes :
 *   - « la tache horaire part quand sa minute arrive » est le TEMOIN :
 *     sans lui, un moteur devenu sourd serait indiscernable d'un moteur
 *     corrige ;
 *   - « @reboot part au DEMARRAGE du service » garde ce que la
 *     correction ne doit PAS emporter : `fireReboot` reste appele par
 *     `start()`, et c'est la seule chose qui parte sans attendre une
 *     minute.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

const ALLUMAGE = '2027-03-01T09:17:30Z';

beforeEach(() => {
  EquipmentRegistry.resetInstance();
  vi.useFakeTimers({ shouldAdvanceTime: false });
  vi.setSystemTime(new Date(Date.parse(ALLUMAGE)));
});

afterEach(() => { vi.useRealTimers(); });

function laboratoire(): { pc: LinuxPC; tour: (iso: string) => void } {
  const pc = new LinuxPC('linux-pc', 'pc1', 0, 0);
  pc.powerOn();
  const machine = pc as unknown as {
    cronTick(at?: Date): void;
    cronTimer: symbol | null;
    hostTimers: { clear(id: symbol): void };
  };
  if (machine.cronTimer) { machine.hostTimers.clear(machine.cronTimer); machine.cronTimer = null; }
  return { pc, tour: (iso) => machine.cronTick(new Date(Date.parse(iso))) };
}

const lignesCron = async (pc: LinuxPC): Promise<string[]> =>
  (await pc.executeCommand('grep CRON /var/log/syslog'))
    .split('\n').filter((l) => l.includes('CRON'));

describe('cron s aligne sur la minute suivante', () => {
  it('la tache horaire de /etc/crontab NE part PAS a l allumage', async () => {
    const { pc } = laboratoire();
    expect(await lignesCron(pc)).toEqual([]);
  });

  it('la tache horaire part quand sa minute arrive — le TEMOIN', async () => {
    const { pc, tour } = laboratoire();
    tour('2027-03-01T10:17:00Z');
    expect((await lignesCron(pc)).join('\n')).toContain('run-parts');
  });

  it('une minute sans rien de du ne journalise rien', async () => {
    const { pc, tour } = laboratoire();
    tour('2027-03-01T09:18:00Z');
    expect(await lignesCron(pc)).toEqual([]);
  });

  it('une tache posee DANS la minute d allumage attend la suivante', async () => {
    const { pc, tour } = laboratoire();
    await pc.executeCommand('echo "* * * * * /bin/true" | crontab -');

    tour(ALLUMAGE);
    expect(await lignesCron(pc), 'la minute d allumage est deja passee').toEqual([]);

    tour('2027-03-01T09:18:00Z');
    expect((await lignesCron(pc)).join('\n')).toContain('/bin/true');
  });

  it('`@reboot` part au DEMARRAGE du service — ce que la correction ne prend pas', async () => {
    const { pc, tour } = laboratoire();
    await pc.executeCommand('echo "@reboot echo boot >> /home/user/b.txt" | crontab -');

    await pc.executeCommand('systemctl stop cron');
    tour('2027-03-01T09:18:00Z');
    await pc.executeCommand('systemctl start cron');
    tour('2027-03-01T09:19:00Z');

    expect((await pc.executeCommand('cat /home/user/b.txt')).trim()).toBe('boot');
  });
});
