import { test, expect } from '@playwright/test';
import { setupSqlplus, sql } from './helpers/oracleTerminal';

test.describe('Oracle savepoint lifecycle', () => {
  test.beforeEach(async ({ page }) => {
    test.setTimeout(60_000);
    await setupSqlplus(page);
    await sql(page, 'CREATE TABLE t (id NUMBER);');
    expect(await sql(page, 'COMMIT;')).toContain('Commit complete.');
  });

  test('COMMIT erases all savepoints (ORA-01086 afterwards)', async ({ page }) => {
    await sql(page, 'INSERT INTO t VALUES (1);');
    expect(await sql(page, 'SAVEPOINT sp;')).toContain('Savepoint created.');
    expect(await sql(page, 'COMMIT;')).toContain('Commit complete.');

    expect(await sql(page, 'ROLLBACK TO SAVEPOINT sp;')).toContain('ORA-01086');
  });

  test('a full ROLLBACK erases all savepoints (ORA-01086 afterwards)', async ({ page }) => {
    await sql(page, 'INSERT INTO t VALUES (2);');
    await sql(page, 'SAVEPOINT sp;');
    expect(await sql(page, 'ROLLBACK;')).toContain('Rollback complete.');

    expect(await sql(page, 'ROLLBACK TO SAVEPOINT sp;')).toContain('ORA-01086');
  });

  test('the implicit COMMIT from a DDL statement erases savepoints (ORA-01086 afterwards)', async ({ page }) => {
    await sql(page, 'INSERT INTO t VALUES (3);');
    await sql(page, 'SAVEPOINT sp;');

    expect(await sql(page, 'CREATE TABLE other (x NUMBER);')).toContain('Table created.');

    expect(await sql(page, 'ROLLBACK TO SAVEPOINT sp;')).toContain('ORA-01086');
  });

  test('savepoint names are case-insensitive', async ({ page }) => {
    await sql(page, 'INSERT INTO t VALUES (4);');
    expect(await sql(page, 'SAVEPOINT MySave;')).toContain('Savepoint created.');
    await sql(page, 'INSERT INTO t VALUES (5);');

    const rolled = await sql(page, 'ROLLBACK TO SAVEPOINT mYsAvE;');
    expect(rolled).toContain('Rollback complete.');
    expect(rolled).not.toContain('ORA-01086');

    const out = await sql(page, 'SELECT id FROM t ORDER BY id;');
    expect(out).toContain('4');
    expect(out).not.toContain('5');
  });
});
