import type { StepKind, TutorialStep } from './engine';

const PRD = 'ORA-PRD';
const STB = 'ORA-STB';
const DATAFILES = '/u01/app/oracle/oradata/ORCL';
const SCRIPTS = '/home/oracle/scripts';
const LOGS = '/home/oracle/logs';
const ALERT_LOG = '/u01/app/oracle/diag/rdbms/orcl/ORCL/trace/alert_ORCL.log';
const CF_FORMAT = '/backup/cf_%F';

type Extra = Pick<TutorialStep, 'forbids' | 'capture' | 'head' | 'tail' | 'advanceMs'>;

function step(kind: StepKind, id: string, device: string, user: 'root' | 'oracle', input: string, expects: readonly RegExp[], extra: Extra = {}): TutorialStep {
  return { id, device, user, kind, input, expects, ...extra };
}

const root = (id: string, device: string, input: string, expects: readonly RegExp[], extra?: Extra) => step('shell', id, device, 'root', input, expects, extra);
const oracle = (id: string, device: string, input: string, expects: readonly RegExp[], extra?: Extra) => step('shell', id, device, 'oracle', input, expects, extra);
const sql = (id: string, input: string, expects: readonly RegExp[], extra?: Extra, device = PRD) => step('sql', id, device, 'oracle', input, expects, extra);
const rman = (id: string, input: string, expects: readonly RegExp[], extra?: Extra, device = PRD) => step('rman', id, device, 'oracle', input, expects, extra);

const RMAN_JOB = [
  '#!/bin/bash',
  'job=$1',
  `rman target / cmdfile=${SCRIPTS}/$job.rman log=${LOGS}/$job.log`,
  'code=$?',
  'logger -t rman-backup "job=$job code=$code"',
  'exit $code',
].join('\n');

const L0_RMAN = ['RUN {', "  BACKUP INCREMENTAL LEVEL 0 DATABASE TAG 'DIMANCHE_L0';", '}'].join('\n');
const L1_RMAN = ['RUN {', "  BACKUP INCREMENTAL LEVEL 1 DATABASE TAG 'QUOTIDIEN_L1';", '}'].join('\n');
const ARC_RMAN = ['RUN {', "  BACKUP ARCHIVELOG ALL DELETE INPUT TAG 'JOURNAUX';", '}'].join('\n');

export const TUTORIAL_STEPS: readonly TutorialStep[] = [
  sql('zero-clients', 'SELECT customer_id, full_name, city FROM shop.customers WHERE ROWNUM <= 3;', [/Awa Ndiaye/, /Douala/]),
  sql('zero-instance', 'SELECT instance_name, status FROM v$instance;\nSELECT name, open_mode FROM v$database;', [/ORCL/, /OPEN/]),
  oracle('zero-processus', PRD, 'ps -ef | grep ora_ | grep -v grep', [/ora_pmon/, /ora_smon/]),
  oracle('zero-linux', PRD, `whoami\npwd\nid\nls -l ${DATAFILES}`, [/^oracle$/m, /uid=54321\(oracle\)/, /users01\.dbf/]),
  root('zero-root-refuse', PRD, "whoami\nsqlplus -s / as sysdba <<'E'\nSELECT 1 FROM dual;\nE", [/^root$/m, /ORA-01031/], { forbids: [/1 row selected/] }),
  sql('zero-sqlplus', "SHOW USER\nSELECT 'bonjour' AS message FROM dual;\nSELECT SYSDATE FROM dual;", [/USER is "SYS"/, /bonjour/]),
  rman('zero-rman', 'LIST BACKUP SUMMARY;', [/no backup found in the repository/]),

  oracle('identite', PRD, 'id\nhostname', [/uid=54321\(oracle\)/, /ora-prd/]),
  root('montage-sauvegarde', PRD, 'mount -a\nmount | grep backup\nls -ldn /backup\ndf -h /backup', [/10\.10\.30\.20:\/srv\/backup\/rman on \/backup type nfs/, /54321 54321/, /10\.10\.30\.20:\/srv\/backup\/rman\s+\S+\s+\S+\s+\S+\s+\d+% \/backup/]),
  oracle('test-ecriture-sauvegarde', PRD, "touch /backup/ecriture-test\nstat -c '%n %y' /backup/ecriture-test\nsleep 3\ntouch /backup/ecriture-test\nstat -c '%n %y' /backup/ecriture-test\nrm /backup/ecriture-test", [/ecriture-test/]),
  sql('sante', '@/home/oracle/scripts/health.sql', [/SHOP_DATA/, /SHOP_IDX/, /NOARCHIVELOG/]),
  sql('identite-base', 'SELECT name, dbid, log_mode, open_mode FROM v$database;', [/ORCL\s+\d{6,}\s+NOARCHIVELOG/], { capture: { DBID: /ORCL\s+(\d{6,})\s+NOARCHIVELOG/ } }),
  sql('fichiers', 'SELECT file#, name FROM v$datafile ORDER BY 1;\nSELECT name FROM v$controlfile;\nSELECT group#, members, status FROM v$log;', [/shop_data01\.dbf/, /control01\.ctl/, /control02\.ctl/]),

  rman('noarchivelog-refus', 'BACKUP DATABASE;', [/RMAN-06149: cannot BACKUP DATABASE in NOARCHIVELOG mode/], { forbids: [/piece handle/] }),
  sql('passage-archivelog', '@/home/oracle/scripts/03_archivelog.sql', [/Database log mode\s+Archive Mode/], { head: 4, tail: 9 }),
  sql('verif-archivelog', 'SELECT log_mode, force_logging FROM v$database;', [/ARCHIVELOG\s+YES/]),

  rman('show-all', 'SHOW ALL;', [/RETENTION POLICY TO REDUNDANCY 1/, /CONTROLFILE AUTOBACKUP OFF/], { head: 7, tail: 3 }),
  rman('configure', [
    'CONFIGURE RETENTION POLICY TO RECOVERY WINDOW OF 7 DAYS;',
    'CONFIGURE CONTROLFILE AUTOBACKUP ON;',
    `CONFIGURE CONTROLFILE AUTOBACKUP FORMAT FOR DEVICE TYPE DISK TO '${CF_FORMAT}';`,
    "CONFIGURE CHANNEL DEVICE TYPE DISK FORMAT '/backup/%d_%T_%U.bkp';",
  ].join('\n'), [/new RMAN configuration parameters are successfully stored/]),
  rman('show-config', 'SHOW RETENTION POLICY;\nSHOW CONTROLFILE AUTOBACKUP FORMAT;', [/RECOVERY WINDOW OF 7 DAYS/, /cf_%F/]),

  rman('premiere-sauvegarde', "BACKUP DATABASE PLUS ARCHIVELOG TAG 'PREMIERE';", [/Finished backup/, /piece handle=\/backup\/ORCL_/, /tag=PREMIERE/], { forbids: [/RMAN-0\d{4}: (?!00571|00569)/] }),
  rman('liste-sauvegardes', 'LIST BACKUP SUMMARY;\nREPORT SCHEMA;\nREPORT NEED BACKUP;', [/PREMIERE/, /SHOP_DATA/, /Report of files that must be backed up/], { head: 14, tail: 14 }),
  root('preuve-par-le-fil', 'BKP-HQ', 'ls -ln /srv/backup/rman', [/54321\s+54321/, /ORCL_\d{8}_/, /cf_c-\d+-\d{8}-\d\d/]),
  sql('vues-sauvegardes', 'SELECT handle, status FROM v$backup_piece;\nSELECT session_key, input_type, status FROM v$rman_backup_job_details;', [/\/backup\/ORCL_/, /COMPLETED/], undefined),

  oracle('ecriture-scripts', PRD, [
    `mkdir -p ${LOGS}`,
    `cat > ${SCRIPTS}/rman_job.sh <<'X'\n${RMAN_JOB}\nX`,
    `cat > ${SCRIPTS}/l0.rman <<'X'\n${L0_RMAN}\nX`,
    `cat > ${SCRIPTS}/l1.rman <<'X'\n${L1_RMAN}\nX`,
    `cat > ${SCRIPTS}/arc.rman <<'X'\n${ARC_RMAN}\nX`,
    `chmod 750 ${SCRIPTS}/rman_job.sh`,
    `ls -l ${SCRIPTS}`,
  ].join('\n'), [/rman_job\.sh/, /l0\.rman/, /arc\.rman/], { head: 0, tail: 12 }),
  oracle('niveau-0', PRD, `${SCRIPTS}/rman_job.sh l0\necho "code retour : $?"\ntail -4 ${LOGS}/l0.log`, [/code retour : 0/, /Finished backup/]),
  sql('donnees-du-jour', "UPDATE shop.orders SET status = 'PAID' WHERE status = 'NEW';\nCOMMIT;\nALTER SYSTEM SWITCH LOGFILE;\nSELECT status, COUNT(*) AS nb FROM shop.orders GROUP BY status ORDER BY 1;", [/PAID/]),
  oracle('niveau-1', PRD, `${SCRIPTS}/rman_job.sh l1\necho "code retour : $?"\ntail -3 ${LOGS}/l1.log`, [/code retour : 0/, /Finished backup/]),
  sql('donnees-apres-niveau-1', 'UPDATE shop.products SET stock = stock - 5 WHERE product_id = 1;\nCOMMIT;\nALTER SYSTEM SWITCH LOGFILE;\nSELECT stock FROM shop.products WHERE product_id = 1;', [/STOCK/, /\b115\b/]),
  rman('crosscheck-journaux', 'CROSSCHECK ARCHIVELOG ALL;', [/validation succeeded for archived log/, /archived log file name=/], { head: 9, tail: 4 }),
  oracle('sauvegarde-journaux', PRD, `${SCRIPTS}/rman_job.sh arc\necho "code retour : $?"\ntail -3 ${LOGS}/arc.log`, [/code retour : 0/, /Finished backup/]),
  rman('liste-niveaux', 'LIST BACKUP SUMMARY;\nLIST ARCHIVELOG ALL;', [/B\s+0\s+A/, /B\s+1\s+A/, /B\s+A\s+A/, /specification does not match any archived log/]),
  oracle('planification', PRD, `(crontab -l 2>/dev/null; echo "0 2 * * 0 ${SCRIPTS}/rman_job.sh l0"; echo "0 2 * * 1-6 ${SCRIPTS}/rman_job.sh l1"; echo "0 */4 * * * ${SCRIPTS}/rman_job.sh arc") | crontab -\ncrontab -l`, [/rman_job\.sh l0/, /rman_job\.sh l1/, /rman_job\.sh arc/]),
  root('journal-central', 'LOG-HQ', 'grep rman-backup /var/log/syslog', [/ora-prd/, /job=l0 code=0/, /job=arc code=0/]),

  rman('validate', 'VALIDATE DATABASE;', [/validation complete/, /OK/], { head: 9, tail: 4 }),
  rman('restore-validate', 'RESTORE DATABASE VALIDATE;', [/validation complete/], { forbids: [/RMAN-06023/] }),
  rman('crosscheck', 'CROSSCHECK BACKUP;', [/crosschecked backup piece: found to be 'AVAILABLE'/, /Crosschecked \d+ objects/], { head: 10, tail: 4 }),
  rman('obsolete', 'REPORT OBSOLETE;\nDELETE OBSOLETE NOPROMPT;', [/recovery window of 7 days/, /no obsolete backups found/]),

  sql('a-avant', 'SELECT COUNT(*) AS commandes FROM shop.orders;', [/COMMANDES/, /\b12\b/]),
  oracle('a-sinistre', PRD, `rm -f ${DATAFILES}/shop_data01.dbf\nls ${DATAFILES}`, [/users01\.dbf/], { forbids: [/shop_data01/] }),
  sql('a-arret', 'SHUTDOWN ABORT', [/ORACLE instance shut down/]),
  sql('a-demarrage', 'STARTUP MOUNT\nALTER DATABASE OPEN;', [/Database mounted/, /ORA-01157/, /ORA-01110/, /shop_data01\.dbf/]),
  rman('a-restauration', 'RESTORE DATAFILE 5;\nRECOVER DATAFILE 5;', [/restoring datafile 00005/, /media recovery complete/], { forbids: [/RMAN-06054/] }),
  sql('a-ouverture', 'ALTER DATABASE OPEN;\nSELECT COUNT(*) AS commandes FROM shop.orders;\nSELECT COUNT(*) AS payees FROM shop.orders WHERE status = \'PAID\';\nSELECT stock FROM shop.products WHERE product_id = 1;', [/Database altered/, /COMMANDES/, /PAYEES/, /STOCK\s+-+\s+115/]),

  sql('a2-hors-ligne', 'ALTER TABLESPACE shop_data OFFLINE IMMEDIATE;\nSELECT COUNT(*) AS commandes FROM shop.orders;\nSELECT COUNT(*) FROM shop.customers;', [/Tablespace altered/, /ORA-00376/, /ORA-01110/]),
  rman('a2-restauration-en-ligne', 'RESTORE TABLESPACE shop_data;\nRECOVER TABLESPACE shop_data;', [/media recovery complete/]),
  sql('a2-remise-en-ligne', 'ALTER TABLESPACE shop_data ONLINE;\nSELECT COUNT(*) AS commandes FROM shop.orders;', [/Tablespace altered/, /COMMANDES/]),

  sql('c-identite', 'SELECT dbid FROM v$database;\nSELECT name FROM v$controlfile;', [/control01\.ctl/], { capture: { DBID: /DBID\s+-+\s+(\d+)/ } }),
  oracle('c-sinistre', PRD, `rm -f ${DATAFILES}/control01.ctl ${DATAFILES}/control02.ctl\nls ${DATAFILES} | grep -c control`, [/^0$/m]),
  sql('c-arret', 'SHUTDOWN ABORT', [/ORACLE instance shut down/]),
  sql('c-demarrage', 'STARTUP', [/ORACLE instance started/, /ORA-00205/]),
  rman('c-restauration-controle', `SET DBID $DBID;\nSET CONTROLFILE AUTOBACKUP FORMAT FOR DEVICE TYPE DISK TO '${CF_FORMAT}';\nRESTORE CONTROLFILE FROM AUTOBACKUP;`, [/AUTOBACKUP found: \/backup\/cf_c-\d+-\d{8}-\d\d/, /control file restore from AUTOBACKUP complete/]),
  sql('c-montage', 'ALTER DATABASE MOUNT;\nSELECT name, log_mode FROM v$database;', [/Database altered/, /ORCL\s+ARCHIVELOG/]),
  rman('c-recover', 'RECOVER DATABASE;', [/media recovery complete/], { forbids: [/RMAN-06054/] }),
  sql('c-ouverture', 'ALTER DATABASE OPEN;\nALTER DATABASE OPEN RESETLOGS;\nSELECT COUNT(*) AS commandes FROM shop.orders;', [/ORA-01589/, /Database altered/, /COMMANDES/]),
  rman('c-sauvegarde-apres', "LIST INCARNATION;\nBACKUP DATABASE PLUS ARCHIVELOG TAG 'POST_RESETLOGS';", [/PARENT/, /CURRENT/, /tag=POST_RESETLOGS/]),

  sql('b-avant', "INSERT INTO shop.orders VALUES (2001, 1, SYSDATE, 'NEW', 99.5);\nCOMMIT;\nALTER SYSTEM SWITCH LOGFILE;\nSELECT COUNT(*) AS paiements FROM shop.payments;\nSELECT current_scn FROM v$database;", [/PAIEMENTS/, /CURRENT_SCN/], { capture: { SCN: /CURRENT_SCN\s+-+\s+(\d+)/ } }),
  sql('b-erreur', 'DROP TABLE shop.payments CASCADE CONSTRAINTS PURGE;\nALTER SYSTEM SWITCH LOGFILE;\nSELECT COUNT(*) FROM shop.payments;', [/Table dropped/, /ORA-00942/]),
  sql('b-arret-montage', 'SHUTDOWN IMMEDIATE\nSTARTUP MOUNT', [/Database mounted/]),
  rman('b-pitr', 'RUN {\n  SET UNTIL SCN $SCN;\n  RESTORE DATABASE;\n  RECOVER DATABASE;\n}', [/SET until clause/, /Finished restore/, /Finished recover/], { forbids: [/RMAN-06026/, /RMAN-06054/], head: 8, tail: 7 }),
  sql('b-ouverture', 'ALTER DATABASE OPEN;\nALTER DATABASE OPEN RESETLOGS;\nSELECT COUNT(*) AS paiements FROM shop.payments;\nSELECT COUNT(*) AS commandes FROM shop.orders WHERE order_id = 2001;', [/ORA-01589/, /Database altered/, /PAIEMENTS/]),
  rman('b-incarnations', 'LIST INCARNATION;', [/PARENT/, /CURRENT/]),
  rman('b-sauvegarde-apres', "BACKUP DATABASE PLUS ARCHIVELOG TAG 'APRES_PITR';", [/tag=APRES_PITR/, /Finished backup/]),

  sql('sp-montage', 'SHUTDOWN IMMEDIATE\nSTARTUP MOUNT', [/Database mounted/]),
  rman('sp-restauration', 'RESTORE DATABASE;', [/Finished restore/], { forbids: [/RMAN-06023/], head: 6, tail: 4 }),
  sql('sp-recover', "RECOVER DATABASE UNTIL CANCEL;\nALTER DATABASE OPEN;\nALTER DATABASE OPEN RESETLOGS;\nSELECT COUNT(*) AS commandes FROM shop.orders;", [/Media recovery complete\./, /ORA-01589/, /Database altered/, /COMMANDES/]),

  root('acces-intrus', PRD, 'useradd -m stagiaire\nsudo -u stagiaire rman target /', [/RMAN-04005/, /ORA-01031/], { forbids: [/connected to target database/] }),
  sql('acces-audit', 'SELECT os_username, returncode FROM dba_audit_trail WHERE returncode = 1031;', [/stagiaire/, /1031/]),
  oracle('journal-alerte', PRD, `grep -i "failed sysdba logon" ${ALERT_LOG} | tail -2`, [/stagiaire/]),

  root('dr-tunnel', 'FGT-HQ', 'get vpn ipsec tunnel summary', [/'to-dr'.*selectors\(total,up\): 1\/1/]),
  sql('dr-nomount', 'SHUTDOWN IMMEDIATE\nSTARTUP NOMOUNT', [/ORACLE instance started/], undefined, STB),
  rman('dr-duplicate', 'CONNECT AUXILIARY sys/oracle@10.20.30.10:1521/ORCL;\nDUPLICATE TARGET DATABASE FOR STANDBY FROM ACTIVE DATABASE DORECOVER NOFILENAMECHECK;', [/connected to auxiliary database/, /alter database mount standby database/, /Finished Duplicate Db/], { head: 12, tail: 6 }),
  sql('dr-role', 'SELECT database_role, open_mode, log_mode FROM v$database;\nSELECT file#, name FROM v$datafile ORDER BY 1;', [/PHYSICAL STANDBY\s+MOUNTED\s+ARCHIVELOG/, /shop_data01\.dbf/], undefined, STB),
  sql('dr-expedition', "ALTER SYSTEM SET log_archive_dest_2='SERVICE=10.20.30.10:1521/ORCL ASYNC VALID_FOR=(ONLINE_LOGFILES,PRIMARY_ROLE) DB_UNIQUE_NAME=ORCL_STB' SCOPE=BOTH;\nALTER SYSTEM SET log_archive_dest_state_2=ENABLE SCOPE=BOTH;", [/System altered/]),
  sql('dr-application', 'ALTER DATABASE RECOVER MANAGED STANDBY DATABASE DISCONNECT FROM SESSION;', [/Database altered/], undefined, STB),
  sql('dr-journaux-standby-prd', "ALTER DATABASE ADD STANDBY LOGFILE GROUP 11 ('/u01/app/oracle/oradata/ORCL/srl11.log') SIZE 50M;\nSELECT group#, thread#, bytes, status FROM v$standby_log;", [/Database altered/, /11\s+1\s+52428800\s+UNASSIGNED/]),
  sql('dr-journaux-standby-stb', "ALTER DATABASE ADD STANDBY LOGFILE GROUP 11 ('/u01/app/oracle/oradata/ORCL/srl11.log') SIZE 50M;\nSELECT group#, thread#, bytes, status FROM v$standby_log;", [/Database altered/, /11\s+1\s+52428800\s+UNASSIGNED/], undefined, STB),
  oracle('dr-broker', PRD, "dgmgrl / <<'E'\nCREATE CONFIGURATION 'lumiere_dg' AS PRIMARY DATABASE IS 'ORCL' CONNECT IDENTIFIER IS orcl;\nADD DATABASE 'ORCL_STB' AS CONNECT IDENTIFIER IS 10.20.30.10:1521/ORCL MAINTAINED AS PHYSICAL;\nENABLE CONFIGURATION;\nSHOW CONFIGURATION;\nE", [/Configuration "lumiere_dg" created/, /Database "ORCL_STB" added/, /Enabled\./, /SUCCESS/]),
  oracle('dr-broker-standby', STB, "dgmgrl / <<'E'\nSHOW CONFIGURATION;\nE", [/Configuration - lumiere_dg/, /ORCL - Primary database/, /ORCL_STB - Physical standby database/, /SUCCESS/]),
  oracle('dr-protection', PRD, "dgmgrl / <<'E'\nEDIT CONFIGURATION SET PROTECTION MODE AS MaxAvailability;\nEDIT DATABASE 'ORCL_STB' SET PROPERTY LogXptMode='SYNC';\nEDIT CONFIGURATION SET PROTECTION MODE AS MaxAvailability;\nSHOW CONFIGURATION;\nE", [/ORA-16627/, /Succeeded\./, /Protection Mode: MaxAvailability/]),
  sql('dr-niveau', 'SELECT protection_mode, protection_level FROM v$database;', [/MAXIMUM AVAILABILITY\s+MAXIMUM AVAILABILITY/]),
  oracle('dr-fsfo', 'BKP-HQ', "dgmgrl sys/oracle@10.10.30.10:1521/ORCL <<'E'\nENABLE FAST_START FAILOVER;\nSHOW FAST_START FAILOVER;\nSTART OBSERVER observateur1;\nE", [/Enabled in Zero Data Loss Mode\./, /Observer started/, /Active Target:\s+ORCL_STB/, /Threshold:\s+30 seconds/]),
  oracle('dr-observateur', 'BKP-HQ', "dgmgrl sys/oracle@10.10.30.10:1521/ORCL <<'E'\nSHOW OBSERVER;\nE", [/Observer "observateur1" - Master/, /Last Ping to Primary:\s+\d+ seconds? ago/], { advanceMs: 9000 }),
  sql('dr-commande', "INSERT INTO shop.orders VALUES (3001, 2, SYSDATE, 'NEW', 42);\nCOMMIT;\nALTER SYSTEM SWITCH LOGFILE;\nINSERT INTO shop.orders VALUES (3002, 3, SYSDATE, 'NEW', 17);\nCOMMIT;\nSELECT dest_id, status, destination FROM v$archive_dest WHERE dest_id <= 2;", [/10\.20\.30\.10:1521\/ORCL/, /VALID/]),
  sql('dr-lecture', 'SELECT COUNT(*) AS logs_appliques FROM v$archived_log WHERE applied = \'YES\';\nALTER DATABASE RECOVER MANAGED STANDBY DATABASE CANCEL;\nALTER DATABASE OPEN READ ONLY;\nSELECT COUNT(*) AS commande_3001 FROM shop.orders WHERE order_id = 3001;\nSELECT COUNT(*) AS commande_3002 FROM shop.orders WHERE order_id = 3002;', [/LOGS_APPLIQUES/, /COMMANDE_3001/, /COMMANDE_3002/, /READ ONLY|Database altered/], undefined, STB),
  sql('dr-sinistre', 'SHUTDOWN ABORT', [/ORACLE instance shut down/]),
  sql('dr-bascule', 'SHUTDOWN IMMEDIATE\nSTARTUP MOUNT\nALTER DATABASE FAILOVER TO ORCL;\nALTER DATABASE OPEN;\nSELECT database_role, open_mode FROM v$database;\nSELECT COUNT(*) AS commande_3001 FROM shop.orders WHERE order_id = 3001;\nSELECT COUNT(*) AS commande_3002 FROM shop.orders WHERE order_id = 3002;', [/PRIMARY\s+READ WRITE/, /COMMANDE_3001/, /COMMANDE_3002/], undefined, STB),
];
