/*
 * Sonde — la duree d'une restauration est celle que le simulateur fait ECOULER, calculee du meme modele que celle d'une sauvegarde.
 *
 * Releve AVANT (laboratoire RMAN, sauvegarde de la base puis RESTORE DATAFILE) : `elapsed time: 00:00:25` etait une chaine ecrite en dur (et `00:00:03` pour RECOVER), sans rapport avec la
 * taille du fichier, alors que la sauvegarde utilisait `simulateBackupElapsedMs` (taille / debit modelise) ; l'horloge n'avancait que de quelques secondes : « Starting restore at 02:19:30 »
 * puis « Finished restore at 02:19:32 » pour « elapsed time: 00:00:25 ». Deux ecritures d'un meme fait qui se contredisaient.
 *
 * Maintenant : une seule regle (taille / 50 Mo/s, minimum 1 s, `pureUtils.simulateBackupElapsedMs`), la restauration et la recuperation l'appliquent et font avancer l'horloge de l'hote d'autant,
 * donc `Finished restore at` - `Starting restore at` = `elapsed time`. Le debit de 50 Mo/s est un MODELE (pas une mesure de disque) : c'est la limite qui reste, dite telle quelle.
 *
 * Discrimine par `git stash push -- src/terminal` : 2 des 3 cas tombent. TEMOIN : la duree d'une sauvegarde suit toujours le meme modele (passe des deux cotes).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { resetAllOracleInstances } from '@/terminal/commands/database';
import { buildRmanLab, type RmanLab } from '../../support/rmanLab';

let lab: RmanLab;

beforeEach(async () => {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); resetAllOracleInstances(); Logger.reset();
  lab = await buildRmanLab();
});

const rman = (script: string): string => lab.sh(lab.prod, `printf '${script}\\n' | rman target /`);
const sql = (statement: string): string => lab.sql(lab.prod, statement);

const seconds = (hms: string): number => { const [h, m, s] = hms.split(':').map(Number); return h * 3600 + m * 60 + s; };
const clock = (out: string, label: string): number => seconds(new RegExp(`${label} restore at \\d\\d-\\w{3}-\\d{4} (\\d\\d:\\d\\d:\\d\\d)`).exec(out)?.[1] ?? '00:00:00');
const elapsed = (out: string): number => [...out.matchAll(/restore complete, elapsed time: (\d\d:\d\d:\d\d)/g)].reduce((total, match) => total + seconds(match[1]), 0);

function restoreOutput(): string {
  rman('SHUTDOWN IMMEDIATE;\\nSTARTUP MOUNT;\\nSQL "ALTER DATABASE ARCHIVELOG";\\nALTER DATABASE OPEN;');
  sql('CREATE TABLE clients (id NUMBER);');
  sql('INSERT INTO clients VALUES (1);');
  sql('COMMIT;');
  rman('BACKUP DATABASE;');
  rman('SHUTDOWN ABORT;');
  rman('STARTUP MOUNT;');
  return rman('RESTORE DATABASE;');
}

describe('duration of RESTORE and RECOVER', () => {
  it('TEMOIN — a backup reports the time the model derives from its size and the clock moves by it', () => {
    rman('SHUTDOWN IMMEDIATE;\\nSTARTUP MOUNT;\\nSQL "ALTER DATABASE ARCHIVELOG";\\nALTER DATABASE OPEN;');
    const out = rman('BACKUP DATABASE;');
    const start = seconds(/Starting backup at \d\d-\w{3}-\d{4} (\d\d:\d\d:\d\d)/.exec(out)?.[1] ?? '00:00:00');
    const finish = seconds(/Finished backup at \d\d-\w{3}-\d{4} (\d\d:\d\d:\d\d)/.exec(out)?.[1] ?? '00:00:00');
    const reported = seconds(/backup set complete, elapsed time: (\d\d:\d\d:\d\d)/.exec(out)?.[1] ?? '00:00:00');
    expect(finish - start).toBe(reported);
  });

  it('the clock moves by the sum of the restore times that are printed', () => {
    const out = restoreOutput();
    expect(elapsed(out)).toBeGreaterThan(0);
    expect(clock(out, 'Finished') - clock(out, 'Starting')).toBe(elapsed(out));
  });

  it('the printed restore time is not the old literal 00:00:25 for every file', () => {
    const out = restoreOutput();
    const times = [...out.matchAll(/restore complete, elapsed time: (\d\d:\d\d:\d\d)/g)].map((match) => match[1]);
    expect(times.length).toBeGreaterThan(1);
    expect(new Set(times).size).toBeGreaterThan(1);
  });
});
