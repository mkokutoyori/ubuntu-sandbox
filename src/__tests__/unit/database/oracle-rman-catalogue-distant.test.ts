/**
 * Sonde — le catalogue de recuperation est une VRAIE base distante, et
 * DUPLICATE ecrit vraiment sur la machine auxiliaire.
 * Laboratoire routeur + pare-feu du lot RMAN.
 *
 *   ORA-PROD ── R-CORE (routeur) ── FGT-DC (pare-feu) ── ORA-DR
 *   10.10.10.10                                         10.10.20.20
 *
 * Releve AVANT. Le fichier RecoveryCatalogCommands.ts le disait en
 * en-tete — « accepted as no-ops », « we just echo the canonical success
 * line ». La mesure montre ce que cela coute :
 *
 *   CONNECT CATALOG rman/rman@10.99.99.99:1521/NEXISTEPAS
 *     connected to recovery catalog database
 *   CONNECT CATALOG rman/rman@10.10.20.20:1521/ORCL
 *     connected to recovery catalog database        (la MEME reponse)
 *   sessions vues par ORA-DR juste apres            inchangees
 *
 *   CREATE CATALOG ; REGISTER DATABASE
 *     recovery catalog created
 *     database ORCL registered
 *   SELECT table_name FROM user_tables WHERE table_name LIKE 'RC%'
 *     (sur ORA-DR)                                  no rows selected
 *
 *   CONNECT AUXILIARY sys/oracle@10.99.99.99:1521/RIEN
 *     connected to auxiliary database: ORCL         (la base LOCALE)
 *
 *   DUPLICATE TARGET DATABASE TO DUPDB
 *     channel ORA_DISK_1: restoring datafile 00001 to
 *       /u01/app/oracle/oradata/DUPDB/system01.dbf
 *     Finished Duplicate Db
 *     find / -name "*DUPDB*" sur PROD               (rien)
 *     find / -name "*DUPDB*" sur DR                 (rien)
 *
 * Un hote qui n'existe pas rendait la meme phrase qu'un hote qui existe.
 * Un catalogue « cree » ne laissait pas une table dans la base visee. Un
 * DUPLICATE annoncait quatre fichiers restaures et n'en ecrivait aucun,
 * nulle part. C'est le §6 dans sa forme la plus pure — toutes les
 * apparences de l'existence, sauf l'effet — double d'une violation du §4.
 *
 * Ce que le lot pose. Le catalogue EST une base Oracle : `CONNECT
 * CATALOG` passe par le meme `resolveOracleConnectTarget` que `CONNECT
 * TARGET` depuis le lot R2b, donc la resolution TNS, l'echelle d'erreurs
 * Oracle et le SYN sur le fil sont ceux du reste du depot (§1 — on ne
 * reecrit pas un second client Oracle Net). `RemoteRecoveryCatalog` est
 * une seconde implantation d'`IRmanCatalogRepository` dont le magasin
 * est un jeu de tables RC_ dans cette base ; `CREATE CATALOG` les cree,
 * `REGISTER DATABASE` y insere, `RESYNC CATALOG` y recopie le
 * repertoire du fichier de controle. `DUPLICATE` ecrit par le VFS de la
 * machine AUXILIAIRE, celle que `CONNECT AUXILIARY` a resolue.
 *
 * LIMITE, et elle n'est pas neuve : une fois la connexion etablie et
 * comptee sur le fil, les ordres SQL s'executent contre l'objet
 * `OracleDatabase` resolu, ils ne repartent pas en paquets de donnees
 * Oracle Net. C'est le comportement que `sqlplus user/pass@hote` a dans
 * ce depot depuis toujours et que le lot R2b a repris pour RMAN ; ce lot
 * le SUIT plutot que d'en inventer un second. Rendre le plan de donnees
 * d'Oracle Net reel est un lot a lui seul, et il concernerait sqlplus
 * autant que RMAN.
 *
 * Discrimination par `git stash push -- src/terminal` : 10 cas sur 12
 * tombent avant le correctif.
 *
 * Les DEUX qui ne discriminent pas, nommes avec leur raison :
 *  - « CONNECT CATALOG vers une base qui existe repond qu'il est
 *    connecte » : il ne PEUT pas discriminer — avant, cette phrase
 *    sortait pour n'importe quoi. Il ne vaut que lu avec le premier cas,
 *    qui exige un REFUS pour l'hote inexistant : c'est la paire qui
 *    prouve que la reponse depend enfin de la realite.
 *  - « sans catalogue, BACKUP et LIST marchent depuis le fichier de
 *    controle » : NON-REGRESSION. Brancher un catalogue distant ne doit
 *    rien changer a la marche sans catalogue, qui est le cas courant.
 *
 * DEUX AJUSTEMENTS DU LOT R7, et ce qu'ils disent. Le banc se passait
 * d'un compte `rman` sur la base distante, et lisait les tables `RC_`
 * dans le schema de SYS : les deux ne tenaient que parce que
 * `CONNECT CATALOG` n'authentifiait RIEN et executait ses ordres en
 * SYSDBA sur l'objet du pair. Depuis que la session s'ouvre par le fil,
 * le proprietaire du catalogue est un compte REEL — un compte absent
 * rend `ORA-01017` comme sur une vraie base — et ses tables vivent dans
 * SON schema, ou ce banc les cherche desormais.
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
  lab.sql(lab.dr, 'CREATE USER rman IDENTIFIED BY rman;');
  lab.sql(lab.dr, 'GRANT RECOVERY_CATALOG_OWNER TO rman;');
  lab.sql(lab.dr, 'GRANT CONNECT, RESOURCE TO rman;');
});

const rman = (script: string): string =>
  lab.sh(lab.prod, `printf '${script}\\n' | rman target /`);

const catalogOf = (): string => `rman/rman@${lab.drIp}:1521/ORCL`;

const catalogTables = (): string =>
  lab.sql(lab.dr,
    "SELECT table_name FROM all_tables WHERE owner = 'RMAN' AND table_name LIKE 'RC%';");

describe('CONNECT CATALOG joint vraiment une base, ou refuse', () => {
  it('un hote qui n existe pas est refuse par RMAN-04004', () => {
    const out = rman('CONNECT CATALOG rman/rman@10.99.99.99:1521/NEXISTEPAS;');
    expect(out).toContain('RMAN-04004');
    expect(out).toContain('error from recovery catalog database');
    expect(out).not.toContain('connected to recovery catalog database');
  });

  it('une base qui existe repond qu il est connecte', () => {
    expect(rman(`CONNECT CATALOG ${catalogOf()};`))
      .toContain('connected to recovery catalog database');
  });

  it('TEMOIN — pare-feu ferme, le catalogue devient injoignable', async () => {
    await lab.firewall.executeCommand('config firewall policy');
    await lab.firewall.executeCommand('edit 1');
    await lab.firewall.executeCommand('set action deny');
    await lab.firewall.executeCommand('next');
    await lab.firewall.executeCommand('end');

    const out = rman(`CONNECT CATALOG ${catalogOf()};`);
    expect(out).toContain('RMAN-04004');
    expect(out).not.toContain('connected to recovery catalog database');
  });
});

describe('le catalogue laisse une trace dans la base qui le porte', () => {
  it('sans connexion au catalogue, CREATE CATALOG est refuse', () => {
    const out = rman('CREATE CATALOG;');
    expect(out).toContain('RMAN-06171');
    expect(out).not.toContain('recovery catalog created');
  });

  it('CREATE CATALOG cree vraiment les tables RC_ dans la base distante', () => {
    expect(catalogTables()).toContain('no rows selected');
    rman(`CONNECT CATALOG ${catalogOf()};\\nCREATE CATALOG;`);
    const tables = catalogTables();
    expect(tables).toContain('RC_DATABASE');
    expect(tables).toContain('RC_BACKUP_SET');
  });

  it('REGISTER DATABASE insere la base, et refuse de la reinserer', () => {
    rman(`CONNECT CATALOG ${catalogOf()};\\nCREATE CATALOG;\\nREGISTER DATABASE;`);
    expect(lab.sql(lab.dr, 'SELECT name FROM rman.rc_database;')).toContain('ORCL');

    const again = rman(`CONNECT CATALOG ${catalogOf()};\\nREGISTER DATABASE;`);
    expect(again).toContain('RMAN-20002');
  });

  it('une sauvegarde faite sous catalogue arrive dans RC_BACKUP_SET', () => {
    rman(`CONNECT CATALOG ${catalogOf()};\\nCREATE CATALOG;\\nREGISTER DATABASE;\\nBACKUP DATABASE;`);
    const rows = lab.sql(lab.dr, 'SELECT COUNT(*) FROM rman.rc_backup_set;');
    expect(rows).not.toMatch(/^\s*0\s*$/m);
    expect(lab.sql(lab.dr, 'SELECT payload FROM rman.rc_backup_set;')).toContain('bsKey');
  });

  it('UNREGISTER DATABASE retire vraiment la ligne', () => {
    rman(`CONNECT CATALOG ${catalogOf()};\\nCREATE CATALOG;\\nREGISTER DATABASE;`);
    expect(lab.sql(lab.dr, 'SELECT name FROM rman.rc_database;')).toContain('ORCL');

    rman(`CONNECT CATALOG ${catalogOf()};\\nUNREGISTER DATABASE NOPROMPT;`);
    expect(lab.sql(lab.dr, 'SELECT name FROM rman.rc_database;')).not.toContain('ORCL');
  });
});

describe('DUPLICATE ecrit sur la machine auxiliaire', () => {
  it('un auxiliaire injoignable est refuse par RMAN-04006', () => {
    const out = rman('CONNECT AUXILIARY sys/oracle@10.99.99.99:1521/RIEN;');
    expect(out).toContain('RMAN-04006');
    expect(out).toContain('error from auxiliary database');
  });

  it('les fichiers du double atterrissent sur l auxiliaire, pas sur la cible', () => {
    rman('BACKUP DATABASE;');
    const out = rman(
      `CONNECT AUXILIARY sys/oracle@${lab.drIp}:1521/ORCL;\\nDUPLICATE TARGET DATABASE TO DUPDB;`);
    expect(out).toContain('Finished Duplicate Db');

    const onAuxiliary = lab.sh(lab.dr, 'ls /u01/app/oracle/oradata/DUPDB');
    expect(onAuxiliary).toContain('system01.dbf');
    expect(onAuxiliary).toContain('users01.dbf');
    expect(lab.sh(lab.prod, 'ls /u01/app/oracle/oradata/DUPDB')).toContain('No such file');
  });

  it('le double porte le CONTENU de la sauvegarde, pas un fichier vide', () => {
    lab.sql(lab.prod, 'CREATE TABLE clients (id NUMBER);');
    lab.sql(lab.prod, 'INSERT INTO clients VALUES (7);');
    lab.sql(lab.prod, 'COMMIT;');
    rman('BACKUP DATABASE;');
    rman(`CONNECT AUXILIARY sys/oracle@${lab.drIp}:1521/ORCL;\\nDUPLICATE TARGET DATABASE TO DUPDB;`);

    const copied = lab.sh(lab.dr, 'cat /u01/app/oracle/oradata/DUPDB/users01.dbf');
    expect(copied).toContain('CLIENTS');
  });
});

describe('sans catalogue, rien ne change', () => {
  it('NON-REGRESSION — BACKUP et LIST marchent depuis le fichier de controle', () => {
    expect(rman('BACKUP DATABASE;')).toContain('Finished backup');
    const listed = rman('LIST BACKUP SUMMARY;');
    expect(listed).toContain('List of Backups');
    expect(listed).toMatch(/\bB\s+F\s+A\b/);
  });
});
