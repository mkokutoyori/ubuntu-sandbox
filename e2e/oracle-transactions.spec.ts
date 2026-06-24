/**
 * Oracle transaction control E2E tests — Playwright
 *
 * Drives the real browser UI: drops a Linux server on the canvas, opens its
 * graphical terminal, launches the in-browser SQL*Plus REPL with
 * `sqlplus / as sysdba`, and exercises Oracle's transaction-control surface
 * end to end:
 *
 *   - implicit transaction start on the first DML, COMMIT durability
 *   - ROLLBACK of uncommitted INSERT / UPDATE / DELETE
 *   - SAVEPOINT + ROLLBACK TO SAVEPOINT (partial rollback), savepoint
 *     re-use, nested-savepoint erasure, ORA-01086 on an unknown savepoint
 *   - DDL implicit-commit (auto-commit) semantics
 *   - SET AUTOCOMMIT ON/OFF behaviour
 *   - a realistic atomic funds-transfer scenario
 *
 * Scope note: the simulator models one writing session at a time (all
 * SQL*Plus sessions on a device share the same storage and there is no
 * read-isolation between them), so every test confines itself to a single
 * session — which is exactly where COMMIT / ROLLBACK / SAVEPOINT are
 * faithfully modelled and observable.
 *
 * Setup: `window.__networkStore` is exposed in dev mode (src/main.tsx).
 */

import { test, expect, type Page } from '@playwright/test';

// ─── Helpers ────────────────────────────────────────────────────────────────

async function waitForStore(page: Page): Promise<void> {
  await page.waitForFunction(
    () => !!(window as Record<string, unknown>).__networkStore,
    { timeout: 10_000 },
  );
}

async function addLinuxServer(page: Page): Promise<string> {
  return page.evaluate(() => {
    const store = (window as Record<string, unknown>).__networkStore as {
      getState(): { addDevice(t: string, x: number, y: number): { id: string } };
    };
    return store.getState().addDevice('linux-server', 400, 300).id;
  });
}

async function openTerminal(page: Page, deviceId: string): Promise<void> {
  await page.locator(`[data-device-id="${deviceId}"]`).first().dblclick({ timeout: 5_000 });
  await expect(page.locator('[data-testid="terminal-modal"]')).toBeVisible({ timeout: 8_000 });
}

/** Full visible scrollback text of the terminal (input values are excluded). */
function termText(page: Page): Promise<string> {
  return page.locator('[data-testid="terminal-modal"]').innerText();
}

/** Type a line into the active terminal input and submit it. */
async function typeLine(page: Page, text: string): Promise<void> {
  const input = page.locator('[data-testid="terminal-modal"] input[type="text"]').last();
  await input.focus();
  await input.fill(text);
  await input.press('Enter');
}

/**
 * Submit one SQL*Plus line and return ONLY the newly-appended terminal text.
 *
 * Because the scrollback is append-only and the entered line is always echoed
 * with its prompt, the text strictly grows after every submission — so we can
 * poll for growth and slice off the delta. Returning just the delta keeps both
 * positive (`toContain`) and negative (`not.toContain`) assertions unambiguous
 * even when the same phrase (e.g. "Rollback complete.") recurs across steps.
 */
async function sql(page: Page, statement: string): Promise<string> {
  const before = (await termText(page)).length;
  await typeLine(page, statement);
  await expect.poll(async () => (await termText(page)).length, { timeout: 8_000 })
    .toBeGreaterThan(before);
  // Let multi-line output (SELECT grids) finish flushing before slicing.
  await page.waitForTimeout(150);
  return (await termText(page)).slice(before);
}

/** Launch the SQL*Plus REPL as SYSDBA and wait for the "Connected." banner. */
async function launchSqlplus(page: Page): Promise<void> {
  await typeLine(page, 'sqlplus / as sysdba');
  await expect(
    page.locator('[data-testid="terminal-modal"]').getByText('Connected.', { exact: false }),
  ).toBeVisible({ timeout: 10_000 });
}

/**
 * Create and COMMIT a small two-row ACCOUNTS table, the shared fixture for
 * the ROLLBACK / SAVEPOINT / AUTOCOMMIT / transfer scenarios.
 *
 *   id=1 alice 100   |   id=2 bob 50
 */
async function seedAccounts(page: Page): Promise<void> {
  await sql(page, 'CREATE TABLE accounts (id NUMBER PRIMARY KEY, owner VARCHAR2(20), balance NUMBER);');
  await sql(page, "INSERT INTO accounts VALUES (1, 'alice', 100);");
  await sql(page, "INSERT INTO accounts VALUES (2, 'bob', 50);");
  const committed = await sql(page, 'COMMIT;');
  expect(committed).toContain('Commit complete.');
}

// ─── Suite ────────────────────────────────────────────────────────────────

test.describe('Oracle transactions (SQL*Plus, end to end)', () => {
  // Each test boots a fresh page → fresh store → fresh device → fresh Oracle
  // instance, so tables never leak between tests.
  test.beforeEach(async ({ page }) => {
    test.setTimeout(60_000);
    await page.goto('/');
    await waitForStore(page);
    const id = await addLinuxServer(page);
    await openTerminal(page, id);
    await launchSqlplus(page);
  });

  // ── A. Implicit transaction lifecycle & COMMIT ────────────────────────────
  test.describe('implicit transaction & COMMIT', () => {
    test('the first DML opens an implicit transaction that COMMIT makes permanent', async ({ page }) => {
      await sql(page, 'CREATE TABLE t (id NUMBER, tag VARCHAR2(20));');

      // No explicit BEGIN — the INSERT itself starts the transaction.
      expect(await sql(page, "INSERT INTO t VALUES (1, 'persisted');")).toContain('1 row created.');
      expect(await sql(page, 'COMMIT;')).toContain('Commit complete.');

      // A ROLLBACK after the COMMIT cannot undo committed work.
      expect(await sql(page, 'ROLLBACK;')).toContain('Rollback complete.');
      expect(await sql(page, 'SELECT tag FROM t WHERE id = 1;')).toContain('persisted');
    });

    test('COMMIT with no open transaction is a harmless no-op', async ({ page }) => {
      await sql(page, 'CREATE TABLE t (id NUMBER);');
      // Nothing pending: COMMIT still succeeds without raising an error.
      const out = await sql(page, 'COMMIT;');
      expect(out).toContain('Commit complete.');
      expect(out).not.toContain('ORA-');
    });
  });

  // ── B. ROLLBACK of uncommitted DML ────────────────────────────────────────
  test.describe('ROLLBACK of uncommitted DML', () => {
    test.beforeEach(async ({ page }) => { await seedAccounts(page); });

    test('ROLLBACK undoes an uncommitted INSERT', async ({ page }) => {
      expect(await sql(page, "INSERT INTO accounts VALUES (3, 'carol', 10);")).toContain('1 row created.');
      expect(await sql(page, 'SELECT owner FROM accounts WHERE id = 3;')).toContain('carol');

      expect(await sql(page, 'ROLLBACK;')).toContain('Rollback complete.');

      const after = await sql(page, 'SELECT owner FROM accounts ORDER BY id;');
      expect(after).not.toContain('carol');
      expect(after).toContain('alice');
      expect(after).toContain('bob');
    });

    test('ROLLBACK undoes an uncommitted UPDATE', async ({ page }) => {
      expect(await sql(page, 'UPDATE accounts SET balance = 999 WHERE id = 1;')).toContain('1 row updated.');
      expect(await sql(page, 'SELECT balance FROM accounts WHERE id = 1;')).toContain('999');

      expect(await sql(page, 'ROLLBACK;')).toContain('Rollback complete.');

      const restored = await sql(page, 'SELECT balance FROM accounts WHERE id = 1;');
      expect(restored).toContain('100');
      expect(restored).not.toContain('999');
    });

    test('ROLLBACK undoes an uncommitted DELETE (restores every row)', async ({ page }) => {
      expect(await sql(page, 'DELETE FROM accounts;')).toContain('2 rows deleted.');
      expect(await sql(page, 'SELECT owner FROM accounts;')).toContain('no rows selected');

      expect(await sql(page, 'ROLLBACK;')).toContain('Rollback complete.');

      const restored = await sql(page, 'SELECT owner FROM accounts ORDER BY id;');
      expect(restored).toContain('alice');
      expect(restored).toContain('bob');
    });

    test('ROLLBACK with no open transaction is a harmless no-op', async ({ page }) => {
      // The seed already COMMITted, so there is nothing pending to undo.
      const out = await sql(page, 'ROLLBACK;');
      expect(out).toContain('Rollback complete.');
      expect(out).not.toContain('ORA-');
      // Committed data is untouched.
      expect(await sql(page, 'SELECT owner FROM accounts ORDER BY id;')).toContain('alice');
    });
  });

  // ── C. SAVEPOINT & partial rollback ───────────────────────────────────────
  test.describe('SAVEPOINT & ROLLBACK TO SAVEPOINT', () => {
    test.beforeEach(async ({ page }) => { await seedAccounts(page); });

    test('ROLLBACK TO SAVEPOINT keeps the work done before the savepoint', async ({ page }) => {
      await sql(page, "INSERT INTO accounts VALUES (3, 'before_sp', 1);");
      expect(await sql(page, 'SAVEPOINT sp1;')).toContain('Savepoint created.');
      await sql(page, "INSERT INTO accounts VALUES (4, 'after_sp', 1);");

      const both = await sql(page, 'SELECT owner FROM accounts WHERE id IN (3, 4) ORDER BY id;');
      expect(both).toContain('before_sp');
      expect(both).toContain('after_sp');

      // Partial rollback: only the post-savepoint INSERT is undone.
      expect(await sql(page, 'ROLLBACK TO SAVEPOINT sp1;')).toContain('Rollback complete.');
      const afterRollback = await sql(page, 'SELECT owner FROM accounts WHERE id IN (3, 4) ORDER BY id;');
      expect(afterRollback).toContain('before_sp');
      expect(afterRollback).not.toContain('after_sp');

      // The transaction is still open: COMMIT persists the surviving work.
      expect(await sql(page, 'COMMIT;')).toContain('Commit complete.');
      const committed = await sql(page, 'SELECT owner FROM accounts WHERE id = 3;');
      expect(committed).toContain('before_sp');
    });

    test('rolling to an earlier savepoint erases the savepoints created after it', async ({ page }) => {
      await sql(page, "INSERT INTO accounts VALUES (3, 'a', 1);");
      expect(await sql(page, 'SAVEPOINT s1;')).toContain('Savepoint created.');
      await sql(page, "INSERT INTO accounts VALUES (4, 'b', 1);");
      expect(await sql(page, 'SAVEPOINT s2;')).toContain('Savepoint created.');
      await sql(page, "INSERT INTO accounts VALUES (5, 'c', 1);");

      // Rolling back to s1 discards s2 along with everything after s1.
      expect(await sql(page, 'ROLLBACK TO SAVEPOINT s1;')).toContain('Rollback complete.');

      // s2 no longer exists, so rolling to it now raises ORA-01086.
      expect(await sql(page, 'ROLLBACK TO SAVEPOINT s2;')).toContain('ORA-01086');
    });

    test('re-using a savepoint name moves it to the new position', async ({ page }) => {
      await sql(page, "INSERT INTO accounts VALUES (3, 'keep_one', 1);");
      await sql(page, 'SAVEPOINT sp;');
      await sql(page, "INSERT INTO accounts VALUES (4, 'keep_two', 1);");
      // Re-using the name SP erases the first marker and re-plants it here.
      await sql(page, 'SAVEPOINT sp;');
      await sql(page, "INSERT INTO accounts VALUES (5, 'drop_me', 1);");

      expect(await sql(page, 'ROLLBACK TO SAVEPOINT sp;')).toContain('Rollback complete.');

      const survivors = await sql(page, 'SELECT owner FROM accounts WHERE id IN (3, 4, 5) ORDER BY id;');
      expect(survivors).toContain('keep_one');
      expect(survivors).toContain('keep_two');
      expect(survivors).not.toContain('drop_me');
    });

    test('ROLLBACK TO an unknown savepoint raises ORA-01086 and leaves the transaction intact', async ({ page }) => {
      await sql(page, "INSERT INTO accounts VALUES (3, 'still_here', 1);");

      const err = await sql(page, 'ROLLBACK TO SAVEPOINT ghost;');
      expect(err).toContain('ORA-01086');
      expect(err.toUpperCase()).toContain('GHOST');

      // The transaction was not aborted by the error — the row is still pending.
      expect(await sql(page, 'SELECT owner FROM accounts WHERE id = 3;')).toContain('still_here');

      // A full ROLLBACK still works and removes the pending row.
      expect(await sql(page, 'ROLLBACK;')).toContain('Rollback complete.');
      expect(await sql(page, 'SELECT owner FROM accounts WHERE id = 3;')).toContain('no rows selected');
    });
  });

  // ── D. DDL implicit-commit (auto-commit) ──────────────────────────────────
  test.describe('DDL auto-commit', () => {
    test('a DDL statement implicitly commits the pending DML before it', async ({ page }) => {
      await sql(page, 'CREATE TABLE dml_target (id NUMBER, tag VARCHAR2(20));');

      // Pending, uncommitted INSERT…
      expect(await sql(page, "INSERT INTO dml_target VALUES (1, 'flushed_by_ddl');")).toContain('1 row created.');
      // …then a DDL statement, which forces an implicit COMMIT of the INSERT.
      expect(await sql(page, 'CREATE TABLE ddl_marker (x NUMBER);')).toContain('Table created.');

      // The subsequent ROLLBACK has nothing to undo — the INSERT was committed.
      expect(await sql(page, 'ROLLBACK;')).toContain('Rollback complete.');
      expect(await sql(page, 'SELECT tag FROM dml_target WHERE id = 1;')).toContain('flushed_by_ddl');
    });

    test('a CREATE TABLE cannot itself be rolled back', async ({ page }) => {
      expect(await sql(page, 'CREATE TABLE temp_ddl (x NUMBER);')).toContain('Table created.');
      await sql(page, 'ROLLBACK;');

      // The table still exists: querying it does NOT raise ORA-00942.
      const out = await sql(page, 'SELECT COUNT(*) FROM temp_ddl;');
      expect(out).not.toContain('ORA-00942');
      expect(out).toContain('1 row selected.');
    });
  });

  // ── E. SET AUTOCOMMIT ─────────────────────────────────────────────────────
  test.describe('SET AUTOCOMMIT', () => {
    test.beforeEach(async ({ page }) => { await seedAccounts(page); });

    test('with AUTOCOMMIT ON every DML is committed immediately', async ({ page }) => {
      await sql(page, 'SET AUTOCOMMIT ON');
      expect(await sql(page, 'UPDATE accounts SET balance = 500 WHERE id = 1;')).toContain('1 row updated.');

      // The change was auto-committed, so a ROLLBACK cannot take it back.
      expect(await sql(page, 'ROLLBACK;')).toContain('Rollback complete.');
      const out = await sql(page, 'SELECT balance FROM accounts WHERE id = 1;');
      expect(out).toContain('500');
    });

    test('with AUTOCOMMIT OFF (the default) DML is held until COMMIT/ROLLBACK', async ({ page }) => {
      // Default is OFF; assert it explicitly for clarity.
      await sql(page, 'SET AUTOCOMMIT OFF');
      expect(await sql(page, 'UPDATE accounts SET balance = 1 WHERE id = 1;')).toContain('1 row updated.');

      expect(await sql(page, 'ROLLBACK;')).toContain('Rollback complete.');
      const out = await sql(page, 'SELECT balance FROM accounts WHERE id = 1;');
      expect(out).toContain('100');
      expect(out).not.toContain('1 row updated');
    });
  });

  // ── F. Realistic atomic funds transfer ────────────────────────────────────
  test.describe('atomic funds transfer', () => {
    test.beforeEach(async ({ page }) => { await seedAccounts(page); });

    test('a committed two-statement transfer moves the money atomically', async ({ page }) => {
      await sql(page, 'UPDATE accounts SET balance = balance - 30 WHERE id = 1;'); // debit alice
      await sql(page, 'UPDATE accounts SET balance = balance + 30 WHERE id = 2;'); // credit bob
      expect(await sql(page, 'COMMIT;')).toContain('Commit complete.');

      const out = await sql(page, 'SELECT owner, balance FROM accounts ORDER BY id;');
      expect(out).toMatch(/alice\s+70/);
      expect(out).toMatch(/bob\s+80/);
    });

    test('an abandoned transfer rolls back atomically — no partial debit survives', async ({ page }) => {
      // Debit alice, then abort before crediting bob (e.g. validation failed).
      await sql(page, 'UPDATE accounts SET balance = balance - 30 WHERE id = 1;');
      expect(await sql(page, 'SELECT balance FROM accounts WHERE id = 1;')).toContain('70');

      expect(await sql(page, 'ROLLBACK;')).toContain('Rollback complete.');

      // Both balances are back to their committed values — money was never lost.
      const out = await sql(page, 'SELECT owner, balance FROM accounts ORDER BY id;');
      expect(out).toMatch(/alice\s+100/);
      expect(out).toMatch(/bob\s+50/);
      expect(out).not.toContain('70');
    });
  });
});
