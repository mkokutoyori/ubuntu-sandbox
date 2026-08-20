import { test, expect, type Page } from '@playwright/test';
import { setupSqlplus, sql } from './helpers/oracleTerminal';

async function readInSecondSession(page: Page, deviceId: string, query: string): Promise<string> {
  return page.evaluate(({ id, q }) => {
    const store = (window as Record<string, unknown>).__networkStore as {
      getState(): { deviceInstances: Map<string, Record<string, unknown>> };
    };
    const device = store.getState().deviceInstances.get(id) as Record<string, unknown>;
    const exec = device.executeCommand as (c: string) => Promise<string> | string;
    return Promise.resolve(exec.call(device, `echo "${q}" | sqlplus / as sysdba`));
  }, { id: deviceId, q: query });
}

test.describe('Oracle READ COMMITTED isolation between sessions', () => {
  let deviceId: string;

  test.beforeEach(async ({ page }) => {
    test.setTimeout(60_000);
    deviceId = await setupSqlplus(page);

    await sql(page, 'CREATE TABLE t (id NUMBER PRIMARY KEY, label VARCHAR2(30), balance NUMBER);');
    await sql(page, "INSERT INTO t VALUES (1, 'committed', 100);");
    expect(await sql(page, 'COMMIT;')).toContain('Commit complete.');
  });

  test("a second session cannot see the first session's uncommitted INSERT", async ({ page }) => {

    expect(await sql(page, "INSERT INTO t VALUES (2, 'UNCOMMITTED_ROW', 5);")).toContain('1 row created.');

    const beforeCommit = await readInSecondSession(page, deviceId, 'SELECT label FROM t ORDER BY id;');
    expect(beforeCommit).toContain('committed');
    expect(beforeCommit).not.toContain('UNCOMMITTED_ROW');

    expect(await sql(page, 'COMMIT;')).toContain('Commit complete.');
    const afterCommit = await readInSecondSession(page, deviceId, 'SELECT label FROM t ORDER BY id;');
    expect(afterCommit).toContain('UNCOMMITTED_ROW');
  });

  test("a second session cannot see the first session's uncommitted UPDATE", async ({ page }) => {

    expect(await sql(page, 'UPDATE t SET balance = 999 WHERE id = 1;')).toContain('1 row updated.');

    const beforeCommit = await readInSecondSession(page, deviceId, 'SELECT balance FROM t WHERE id = 1;');
    expect(beforeCommit).toContain('100');
    expect(beforeCommit).not.toContain('999');

    expect(await sql(page, 'COMMIT;')).toContain('Commit complete.');
    const afterCommit = await readInSecondSession(page, deviceId, 'SELECT balance FROM t WHERE id = 1;');
    expect(afterCommit).toContain('999');
  });

  test("a second session cannot see the first session's uncommitted DELETE", async ({ page }) => {

    expect(await sql(page, 'DELETE FROM t WHERE id = 1;')).toContain('1 row deleted.');

    const beforeCommit = await readInSecondSession(page, deviceId, 'SELECT label FROM t WHERE id = 1;');
    expect(beforeCommit).toContain('committed');

    expect(await sql(page, 'COMMIT;')).toContain('Commit complete.');
    const afterCommit = await readInSecondSession(page, deviceId, 'SELECT label FROM t WHERE id = 1;');
    expect(afterCommit).toContain('no rows selected');
  });
});
