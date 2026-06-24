import { test, expect } from '@playwright/test';
import { setupSqlplus, sql, runBlock } from './helpers/oracleTerminal';

test.describe('Oracle autonomous transactions', () => {
  test.beforeEach(async ({ page }) => {
    test.setTimeout(60_000);
    await setupSqlplus(page);
    await sql(page, 'CREATE TABLE audit_log (msg VARCHAR2(50));');
    await sql(page, 'CREATE TABLE main_data (id NUMBER);');
    const proc = await runBlock(page, [
      'CREATE OR REPLACE PROCEDURE write_audit(p_msg VARCHAR2) AS',
      '  PRAGMA AUTONOMOUS_TRANSACTION;',
      'BEGIN',
      '  INSERT INTO audit_log VALUES (p_msg);',
      '  COMMIT;',
      'END;',
      '/',
    ]);
    expect(proc).toContain('Procedure created.');
  });

  test('an autonomous COMMIT survives the parent transaction ROLLBACK', async ({ page }) => {

    expect(await sql(page, 'INSERT INTO main_data VALUES (1);')).toContain('1 row created.');

    expect(await sql(page, "EXEC write_audit('logged');")).not.toContain('ORA-');

    expect(await sql(page, 'ROLLBACK;')).toContain('Rollback complete.');
    expect(await sql(page, 'SELECT COUNT(*) FROM main_data;')).toMatch(/\b0\b/);

    expect(await sql(page, 'SELECT msg FROM audit_log;')).toContain('logged');
  });

  test('the autonomous unit does not commit the parent transaction', async ({ page }) => {
    await sql(page, 'INSERT INTO main_data VALUES (42);');
    await sql(page, "EXEC write_audit('side-channel');");

    expect(await sql(page, 'ROLLBACK;')).toContain('Rollback complete.');
    expect(await sql(page, 'SELECT COUNT(*) FROM main_data WHERE id = 42;')).toMatch(/\b0\b/);

    expect(await sql(page, 'SELECT COUNT(*) FROM audit_log;')).toMatch(/\b1\b/);
  });
});
