/**
 * Sonde — la standby APPLIQUE ce qu'elle a recu.
 *
 * Deuxieme des trois morceaux du chantier Data Guard. Le transport est
 * ferme (R13) : le journal traverse le fil et la standby l'ecrit.
 * CLAUDE.md nommait ce qui restait : « ALTER DATABASE RECOVER MANAGED
 * STANDBY DATABASE still answers `Database altered.` without applying
 * anything, so the standby's SCN never advances. » Le banc
 * `debug/rman/dataguard-application-redo` l'a mesure : la commande etait
 * avalee par le repli generique du parseur d'ALTER DATABASE, qui rend
 * « Database altered. » a tout ce qu'il ne reconnait pas.
 *
 * LA QUESTION QUI DECIDE, et que cette sonde pose : une ligne inseree
 * sur le PRIMAIRE se retrouve-t-elle dans la base de la STANDBY ?
 *
 * CE QUE LE MRP APPLIQUE, et c'est une decision mesuree. Un journal
 * archive de ce simulateur porte DEUX choses : l'image des tablespaces
 * au moment du switch, et les vecteurs de changement de la periode. Ma
 * premiere ecriture appliquait les deux — et la standby comptait DEUX
 * lignes la ou le primaire en comptait une, parce que l'instantane les
 * contenait deja. L'instantane EST l'etat a la fin du journal : il
 * suffit, et les vecteurs ne servent qu'a un datafile que l'expedition
 * ne portait pas.
 *
 * CE QUI RESTE APRES CE LOT : la bascule. `switchover()` echange
 * toujours deux champs de role sans deplacer de donnees.
 *
 * Discrimination par `git stash push -- src/database src/adapters
 * src/terminal` : 6 cas sur 8 tombent avant.
 *
 * Les DEUX qui ne discriminent pas, nommes avec leur raison :
 *  - « TEMOIN — sans MRP, la standby recoit mais n'applique pas » :
 *    TEMOIN de la SEPARATION. Il passe avant (rien ne s'appliquait) et
 *    apres (le CANCEL decide vraiment) ; c'est lui qui interdit de
 *    fermer le defaut en appliquant tout ce qui arrive.
 *  - « TEMOIN — le primaire n'est pas touche par l'application » :
 *    TEMOIN. La standby lit et ecrit SES fichiers ; si le compte du
 *    primaire bougeait, c'est que l'un ecrirait chez l'autre. Il a
 *    fallu le REDUIRE : ma premiere redaction lui faisait verifier
 *    d'abord l'etat de la standby, donc il tombait avant le correctif,
 *    et un temoin qui tombe ne temoigne de rien.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import type { LinuxServer } from '@/network/devices/LinuxServer';
import { resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { getOracleDatabase, resetAllOracleInstances } from '@/terminal/commands/database';
import { buildRmanLab, type RmanLab } from '../support/rmanLab';

let lab: RmanLab;

beforeEach(async () => {
  resetCounters();
  resetDeviceCounters();
  resetAllOracleInstances();
  Logger.reset();
  lab = await buildRmanLab();
});

const sh = (srv: LinuxServer, cmd: string) => srv.executeShellCommandSync(cmd);

const compte = (srv: LinuxServer): number => {
  const out = lab.sql(srv, 'SELECT COUNT(*) FROM clients;');
  const m = /^\s*(\d+)\s*$/m.exec(out);
  return m ? Number(m[1]) : -1;
};

function paire(avecMrp: boolean): { prod: LinuxServer; dr: LinuxServer } {
  const { prod, dr } = lab;
  for (const s of [prod, dr]) {
    const db = getOracleDatabase(s.getId());
    (db.instance as unknown as { _archiveLogMode: boolean })._archiveLogMode = true;
  }
  lab.sql(prod,
    `ALTER SYSTEM SET LOG_ARCHIVE_DEST_2 = 'SERVICE=${lab.drIp}:1521/ORCL ASYNC DB_UNIQUE_NAME=DR';`);
  lab.sql(prod, 'ALTER SYSTEM SET LOG_ARCHIVE_DEST_STATE_2 = ENABLE;');
  if (avecMrp) lab.sql(dr, 'ALTER DATABASE RECOVER MANAGED STANDBY DATABASE DISCONNECT FROM SESSION;');
  lab.sql(prod, 'CREATE TABLE clients (id NUMBER);');
  lab.sql(prod, 'INSERT INTO clients VALUES (1);');
  lab.sql(prod, 'COMMIT;');
  lab.sql(prod, 'ALTER SYSTEM SWITCH LOGFILE;');
  return { prod, dr };
}

describe('la recuperation geree de la standby', () => {
  it('la ligne inseree sur le primaire arrive dans la base de la standby', () => {
    const { prod, dr } = paire(true);
    expect(compte(prod)).toBe(1);
    expect(compte(dr)).toBe(1);
  });

  it('l alert log de la standby porte le MRP et le journal applique', () => {
    const { dr } = paire(true);
    const journal = sh(dr, 'cat /u01/app/oracle/diag/rdbms/orcl/ORCL/trace/alert_ORCL.log');
    expect(journal).toContain('MRP0 started');
    expect(journal).toMatch(/Media Recovery Log applied, sequence 1/);
  });

  it('TEMOIN DE SEPARATION — sans MRP, la standby recoit mais n applique pas', () => {
    const { prod, dr } = paire(false);
    expect(sh(dr, 'ls /u01/app/oracle/archivelog')).toContain('1_1_arc.arc');
    expect(compte(prod)).toBe(1);
    expect(compte(dr)).toBe(-1);
  });

  it('CANCEL arrete vraiment : le primaire avance, la standby non', () => {
    const { prod, dr } = paire(true);
    expect(compte(dr)).toBe(1);
    lab.sql(dr, 'ALTER DATABASE RECOVER MANAGED STANDBY DATABASE CANCEL;');
    lab.sql(prod, 'INSERT INTO clients VALUES (2);');
    lab.sql(prod, 'COMMIT;');
    lab.sql(prod, 'ALTER SYSTEM SWITCH LOGFILE;');
    expect(compte(prod)).toBe(2);
    expect(compte(dr)).toBe(1);
  });

  it('relancer le MRP rattrape le retard accumule', () => {
    const { prod, dr } = paire(true);
    lab.sql(dr, 'ALTER DATABASE RECOVER MANAGED STANDBY DATABASE CANCEL;');
    lab.sql(prod, 'INSERT INTO clients VALUES (2);');
    lab.sql(prod, 'COMMIT;');
    lab.sql(prod, 'ALTER SYSTEM SWITCH LOGFILE;');
    expect(compte(dr)).toBe(1);
    lab.sql(dr, 'ALTER DATABASE RECOVER MANAGED STANDBY DATABASE;');
    expect(compte(dr)).toBe(2);
  });

  it('le retard d application se MESURE sur la standby', () => {
    const { prod, dr } = paire(true);
    expect(lab.sql(dr, "SELECT name, value FROM v$dataguard_stats WHERE name = 'apply lag';"))
      .toMatch(/apply lag\s+\+00 00:00:00/);
    lab.sql(dr, 'ALTER DATABASE RECOVER MANAGED STANDBY DATABASE CANCEL;');
    lab.sql(prod, 'INSERT INTO clients VALUES (2);');
    lab.sql(prod, 'COMMIT;');
    lab.sql(prod, 'ALTER SYSTEM SWITCH LOGFILE;');
    expect(lab.sql(dr, "SELECT name, value FROM v$dataguard_stats WHERE name = 'apply lag';"))
      .not.toMatch(/apply lag\s+\+00 00:00:00/);
  });

  it('une instance arretee refuse de demarrer le MRP', () => {
    const { dr } = paire(false);
    lab.sql(dr, 'SHUTDOWN IMMEDIATE;');
    expect(lab.sql(dr, 'ALTER DATABASE RECOVER MANAGED STANDBY DATABASE;'))
      .toContain('ORA-01034');
  });

  it('TEMOIN — le primaire n est pas touche par l application', () => {
    const { prod } = paire(true);
    expect(compte(prod)).toBe(1);
    expect(sh(prod, 'ls /u01/app/oracle/archivelog')).toContain('1_1_arc.arc');
  });
});
