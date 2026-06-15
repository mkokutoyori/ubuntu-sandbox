import { describe, test, expect, beforeEach } from 'vitest';
import { OracleDatabase } from '../../../database/oracle/OracleDatabase';
import type { OracleExecutor } from '../../../database/oracle/OracleExecutor';

let db: OracleDatabase;
let sys: OracleExecutor;
let alice: OracleExecutor;
let hostFiles: Map<string, string>;

function exec(sql: string, on: OracleExecutor) {
  return db.executeSql(on, sql);
}

beforeEach(() => {
  db = new OracleDatabase();
  db.instance.startup('OPEN');
  hostFiles = new Map();
  db.instance.setDeviceFileReader((p) => (hostFiles.has(p) ? hostFiles.get(p)! : null));
  db.instance.setDeviceFileWriter((p, c) => { hostFiles.set(p, c); return true; });
  db.instance.setDeviceFileRemover((p) => hostFiles.delete(p));
  sys = db.connectAsSysdba().executor;
  exec("CREATE DIRECTORY ext_dir AS '/home/oracle/load'", sys);
  hostFiles.set('/home/oracle/load/e.csv', '1,a\n2,b\n');
  exec(`CREATE TABLE ext (id NUMBER, s VARCHAR2(10)) ORGANIZATION EXTERNAL
          (TYPE ORACLE_LOADER DEFAULT DIRECTORY ext_dir
           ACCESS PARAMETERS (FIELDS TERMINATED BY ',') LOCATION ('e.csv'))`, sys);
  exec('CREATE USER alice IDENTIFIED BY pw', sys);
  exec('GRANT CREATE SESSION TO alice', sys);
  exec('GRANT SELECT ON ext TO alice', sys);
  alice = db.connect('alice', 'pw').executor;
});

describe('External-table queries enforce directory READ', () => {
  test('SELECT without READ on the directory fails with ORA-29913/29289', () => {
    expect(() => exec('SELECT COUNT(*) FROM sys.ext', alice))
      .toThrow(/29913|29289|access denied/i);
  });

  test('after GRANT READ ON DIRECTORY the user can query', () => {
    exec('GRANT READ ON DIRECTORY ext_dir TO alice', sys);
    const r = exec('SELECT COUNT(*) FROM sys.ext', alice);
    expect(r.rows[0][0]).toBe(2);
  });

  test('the owner (SYS) queries without an explicit directory grant', () => {
    const r = exec('SELECT COUNT(*) FROM ext', sys);
    expect(r.rows[0][0]).toBe(2);
  });

  test('revoking READ denies the query again', () => {
    exec('GRANT READ ON DIRECTORY ext_dir TO alice', sys);
    expect(exec('SELECT COUNT(*) FROM sys.ext', alice).rows[0][0]).toBe(2);
    exec('REVOKE READ ON DIRECTORY ext_dir FROM alice', sys);
    expect(() => exec('SELECT COUNT(*) FROM sys.ext', alice)).toThrow(/29913|29289/i);
  });
});
