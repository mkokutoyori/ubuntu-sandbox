/*
 * Probe: CONFIGURE CHANNEL DEVICE TYPE DISK FORMAT '...' and CONFIGURE CONTROLFILE AUTOBACKUP FORMAT FOR DEVICE TYPE DISK TO '...' were stored and shown by
 * SHOW ALL and never read by BACKUP: every piece went to the fast recovery area under its OMF name, so a backup meant for a mounted backup volume left nothing
 * there (measured on the e-commerce lab: `ls` of the NFS export empty after BACKUP DATABASE PLUS ARCHIVELOG with the channel format configured). Oracle Database
 * Backup and Recovery Reference, CONFIGURE: the channel FORMAT is the default file name for the pieces a channel creates when BACKUP gives no FORMAT; the
 * autobackup format names the control file autobackup piece (the default %F keeps the recovery area). BACKUP now reads both. An explicit FORMAT in the command
 * wins, as in Oracle.
 *
 * Discriminated with git stash on src: 4 of 7 fall before the fix; the witness (an explicit FORMAT), the explicit-FORMAT-wins case and the default-autobackup
 * case pass either way: the first is the lab's soundness check, the other two non-regressions the fix keeps true.
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
const handles = (output: string) => [...output.matchAll(/piece handle=(\S+)/g)].map((match) => match[1]);

describe('the configured channel format and autobackup format are read by BACKUP', () => {
  it('witness: an explicit FORMAT puts the pieces where it says', () => {
    const output = rman("BACKUP DATABASE FORMAT '/vol/backup/x_%U';");
    expect(handles(output).every((handle) => handle.startsWith('/vol/backup/x_'))).toBe(true);
    expect(handles(output).length).toBeGreaterThan(0);
  });

  it('BACKUP DATABASE without FORMAT uses the configured channel format', () => {
    const output = rman("CONFIGURE CHANNEL DEVICE TYPE DISK FORMAT '/vol/backup/db_%U';", 'BACKUP DATABASE;');
    expect(handles(output).some((handle) => handle.startsWith('/vol/backup/db_'))).toBe(true);
    expect(lab.sh(lab.prod, 'ls /vol/backup')).toContain('db_');
  });

  it('BACKUP DATABASE PLUS ARCHIVELOG puts both parts there', () => {
    lab.sql(lab.prod, 'ALTER SYSTEM SWITCH LOGFILE;');
    const output = rman("CONFIGURE CHANNEL DEVICE TYPE DISK FORMAT '/vol/backup/p_%U';", 'BACKUP DATABASE PLUS ARCHIVELOG;');
    const pieces = handles(output).filter((handle) => !handle.includes('/autobackup/'));
    expect(pieces.length).toBeGreaterThanOrEqual(2);
    expect(pieces.every((handle) => handle.startsWith('/vol/backup/p_'))).toBe(true);
  });

  it('incremental, tablespace and archivelog backups follow it too', () => {
    lab.sql(lab.prod, 'ALTER SYSTEM SWITCH LOGFILE;');
    const output = rman(
      "CONFIGURE CHANNEL DEVICE TYPE DISK FORMAT '/vol/backup/k_%U';",
      'BACKUP INCREMENTAL LEVEL 0 DATABASE;', 'BACKUP TABLESPACE USERS;', 'BACKUP ARCHIVELOG ALL;',
    );
    const pieces = handles(output);
    expect(pieces.length).toBeGreaterThanOrEqual(3);
    expect(pieces.every((handle) => handle.startsWith('/vol/backup/k_'))).toBe(true);
  });

  it('an explicit FORMAT in the command wins over the configured one', () => {
    const output = rman("CONFIGURE CHANNEL DEVICE TYPE DISK FORMAT '/vol/backup/db_%U';", "BACKUP DATABASE FORMAT '/vol/backup/own_%U';");
    expect(handles(output).every((handle) => handle.startsWith('/vol/backup/own_'))).toBe(true);
  });

  it('the autobackup format names the control file autobackup piece', () => {
    const output = rman(
      'CONFIGURE CONTROLFILE AUTOBACKUP ON;',
      "CONFIGURE CONTROLFILE AUTOBACKUP FORMAT FOR DEVICE TYPE DISK TO '/vol/backup/cf_%F';",
      "BACKUP DATABASE FORMAT '/vol/backup/d_%U';",
    );
    expect(handles(output).some((handle) => handle.startsWith('/vol/backup/cf_'))).toBe(true);
  });

  it('the default autobackup format (%F) keeps the recovery area', () => {
    const output = rman('CONFIGURE CONTROLFILE AUTOBACKUP ON;', "BACKUP DATABASE FORMAT '/vol/backup/d_%U';");
    expect(handles(output).some((handle) => handle.includes('/autobackup/'))).toBe(true);
  });
});
