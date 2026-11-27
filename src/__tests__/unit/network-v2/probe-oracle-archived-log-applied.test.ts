/*
 * Probe: measured on the e-commerce lab, `SELECT sequence#, applied FROM v$archived_log` on the standby failed with ORA-00904: "APPLIED": invalid identifier,
 * the column every DBA reads to see how far the managed recovery process got. The view stopped at BLOCK_SIZE. Oracle Database Reference, V$ARCHIVED_LOG:
 * COMPLETION_TIME, DEST_ID, STANDBY_DEST and APPLIED (YES once the log was applied on a standby destination, NO on the primary). The instance already counts the
 * redo the recovery process applied (appliedSequence); the view reads it.
 *
 * The standby also reported LOG_MODE NOARCHIVELOG (and so an empty V$ARCHIVED_LOG) although its control file comes from the primary, which Data Guard requires in
 * ARCHIVELOG; mounting as standby now takes that mode.
 *
 * Discriminated with git stash on src: 6 of 6 fall (the witness reads the standby's V$ARCHIVED_LOG, which was empty) before the fix; the witness (the standby is built and ships) passes either way.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { resetAllOracleInstances } from '@/terminal/commands/database';
import { BackupKey, DeviceCatalogRegistry } from '@/terminal/subshells/rman';
import { buildRmanLab, type RmanLab } from '../../support/rmanLab';

let lab: RmanLab;

beforeEach(async () => {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); resetAllOracleInstances(); Logger.reset(); BackupKey._reset(); DeviceCatalogRegistry._reset();
  lab = await buildRmanLab();
  lab.sql(lab.prod, 'SHUTDOWN IMMEDIATE;');
  lab.sql(lab.prod, 'STARTUP MOUNT;');
  lab.sql(lab.prod, 'ALTER DATABASE ARCHIVELOG;');
  lab.sql(lab.prod, 'ALTER DATABASE OPEN;');
  lab.sql(lab.dr, 'SHUTDOWN IMMEDIATE;');
  lab.sql(lab.dr, 'STARTUP NOMOUNT;');
  lab.sh(lab.prod, `rman target / <<'EOF'\nCONNECT AUXILIARY sys/oracle@${lab.drIp}:1521/ORCL;\nDUPLICATE TARGET DATABASE FOR STANDBY FROM ACTIVE DATABASE DORECOVER NOFILENAMECHECK;\nEOF`);
  lab.sql(lab.prod, `ALTER SYSTEM SET log_archive_dest_2='SERVICE=${lab.drIp}:1521/ORCL ASYNC' SCOPE=BOTH;`);
  lab.sql(lab.prod, 'ALTER SYSTEM SET log_archive_dest_state_2=ENABLE SCOPE=BOTH;');
  lab.sql(lab.dr, 'ALTER DATABASE RECOVER MANAGED STANDBY DATABASE DISCONNECT FROM SESSION;');
  lab.sql(lab.prod, 'CREATE TABLE t (id NUMBER);');
  lab.sql(lab.prod, 'INSERT INTO t VALUES (1);');
  lab.sql(lab.prod, 'COMMIT;');
  lab.sql(lab.prod, 'ALTER SYSTEM SWITCH LOGFILE;');
});

describe('V$ARCHIVED_LOG carries the standby columns', () => {
  it('witness: the shipped log is on the standby', () => {
    expect(lab.sql(lab.dr, 'SELECT COUNT(*) FROM v$archived_log;')).toMatch(/^\s*[1-9]\d*\s*$/m);
  });

  it('the standby reports ARCHIVELOG', () => {
    expect(lab.sql(lab.dr, 'SELECT log_mode FROM v$database;')).toContain('ARCHIVELOG');
    expect(lab.sql(lab.dr, 'SELECT log_mode FROM v$database;')).not.toContain('NOARCHIVELOG');
  });

  it('the view has an APPLIED column', () => {
    expect(lab.sql(lab.dr, 'SELECT sequence#, applied FROM v$archived_log;')).not.toContain('ORA-00904');
  });

  it('a log applied by the managed recovery process is APPLIED = YES on the standby', () => {
    expect(lab.sql(lab.dr, "SELECT COUNT(*) FROM v$archived_log WHERE applied = 'YES';")).toMatch(/^\s*[1-9]\d*\s*$/m);
  });

  it('the primary reports APPLIED = NO for its own logs', () => {
    expect(lab.sql(lab.prod, "SELECT COUNT(*) FROM v$archived_log WHERE applied = 'NO';")).toMatch(/^\s*[1-9]\d*\s*$/m);
  });

  it('the view carries DEST_ID', () => {
    expect(lab.sql(lab.prod, 'SELECT dest_id FROM v$archived_log;')).not.toContain('ORA-00904');
  });
});
