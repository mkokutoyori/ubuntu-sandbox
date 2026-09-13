/**
 * Sonde — sauvegarder, detruire, restaurer : le cycle qui dit si RMAN
 * veut dire quelque chose.
 *
 * Releve AVANT le correctif (docs/ASSESSMENT-RMAN.md §1) :
 *
 *   CREATE TABLE clients ...                     Table created.
 *   INSERT x2 ; COMMIT ; SELECT COUNT(*)         2
 *   BACKUP DATABASE                              Finished backup
 *   cat .../users01.dbf                          "[ORACLE DATAFILE - USERS tablespace - 100M]"
 *   DROP TABLE clients                           Table dropped.
 *   RESTORE DATABASE                             Finished restore
 *   ALTER DATABASE OPEN                          Database altered.
 *   SELECT COUNT(*) FROM clients                 ORA-00942
 *
 * Toute la chaine repondait « fini » et la table ne revenait pas : le
 * fichier de donnees etait une phrase de 43 octets annoncant sa propre
 * taille, la piece de sauvegarde une autre phrase du meme genre, et la
 * restauration reecrivait la premiere phrase. Trois artefacts, aucune
 * donnee.
 *
 * Discrimination par `git stash push -- src/database src/terminal src/adapters`
 * (sans -u, pour que les codecs neufs restent chargeables) : 5 cas sur 6
 * tombent avant le correctif.
 *
 * Le sixieme ne discrimine pas et c'est le TEMOIN : « une base sans
 * sauvegarde refuse la restauration » passe des deux cotes. Il prouve
 * que le laboratoire sait encore refuser, donc que les cinq reussites
 * mesurees au-dessus sont des reussites et non un banc complaisant.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { resetAllOracleInstances } from '@/terminal/commands/database';
import { SqlPlusSubShell } from '@/terminal/subshells/SqlPlusSubShell';
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

const USERS_DBF = '/u01/app/oracle/oradata/ORCL/users01.dbf';
const sh = (srv: LinuxServer, cmd: string) => srv.executeShellCommandSync(cmd);

function bootOracleServer(_name: string): { srv: LinuxServer; q: (sql: string) => string } {
  const srv = lab.prod;
  const sql = SqlPlusSubShell.create(srv, ['/', 'as', 'sysdba']).subShell;
  return { srv, q: (s: string) => sql.processLine(s).output.join('\n').trim() };
}

function seedClients(q: (sql: string) => string): void {
  q('CREATE TABLE clients (id NUMBER, nom VARCHAR2(20));');
  q("INSERT INTO clients VALUES (1, 'Dupont');");
  q("INSERT INTO clients VALUES (2, 'Martin');");
  q('COMMIT;');
}

const rman = (srv: LinuxServer, script: string) =>
  sh(srv, `echo "${script}" | rman target /`);

describe('un tablespace se serialise vers son fichier de donnees', () => {
  it('un checkpoint ecrit les lignes committees dans le .dbf', () => {
    const { srv, q } = bootOracleServer('cyc1');
    seedClients(q);
    expect(sh(srv, `cat ${USERS_DBF}`)).not.toContain('CLIENTS');
    q('ALTER SYSTEM CHECKPOINT;');
    const image = sh(srv, `cat ${USERS_DBF}`);
    expect(image).toContain('[ORACLE DATAFILE - USERS tablespace - 100M]');
    expect(image).toContain('CLIENTS');
    expect(image).toContain('Dupont');
  });

  it('la piece de sauvegarde porte le contenu du fichier de donnees', () => {
    const { srv, q } = bootOracleServer('cyc2');
    seedClients(q);
    rman(srv, 'BACKUP DATABASE;');
    const piece = sh(srv,
      'cat $(find /u01/app/oracle/fast_recovery_area -name "*.bkp" -type f | head -1)');
    expect(piece).toContain('CLIENTS');
    expect(piece).toContain('Martin');
  });
});

describe('sauvegarder / detruire / restaurer referme la boucle', () => {
  it('la table detruite revient apres RESTORE puis OPEN', () => {
    const { srv, q } = bootOracleServer('cyc3');
    seedClients(q);
    expect(rman(srv, 'BACKUP DATABASE;')).toContain('Finished backup');

    expect(q('DROP TABLE clients;')).toContain('Table dropped.');
    expect(q('SELECT COUNT(*) FROM clients;')).toContain('ORA-00942');

    q('SHUTDOWN IMMEDIATE');
    q('STARTUP MOUNT');
    expect(rman(srv, 'RESTORE DATABASE;')).toContain('Finished restore');
    expect(q('ALTER DATABASE OPEN;')).toContain('Database altered.');

    const after = q('SELECT COUNT(*) FROM clients;');
    expect(after).not.toContain('ORA-00942');
    expect(after).toMatch(/\b2\b/);
  });

  it('les lignes restaurees sont les vraies lignes, pas un compte', () => {
    const { srv, q } = bootOracleServer('cyc4');
    seedClients(q);
    rman(srv, 'BACKUP DATABASE;');
    q('DROP TABLE clients;');
    q('SHUTDOWN IMMEDIATE');
    q('STARTUP MOUNT');
    rman(srv, 'RESTORE DATABASE;');
    q('ALTER DATABASE OPEN;');
    const rows = q('SELECT nom FROM clients ORDER BY id;');
    expect(rows).toContain('Dupont');
    expect(rows).toContain('Martin');
  });

  it('une ligne inseree APRES la sauvegarde ne revient pas', () => {
    const { srv, q } = bootOracleServer('cyc5');
    seedClients(q);
    rman(srv, 'BACKUP DATABASE;');
    q("INSERT INTO clients VALUES (3, 'Tardif');");
    q('COMMIT;');
    q('SHUTDOWN IMMEDIATE');
    q('STARTUP MOUNT');
    rman(srv, 'RESTORE DATABASE;');
    q('ALTER DATABASE OPEN;');
    const rows = q('SELECT nom FROM clients ORDER BY id;');
    expect(rows).toContain('Dupont');
    expect(rows).not.toContain('Tardif');
  });

  it('TEMOIN — une base sans sauvegarde refuse la restauration', () => {
    const { srv, q } = bootOracleServer('cyc6');
    seedClients(q);
    q('SHUTDOWN IMMEDIATE');
    q('STARTUP MOUNT');
    expect(rman(srv, 'RESTORE DATABASE;')).toMatch(/RMAN-0602[36]/);
  });
});
