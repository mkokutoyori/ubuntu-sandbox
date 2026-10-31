/**
 * Une sauvegarde RMAN affichait trois durees qui ne disaient pas la meme chose : « backup set complete, elapsed time:
 * 00:00:33 » (modele de debit, fonction de la taille), « Starting backup at » et « Finished backup at » a la MEME seconde
 * (l'horloge de la machine n'avancait pas), et la colonne « Elapsed Time » de LIST BACKUP valant 00:00:15 quelle que soit la
 * taille (`startTime = completionTime - 15000` en dur dans BackupSetFactory). Meme defaut pour SYSDATE apres la sauvegarde.
 * Corrige : le moteur calcule UNE duree par jeu de sauvegarde (`simulateBackupElapsedMs`), la depense sur l'horloge de la machine
 * cible (`IRmanOracleContext.spendHostTime` -> `_stepSystemClock`), la fait porter par l'evenement et par le catalogue
 * (startTime = completionTime - duree). « Finished at » = « Starting at » + duree, SYSDATE l'a franchie, LIST BACKUP la relit.
 *
 * Discrimine par `git stash` sur src/terminal : 2 des 4 cas tombent (Finished = Starting + duree, colonne Elapsed Time).
 * Passent des deux cotes : le TEMOIN (la sauvegarde reussit, son tag est catalogue) et « SYSDATE a franchi la duree »,
 * STRUCTUREL avant la correction (debut et fin etaient la meme seconde, donc SYSDATE les egalait) et qui garde
 * maintenant contre une horloge qui avancerait pour l'affichage sans avancer pour SQL.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { getOracleDatabase } from '@/terminal/commands/database';
import { createSqlPlusRunner, type SqlPlusRunner } from '../../debug/oracle/_oracle-dump';
import { createRmanRunner, type RmanShellRunner } from '../../debug/rman/_rman-dump';

let server: LinuxServer;
let sql: SqlPlusRunner;
let rman: RmanShellRunner;

beforeEach(async () => {
  server = new LinuxServer('linux-server', 'ora-duration', 100, 100);
  await server.executeCommand('date -s "2026-01-10 08:00:00"');
  getOracleDatabase(server.id);
  sql = createSqlPlusRunner(server);
  rman = createRmanRunner(server);
});

const seconds = (hms: string): number => {
  const [h, m, s] = hms.split(':').map(Number);
  return h * 3600 + m * 60 + s;
};
const wallSeconds = (stamp: string): number => {
  const m = /(\d{2}):(\d{2}):(\d{2})$/.exec(stamp)!;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
};

describe('la duree d une sauvegarde RMAN passe sur l horloge de la machine', () => {
  it('TEMOIN — la sauvegarde reussit et son tag est catalogue', () => {
    const out = rman.execute('BACKUP DATABASE TAG weekly;');
    expect(out).toContain('Finished backup at');
    expect(rman.execute('LIST BACKUP SUMMARY;')).toContain('WEEKLY');
  });

  it('Finished backup at = Starting backup at + elapsed time', () => {
    const out = rman.execute('BACKUP DATABASE;');
    const starting = /Starting backup at (.+)/.exec(out)![1];
    const finished = /Finished backup at (.+)/.exec(out)![1];
    const elapsed = seconds(/elapsed time: (\d{2}:\d{2}:\d{2})/.exec(out)![1]);
    expect(elapsed).toBeGreaterThan(0);
    expect(wallSeconds(finished) - wallSeconds(starting)).toBe(elapsed);
  });

  it('SYSDATE a franchi la duree de la sauvegarde', () => {
    const out = rman.execute('BACKUP DATABASE;');
    const finished = /Finished backup at (.+)/.exec(out)![1];
    const sysdate = sql.execute("SELECT TO_CHAR(SYSDATE, 'HH24:MI:SS') FROM dual;");
    expect(sysdate).toContain(finished.slice(-8));
  });

  it('la colonne Elapsed Time de LIST BACKUP est la duree annoncee par la sauvegarde', () => {
    const out = rman.execute('BACKUP DATABASE;');
    const elapsed = /elapsed time: (\d{2}:\d{2}:\d{2})/.exec(out)![1];
    const listing = rman.execute('LIST BACKUP;');
    expect(listing).toContain(elapsed);
  });
});
