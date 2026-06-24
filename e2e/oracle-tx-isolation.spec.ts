/**
 * Oracle multi-session read isolation (READ COMMITTED) — E2E (Playwright).
 *
 * Oracle's default isolation level is READ COMMITTED: a session NEVER sees
 * another session's uncommitted changes, and sees them only once the writer
 * COMMITs. Readers do not block writers and vice-versa.
 *
 * Driving two concurrent sessions against one database:
 *   - session A is the interactive SQL*Plus REPL in the terminal UI; it holds
 *     an OPEN transaction with uncommitted DML across steps;
 *   - session B is a separate, short-lived `sqlplus` invocation run through the
 *     server's shell (`echo "<sql>" | sqlplus ...`) — a distinct session on the
 *     same Oracle instance.
 *
 * These assertions encode real Oracle. If the simulator shares one mutable
 * store across sessions with no read isolation, session B will observe A's
 * uncommitted rows and these tests fail — which is exactly the gap to expose.
 */

import { test, expect, type Page } from '@playwright/test';
import { setupSqlplus, sql } from './helpers/oracleTerminal';

/** Run a read in a *separate* sqlplus session via the device shell pipe. */
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
    // Baseline, committed by session A so session B has something to read.
    await sql(page, 'CREATE TABLE t (id NUMBER PRIMARY KEY, label VARCHAR2(30), balance NUMBER);');
    await sql(page, "INSERT INTO t VALUES (1, 'committed', 100);");
    expect(await sql(page, 'COMMIT;')).toContain('Commit complete.');
  });

  test("a second session cannot see the first session's uncommitted INSERT", async ({ page }) => {
    // Session A inserts a uniquely-tagged row but does NOT commit.
    expect(await sql(page, "INSERT INTO t VALUES (2, 'UNCOMMITTED_ROW', 5);")).toContain('1 row created.');

    // Session B (separate session) must NOT see it under READ COMMITTED.
    const beforeCommit = await readInSecondSession(page, deviceId, 'SELECT label FROM t ORDER BY id;');
    expect(beforeCommit).toContain('committed');
    expect(beforeCommit).not.toContain('UNCOMMITTED_ROW');

    // After A commits, B sees it.
    expect(await sql(page, 'COMMIT;')).toContain('Commit complete.');
    const afterCommit = await readInSecondSession(page, deviceId, 'SELECT label FROM t ORDER BY id;');
    expect(afterCommit).toContain('UNCOMMITTED_ROW');
  });

  test("a second session cannot see the first session's uncommitted UPDATE", async ({ page }) => {
    // Session A updates the balance but does NOT commit.
    expect(await sql(page, 'UPDATE t SET balance = 999 WHERE id = 1;')).toContain('1 row updated.');

    // Session B still sees the previously-committed value.
    const beforeCommit = await readInSecondSession(page, deviceId, 'SELECT balance FROM t WHERE id = 1;');
    expect(beforeCommit).toContain('100');
    expect(beforeCommit).not.toContain('999');

    // After commit, B sees the new value.
    expect(await sql(page, 'COMMIT;')).toContain('Commit complete.');
    const afterCommit = await readInSecondSession(page, deviceId, 'SELECT balance FROM t WHERE id = 1;');
    expect(afterCommit).toContain('999');
  });

  test("a second session cannot see the first session's uncommitted DELETE", async ({ page }) => {
    // Session A deletes the committed row but does NOT commit.
    expect(await sql(page, 'DELETE FROM t WHERE id = 1;')).toContain('1 row deleted.');

    // Session B must still see the row (the delete is not visible yet).
    const beforeCommit = await readInSecondSession(page, deviceId, 'SELECT label FROM t WHERE id = 1;');
    expect(beforeCommit).toContain('committed');

    // After commit, the row is gone for B as well.
    expect(await sql(page, 'COMMIT;')).toContain('Commit complete.');
    const afterCommit = await readInSecondSession(page, deviceId, 'SELECT label FROM t WHERE id = 1;');
    expect(afterCommit).toContain('no rows selected');
  });
});
