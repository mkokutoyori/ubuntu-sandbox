/**
 * Scenario 6 — Transparent Data Encryption: wallet lifecycle gates
 * tablespace/column encryption, encrypted tablespaces are unreadable
 * plaintext at the OS/VFS level, and SQL access stays fully transparent.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { resetAllOracleInstances } from '@/terminal/commands/database';
import { SqlPlusSubShell } from '@/terminal/subshells/SqlPlusSubShell';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  resetAllOracleInstances();
  Logger.reset();
});

function boot(name: string) {
  const srv = new LinuxServer('linux-server', name, 100, 100);
  const { subShell } = SqlPlusSubShell.create(srv, ['/', 'as', 'sysdba']);
  return { srv, subShell };
}

const sql = (s: ReturnType<typeof boot>['subShell'], q: string) => s.processLine(q).output.join('\n');

describe('creating an encrypted tablespace requires an open wallet with an active key', () => {
  it('fails with ORA-28365 when no wallet has ever been created', () => {
    const { subShell: s } = boot('tde1');
    const out = sql(s,
      "CREATE TABLESPACE secure_ts DATAFILE '/u01/app/oracle/oradata/ORCL/secure01.dbf' SIZE 1M ENCRYPTION USING 'AES256' ENCRYPT;");
    expect(out).toMatch(/ORA-28365/);
    s.dispose();
  });

  it('fails with ORA-28365 once the keystore exists but has no master key yet', () => {
    const { subShell: s } = boot('tde2');
    sql(s, "ADMINISTER KEY MANAGEMENT CREATE KEYSTORE '/opt/oracle/wallet' IDENTIFIED BY \"WalletP@ss1\";");
    const out = sql(s,
      "CREATE TABLESPACE secure_ts DATAFILE '/u01/app/oracle/oradata/ORCL/secure01.dbf' SIZE 1M ENCRYPTION USING 'AES256' ENCRYPT;");
    expect(out).toMatch(/ORA-28365/);
    s.dispose();
  });

  it('succeeds once the keystore is open and a master key is set', () => {
    const { subShell: s } = boot('tde3');
    sql(s, "ADMINISTER KEY MANAGEMENT CREATE KEYSTORE '/opt/oracle/wallet' IDENTIFIED BY \"WalletP@ss1\";");
    sql(s, "ADMINISTER KEY MANAGEMENT SET KEYSTORE OPEN IDENTIFIED BY \"WalletP@ss1\";");
    sql(s, "ADMINISTER KEY MANAGEMENT SET KEY USING TAG 'master-2026' IDENTIFIED BY \"WalletP@ss1\" WITH BACKUP;");

    const status = sql(s, 'SELECT status FROM v$encryption_wallet;');
    expect(status).toContain('OPEN');
    expect(status).not.toContain('CLOSED');
    expect(status).not.toContain('NO_MASTER_KEY');

    const out = sql(s,
      "CREATE TABLESPACE secure_ts DATAFILE '/u01/app/oracle/oradata/ORCL/secure01.dbf' SIZE 1M ENCRYPTION USING 'AES256' ENCRYPT;");
    expect(out).toContain('Tablespace created');
    s.dispose();
  });

  it('closing the keystore blocks further encrypted tablespace creation again', () => {
    const { subShell: s } = boot('tde4');
    sql(s, "ADMINISTER KEY MANAGEMENT CREATE KEYSTORE '/opt/oracle/wallet' IDENTIFIED BY \"WalletP@ss1\";");
    sql(s, "ADMINISTER KEY MANAGEMENT SET KEYSTORE OPEN IDENTIFIED BY \"WalletP@ss1\";");
    sql(s, "ADMINISTER KEY MANAGEMENT SET KEY USING TAG 'master-2026' IDENTIFIED BY \"WalletP@ss1\" WITH BACKUP;");
    sql(s, "ADMINISTER KEY MANAGEMENT SET KEYSTORE CLOSE IDENTIFIED BY \"WalletP@ss1\";");

    const out = sql(s,
      "CREATE TABLESPACE later_ts DATAFILE '/u01/app/oracle/oradata/ORCL/later01.dbf' SIZE 1M ENCRYPTION USING 'AES256' ENCRYPT;");
    expect(out).toMatch(/ORA-28365/);
    s.dispose();
  });
});

describe('V$ENCRYPTED_TABLESPACES and DBA_TABLESPACES.ENCRYPTED reflect real state', () => {
  function withOpenWallet(s: ReturnType<typeof boot>['subShell']) {
    sql(s, "ADMINISTER KEY MANAGEMENT CREATE KEYSTORE '/opt/oracle/wallet' IDENTIFIED BY \"WalletP@ss1\";");
    sql(s, "ADMINISTER KEY MANAGEMENT SET KEYSTORE OPEN IDENTIFIED BY \"WalletP@ss1\";");
    sql(s, "ADMINISTER KEY MANAGEMENT SET KEY USING TAG 'master-2026' IDENTIFIED BY \"WalletP@ss1\" WITH BACKUP;");
  }

  it('an encrypted tablespace shows up in both views; a plain one does not', () => {
    const { subShell: s } = boot('tde5');
    withOpenWallet(s);
    sql(s, "CREATE TABLESPACE secure_ts DATAFILE '/u01/app/oracle/oradata/ORCL/secure01.dbf' SIZE 1M ENCRYPTION USING 'AES256' ENCRYPT;");
    sql(s, "CREATE TABLESPACE plain_ts DATAFILE '/u01/app/oracle/oradata/ORCL/plain01.dbf' SIZE 1M;");

    const tbs = sql(s, "SELECT tablespace_name, encrypted FROM dba_tablespaces WHERE tablespace_name IN ('SECURE_TS','PLAIN_TS');");
    expect(tbs).toMatch(/SECURE_TS\s+YES/);
    expect(tbs).toMatch(/PLAIN_TS\s+NO/);

    const enc = sql(s, 'SELECT encryptedts FROM v$encrypted_tablespaces;');
    expect(enc).toContain('YES');
    expect(enc.match(/YES/g)?.length).toBe(1);
    s.dispose();
  });

  it('ALTER TABLESPACE ... ENCRYPTION ONLINE ENCRYPT re-encrypts an existing tablespace', () => {
    const { subShell: s } = boot('tde6');
    withOpenWallet(s);
    sql(s, "CREATE TABLESPACE later_ts DATAFILE '/u01/app/oracle/oradata/ORCL/later01.dbf' SIZE 1M;");
    expect(sql(s, "SELECT encrypted FROM dba_tablespaces WHERE tablespace_name = 'LATER_TS';")).toContain('NO');

    sql(s, 'ALTER TABLESPACE later_ts ENCRYPTION ONLINE ENCRYPT;');
    expect(sql(s, "SELECT encrypted FROM dba_tablespaces WHERE tablespace_name = 'LATER_TS';")).toContain('YES');
    expect(sql(s, 'SELECT COUNT(*) FROM v$encrypted_tablespaces;')).not.toMatch(/^\s*0\s*$/m);
    s.dispose();
  });
});

describe('encrypted datafiles are unreadable plaintext at the OS/VFS level; unencrypted ones are not', () => {
  it('an unencrypted datafile shows a readable tablespace marker; an encrypted one shows only hex noise', () => {
    const { srv, subShell: s } = boot('tde7');
    sql(s, "ADMINISTER KEY MANAGEMENT CREATE KEYSTORE '/opt/oracle/wallet' IDENTIFIED BY \"WalletP@ss1\";");
    sql(s, "ADMINISTER KEY MANAGEMENT SET KEYSTORE OPEN IDENTIFIED BY \"WalletP@ss1\";");
    sql(s, "ADMINISTER KEY MANAGEMENT SET KEY USING TAG 'master-2026' IDENTIFIED BY \"WalletP@ss1\" WITH BACKUP;");
    sql(s, "CREATE TABLESPACE secure_ts DATAFILE '/u01/app/oracle/oradata/ORCL/secure01.dbf' SIZE 1M ENCRYPTION USING 'AES256' ENCRYPT;");
    sql(s, "CREATE TABLESPACE plain_ts DATAFILE '/u01/app/oracle/oradata/ORCL/plain01.dbf' SIZE 1M;");

    const plainContent = srv.executeShellCommandSync('cat /u01/app/oracle/oradata/ORCL/plain01.dbf');
    expect(plainContent).toContain('PLAIN_TS');
    expect(plainContent).toMatch(/ORACLE DATAFILE/);

    const secureContent = srv.executeShellCommandSync('cat /u01/app/oracle/oradata/ORCL/secure01.dbf');
    expect(secureContent).not.toContain('SECURE_TS');
    expect(secureContent).not.toMatch(/ORACLE DATAFILE/);
    expect(secureContent).toMatch(/^[0-9a-f]+$/);
    s.dispose();
  });

  it('an online-encrypted datafile turns unreadable at the moment it is re-encrypted', () => {
    const { srv, subShell: s } = boot('tde8');
    sql(s, "ADMINISTER KEY MANAGEMENT CREATE KEYSTORE '/opt/oracle/wallet' IDENTIFIED BY \"WalletP@ss1\";");
    sql(s, "ADMINISTER KEY MANAGEMENT SET KEYSTORE OPEN IDENTIFIED BY \"WalletP@ss1\";");
    sql(s, "ADMINISTER KEY MANAGEMENT SET KEY USING TAG 'master-2026' IDENTIFIED BY \"WalletP@ss1\" WITH BACKUP;");
    sql(s, "CREATE TABLESPACE later_ts DATAFILE '/u01/app/oracle/oradata/ORCL/later01.dbf' SIZE 1M;");

    const before = srv.executeShellCommandSync('cat /u01/app/oracle/oradata/ORCL/later01.dbf');
    expect(before).toContain('LATER_TS');

    sql(s, 'ALTER TABLESPACE later_ts ENCRYPTION ONLINE ENCRYPT;');
    const after = srv.executeShellCommandSync('cat /u01/app/oracle/oradata/ORCL/later01.dbf');
    expect(after).not.toContain('LATER_TS');
    expect(after).toMatch(/^[0-9a-f]+$/);
    s.dispose();
  });
});

describe('column-level ENCRYPT also requires an open wallet with an active key', () => {
  it('ALTER TABLE MODIFY (col ENCRYPT) fails before a key exists, succeeds after', () => {
    const { subShell: s } = boot('tde9');
    sql(s, 'CREATE TABLE customers (id NUMBER, ssn VARCHAR2(11));');

    const before = sql(s, 'ALTER TABLE customers MODIFY (ssn ENCRYPT);');
    expect(before).toMatch(/ORA-28365/);

    sql(s, "ADMINISTER KEY MANAGEMENT CREATE KEYSTORE '/opt/oracle/wallet' IDENTIFIED BY \"WalletP@ss1\";");
    sql(s, "ADMINISTER KEY MANAGEMENT SET KEYSTORE OPEN IDENTIFIED BY \"WalletP@ss1\";");
    sql(s, "ADMINISTER KEY MANAGEMENT SET KEY USING TAG 'master-2026' IDENTIFIED BY \"WalletP@ss1\" WITH BACKUP;");

    const after = sql(s, 'ALTER TABLE customers MODIFY (ssn ENCRYPT);');
    expect(after).toContain('Table altered');

    const cols = sql(s, "SELECT table_name, column_name FROM dba_encrypted_columns WHERE table_name = 'CUSTOMERS';");
    expect(cols).toContain('SSN');
    s.dispose();
  });
});

describe('TDE is fully transparent to SQL: encrypted data reads and writes exactly like plaintext', () => {
  it('SELECT/INSERT against an encrypted tablespace behave identically to a normal one', () => {
    const { subShell: s } = boot('tde10');
    sql(s, "ADMINISTER KEY MANAGEMENT CREATE KEYSTORE '/opt/oracle/wallet' IDENTIFIED BY \"WalletP@ss1\";");
    sql(s, "ADMINISTER KEY MANAGEMENT SET KEYSTORE OPEN IDENTIFIED BY \"WalletP@ss1\";");
    sql(s, "ADMINISTER KEY MANAGEMENT SET KEY USING TAG 'master-2026' IDENTIFIED BY \"WalletP@ss1\" WITH BACKUP;");
    sql(s, "CREATE TABLESPACE secure_ts DATAFILE '/u01/app/oracle/oradata/ORCL/secure01.dbf' SIZE 1M ENCRYPTION USING 'AES256' ENCRYPT;");
    const created = sql(s, 'CREATE TABLE vault (customer VARCHAR2(30)) TABLESPACE secure_ts;');
    expect(created).toContain('Table created');
    const inserted = sql(s, "INSERT INTO vault VALUES ('BOB');");
    expect(inserted).toMatch(/1 row created/);
    const rows = sql(s, 'SELECT customer FROM vault;');
    expect(rows).toContain('BOB');
    s.dispose();
  });
});
