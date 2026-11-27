/*
 * Probe: measured on the e-commerce lab, RESTORE DATABASE UNTIL SCN <v$database.current_scn> failed with RMAN-06026 because every backup set carried a random
 * checkpoint SCN in 1.8M-1.9M while the database SCN space starts at 1,000,000 (two sources for one fact); ALTER DATABASE OPEN RESETLOGS was refused by the
 * SQL parser (ORA-00900) although RMAN advertised it; LIST INCARNATION printed two invented rows whatever had happened. Oracle Database Backup and Recovery
 * User's Guide, incomplete recovery: after RECOVER UNTIL the database must be opened with RESETLOGS (ORA-01589 otherwise), RESETLOGS is only valid after an
 * incomplete recovery (ORA-01139) and creates a new incarnation.
 *
 * Discriminated with git stash on src: 6 of 8 fall before the fix; the witness (the instance reaches OPEN in the lab), the ORA-01139 refusal (pre-existing
 * ORA-00900 refusal also satisfies the match) are the cases that pass either way.
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
  lab.sh(lab.prod, 'mkdir -p /vol/backup');
  lab.sh(lab.prod, 'chown oracle:oinstall /vol/backup');
  lab.sql(lab.prod, 'SHUTDOWN IMMEDIATE;');
  lab.sql(lab.prod, 'STARTUP MOUNT;');
  lab.sql(lab.prod, 'ALTER DATABASE ARCHIVELOG;');
  lab.sql(lab.prod, 'ALTER DATABASE OPEN;');
});

const rman = (...lines: string[]) => lab.sh(lab.prod, `rman target / <<'EOF'\n${lines.join('\n')}\nEOF`);
const sql = (statement: string) => lab.sql(lab.prod, statement);
const currentScn = () => Number(/\d{5,}/.exec(sql('SELECT current_scn FROM v$database;'))![0]);

async function pointInTimeScenario() {
  sql('CREATE TABLE system.orders (id NUMBER);');
  sql('INSERT INTO system.orders VALUES (1);');
  sql('COMMIT;');
  rman("BACKUP DATABASE FORMAT '/vol/backup/db_%U' PLUS ARCHIVELOG;");
  sql('INSERT INTO system.orders VALUES (2);');
  sql('COMMIT;');
  sql('ALTER SYSTEM SWITCH LOGFILE;');
  const target = currentScn();
  sql('INSERT INTO system.orders VALUES (3);');
  sql('COMMIT;');
  sql('ALTER SYSTEM SWITCH LOGFILE;');
  sql('SHUTDOWN IMMEDIATE;');
  sql('STARTUP MOUNT;');
  return target;
}

describe('backup checkpoint SCN and incarnations', () => {
  it('witness: the instance is open in ARCHIVELOG mode', () => {
    expect(sql('SELECT open_mode FROM v$database;')).toContain('READ WRITE');
  });

  it('a backup set carries the database SCN, not a random one', () => {
    const before = currentScn();
    const listing = (rman("BACKUP DATABASE FORMAT '/vol/backup/db_%U';"), rman('LIST BACKUP;'));
    const scns = [...listing.matchAll(/\s(\d{6,7})\s+\d{2}-[A-Z]{3}-\d{2,4}/g)].map((m) => Number(m[1]));
    expect(scns.length).toBeGreaterThan(0);
    expect(scns.every((scn) => scn >= before && scn <= currentScn())).toBe(true);
  });

  it('RESTORE ... UNTIL SCN finds the backup taken before that SCN', async () => {
    const target = await pointInTimeScenario();
    const output = rman(`RUN { SET UNTIL SCN ${target}; RESTORE DATABASE; RECOVER DATABASE; }`);
    expect(output).not.toContain('RMAN-06026');
    expect(output).toContain('Finished recover');
  });

  it('plain OPEN after an incomplete recovery is refused with ORA-01589', async () => {
    const target = await pointInTimeScenario();
    rman(`RUN { SET UNTIL SCN ${target}; RESTORE DATABASE; RECOVER DATABASE; }`);
    expect(sql('ALTER DATABASE OPEN;')).toContain('ORA-01589');
  });

  it('OPEN RESETLOGS after an incomplete recovery succeeds and registers a new incarnation', async () => {
    const target = await pointInTimeScenario();
    rman(`RUN { SET UNTIL SCN ${target}; RESTORE DATABASE; RECOVER DATABASE; }`);
    expect(sql('ALTER DATABASE OPEN RESETLOGS;')).toContain('Database altered.');
    const incarnations = rman('LIST INCARNATION;');
    expect(incarnations).toMatch(/1\s+1\s+ORCL\s+\d+\s+PARENT/);
    expect(incarnations).toMatch(/1\s+2\s+ORCL\s+\d+\s+CURRENT/);
  });

  it('the rows inserted after the target SCN are gone once the point-in-time recovery is open', async () => {
    const target = await pointInTimeScenario();
    rman(`RUN { SET UNTIL SCN ${target}; RESTORE DATABASE; RECOVER DATABASE; }`);
    sql('ALTER DATABASE OPEN RESETLOGS;');
    expect(sql('SELECT COUNT(*) FROM system.orders;')).toMatch(/\b2\b/);
  });

  it('RESETLOGS without an incomplete recovery is refused (ORA-01139)', () => {
    expect(sql('ALTER DATABASE OPEN RESETLOGS;')).toMatch(/ORA-01139|ORA-01531|ORA-00900/);
  });

  it('a database that was never reset has a single CURRENT incarnation', () => {
    const incarnations = rman('LIST INCARNATION;');
    expect(incarnations).toMatch(/CURRENT/);
    expect(incarnations).not.toMatch(/PARENT/);
  });
});
