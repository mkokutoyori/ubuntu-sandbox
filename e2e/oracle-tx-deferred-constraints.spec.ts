import { test, expect } from '@playwright/test';
import { setupSqlplus, sql } from './helpers/oracleTerminal';

test.describe('Oracle deferrable constraints', () => {
  test.beforeEach(async ({ page }) => {
    test.setTimeout(60_000);
    await setupSqlplus(page);
    await sql(page, 'CREATE TABLE parent (id NUMBER PRIMARY KEY);');
    await sql(page,
      'CREATE TABLE child (id NUMBER PRIMARY KEY, pid NUMBER, ' +
      'CONSTRAINT fk_child_parent FOREIGN KEY (pid) REFERENCES parent (id) ' +
      'DEFERRABLE INITIALLY DEFERRED);');
    await sql(page, 'INSERT INTO parent VALUES (1);');
    expect(await sql(page, 'COMMIT;')).toContain('Commit complete.');
  });

  test('a deferred FK violation is tolerated mid-transaction and raised at COMMIT (ORA-02091/ORA-02291)', async ({ page }) => {

    expect(await sql(page, 'INSERT INTO child VALUES (10, 999);')).toContain('1 row created.');

    const commit = await sql(page, 'COMMIT;');
    expect(commit).toContain('ORA-02091');
    expect(commit).toContain('ORA-02291');

    expect(await sql(page, 'SELECT id FROM child WHERE id = 10;')).toContain('no rows selected');
  });

  test('a deferred FK transaction COMMITs cleanly once the parent is supplied before COMMIT', async ({ page }) => {

    expect(await sql(page, 'INSERT INTO child VALUES (11, 2);')).toContain('1 row created.');
    await sql(page, 'INSERT INTO parent VALUES (2);');
    const commit = await sql(page, 'COMMIT;');
    expect(commit).toContain('Commit complete.');
    expect(commit).not.toContain('ORA-');
    const sel = await sql(page, 'SELECT pid FROM child WHERE id = 11;');
    expect(sel).not.toContain('ORA-');
    expect(sel).toContain('2');
  });

  test('SET CONSTRAINTS ALL IMMEDIATE forces an early check (ORA-02291)', async ({ page }) => {
    await sql(page, 'INSERT INTO child VALUES (12, 888);');
    const immediate = await sql(page, 'SET CONSTRAINTS ALL IMMEDIATE;');
    expect(immediate).toContain('ORA-02291');
    await sql(page, 'ROLLBACK;');
  });
});
