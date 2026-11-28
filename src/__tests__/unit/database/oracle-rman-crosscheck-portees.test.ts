/*
 * Sonde — `CROSSCHECK BACKUP` couvre toutes les sauvegardes, `CROSSCHECK ARCHIVELOG ALL` controle les FICHIERS de journaux archives.
 *
 * Releve AVANT (laboratoire RMAN, base en ARCHIVELOG, une sauvegarde de la base puis une sauvegarde des journaux archives) :
 *
 *   CROSSCHECK BACKUP           ->  « Crosschecked N objects » sans compter les jeux de journaux
 *   CROSSCHECK ARCHIVELOG ALL   ->  « crosschecked archived log: found to be 'AVAILABLE' » par PIECE de sauvegarde de journaux ; un journal supprime du disque
 *                                    n'etait pas vu
 *
 * Oracle (Backup and Recovery Reference, CROSSCHECK) : BACKUP contrôle les sauvegardes, quel que soit leur contenu, et rend `crosschecked backup piece: found to
 * be 'AVAILABLE'` ; ARCHIVELOG controle les journaux archives inscrits dans le fichier de controle et rend `validation succeeded for archived log` puis
 * `archived log file name=...`, ou `validation failed for archived log` quand le fichier a disparu.
 *
 * Discrimine par `git stash push -- src/terminal` : 3 des 4 premiers cas tombent. Le marquage EXPIRED d'un journal absent (STATUS = X) a ete ajoute ensuite : 1 cas sur 5 tombe avant ce second correctif. Le TEMOIN (CROSSCHECK BACKUP voit les pieces de la sauvegarde de la base) passe des deux cotes.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { resetAllOracleInstances } from '@/terminal/commands/database';
import { buildRmanLab, type RmanLab } from '../../support/rmanLab';

let lab: RmanLab;

beforeEach(async () => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  resetAllOracleInstances();
  Logger.reset();
  lab = await buildRmanLab();
});

const rman = (script: string): string => lab.sh(lab.prod, `printf '${script}\\n' | rman target /`);
const sql = (statement: string): string => lab.sql(lab.prod, statement);
const ARC_DIR = '/u01/app/oracle/archivelog';

function twoKindsOfBackup(): void {
  rman('SHUTDOWN IMMEDIATE;\\nSTARTUP MOUNT;\\nSQL "ALTER DATABASE ARCHIVELOG";\\nALTER DATABASE OPEN;');
  sql('CREATE TABLE clients (id NUMBER);');
  sql('INSERT INTO clients VALUES (1);');
  sql('COMMIT;');
  rman('BACKUP DATABASE;');
  sql('ALTER SYSTEM SWITCH LOGFILE;');
  sql('ALTER SYSTEM SWITCH LOGFILE;');
  rman('BACKUP ARCHIVELOG ALL;');
}

const objects = (out: string): number => Number(/Crosschecked (\d+) objects/.exec(out)?.[1] ?? '-1');

describe('les deux portees de CROSSCHECK', () => {
  it('TEMOIN — CROSSCHECK BACKUP voit les pieces de la sauvegarde de la base', () => {
    twoKindsOfBackup();
    expect(rman('CROSSCHECK BACKUP;')).toContain("crosschecked backup piece: found to be 'AVAILABLE'");
  });

  it('CROSSCHECK BACKUP couvre aussi les sauvegardes de journaux : un objet par piece, journaux compris', () => {
    twoKindsOfBackup();
    const out = rman('CROSSCHECK BACKUP;');
    expect(objects(out)).toBe(2);
    expect((out.match(/backup piece handle=/g) ?? []).length).toBe(2);
  });

  it('CROSSCHECK ARCHIVELOG ALL controle les fichiers de journaux, pas leurs sauvegardes', () => {
    twoKindsOfBackup();
    const out = rman('CROSSCHECK ARCHIVELOG ALL;');
    expect(out).toContain('validation succeeded for archived log');
    expect(out).toMatch(/archived log file name=\/u01\/app\/oracle\/archivelog\/\S+\.arc thread=1 sequence=\d+/);
    expect(out).not.toContain('backup piece handle=');
  });

  it('un journal archive supprime du disque est signale : validation failed', () => {
    twoKindsOfBackup();
    const victim = lab.sh(lab.prod, `find ${ARC_DIR} -name "*.arc" | head -1`).trim();
    lab.sh(lab.prod, `rm ${victim}`);
    const out = rman('CROSSCHECK ARCHIVELOG ALL;');
    expect(out).toContain('validation failed for archived log');
    expect(out).toContain(victim);
  });

  it('le journal absent est marque EXPIRED (STATUS = X) dans V$ARCHIVED_LOG, les autres restent disponibles', () => {
    twoKindsOfBackup();
    const victim = lab.sh(lab.prod, `find ${ARC_DIR} -name "*.arc" | head -1`).trim();
    lab.sh(lab.prod, `rm ${victim}`);
    rman('CROSSCHECK ARCHIVELOG ALL;');
    expect(sql(`SELECT status FROM v$archived_log WHERE name = '${victim}';`)).toMatch(/^\s*X\s*$/m);
    expect(sql(`SELECT COUNT(*) AS n FROM v$archived_log WHERE name <> '${victim}' AND status = 'A';`)).toMatch(/^\s*[1-9]\d*\s*$/m);
  });
});
