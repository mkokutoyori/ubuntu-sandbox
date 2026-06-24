import { test, expect } from '@playwright/test';
import { setupSqlplus, sql } from './helpers/oracleTerminal';

test.describe('Oracle statement-level rollback', () => {
  test.beforeEach(async ({ page }) => {
    test.setTimeout(60_000);
    await setupSqlplus(page);
    await sql(page, 'CREATE TABLE t (id NUMBER PRIMARY KEY, label VARCHAR2(20) NOT NULL, qty NUMBER CHECK (qty >= 0));');
    await sql(page, "INSERT INTO t VALUES (1, 'seed', 5);");
    expect(await sql(page, 'COMMIT;')).toContain('Commit complete.');
  });

  test('a duplicate-key INSERT (ORA-00001) rolls back only that statement, not the transaction', async ({ page }) => {

    expect(await sql(page, "INSERT INTO t VALUES (2, 'keep_me', 1);")).toContain('1 row created.');

    const dup = await sql(page, "INSERT INTO t VALUES (1, 'dup', 1);");
    expect(dup).toContain('ORA-00001');

    expect(await sql(page, 'SELECT label FROM t WHERE id = 2;')).toContain('keep_me');

    expect(await sql(page, 'COMMIT;')).toContain('Commit complete.');
    const after = await sql(page, 'SELECT label FROM t ORDER BY id;');
    expect(after).toContain('seed');
    expect(after).toContain('keep_me');
    expect(after).not.toContain('dup');
  });

  test('a CHECK violation (ORA-02290) leaves the rest of the transaction intact', async ({ page }) => {
    expect(await sql(page, "INSERT INTO t VALUES (3, 'before_check', 2);")).toContain('1 row created.');

    const bad = await sql(page, "INSERT INTO t VALUES (4, 'negative', -1);");
    expect(bad).toContain('ORA-02290');

    expect(await sql(page, 'SELECT label FROM t WHERE id = 3;')).toContain('before_check');
    expect(await sql(page, 'COMMIT;')).toContain('Commit complete.');
    expect(await sql(page, 'SELECT label FROM t WHERE id = 4;')).toContain('no rows selected');
  });

  test('a NOT NULL violation (ORA-01400) does not discard prior uncommitted DML', async ({ page }) => {
    expect(await sql(page, "UPDATE t SET qty = 99 WHERE id = 1;")).toContain('1 row updated.');

    const bad = await sql(page, "INSERT INTO t (id, qty) VALUES (5, 1);");
    expect(bad).toContain('ORA-01400');

    expect(await sql(page, 'SELECT qty FROM t WHERE id = 1;')).toContain('99');
    expect(await sql(page, 'ROLLBACK;')).toContain('Rollback complete.');
    expect(await sql(page, 'SELECT qty FROM t WHERE id = 1;')).toContain('5');
  });

  test('a failed statement followed by ROLLBACK undoes the whole transaction', async ({ page }) => {
    await sql(page, "INSERT INTO t VALUES (6, 'doomed', 1);");
    expect(await sql(page, "INSERT INTO t VALUES (1, 'dup', 1);")).toContain('ORA-00001');

    expect(await sql(page, 'ROLLBACK;')).toContain('Rollback complete.');

    const out = await sql(page, 'SELECT label FROM t ORDER BY id;');
    expect(out).toContain('seed');
    expect(out).not.toContain('doomed');
  });
});
