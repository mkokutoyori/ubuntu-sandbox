import { test, expect } from '@playwright/test';
import { setupSqlplus, sql } from './helpers/oracleTerminal';

test.describe('Oracle READ ONLY / SET TRANSACTION', () => {
  test.beforeEach(async ({ page }) => {
    test.setTimeout(60_000);
    await setupSqlplus(page);
    await sql(page, 'CREATE TABLE t (id NUMBER PRIMARY KEY, balance NUMBER);');
    await sql(page, 'INSERT INTO t VALUES (1, 100);');
    expect(await sql(page, 'COMMIT;')).toContain('Commit complete.');
  });

  test('DML inside a READ ONLY transaction raises ORA-01456', async ({ page }) => {
    expect(await sql(page, 'SET TRANSACTION READ ONLY;')).not.toContain('ORA-');

    expect(await sql(page, 'SELECT balance FROM t WHERE id = 1;')).toContain('100');

    expect(await sql(page, 'UPDATE t SET balance = 200 WHERE id = 1;')).toContain('ORA-01456');
    expect(await sql(page, 'INSERT INTO t VALUES (2, 5);')).toContain('ORA-01456');
    expect(await sql(page, 'DELETE FROM t WHERE id = 1;')).toContain('ORA-01456');
  });

  test('COMMIT ends the READ ONLY transaction and re-enables DML', async ({ page }) => {
    await sql(page, 'SET TRANSACTION READ ONLY;');
    expect(await sql(page, 'UPDATE t SET balance = 1 WHERE id = 1;')).toContain('ORA-01456');

    expect(await sql(page, 'COMMIT;')).toContain('Commit complete.');
    expect(await sql(page, 'UPDATE t SET balance = 250 WHERE id = 1;')).toContain('1 row updated.');
    expect(await sql(page, 'COMMIT;')).toContain('Commit complete.');
    expect(await sql(page, 'SELECT balance FROM t WHERE id = 1;')).toContain('250');
  });

  test('SET TRANSACTION is rejected (ORA-01453) when it is not the first statement', async ({ page }) => {

    expect(await sql(page, 'UPDATE t SET balance = 300 WHERE id = 1;')).toContain('1 row updated.');

    expect(await sql(page, 'SET TRANSACTION READ ONLY;')).toContain('ORA-01453');
    await sql(page, 'ROLLBACK;');
  });

  test('SET TRANSACTION READ WRITE and ISOLATION LEVEL SERIALIZABLE are accepted', async ({ page }) => {
    expect(await sql(page, 'SET TRANSACTION READ WRITE;')).not.toContain('ORA-');
    await sql(page, 'COMMIT;');
    expect(await sql(page, 'SET TRANSACTION ISOLATION LEVEL SERIALIZABLE;')).not.toContain('ORA-');
    await sql(page, 'COMMIT;');
    expect(await sql(page, 'SET TRANSACTION ISOLATION LEVEL READ COMMITTED;')).not.toContain('ORA-');
    await sql(page, 'COMMIT;');
  });
});
