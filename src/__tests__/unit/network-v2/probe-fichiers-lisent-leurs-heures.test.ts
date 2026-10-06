/**
 * Un fichier Linux simule portait des heures (`atime`, `mtime`, `ctime`) que presque rien ne
 * lisait. MESURE, machine posee au mardi 2026-10-06 18:25:00 UTC :
 *  - `touch -d "2 days ago" f`, `touch -t 202001011200.30 f` et `touch -r ref f` laissaient
 *    l'heure du jour : aucun fichier ne pouvait vieillir, donc aucun lab de rotation ou de purge ;
 *  - `ls -l --full-time`, `--time-style=long-iso|iso|+FORMAT`, `-c`, `-u` et `-r` etaient ignores ;
 *  - `stat -c "%y %Y"` rendait la chaine `%y %Y` ;
 *  - `find -mtime +1` comparait avec un seuil approximatif (le signe de `parseInt`), et
 *    `-mmin`, `-atime`, `-ctime`, `-newer`, `-newermt` n'existaient pas.
 *
 * Corrige : `touch` lit `-a -m -c -d -t -r` (date par `core/time/GnuDateInput`, la meme que
 * `date -d`), `ls` rend `full-iso` / `long-iso` / `iso` / `+FORMAT` dans le fuseau de la machine,
 * `stat -c` rend `%x %y %z %X %Y %Z`, `find` evalue `-mtime/-atime/-ctime N` (jours entiers, GNU),
 * `-mmin/-amin/-cmin`, `-newer`, `-newer[acm][acmt]` sur l'horloge de la machine.
 *
 * Discriminee contre l'etat d'avant : les 19 cas tombent, temoins compris, parce que `stat -c %y`
 * rendait la chaine `%y` : la lecture des heures n'etait pas observable du tout. Les deux temoins
 * (« un touch simple pose l'heure courante », « -mtime -1 ne garde que le fichier neuf ») prouvent
 * donc le laboratoire seulement apres le correctif ; leur contrepartie d'avant est mesuree plus haut.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { SimulationClock, installSimulationClock, __resetSimulationClock } from '@/events/SimulationClock';
import { MACAddress, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

let server: LinuxServer;
let clock: SimulationClock;

beforeEach(async () => {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();
  clock = installSimulationClock(new SimulationClock({
    startPump: () => () => undefined,
    originMs: Date.UTC(2026, 9, 6, 18, 25, 0),
  }));
  server = new LinuxServer('linux-server', 'S1');
  await server.executeCommand('mkdir -p /srv/lab');
  await server.executeCommand('touch -d "2 days ago" /srv/lab/old');
  await server.executeCommand('touch -t 202001011200.30 /srv/lab/ancient');
  await server.executeCommand('touch -r /srv/lab/ancient /srv/lab/copy');
  await server.executeCommand('touch /srv/lab/fresh');
});

afterEach(() => { __resetSimulationClock(); });

const run = async (command: string) => (await server.executeCommand(command)).trim();

describe('touch sets the times of a file', () => {
  it('-d reads the GNU date grammar', async () => {
    expect(await run('stat -c "%y" /srv/lab/old')).toBe('2026-10-04 18:25:00.000000000 +0000');
  });

  it('-t reads [[CC]YY]MMDDhhmm[.ss]', async () => {
    expect(await run('stat -c "%y" /srv/lab/ancient')).toBe('2020-01-01 12:00:30.000000000 +0000');
  });

  it('-r copies the time of a reference file', async () => {
    expect(await run('stat -c "%Y" /srv/lab/copy')).toBe('1577880030');
    expect(await run('stat -c "%Y" /srv/lab/ancient')).toBe('1577880030');
  });

  it('-a changes only the access time', async () => {
    await server.executeCommand('touch -a -d "1 hour ago" /srv/lab/old');
    expect(await run('stat -c "%x" /srv/lab/old')).toBe('2026-10-06 17:25:00.000000000 +0000');
    expect(await run('stat -c "%y" /srv/lab/old')).toBe('2026-10-04 18:25:00.000000000 +0000');
  });

  it('-c does not create a missing file', async () => {
    await server.executeCommand('touch -c /srv/lab/ghost');
    expect(await run('ls /srv/lab/ghost')).toContain('No such file or directory');
  });

  it('refuses a date it cannot read, and a missing operand', async () => {
    expect(await run('touch -d garbage /srv/lab/x')).toBe("touch: invalid date format 'garbage'");
    expect(await run('touch')).toContain('missing file operand');
  });

  it('witness: a plain touch stamps the current time', async () => {
    expect(await run('stat -c "%y" /srv/lab/fresh')).toBe('2026-10-06 18:25:00.000000000 +0000');
  });
});

describe('ls prints the time the way it is asked to', () => {
  it('--full-time and --time-style=full-iso print nanoseconds and the offset', async () => {
    expect(await run('ls -l --full-time /srv/lab/old')).toContain('2026-10-04 18:25:00.000000000 +0000');
  });

  it('--time-style=long-iso prints minutes', async () => {
    expect(await run('ls -l --time-style=long-iso /srv/lab/ancient')).toContain('2020-01-01 12:00 /srv/lab/ancient');
  });

  it('--time-style=+FORMAT prints a strftime format', async () => {
    expect(await run('ls -l --time-style=+%Y/%m /srv/lab/ancient')).toContain('2020/01 /srv/lab/ancient');
  });

  it('prints the time in the zone of the machine', async () => {
    await server.executeCommand('timedatectl set-timezone Asia/Tokyo');
    expect(await run('ls -l --time-style=long-iso /srv/lab/old')).toContain('2026-10-05 03:25');
  });

  it('-t sorts newest first, -r reverses', async () => {
    const newest = (await run('ls -t /srv/lab')).split(/\s+/);
    expect(newest[0]).toBe('fresh');
    const oldest = (await run('ls -tr /srv/lab')).split(/\s+/);
    expect(oldest[0]).toMatch(/ancient|copy/);
    expect(oldest[oldest.length - 1]).toBe('fresh');
  });

  it('-u shows the access time and -c the change time', async () => {
    await server.executeCommand('touch -a -d "1 hour ago" /srv/lab/old');
    expect(await run('ls -lu --time-style=long-iso /srv/lab/old')).toContain('2026-10-06 17:25');
    expect(await run('ls -lc --time-style=long-iso /srv/lab/old')).toContain('2026-10-06 18:25');
  });
});

describe('find reads the times of the files against the clock of the machine', () => {
  it('-mtime +1 keeps files older than one full day', async () => {
    expect((await run('find /srv/lab -type f -mtime +1')).split('\n').sort()).toEqual(['/srv/lab/ancient', '/srv/lab/copy', '/srv/lab/old']);
  });

  it('-mtime 2 keeps the files whose age is two whole days', async () => {
    expect(await run('find /srv/lab -type f -mtime 2')).toBe('/srv/lab/old');
  });

  it('-mmin -5 keeps the files touched within five minutes, and moves with the clock', async () => {
    expect(await run('find /srv/lab -type f -mmin -5')).toBe('/srv/lab/fresh');
    await clock.advance(10 * 60_000);
    expect(await run('find /srv/lab -type f -mmin +5 -newermt "1 day ago"')).toBe('/srv/lab/fresh');
  });

  it('-newer and -newermt compare against a file and a date', async () => {
    expect(await run('find /srv/lab -type f -newer /srv/lab/ancient')).toContain('/srv/lab/old');
    expect(await run('find /srv/lab -type f -newermt "1 hour ago"')).toBe('/srv/lab/fresh');
  });

  it('refuses an operand that is not a number', async () => {
    expect(await run('find /srv/lab -mtime abc')).toBe("find: invalid argument `abc' to `-mtime'");
  });

  it('witness: -mtime -1 keeps only the fresh file', async () => {
    expect(await run('find /srv/lab -type f -mtime -1')).toBe('/srv/lab/fresh');
  });
});
