import { describe, it, expect, beforeEach } from 'vitest';
import { OracleDatabase } from '@/database/oracle/OracleDatabase';
import { SQLPlusSession } from '@/database/oracle/commands/SQLPlusSession';
import { EventBus } from '@/events/EventBus';

let db: OracleDatabase;
let session: SQLPlusSession;
const run = (sql: string) => session.processLine(sql).output.join('\n');

beforeEach(() => {
  db = new OracleDatabase();
  db.instance.setEventBus(new EventBus());
  db.instance.startup('OPEN');
  session = new SQLPlusSession(db);
  session.login('SYS', '', true);
  run('CREATE TABLE hr.emp (id NUMBER PRIMARY KEY, name VARCHAR2(30));');
  run("INSERT INTO hr.emp VALUES (1, 'a');");
  run('COMMIT;');
});

describe('V$SQL_PLAN_MONITOR reads the real plan generator', () => {
  it('a full scan query shows TABLE ACCESS FULL on the right object', () => {
    run("SELECT name FROM hr.emp WHERE name = 'a';");
    const out = run(
      "SELECT plan_line_id, plan_operation, plan_options, plan_object_name FROM v$sql_plan_monitor WHERE plan_object_name = 'EMP';");
    expect(out).toMatch(/TABLE ACCESS\s+FULL\s+EMP/);
  });

  it('an indexed lookup shows the INDEX access path, not a canned root line', () => {
    run('SELECT name FROM hr.emp WHERE id = 1;');
    const out = run(
      "SELECT plan_operation, plan_options FROM v$sql_plan_monitor;");
    expect(out).toMatch(/INDEX/);
    expect(out).toMatch(/TABLE ACCESS/);
  });

  it('a statement contributes several plan lines, root first', () => {
    run('SELECT name FROM hr.emp WHERE id = 1;');
    const out = run(
      "SELECT sql_id, plan_line_id, plan_operation FROM v$sql_plan_monitor ORDER BY plan_line_id;");
    expect(out).toMatch(/SELECT STATEMENT/);
    expect(out).toMatch(/\b1\b/);
    expect(out.split('\n').filter(l => /SELECT STATEMENT|TABLE ACCESS|INDEX/.test(l)).length)
      .toBeGreaterThan(1);
  });
});
