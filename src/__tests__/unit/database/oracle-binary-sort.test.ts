import { describe, it, expect, beforeEach } from 'vitest';
import { OracleDatabase } from '@/database/oracle/OracleDatabase';
import { SQLPlusSession } from '@/database/oracle/commands/SQLPlusSession';

let db: OracleDatabase;
let session: SQLPlusSession;
const run = (sql: string) => session.processLine(sql).output.join('\n');

beforeEach(() => {
  db = new OracleDatabase();
  db.instance.startup('OPEN');
  session = new SQLPlusSession(db);
  session.login('SYS', '', true);
  run('CREATE TABLE hr.t (v VARCHAR2(10));');
});

function rowsInOrder(out: string, values: string[]): boolean {
  const positions = values.map(v => out.indexOf(v));
  return positions.every((p, i) => p >= 0 && (i === 0 || p > positions[i - 1]));
}

describe('ORDER BY uses Oracle BINARY collation (NLS_SORT=BINARY)', () => {
  it('uppercase sorts before lowercase (ASCII order)', () => {
    for (const v of ['banana', 'Apple', 'apple', 'Banana']) {
      run(`INSERT INTO hr.t VALUES ('${v}');`);
    }
    const out = run('SELECT v FROM hr.t ORDER BY v;');
    expect(rowsInOrder(out, ['Apple', 'Banana', 'apple', 'banana'])).toBe(true);
  });

  it('digits sort before letters', () => {
    for (const v of ['Zeta', '1one', 'Alpha']) {
      run(`INSERT INTO hr.t VALUES ('${v}');`);
    }
    const out = run('SELECT v FROM hr.t ORDER BY v;');
    expect(rowsInOrder(out, ['1one', 'Alpha', 'Zeta'])).toBe(true);
  });
});
