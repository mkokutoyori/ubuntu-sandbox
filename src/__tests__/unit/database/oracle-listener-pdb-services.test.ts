import { describe, it, expect, beforeEach } from 'vitest';
import { OracleDatabase } from '@/database/oracle/OracleDatabase';

let db: OracleDatabase;

beforeEach(() => {
  db = new OracleDatabase();
  db.instance.startup('OPEN');
  db.instance.startListener();
});

const sys = () => db.connectAsSysdba().executor;
const run = (sql: string) => db.executeSql(sys(), sql);

describe('the listener registers a service per open PDB', () => {
  it('lsnrctl status advertises the seeded ORCLPDB1 service', () => {
    const body = db.instance.listener.statusBody().join('\n');
    expect(body).toMatch(/Service "ORCLPDB1" has 1 instance/);
    expect(body).toMatch(/Service "ORCL" has 1 instance/);
  });

  it('does not advertise PDB$SEED (no service)', () => {
    expect(db.instance.listener.statusBody().join('\n')).not.toMatch(/PDB\$SEED/);
  });

  it('a newly created+opened PDB becomes a registered service', () => {
    run("CREATE PLUGGABLE DATABASE salespdb ADMIN USER a IDENTIFIED BY p");
    expect(db.instance.listener.statusBody().join('\n')).not.toMatch(/SALESPDB/);
    run('ALTER PLUGGABLE DATABASE salespdb OPEN');
    expect(db.instance.listener.statusBody().join('\n')).toMatch(/Service "SALESPDB" has 1 instance/);
  });

  it('attemptConnect accepts an open PDB service and refuses an unknown one', () => {
    run('ALTER PLUGGABLE DATABASE orclpdb1 OPEN');
    expect(db.instance.listener.attemptConnect('ORCLPDB1').ok).toBe(true);
    expect(db.instance.listener.attemptConnect('NOPE').ok).toBe(false);
  });

  it('a closed PDB stops being a registered service', () => {
    run('ALTER PLUGGABLE DATABASE orclpdb1 CLOSE');
    expect(db.instance.listener.statusBody().join('\n')).not.toMatch(/ORCLPDB1/);
    expect(db.instance.listener.attemptConnect('ORCLPDB1').ok).toBe(false);
  });
});
