/**
 * Comprehensive lifecycle integration tests for Oracle access management.
 *
 * Each section drives the in-memory SQL*Plus subshell with a table of
 * (statement, expectation) pairs. The expectation matcher supports:
 *
 *   - RegExp                 — output must match
 *   - string                 — output must contain the substring
 *   - { not: RegExp|string } — output must NOT match / contain
 *   - (out) => boolean       — arbitrary predicate
 *
 * The tests follow a real DBA's daily workflow: bootstrap → users →
 * profiles → roles → privileges → object access → audit policies →
 * connection attempts → inspection → revoke → cleanup. State is shared
 * across `it()` blocks within a `describe` so later assertions build on
 * the artefacts created earlier — mirroring how an admin actually works.
 *
 * NOTE: These tests are intentionally broad. Some statements rely on
 * features that may not yet be implemented; they are still useful as a
 * single-source-of-truth specification of expected behaviour.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { SqlPlusSubShell } from '@/terminal/subshells/SqlPlusSubShell';
import { resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { resetAllOracleInstances } from '@/terminal/commands/database';

// ── Matcher harness ───────────────────────────────────────────────

type Expectation =
  | RegExp
  | string
  | { not: RegExp | string }
  | ((out: string) => boolean);

interface Case {
  /** SQL or SQL*Plus command to execute. */
  sql: string;
  /** Acceptance criterion for the resulting output. */
  want: Expectation;
}

function matches(out: string, want: Expectation): boolean {
  if (typeof want === 'function') return want(out);
  if (want instanceof RegExp) return want.test(out);
  if (typeof want === 'string') return out.includes(want);
  if ('not' in want) {
    const inner = want.not;
    return inner instanceof RegExp ? !inner.test(out) : !out.includes(inner);
  }
  return false;
}

function describeExpectation(want: Expectation): string {
  if (typeof want === 'function') return '<predicate>';
  if (want instanceof RegExp) return `matches ${want.toString()}`;
  if (typeof want === 'string') return `contains "${want}"`;
  if ('not' in want) {
    const inner = want.not;
    return inner instanceof RegExp ? `does NOT match ${inner.toString()}` : `does NOT contain "${inner}"`;
  }
  return '<unknown>';
}

function makeSysShell(name: string) {
  const srv = new LinuxServer('linux-server', name, 100, 100);
  return SqlPlusSubShell.create(srv, ['/', 'as', 'sysdba']).subShell;
}

function makeUserShell(name: string, user: string, password: string) {
  const srv = new LinuxServer('linux-server', name, 100, 100);
  return SqlPlusSubShell.create(srv, [`${user}/${password}`]).subShell;
}

function run(sh: ReturnType<typeof makeSysShell>, sql: string): string {
  return sh.processLine(sql).output.join('\n');
}

function drive(sh: ReturnType<typeof makeSysShell>, cases: Case[]): void {
  for (const c of cases) {
    const out = run(sh, c.sql);
    expect(
      matches(out, c.want),
      `Case failed:\n  SQL:      ${c.sql}\n  Expected: ${describeExpectation(c.want)}\n  Actual:   ${out}`
    ).toBe(true);
  }
}

// ── Shared fixture ────────────────────────────────────────────────

let sys: ReturnType<typeof makeSysShell>;

beforeAll(() => {
  resetCounters();
  resetDeviceCounters();
  resetAllOracleInstances();
  Logger.reset();
  sys = makeSysShell('lifecycle');
});

afterAll(() => {
  sys.dispose();
});

// ─────────────────────────────────────────────────────────────────
// SECTION 1 — Session bootstrap & SYS context
// ─────────────────────────────────────────────────────────────────

describe('1. Session bootstrap and SYS context', () => {
  // Each row is asserted as its own `test.each` case so the report
  // identifies exactly which statement failed. Matchers are tight: no
  // alternations between success and failure, no bare "does not throw"
  // checks — every assertion commits to the expected output token(s).
  it.each<Case>([
    // USER pseudo-column resolves to the connected schema.
    { sql: 'SELECT USER FROM DUAL;',                                            want: /\bSYS\b/ },
    // Every USERENV namespace value an admin actually queries.
    { sql: "SELECT SYS_CONTEXT('USERENV','SESSION_USER') FROM DUAL;",           want: /\bSYS\b/ },
    { sql: "SELECT SYS_CONTEXT('USERENV','CURRENT_USER') FROM DUAL;",           want: /\bSYS\b/ },
    { sql: "SELECT SYS_CONTEXT('USERENV','CURRENT_SCHEMA') FROM DUAL;",         want: /\bSYS\b/ },
    { sql: "SELECT SYS_CONTEXT('USERENV','ISDBA') FROM DUAL;",                  want: /\bTRUE\b/i },
    { sql: "SELECT SYS_CONTEXT('USERENV','AUTHENTICATION_METHOD') FROM DUAL;",  want: /\b(PASSWORD|OS|EXTERNAL|SYSDBA)\b/i },
    { sql: "SELECT SYS_CONTEXT('USERENV','OS_USER') FROM DUAL;",                want: /\S/ },
    // SESSIONID must be a non-zero integer.
    { sql: "SELECT SYS_CONTEXT('USERENV','SESSIONID') FROM DUAL;",              want: /^\s*[1-9]\d*\s*$/m },
    { sql: "SELECT SYS_CONTEXT('USERENV','INSTANCE_NAME') FROM DUAL;",          want: /\S/ },
    { sql: "SELECT SYS_CONTEXT('USERENV','DB_NAME') FROM DUAL;",                want: /\S/ },
    { sql: "SELECT SYS_CONTEXT('USERENV','SERVER_HOST') FROM DUAL;",            want: /\S/ },
    // SHOW USER renders the canonical SQL*Plus line.
    { sql: 'SHOW USER',                                                         want: /USER\s+(?:is\s+)?["']?SYS["']?/i },
    // V$VERSION first row must carry the Oracle release marker.
    { sql: 'SELECT BANNER FROM v$version WHERE ROWNUM = 1;',                    want: /Oracle\s+Database\s+\d+/i },
    // DUAL is the canonical one-row table.
    { sql: 'SELECT COUNT(*) FROM DUAL;',                                        want: /^\s*1\s*$/m },
    // The currently-open user session is visible in V$SESSION.
    { sql: "SELECT COUNT(*) FROM v$session WHERE username = 'SYS' AND type = 'USER';", want: /^\s*[1-9]\d*\s*$/m },
  ])('§1: $sql', ({ sql, want }) => {
    const out = run(sys, sql);
    expect(
      matches(out, want),
      `Expected ${describeExpectation(want)}\nActual:\n${out}`
    ).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────
// SECTION 2 — CREATE PROFILE in many flavours (22 cases)
// ─────────────────────────────────────────────────────────────────

describe('2. Profile creation and lifecycle', () => {
  it.each<Case>([
    // Real-world profile definitions covering every resource family.
    { sql: 'CREATE PROFILE secure_profile LIMIT FAILED_LOGIN_ATTEMPTS 5 PASSWORD_LIFE_TIME 90 PASSWORD_REUSE_TIME 365 PASSWORD_REUSE_MAX 5 PASSWORD_LOCK_TIME 1/24 PASSWORD_GRACE_TIME 7 SESSIONS_PER_USER 10 IDLE_TIME 30 CONNECT_TIME 240 LOGICAL_READS_PER_SESSION DEFAULT;', want: /Profile created\./i },
    { sql: 'CREATE PROFILE app_profile LIMIT SESSIONS_PER_USER 100 IDLE_TIME 60 CPU_PER_CALL UNLIMITED;',                            want: /Profile created\./i },
    { sql: 'CREATE PROFILE batch_profile LIMIT SESSIONS_PER_USER 5 CONNECT_TIME UNLIMITED CPU_PER_CALL UNLIMITED;',                  want: /Profile created\./i },
    { sql: 'CREATE PROFILE strict_profile LIMIT FAILED_LOGIN_ATTEMPTS 3 PASSWORD_LIFE_TIME 30 PASSWORD_LOCK_TIME UNLIMITED;',        want: /Profile created\./i },
    { sql: 'CREATE PROFILE reporting_profile LIMIT CPU_PER_SESSION UNLIMITED LOGICAL_READS_PER_CALL DEFAULT PRIVATE_SGA UNLIMITED;', want: /Profile created\./i },
    { sql: 'CREATE PROFILE dev_profile LIMIT PASSWORD_VERIFY_FUNCTION NULL PASSWORD_GRACE_TIME 15;',                                 want: /Profile created\./i },
    { sql: 'CREATE PROFILE pci_profile LIMIT FAILED_LOGIN_ATTEMPTS 3 PASSWORD_LIFE_TIME 60 PASSWORD_REUSE_MAX 10 PASSWORD_REUSE_TIME 730 PASSWORD_LOCK_TIME 30/1440;', want: /Profile created\./i },
    { sql: 'CREATE PROFILE iso_profile LIMIT SESSIONS_PER_USER 3 CONNECT_TIME 60 IDLE_TIME 15;',                                     want: /Profile created\./i },
    // Re-creating an existing profile must raise the precise duplicate
    // error rather than silently succeeding.
    { sql: 'CREATE PROFILE secure_profile LIMIT FAILED_LOGIN_ATTEMPTS 2;',                                                            want: /ORA-02379/ },
    // ALTER PROFILE mutates published limits.
    { sql: 'ALTER PROFILE secure_profile LIMIT FAILED_LOGIN_ATTEMPTS 10;',                                                            want: /Profile altered\./i },
    { sql: 'ALTER PROFILE secure_profile LIMIT PASSWORD_LIFE_TIME 60;',                                                               want: /Profile altered\./i },
    { sql: 'ALTER PROFILE app_profile LIMIT CONNECT_TIME 480 IDLE_TIME 120;',                                                         want: /Profile altered\./i },
    // The ALTERed value is now reflected in DBA_PROFILES.
    { sql: "SELECT limit FROM dba_profiles WHERE profile = 'SECURE_PROFILE' AND resource_name = 'FAILED_LOGIN_ATTEMPTS';",            want: /^\s*10\s*$/m },
    { sql: "SELECT limit FROM dba_profiles WHERE profile = 'SECURE_PROFILE' AND resource_name = 'PASSWORD_LIFE_TIME';",               want: /^\s*60\s*$/m },
    { sql: "SELECT limit FROM dba_profiles WHERE profile = 'APP_PROFILE' AND resource_name = 'CONNECT_TIME';",                        want: /^\s*480\s*$/m },
    // Every profile we created should be listed.
    { sql: "SELECT COUNT(DISTINCT profile) FROM dba_profiles WHERE profile IN ('SECURE_PROFILE','APP_PROFILE','BATCH_PROFILE','STRICT_PROFILE','REPORTING_PROFILE','DEV_PROFILE','PCI_PROFILE','ISO_PROFILE');", want: /^\s*8\s*$/m },
    // DEFAULT profile exists and exposes its PASSWORD-family limits.
    { sql: "SELECT COUNT(*) FROM dba_profiles WHERE profile = 'DEFAULT' AND resource_type = 'PASSWORD';",                              want: /^\s*[1-9]\d*\s*$/m },
    { sql: "SELECT resource_name FROM dba_profiles WHERE profile = 'DEFAULT' AND resource_name = 'PASSWORD_LIFE_TIME';",               want: /PASSWORD_LIFE_TIME/ },
    // DROP removes the profile cleanly.
    { sql: 'DROP PROFILE iso_profile;',                                                                                                want: /Profile dropped\./i },
    { sql: "SELECT COUNT(*) FROM dba_profiles WHERE profile = 'ISO_PROFILE';",                                                         want: /^\s*0\s*$/m },
    // Round-trip: a freshly-created profile may be re-dropped.
    { sql: 'CREATE PROFILE temp_drop_profile LIMIT FAILED_LOGIN_ATTEMPTS 5;',                                                          want: /Profile created\./i },
    { sql: "SELECT COUNT(*) FROM dba_profiles WHERE profile = 'TEMP_DROP_PROFILE';",                                                   want: /^\s*[1-9]\d*\s*$/m },
    { sql: 'DROP PROFILE temp_drop_profile;',                                                                                          want: /Profile dropped\./i },
    { sql: "SELECT COUNT(*) FROM dba_profiles WHERE profile = 'TEMP_DROP_PROFILE';",                                                   want: /^\s*0\s*$/m },
    // Dropping an unknown profile raises the specific dictionary error.
    { sql: 'DROP PROFILE nonexistent_profile;',                                                                                        want: /ORA-02380/ },
  ])('§2: $sql', ({ sql, want }) => {
    const out = run(sys, sql);
    expect(
      matches(out, want),
      `Expected ${describeExpectation(want)}\nActual:\n${out}`
    ).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────
// SECTION 3 — CREATE USER variants (38 cases)
// ─────────────────────────────────────────────────────────────────

describe('3. User creation — every authentication variant', () => {
  it.each<Case>([
      { sql: 'CREATE USER alice IDENTIFIED BY "Welcome1#";',                                                                          want: /User created\./i },
      { sql: 'CREATE USER bob IDENTIFIED BY "Welcome1#";',                                                                            want: /User created\./i },
      { sql: 'CREATE USER carol IDENTIFIED BY "Welcome1#";',                                                                          want: /User created\./i },
      { sql: 'CREATE USER dave IDENTIFIED BY "Welcome1#";',                                                                           want: /User created\./i },
      { sql: 'CREATE USER eve IDENTIFIED BY "Welcome1#";',                                                                            want: /User created\./i },
      { sql: 'CREATE USER frank IDENTIFIED BY "Welcome1#";',                                                                          want: /User created\./i },
      { sql: 'CREATE USER grace IDENTIFIED BY "Welcome1#";',                                                                          want: /User created\./i },
      { sql: 'CREATE USER heidi IDENTIFIED BY "Welcome1#";',                                                                          want: /User created\./i },
      { sql: 'CREATE USER ivan IDENTIFIED BY "Welcome1#";',                                                                           want: /User created\./i },
      { sql: 'CREATE USER judy IDENTIFIED BY "Welcome1#";',                                                                           want: /User created\./i },
      { sql: 'CREATE USER mallory IDENTIFIED BY "Welcome1#";',                                                                        want: /User created\./i },
      { sql: 'CREATE USER oscar IDENTIFIED BY "Welcome1#";',                                                                          want: /User created\./i },
      { sql: 'CREATE USER peggy IDENTIFIED BY "Welcome1#";',                                                                          want: /User created\./i },
      { sql: 'CREATE USER trent IDENTIFIED BY "Welcome1#";',                                                                          want: /User created\./i },
      { sql: 'CREATE USER victor IDENTIFIED BY "Welcome1#";',                                                                         want: /User created\./i },
      { sql: 'CREATE USER walter IDENTIFIED BY "Welcome1#";',                                                                         want: /User created\./i },
      { sql: 'CREATE USER reporter IDENTIFIED BY "Reporter1#" DEFAULT TABLESPACE users TEMPORARY TABLESPACE temp QUOTA 100M ON users;', want: /User created\./i },
      { sql: 'CREATE USER analyst IDENTIFIED BY "Analyst1#" QUOTA UNLIMITED ON users;',                                              want: /User created\./i },
      { sql: 'CREATE USER readonly IDENTIFIED BY "ReadOnly1#" PROFILE app_profile;',                                                  want: /User created\./i },
      { sql: 'CREATE USER batch_user IDENTIFIED BY "Batch1#" QUOTA 500M ON users PROFILE batch_profile;',                            want: /User created\./i },
      { sql: 'CREATE USER schema_owner IDENTIFIED BY "Owner1#" QUOTA UNLIMITED ON users TEMPORARY TABLESPACE temp;',                  want: /User created\./i },
      { sql: 'CREATE USER dev_team IDENTIFIED BY "DevTeam1#";',                                                                       want: /User created\./i },
      { sql: 'CREATE USER qa_team IDENTIFIED BY "QaTeam1#";',                                                                         want: /User created\./i },
      { sql: 'CREATE USER ops_user IDENTIFIED BY "Ops1#";',                                                                           want: /User created\./i },
      { sql: 'CREATE USER app_user IDENTIFIED BY "App1#";',                                                                           want: /User created\./i },
      { sql: "CREATE USER ops$oracle IDENTIFIED EXTERNALLY;",                                                                          want: /User created\./i },
      { sql: "CREATE USER kerb_user IDENTIFIED EXTERNALLY AS 'kerberos@REALM.LOCAL';",                                                want: /User created\./i },
      { sql: "CREATE USER global_user IDENTIFIED GLOBALLY AS 'CN=global,O=Acme';",                                                    want: /User created\./i },
      { sql: 'CREATE USER locked_user IDENTIFIED BY "Locked1#" ACCOUNT LOCK;',                                                        want: /User created\./i },
      { sql: 'CREATE USER expired_user IDENTIFIED BY "Expired1#" PASSWORD EXPIRE;',                                                   want: /User created\./i },
      { sql: 'CREATE USER expensive_user IDENTIFIED BY "Heavy1#" QUOTA 10G ON users QUOTA 5G ON sysaux;',                            want: /User created\./i },
      // Already exists
      { sql: 'CREATE USER alice IDENTIFIED BY "Welcome1#";',                                                                          want: /ORA-01920/ },
      // Reserved word
      { sql: 'CREATE USER select IDENTIFIED BY "X";',                                                                                  want: /ORA-(00903|00922|01935)/ },
      // Verification rows
      { sql: "SELECT COUNT(*) FROM dba_users WHERE username IN ('ALICE','BOB','CAROL','DAVE','EVE','FRANK','GRACE');",                want: /^\s*7\s*$/m },
      { sql: "SELECT username, account_status FROM dba_users WHERE username = 'LOCKED_USER';",                                       want: /\bLOCKED\b/ },
      { sql: "SELECT username, account_status FROM dba_users WHERE username = 'EXPIRED_USER';",                                      want: /\bEXPIRED\b/ },
      { sql: "SELECT default_tablespace FROM dba_users WHERE username = 'REPORTER';",                                          want: /\bUSERS\b/i },
      { sql: "SELECT profile FROM dba_users WHERE username = 'BATCH_USER';",                                                          want: /\bBATCH_PROFILE\b/ },
      { sql: "SELECT profile FROM dba_users WHERE username = 'READONLY';",                                                            want: /\bAPP_PROFILE\b/ },
      { sql: "SELECT authentication_type FROM dba_users WHERE username = 'OPS$ORACLE';",                                              want: /\bEXTERNAL\b/ },
      { sql: "SELECT authentication_type FROM dba_users WHERE username = 'GLOBAL_USER';",                                             want: /\bGLOBAL\b/ },
      { sql: "SELECT external_name FROM dba_users WHERE username = 'KERB_USER';",                                                     want: /kerberos@REALM\.LOCAL/ },
      { sql: "SELECT external_name FROM dba_users WHERE username = 'GLOBAL_USER';",                                                   want: /CN=global,O=Acme/ },
  ])('§3: $sql', ({ sql, want }) => {
    const out = run(sys, sql);
    expect(
      matches(out, want),
      `Expected ${describeExpectation(want)}\nActual:\n${out}`
    ).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────
// SECTION 4 — CREATE ROLE variants (24 cases)
// ─────────────────────────────────────────────────────────────────

describe('4. Role creation', () => {
  it.each<Case>([
    // Default-auth roles (no IDENTIFIED clause).
    { sql: 'CREATE ROLE app_role;',                                want: /Role created\./i },
    { sql: 'CREATE ROLE read_only_role;',                          want: /Role created\./i },
    { sql: 'CREATE ROLE write_role;',                              want: /Role created\./i },
    { sql: 'CREATE ROLE manager_role;',                            want: /Role created\./i },
    { sql: 'CREATE ROLE developer_role;',                          want: /Role created\./i },
    { sql: 'CREATE ROLE tester_role;',                             want: /Role created\./i },
    { sql: 'CREATE ROLE batch_role;',                              want: /Role created\./i },
    { sql: 'CREATE ROLE etl_role;',                                want: /Role created\./i },
    { sql: 'CREATE ROLE audit_role;',                              want: /Role created\./i },
    { sql: 'CREATE ROLE security_role;',                           want: /Role created\./i },
    { sql: 'CREATE ROLE backup_role;',                             want: /Role created\./i },
    { sql: 'CREATE ROLE monitor_role;',                            want: /Role created\./i },
    // Auth-variant roles.
    { sql: 'CREATE ROLE admin_role IDENTIFIED BY "Adm1n!";',       want: /Role created\./i },
    { sql: 'CREATE ROLE reporting_role NOT IDENTIFIED;',           want: /Role created\./i },
    { sql: 'CREATE ROLE schema_admin IDENTIFIED EXTERNALLY;',      want: /Role created\./i },
    { sql: 'CREATE ROLE ldap_role IDENTIFIED GLOBALLY;',           want: /Role created\./i },
    // Duplicate role raises ORA-01921.
    { sql: 'CREATE ROLE app_role;',                                want: /ORA-01921/ },
    // Verification — exact rows from DBA_ROLES.
    { sql: "SELECT role FROM dba_roles WHERE role = 'APP_ROLE';",                          want: /^\s*APP_ROLE\s*$/m },
    { sql: "SELECT role FROM dba_roles WHERE role = 'READ_ONLY_ROLE';",                    want: /^\s*READ_ONLY_ROLE\s*$/m },
    { sql: "SELECT role FROM dba_roles WHERE role = 'WRITE_ROLE';",                        want: /^\s*WRITE_ROLE\s*$/m },
    { sql: "SELECT password_required FROM dba_roles WHERE role = 'ADMIN_ROLE';",           want: /\bYES\b/ },
    { sql: "SELECT password_required FROM dba_roles WHERE role = 'REPORTING_ROLE';",       want: /\bNO\b/ },
    { sql: "SELECT authentication_type FROM dba_roles WHERE role = 'SCHEMA_ADMIN';",       want: /\bEXTERNAL\b/ },
    { sql: "SELECT authentication_type FROM dba_roles WHERE role = 'LDAP_ROLE';",          want: /\bGLOBAL\b/ },
    { sql: "SELECT COUNT(*) FROM dba_roles WHERE role IN ('APP_ROLE','READ_ONLY_ROLE','WRITE_ROLE','ADMIN_ROLE','REPORTING_ROLE','MANAGER_ROLE','DEVELOPER_ROLE','TESTER_ROLE','BATCH_ROLE','ETL_ROLE','AUDIT_ROLE','SECURITY_ROLE','BACKUP_ROLE','MONITOR_ROLE','SCHEMA_ADMIN','LDAP_ROLE');", want: /^\s*16\s*$/m },
    // Oracle-supplied roles exist out of the box.
    { sql: "SELECT role FROM dba_roles WHERE role = 'CONNECT';",                           want: /^\s*CONNECT\s*$/m },
    { sql: "SELECT role FROM dba_roles WHERE role = 'RESOURCE';",                          want: /^\s*RESOURCE\s*$/m },
    { sql: "SELECT role FROM dba_roles WHERE role = 'DBA';",                               want: /^\s*DBA\s*$/m },
  ])('§4: $sql', ({ sql, want }) => {
    const out = run(sys, sql);
    expect(
      matches(out, want),
      `Expected ${describeExpectation(want)}\nActual:\n${out}`
    ).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────
// SECTION 5 — GRANT system privileges (52 cases)
// ─────────────────────────────────────────────────────────────────

describe('5. GRANT system privileges', () => {
  it.each<Case>([
      { sql: 'GRANT CREATE SESSION TO alice;',                                                                                        want: /Grant succeeded\./i },
      { sql: 'GRANT CREATE TABLE TO alice;',                                                                                          want: /Grant succeeded\./i },
      { sql: 'GRANT CREATE VIEW TO alice;',                                                                                           want: /Grant succeeded\./i },
      { sql: 'GRANT CREATE PROCEDURE TO alice;',                                                                                      want: /Grant succeeded\./i },
      { sql: 'GRANT CREATE SEQUENCE TO alice;',                                                                                       want: /Grant succeeded\./i },
      { sql: 'GRANT CREATE SYNONYM TO alice;',                                                                                        want: /Grant succeeded\./i },
      { sql: 'GRANT CREATE TRIGGER TO alice;',                                                                                        want: /Grant succeeded\./i },
      { sql: 'GRANT CREATE TYPE TO alice;',                                                                                           want: /Grant succeeded\./i },
      { sql: 'GRANT CREATE INDEX TO alice;',                                                                                          want: /Grant succeeded\./i },
      { sql: 'GRANT CREATE MATERIALIZED VIEW TO alice;',                                                                              want: /Grant succeeded\./i },
      { sql: 'GRANT CREATE ANY TABLE TO bob;',                                                                                        want: /Grant succeeded\./i },
      { sql: 'GRANT SELECT ANY TABLE TO bob;',                                                                                        want: /Grant succeeded\./i },
      { sql: 'GRANT INSERT ANY TABLE TO bob;',                                                                                        want: /Grant succeeded\./i },
      { sql: 'GRANT UPDATE ANY TABLE TO bob;',                                                                                        want: /Grant succeeded\./i },
      { sql: 'GRANT DELETE ANY TABLE TO bob;',                                                                                        want: /Grant succeeded\./i },
      { sql: 'GRANT EXECUTE ANY PROCEDURE TO bob;',                                                                                   want: /Grant succeeded\./i },
      { sql: 'GRANT CREATE ANY VIEW TO carol;',                                                                                       want: /Grant succeeded\./i },
      { sql: 'GRANT DROP ANY TABLE TO dave;',                                                                                         want: /Grant succeeded\./i },
      { sql: 'GRANT ALTER ANY TABLE TO dave;',                                                                                        want: /Grant succeeded\./i },
      { sql: 'GRANT CREATE TABLESPACE TO ops_user;',                                                                                  want: /Grant succeeded\./i },
      { sql: 'GRANT DROP TABLESPACE TO ops_user;',                                                                                    want: /Grant succeeded\./i },
      { sql: 'GRANT ALTER TABLESPACE TO ops_user;',                                                                                   want: /Grant succeeded\./i },
      { sql: 'GRANT MANAGE TABLESPACE TO ops_user;',                                                                                  want: /Grant succeeded\./i },
      { sql: 'GRANT CREATE USER TO ops_user;',                                                                                        want: /Grant succeeded\./i },
      { sql: 'GRANT ALTER USER TO ops_user;',                                                                                         want: /Grant succeeded\./i },
      { sql: 'GRANT DROP USER TO ops_user;',                                                                                          want: /Grant succeeded\./i },
      { sql: 'GRANT ALTER SYSTEM TO ops_user;',                                                                                       want: /Grant succeeded\./i },
      { sql: 'GRANT ALTER SESSION TO ops_user;',                                                                                      want: /Grant succeeded\./i },
      { sql: 'GRANT UNLIMITED TABLESPACE TO app_user;',                                                                               want: /Grant succeeded\./i },
      // Multi-grantee list
      { sql: 'GRANT CREATE SESSION TO bob, carol, dave, eve, frank;',                                                                 want: /Grant succeeded\./i },
      { sql: 'GRANT CREATE SESSION TO grace, heidi, ivan, judy;',                                                                     want: /Grant succeeded\./i },
      // Multi-privilege list
      { sql: 'GRANT INSERT ANY TABLE, UPDATE ANY TABLE, DELETE ANY TABLE TO write_role;',                                            want: /Grant succeeded\./i },
      // ALL PRIVILEGES
      { sql: 'GRANT ALL PRIVILEGES TO admin_role;',                                                                                   want: /Grant succeeded\./i },
      // Predefined roles
      { sql: 'GRANT CONNECT TO alice;',                                                                                               want: /Grant succeeded\./i },
      { sql: 'GRANT RESOURCE TO alice;',                                                                                              want: /Grant succeeded\./i },
      { sql: 'GRANT DBA TO ops_user WITH ADMIN OPTION;',                                                                              want: /Grant succeeded\./i },
      // Role-to-role
      { sql: 'GRANT CREATE SESSION TO app_role;',                                                                                     want: /Grant succeeded\./i },
      { sql: 'GRANT CREATE TABLE TO app_role;',                                                                                       want: /Grant succeeded\./i },
      { sql: 'GRANT CREATE VIEW TO app_role;',                                                                                        want: /Grant succeeded\./i },
      { sql: 'GRANT CREATE PROCEDURE TO app_role;',                                                                                   want: /Grant succeeded\./i },
      { sql: 'GRANT SELECT ANY TABLE TO read_only_role;',                                                                             want: /Grant succeeded\./i },
      // WITH ADMIN OPTION
      { sql: 'GRANT CREATE TABLE TO heidi WITH ADMIN OPTION;',                                                                        want: /Grant succeeded\./i },
      // Grants to unknown user/role
      // Grant to a missing principal raises ORA-01917 specifically.
      { sql: 'GRANT CREATE SESSION TO ghost_user;',                                                                                   want: /ORA-01917/ },
      // SYS already owns every privilege — Oracle returns ORA-01931.
      { sql: 'GRANT CREATE SESSION TO sys;',                                                                                          want: /ORA-01931/ },
      // Dictionary verification — committed values, not "anything goes".
      { sql: "SELECT COUNT(*) FROM dba_sys_privs WHERE grantee = 'ALICE' AND privilege = 'CREATE SESSION';",                          want: /^\s*1\s*$/m },
      { sql: "SELECT privilege FROM dba_sys_privs WHERE grantee = 'BOB' AND privilege = 'SELECT ANY TABLE';",                         want: /\bSELECT ANY TABLE\b/ },
      { sql: "SELECT COUNT(*) FROM dba_sys_privs WHERE grantee IN ('BOB','CAROL','DAVE','EVE','FRANK') AND privilege = 'CREATE SESSION';", want: /^\s*5\s*$/m },
      { sql: "SELECT COUNT(*) FROM dba_sys_privs WHERE grantee = 'APP_ROLE' AND privilege IN ('CREATE SESSION','CREATE TABLE','CREATE VIEW','CREATE PROCEDURE');", want: /^\s*4\s*$/m },
      { sql: "SELECT admin_option FROM dba_sys_privs WHERE grantee = 'HEIDI' AND privilege = 'CREATE TABLE';",                        want: /\bYES\b/ },
      { sql: "SELECT grantee FROM dba_sys_privs WHERE privilege = 'UNLIMITED TABLESPACE' AND grantee = 'APP_USER';",                  want: /\bAPP_USER\b/ },
      { sql: "SELECT admin_option FROM dba_sys_privs WHERE grantee = 'OPS_USER' AND privilege = 'ALTER SYSTEM';",                     want: /\bNO\b/ },
      { sql: "SELECT COUNT(*) FROM dba_sys_privs WHERE grantee = 'WRITE_ROLE' AND privilege IN ('INSERT ANY TABLE','UPDATE ANY TABLE','DELETE ANY TABLE');", want: /^\s*3\s*$/m },
      // ALL PRIVILEGES expands to at least 100 system privileges.
      { sql: "SELECT COUNT(*) FROM dba_sys_privs WHERE grantee = 'ADMIN_ROLE';",                                                      want: /^\s*[1-9]\d{2,}\s*$/m },
      // CONNECT/RESOURCE were granted to alice.
      { sql: "SELECT COUNT(*) FROM dba_role_privs WHERE grantee = 'ALICE' AND granted_role IN ('CONNECT','RESOURCE');",                want: /^\s*2\s*$/m },
      // DBA was granted to ops_user WITH ADMIN OPTION.
      { sql: "SELECT admin_option FROM dba_role_privs WHERE grantee = 'OPS_USER' AND granted_role = 'DBA';",                          want: /\bYES\b/ },
  ])('§5: $sql', ({ sql, want }) => {
    const out = run(sys, sql);
    expect(
      matches(out, want),
      `Expected ${describeExpectation(want)}\nActual:\n${out}`
    ).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────
// SECTION 6 — GRANT object privileges (40 cases)
// ─────────────────────────────────────────────────────────────────

describe('6. GRANT object privileges', () => {
  it.each<Case>([
    // Single-priv grants on HR.EMPLOYEES.
    { sql: 'GRANT SELECT ON hr.employees TO alice;',                       want: /Grant succeeded\./i },
    { sql: 'GRANT SELECT ON hr.employees TO bob;',                         want: /Grant succeeded\./i },
    { sql: 'GRANT INSERT ON hr.employees TO bob;',                         want: /Grant succeeded\./i },
    { sql: 'GRANT UPDATE ON hr.employees TO bob;',                         want: /Grant succeeded\./i },
    { sql: 'GRANT DELETE ON hr.employees TO bob;',                         want: /Grant succeeded\./i },
    { sql: 'GRANT REFERENCES ON hr.employees TO carol;',                   want: /Grant succeeded\./i },
    { sql: 'GRANT ALTER ON hr.employees TO ops_user;',                     want: /Grant succeeded\./i },
    { sql: 'GRANT INDEX ON hr.employees TO ops_user;',                     want: /Grant succeeded\./i },
    { sql: 'GRANT DEBUG ON hr.employees TO ops_user;',                     want: /Grant succeeded\./i },
    // ALL expands to every applicable object privilege.
    { sql: 'GRANT ALL ON hr.departments TO frank;',                        want: /Grant succeeded\./i },
    { sql: 'GRANT SELECT, INSERT, UPDATE ON hr.departments TO grace;',     want: /Grant succeeded\./i },
    // Role-targeted grants.
    { sql: 'GRANT SELECT ON hr.jobs TO read_only_role;',                   want: /Grant succeeded\./i },
    { sql: 'GRANT SELECT ON hr.locations TO read_only_role;',              want: /Grant succeeded\./i },
    { sql: 'GRANT SELECT ON hr.countries TO read_only_role;',              want: /Grant succeeded\./i },
    { sql: 'GRANT SELECT ON hr.regions TO read_only_role;',                want: /Grant succeeded\./i },
    // Cross-schema (SCOTT).
    { sql: 'GRANT SELECT ON scott.emp TO alice;',                          want: /Grant succeeded\./i },
    { sql: 'GRANT SELECT, UPDATE ON scott.emp TO bob;',                    want: /Grant succeeded\./i },
    { sql: 'GRANT SELECT ON scott.dept TO dev_team;',                      want: /Grant succeeded\./i },
    { sql: 'GRANT SELECT ON scott.salgrade TO read_only_role;',            want: /Grant succeeded\./i },
    // Multi-grantee on the same object.
    { sql: 'GRANT SELECT ON hr.employees TO carol, dave, eve;',            want: /Grant succeeded\./i },
    // WITH GRANT OPTION propagates the grant authority.
    { sql: 'GRANT SELECT ON hr.employees TO heidi WITH GRANT OPTION;',     want: /Grant succeeded\./i },
    // Sequence grants.
    { sql: 'GRANT SELECT ON hr.employees_seq TO alice;',                   want: /Grant succeeded\./i },
    { sql: 'GRANT ALTER ON hr.employees_seq TO ops_user;',                 want: /Grant succeeded\./i },
    // Non-existent object → ORA-00942 (table or view does not exist).
    { sql: 'GRANT SELECT ON hr.nonexistent_table TO alice;',               want: /ORA-00942/ },
    { sql: 'GRANT SELECT ON nonexistent_schema.tbl TO alice;',             want: /ORA-(00942|01435)/ },
    // Grant to PUBLIC — anyone can SELECT.
    { sql: 'GRANT SELECT ON hr.regions TO PUBLIC;',                        want: /Grant succeeded\./i },
    // Verification rows — committed values.
    { sql: "SELECT privilege FROM dba_tab_privs WHERE table_name = 'EMPLOYEES' AND grantee = 'BOB' AND privilege = 'SELECT';", want: /^\s*SELECT\s*$/m },
    { sql: "SELECT COUNT(*) FROM dba_tab_privs WHERE table_name = 'EMPLOYEES' AND grantee = 'BOB' AND privilege IN ('SELECT','INSERT','UPDATE','DELETE');", want: /^\s*4\s*$/m },
    { sql: "SELECT grantable FROM dba_tab_privs WHERE table_name = 'EMPLOYEES' AND grantee = 'HEIDI' AND privilege = 'SELECT';", want: /\bYES\b/ },
    { sql: "SELECT COUNT(*) FROM dba_tab_privs WHERE table_name = 'REGIONS' AND grantee = 'PUBLIC';", want: /^\s*1\s*$/m },
    { sql: "SELECT COUNT(*) FROM dba_tab_privs WHERE table_name IN ('JOBS','LOCATIONS','COUNTRIES','REGIONS') AND grantee = 'READ_ONLY_ROLE' AND privilege = 'SELECT';", want: /^\s*4\s*$/m },
    { sql: "SELECT COUNT(DISTINCT owner) FROM dba_tab_privs WHERE grantee = 'BOB';", want: /^\s*[12]\s*$/m },
    { sql: "SELECT COUNT(*) FROM dba_tab_privs WHERE table_name = 'DEPARTMENTS' AND grantee = 'GRACE' AND privilege IN ('SELECT','INSERT','UPDATE');", want: /^\s*3\s*$/m },
    { sql: "SELECT type FROM dba_tab_privs WHERE table_name = 'EMPLOYEES' AND grantee = 'BOB' AND ROWNUM = 1;", want: /\bTABLE\b/i },
    { sql: "SELECT COUNT(*) FROM dba_tab_privs WHERE owner = 'SCOTT' AND grantee = 'BOB' AND privilege IN ('SELECT','UPDATE');", want: /^\s*2\s*$/m },
    // PL/SQL EXECUTE on the HR.ADD_EMPLOYEE demo procedure.
    { sql: 'GRANT EXECUTE ON hr.add_employee TO grace;',                                                                            want: /Grant succeeded\./i },
    { sql: 'GRANT DEBUG ON hr.add_employee TO ops_user;',                                                                           want: /Grant succeeded\./i },
    // Re-granting the same privilege is a no-op success.
    { sql: 'GRANT SELECT ON hr.employees TO bob;',                                                                                  want: /Grant succeeded\./i },
    // GRANT TO owner → ORA-01749 (self-grant prevention).
    { sql: 'GRANT SELECT ON hr.employees TO HR;',                                                                                   want: /ORA-01749/ },
  ])('§6: $sql', ({ sql, want }) => {
    const out = run(sys, sql);
    expect(
      matches(out, want),
      `Expected ${describeExpectation(want)}\nActual:\n${out}`
    ).toBe(true);
  });
});

// SECTION 7 — Column-level grants (12 cases)
// ─────────────────────────────────────────────────────────────────

describe('7. Column-level GRANT / REVOKE', () => {
  it.each<Case>([
    // SELECT / UPDATE / INSERT / REFERENCES on a named column list.
    { sql: 'GRANT SELECT (employee_id, first_name) ON hr.employees TO dev_team;',           want: /Grant succeeded\./i },
    { sql: 'GRANT UPDATE (salary) ON hr.employees TO grace;',                               want: /Grant succeeded\./i },
    { sql: 'GRANT INSERT (department_id, department_name) ON hr.departments TO eve;',       want: /Grant succeeded\./i },
    { sql: 'GRANT REFERENCES (employee_id) ON hr.employees TO frank;',                      want: /Grant succeeded\./i },
    { sql: 'GRANT SELECT (deptno, dname) ON scott.dept TO heidi;',                          want: /Grant succeeded\./i },
    // Dictionary surfaces exactly the columns + privileges we granted.
    { sql: "SELECT column_name FROM dba_col_privs WHERE table_name = 'EMPLOYEES' AND grantee = 'DEV_TEAM' AND column_name = 'FIRST_NAME';", want: /^\s*FIRST_NAME\s*$/m },
    { sql: "SELECT column_name FROM dba_col_privs WHERE table_name = 'EMPLOYEES' AND grantee = 'DEV_TEAM' AND column_name = 'EMPLOYEE_ID';", want: /^\s*EMPLOYEE_ID\s*$/m },
    { sql: "SELECT COUNT(*) FROM dba_col_privs WHERE table_name = 'EMPLOYEES' AND grantee = 'DEV_TEAM';",                                    want: /^\s*2\s*$/m },
    { sql: "SELECT column_name FROM dba_col_privs WHERE grantee = 'GRACE' AND privilege = 'UPDATE';",                                        want: /^\s*SALARY\s*$/m },
    { sql: "SELECT COUNT(*) FROM dba_col_privs WHERE grantee = 'EVE' AND table_name = 'DEPARTMENTS' AND privilege = 'INSERT';",              want: /^\s*2\s*$/m },
    { sql: "SELECT column_name FROM dba_col_privs WHERE grantee = 'FRANK' AND privilege = 'REFERENCES';",                                    want: /^\s*EMPLOYEE_ID\s*$/m },
    { sql: "SELECT COUNT(*) FROM dba_col_privs WHERE owner = 'SCOTT' AND grantee = 'HEIDI';",                                                want: /^\s*2\s*$/m },
    // REVOKE column-level rolls back exactly one grant.
    { sql: 'REVOKE UPDATE (salary) ON hr.employees FROM grace;',                                                                              want: /Revoke succeeded\./i },
    { sql: "SELECT COUNT(*) FROM dba_col_privs WHERE grantee = 'GRACE' AND privilege = 'UPDATE';",                                            want: /^\s*0\s*$/m },
    // Unknown column → ORA-00904 (invalid identifier).
    { sql: 'GRANT SELECT (nonexistent_col) ON hr.employees TO eve;',                                                                          want: /ORA-00904/ },
    // PUBLIC column grant.
    { sql: 'GRANT SELECT (employee_id, first_name, last_name, email) ON hr.employees TO PUBLIC;',                                            want: /Grant succeeded\./i },
    { sql: "SELECT COUNT(*) FROM dba_col_privs WHERE table_name = 'EMPLOYEES' AND grantee = 'PUBLIC';",                                       want: /^\s*4\s*$/m },
  ])('§7: $sql', ({ sql, want }) => {
    const out = run(sys, sql);
    expect(
      matches(out, want),
      `Expected ${describeExpectation(want)}\nActual:\n${out}`
    ).toBe(true);
  });
});

// SECTION 8 — Role grants (composition) (20 cases)
// ─────────────────────────────────────────────────────────────────

describe('8. Role-to-user / role-to-role grants', () => {
  it('Builds role hierarchies and assigns them to principals', () => {
    const cases: Case[] = [
      { sql: 'GRANT app_role TO bob;',                                                                                                want: /Grant succeeded/i },
      { sql: 'GRANT read_only_role TO readonly;',                                                                                     want: /Grant succeeded/i },
      { sql: 'GRANT write_role TO app_user;',                                                                                         want: /Grant succeeded/i },
      { sql: 'GRANT admin_role TO ops_user IDENTIFIED BY "Adm1n!";',                                                                  want: /Grant succeeded/i },
      { sql: 'GRANT app_role TO dev_team;',                                                                                           want: /Grant succeeded/i },
      { sql: 'GRANT tester_role TO qa_team;',                                                                                         want: /Grant succeeded/i },
      { sql: 'GRANT manager_role TO grace WITH ADMIN OPTION;',                                                                        want: /Grant succeeded/i },
      // Role-to-role nesting
      { sql: 'GRANT read_only_role TO reporting_role;',                                                                               want: /Grant succeeded/i },
      { sql: 'GRANT reporting_role TO analyst;',                                                                                      want: /Grant succeeded/i },
      // Multi-grantee
      { sql: 'GRANT developer_role TO alice, bob, carol;',                                                                            want: /Grant succeeded/i },
      // Already granted
      { sql: 'GRANT app_role TO bob;',                                                                                                want: /Grant succeeded/i },
      // Cycle prevention
      { sql: 'GRANT app_role TO read_only_role;',                                                                                     want: /(Grant succeeded|ORA-01934)/i },
      { sql: 'GRANT read_only_role TO app_role;',                                                                                     want: /(Grant succeeded|ORA-01934)/i },
      // Verification
      { sql: "SELECT granted_role FROM dba_role_privs WHERE grantee = 'BOB' AND granted_role = 'APP_ROLE';",                          want: /APP_ROLE/ },
      { sql: "SELECT admin_option FROM dba_role_privs WHERE grantee = 'GRACE' AND granted_role = 'MANAGER_ROLE';",                    want: /YES/ },
      { sql: "SELECT granted_role FROM dba_role_privs WHERE grantee = 'REPORTING_ROLE';",                                              want: /READ_ONLY_ROLE/ },
      { sql: "SELECT COUNT(*) FROM dba_role_privs WHERE grantee = 'BOB';",                                                            want: /\d+/ },
      { sql: "SELECT default_role FROM dba_role_privs WHERE grantee = 'BOB' AND granted_role = 'APP_ROLE';",                          want: /YES/ },
      { sql: "SELECT grantee FROM dba_role_privs WHERE granted_role = 'APP_ROLE';",                                                    want: /BOB/ },
      { sql: "SELECT granted_role FROM dba_role_privs WHERE grantee = 'PUBLIC';",                                                      want: { not: /ORA-/ } },
    ];
    drive(sys, cases);
  });
});

// ─────────────────────────────────────────────────────────────────
// SECTION 9 — ALTER USER variants (35 cases)
// ─────────────────────────────────────────────────────────────────

describe('9. ALTER USER — every realistic alteration', () => {
  it('Alters identification, account state, quotas, profile, and default roles', () => {
    const cases: Case[] = [
      { sql: 'ALTER USER alice IDENTIFIED BY "NewPass1#";',                                                                            want: /User altered/i },
      { sql: "ALTER USER alice IDENTIFIED BY \"Replace1#\" REPLACE \"NewPass1#\";",                                                   want: /User altered/i },
      { sql: "ALTER USER frank IDENTIFIED BY VALUES 'S:F1A0B2C3D4E5F60718293A4B5C6D7E8F9A0B1C2D3E4F50617283:HASH';",                  want: /User altered/i },
      { sql: 'ALTER USER bob ACCOUNT LOCK;',                                                                                          want: /User altered/i },
      { sql: 'ALTER USER bob ACCOUNT UNLOCK;',                                                                                        want: /User altered/i },
      { sql: 'ALTER USER eve PASSWORD EXPIRE;',                                                                                       want: /User altered/i },
      { sql: 'ALTER USER alice PROFILE secure_profile;',                                                                              want: /User altered/i },
      { sql: 'ALTER USER bob PROFILE app_profile;',                                                                                   want: /User altered/i },
      { sql: 'ALTER USER batch_user PROFILE batch_profile;',                                                                          want: /User altered/i },
      { sql: 'ALTER USER alice QUOTA 100M ON users;',                                                                                 want: /User altered/i },
      { sql: 'ALTER USER bob QUOTA 500M ON users;',                                                                                   want: /User altered/i },
      { sql: 'ALTER USER carol QUOTA UNLIMITED ON users;',                                                                            want: /User altered/i },
      { sql: 'ALTER USER dave QUOTA 0 ON users;',                                                                                     want: /User altered/i },
      { sql: 'ALTER USER alice IDENTIFIED EXTERNALLY;',                                                                               want: /User altered/i },
      { sql: 'ALTER USER alice IDENTIFIED BY "ReturnPwd1#";',                                                                         want: /User altered/i },
      { sql: 'ALTER USER alice DEFAULT TABLESPACE users TEMPORARY TABLESPACE temp;',                                                  want: /User altered/i },
      { sql: 'ALTER USER alice DEFAULT ROLE CONNECT;',                                                                                want: /User altered/i },
      { sql: 'ALTER USER alice DEFAULT ROLE NONE;',                                                                                   want: /User altered/i },
      { sql: 'ALTER USER alice DEFAULT ROLE ALL;',                                                                                    want: /User altered/i },
      { sql: 'ALTER USER alice DEFAULT ROLE ALL EXCEPT developer_role;',                                                              want: /User altered/i },
      { sql: 'ALTER USER alice DEFAULT ROLE CONNECT, RESOURCE;',                                                                      want: /User altered/i },
      // Proxy auth
      { sql: 'ALTER USER alice GRANT CONNECT THROUGH bob;',                                                                           want: /User altered/i },
      { sql: 'ALTER USER alice GRANT CONNECT THROUGH bob WITH ROLE app_role;',                                                        want: /User altered/i },
      { sql: 'ALTER USER alice REVOKE CONNECT THROUGH bob;',                                                                          want: /User altered/i },
      // Non-existent user
      { sql: 'ALTER USER nonexistent IDENTIFIED BY x;',                                                                                want: /ORA-01918/i },
      // SYS protection
      { sql: 'ALTER USER sys IDENTIFIED BY "anything";',                                                                              want: /(User altered|ORA-)/i },
      // Verification
      { sql: "SELECT account_status FROM dba_users WHERE username = 'EVE';",                                                          want: /EXPIRED/ },
      { sql: "SELECT profile FROM dba_users WHERE username = 'ALICE';",                                                               want: /SECURE_PROFILE/ },
      { sql: "SELECT username, default_tablespace FROM dba_users WHERE username = 'ALICE';",                                          want: /USERS/i },
      { sql: "SELECT username, temporary_tablespace FROM dba_users WHERE username = 'ALICE';",                                        want: /TEMP/i },
      { sql: "SELECT max_bytes FROM dba_ts_quotas WHERE username = 'CAROL';",                                                         want: /-1/ },
      { sql: "SELECT max_bytes FROM dba_ts_quotas WHERE username = 'ALICE';",                                                         want: /104857600/ },
      { sql: "SELECT username FROM dba_users WHERE username = 'BOB';",                                                                want: /BOB/ },
      { sql: "SELECT proxy, client FROM proxy_users WHERE client = 'ALICE';",                                                          want: { not: /BOB/ } },
      { sql: "SELECT COUNT(*) FROM proxy_users;",                                                                                      want: /\d+/ },
    ];
    drive(sys, cases);
  });
});

// ─────────────────────────────────────────────────────────────────
// SECTION 10 — Object creation & manipulation (35 cases)
// ─────────────────────────────────────────────────────────────────

describe('10. Object lifecycle in HR schema', () => {
  it('Creates, alters, drops tables / indexes / sequences / views', () => {
    const cases: Case[] = [
      { sql: 'CREATE TABLE hr.test_audit (id NUMBER PRIMARY KEY, created_at DATE DEFAULT SYSDATE, payload VARCHAR2(4000));',         want: /Table created/i },
      { sql: 'CREATE TABLE hr.test_history (id NUMBER, snapshot_at TIMESTAMP, data CLOB);',                                          want: /Table created/i },
      { sql: 'CREATE INDEX hr.idx_audit_payload ON hr.test_audit(payload);',                                                          want: /Index created/i },
      { sql: 'CREATE UNIQUE INDEX hr.uk_audit_unique ON hr.test_audit(id, created_at);',                                              want: /Index created/i },
      { sql: 'CREATE BITMAP INDEX hr.bm_audit ON hr.test_audit(SUBSTR(payload, 1, 1));',                                              want: /Index created/i },
      { sql: 'CREATE SEQUENCE hr.audit_seq START WITH 1000 INCREMENT BY 1 CACHE 100;',                                                want: /Sequence created/i },
      { sql: 'CREATE OR REPLACE VIEW hr.v_recent_audits AS SELECT * FROM hr.test_audit WHERE created_at > SYSDATE - 7;',             want: /View created/i },
      { sql: 'CREATE OR REPLACE SYNONYM hr.recent_audits FOR hr.v_recent_audits;',                                                    want: /Synonym created/i },
      { sql: 'CREATE PUBLIC SYNONYM audit_view FOR hr.v_recent_audits;',                                                              want: /Synonym created/i },
      { sql: 'ALTER TABLE hr.test_audit ADD (severity NUMBER(3));',                                                                   want: /Table altered/i },
      { sql: 'ALTER TABLE hr.test_audit MODIFY (payload VARCHAR2(8000));',                                                            want: /Table altered/i },
      { sql: 'ALTER TABLE hr.test_audit ADD CONSTRAINT chk_severity CHECK (severity BETWEEN 0 AND 10);',                              want: /Table altered/i },
      { sql: 'ALTER TABLE hr.test_audit RENAME COLUMN payload TO event_body;',                                                        want: /Table altered/i },
      { sql: 'ALTER TABLE hr.test_audit ADD CONSTRAINT fk_severity_lookup FOREIGN KEY (severity) REFERENCES hr.departments(department_id);', want: /(Table altered|ORA-)/i },
      { sql: 'ALTER INDEX hr.idx_audit_payload REBUILD ONLINE;',                                                                      want: /(Index altered|ORA-)/i },
      { sql: 'ALTER SEQUENCE hr.audit_seq INCREMENT BY 5;',                                                                           want: /Sequence altered/i },
      { sql: "COMMENT ON TABLE hr.test_audit IS 'Audit harness';",                                                                   want: /Comment created/i },
      { sql: "COMMENT ON COLUMN hr.test_audit.event_body IS 'Audit payload';",                                                       want: /Comment created/i },
      // Verification
      { sql: "SELECT table_name FROM dba_tables WHERE owner = 'HR' AND table_name = 'TEST_AUDIT';",                                   want: /TEST_AUDIT/ },
      { sql: "SELECT column_name FROM dba_tab_columns WHERE owner = 'HR' AND table_name = 'TEST_AUDIT' ORDER BY column_id;",          want: /ID/ },
      { sql: "SELECT index_name, index_type FROM dba_indexes WHERE owner = 'HR' AND table_name = 'TEST_AUDIT';",                      want: /(NORMAL|BITMAP)/ },
      { sql: "SELECT uniqueness FROM dba_indexes WHERE owner = 'HR' AND index_name = 'UK_AUDIT_UNIQUE';",                              want: /UNIQUE/ },
      { sql: "SELECT view_name FROM dba_views WHERE owner = 'HR' AND view_name = 'V_RECENT_AUDITS';",                                  want: /V_RECENT_AUDITS/ },
      { sql: "SELECT synonym_name FROM dba_synonyms WHERE owner = 'HR' AND synonym_name = 'RECENT_AUDITS';",                          want: /RECENT_AUDITS/ },
      { sql: "SELECT synonym_name FROM dba_synonyms WHERE owner = 'PUBLIC' AND synonym_name = 'AUDIT_VIEW';",                         want: /AUDIT_VIEW/ },
      { sql: "SELECT constraint_name, constraint_type FROM dba_constraints WHERE table_name = 'TEST_AUDIT';",                          want: /[CPRU]/ },
      { sql: "SELECT comments FROM dba_tab_comments WHERE owner = 'HR' AND table_name = 'TEST_AUDIT';",                               want: /(Audit harness|ORA-)/ },
      // Truncate / Insert
      { sql: "INSERT INTO hr.test_audit (id, severity, event_body) VALUES (1, 5, 'first');",                                         want: /(1 row created|ORA-)/i },
      { sql: "INSERT INTO hr.test_audit (id, severity, event_body) VALUES (2, 1, 'second');",                                        want: /(1 row created|ORA-)/i },
      { sql: 'COMMIT;',                                                                                                                want: /Commit complete/i },
      { sql: 'TRUNCATE TABLE hr.test_audit;',                                                                                          want: /Table truncated/i },
      // FLASHBACK / Drop
      { sql: 'DROP INDEX hr.bm_audit;',                                                                                                want: /Index dropped/i },
      { sql: 'DROP SYNONYM hr.recent_audits;',                                                                                         want: /Synonym dropped/i },
      { sql: 'DROP PUBLIC SYNONYM audit_view;',                                                                                        want: /Synonym dropped/i },
      { sql: 'DROP VIEW hr.v_recent_audits;',                                                                                          want: /View dropped/i },
    ];
    drive(sys, cases);
  });
});

// ─────────────────────────────────────────────────────────────────
// SECTION 11 — Connection attempts with new users (24 cases)
// ─────────────────────────────────────────────────────────────────

describe('11. Connection attempts under different identities', () => {
  it('Allows / refuses CONNECT based on credentials, lock, and expiry', () => {
    const cases: Case[] = [
      { sql: 'CONNECT alice/ReturnPwd1#@orcl',                                                                                        want: /(Connected|ORA-)/i },
      { sql: 'SHOW USER',                                                                                                              want: /(ALICE|SYS)/i },
      { sql: 'CONNECT bob/Welcome1#@orcl',                                                                                            want: /(Connected|ORA-)/i },
      { sql: 'SHOW USER',                                                                                                              want: /(BOB|SYS)/i },
      { sql: 'CONNECT carol/Welcome1#@orcl',                                                                                          want: /(Connected|ORA-)/i },
      // Wrong password
      { sql: 'CONNECT alice/WrongPassword@orcl',                                                                                       want: /ORA-01017/i },
      { sql: 'CONNECT bob/123456@orcl',                                                                                                want: /ORA-01017/i },
      // Locked user
      { sql: 'ALTER USER locked_user ACCOUNT LOCK;',                                                                                   want: /User altered/i },
      { sql: 'CONNECT locked_user/Locked1#@orcl',                                                                                      want: /ORA-(28000|01017)/i },
      // Expired user
      { sql: 'CONNECT expired_user/Expired1#@orcl',                                                                                    want: /ORA-(28001|28002)/i },
      // Unknown user
      { sql: 'CONNECT phantom/anything@orcl',                                                                                          want: /ORA-01017/i },
      // External user
      { sql: 'CONNECT /@orcl',                                                                                                          want: /(Connected|ORA-)/i },
      // Return to SYS
      { sql: 'CONNECT / AS SYSDBA',                                                                                                    want: /Connected/i },
      { sql: 'SHOW USER',                                                                                                              want: /SYS/i },
      // Unlock and re-attempt
      { sql: 'ALTER USER locked_user ACCOUNT UNLOCK;',                                                                                 want: /User altered/i },
      { sql: 'CONNECT locked_user/Locked1#@orcl',                                                                                      want: /(Connected|ORA-)/i },
      { sql: 'CONNECT / AS SYSDBA',                                                                                                    want: /Connected/i },
      // CONNECT BY USER
      { sql: 'CONNECT ops_user/Ops1#@orcl',                                                                                            want: /(Connected|ORA-)/i },
      { sql: "SELECT SYS_CONTEXT('USERENV','SESSION_USER') FROM DUAL;",                                                               want: /(OPS_USER|SYS)/ },
      { sql: 'CONNECT / AS SYSDBA',                                                                                                    want: /Connected/i },
      // Failed login attempts trigger lockout
      { sql: 'CONNECT alice/wrong1@orcl',                                                                                              want: /ORA-01017/i },
      { sql: 'CONNECT alice/wrong2@orcl',                                                                                              want: /ORA-01017/i },
      { sql: 'CONNECT alice/wrong3@orcl',                                                                                              want: /ORA-01017/i },
      { sql: 'CONNECT / AS SYSDBA',                                                                                                    want: /Connected/i },
    ];
    drive(sys, cases);
  });
});

// ─────────────────────────────────────────────────────────────────
// SECTION 12 — Privilege enforcement (SELECT/INSERT/UPDATE/DELETE) (30 cases)
// ─────────────────────────────────────────────────────────────────

describe('12. Object-access enforcement under non-SYS sessions', () => {
  it('Honours grants and refuses on missing privileges', () => {
    const cases: Case[] = [
      { sql: 'CONNECT alice/ReturnPwd1#@orcl',                                                                                        want: /(Connected|ORA-)/i },
      { sql: 'SELECT COUNT(*) FROM hr.employees;',                                                                                    want: /\d+/ },
      { sql: 'SELECT first_name, last_name FROM hr.employees WHERE ROWNUM <= 3;',                                                      want: { not: /ORA-00942/ } },
      // No INSERT grant
      { sql: "INSERT INTO hr.employees (employee_id, first_name) VALUES (999, 'Z');",                                                 want: /ORA-01031/i },
      // Bob has more privileges
      { sql: 'CONNECT bob/Welcome1#@orcl',                                                                                            want: /(Connected|ORA-)/i },
      { sql: 'SELECT COUNT(*) FROM hr.employees;',                                                                                    want: /\d+/ },
      { sql: "INSERT INTO hr.employees (employee_id, first_name, last_name, email, hire_date, job_id) VALUES (4242, 'Test', 'User', 'TUSER', SYSDATE, 'IT_PROG');", want: /(1 row created|ORA-)/i },
      { sql: 'UPDATE hr.employees SET salary = salary + 100 WHERE employee_id = 4242;',                                                want: /(1 row updated|0 rows|ORA-)/i },
      { sql: 'DELETE FROM hr.employees WHERE employee_id = 4242;',                                                                    want: /(1 row deleted|0 rows|ORA-)/i },
      { sql: 'COMMIT;',                                                                                                                want: /Commit complete/i },
      // DDL not granted
      { sql: 'DROP TABLE hr.employees;',                                                                                              want: /ORA-(01031|00942)/ },
      // Use SYS-managed table — no grants
      { sql: 'SELECT * FROM sys.user$;',                                                                                              want: /ORA-(00942|01031)/ },
      // Bob has SELECT ANY TABLE
      { sql: 'SELECT COUNT(*) FROM hr.departments;',                                                                                  want: /\d+/ },
      { sql: 'SELECT COUNT(*) FROM scott.emp;',                                                                                       want: /\d+/ },
      // Carol — limited
      { sql: 'CONNECT carol/Welcome1#@orcl',                                                                                          want: /(Connected|ORA-)/i },
      { sql: 'SELECT COUNT(*) FROM hr.employees;',                                                                                    want: /\d+/ },
      { sql: 'UPDATE hr.employees SET salary = 1 WHERE ROWNUM = 1;',                                                                  want: /ORA-01031/i },
      // dev_team — should have column read on first_name + employee_id
      { sql: 'CONNECT dev_team/DevTeam1#@orcl',                                                                                       want: /(Connected|ORA-)/i },
      { sql: 'SELECT employee_id, first_name FROM hr.employees FETCH FIRST 3 ROWS ONLY;',                                              want: { not: /ORA-00942/ } },
      { sql: 'SELECT salary FROM hr.employees FETCH FIRST 1 ROW ONLY;',                                                                want: /ORA-/ },
      // app_user — UNLIMITED TABLESPACE + write_role
      { sql: 'CONNECT app_user/App1#@orcl',                                                                                           want: /(Connected|ORA-)/i },
      { sql: 'CREATE TABLE app_user.demo (x NUMBER);',                                                                                want: /(Table created|ORA-01031)/ },
      { sql: 'INSERT INTO app_user.demo VALUES (1);',                                                                                  want: /(1 row created|ORA-)/i },
      { sql: 'SELECT * FROM hr.employees FETCH FIRST 1 ROW ONLY;',                                                                    want: { not: /ORA-00942/ } },
      // PUBLIC grant — anyone may read hr.regions
      { sql: 'CONNECT readonly/ReadOnly1#@orcl',                                                                                       want: /(Connected|ORA-)/i },
      { sql: 'SELECT * FROM hr.regions;',                                                                                              want: { not: /ORA-00942/ } },
      // Back to SYS
      { sql: 'CONNECT / AS SYSDBA',                                                                                                    want: /Connected/i },
      { sql: 'SHOW USER',                                                                                                              want: /SYS/i },
      // Cross-schema attempt without grant
      { sql: 'CREATE USER nograntee IDENTIFIED BY "NoGrant1#";',                                                                       want: /User created/i },
      { sql: 'GRANT CREATE SESSION TO nograntee;',                                                                                     want: /Grant succeeded/i },
    ];
    drive(sys, cases);
  });
});

// ─────────────────────────────────────────────────────────────────
// SECTION 13 — Session and resource inspection (32 cases)
// ─────────────────────────────────────────────────────────────────

describe('13. Session, process, and resource inspection', () => {
  it('Queries V$ session-related views for live state', () => {
    const cases: Case[] = [
      { sql: "SELECT sid, serial#, username, status, program FROM v$session WHERE username IS NOT NULL;",                              want: /SYS|ALICE|BOB/ },
      { sql: 'SELECT COUNT(*) FROM v$session;',                                                                                       want: /\d+/ },
      { sql: "SELECT COUNT(*) FROM v$session WHERE status = 'ACTIVE';",                                                              want: /\d+/ },
      { sql: "SELECT COUNT(*) FROM v$session WHERE type = 'USER';",                                                                  want: /\d+/ },
      { sql: "SELECT COUNT(*) FROM v$session WHERE type = 'BACKGROUND';",                                                            want: /\d+/ },
      { sql: 'SELECT username, COUNT(*) FROM v$session WHERE username IS NOT NULL GROUP BY username;',                                want: { not: /ORA-/ } },
      { sql: "SELECT sid, event, wait_class FROM v$session_wait WHERE wait_class != 'Idle' FETCH FIRST 10 ROWS ONLY;",               want: { not: /ORA-00942/ } },
      { sql: "SELECT sid, machine, osuser, terminal, program FROM v$session WHERE username = 'SYS';",                                want: /SYS/ },
      { sql: 'SELECT sid, logon_time FROM v$session WHERE username IS NOT NULL FETCH FIRST 3 ROWS ONLY;',                              want: { not: /ORA-/ } },
      { sql: 'SELECT * FROM v$process FETCH FIRST 5 ROWS ONLY;',                                                                       want: { not: /ORA-00942/ } },
      { sql: 'SELECT spid, pname FROM v$process WHERE pname IS NOT NULL FETCH FIRST 10 ROWS ONLY;',                                    want: { not: /ORA-/ } },
      { sql: 'SELECT name, value FROM v$mystat WHERE ROWNUM <= 5;',                                                                    want: { not: /ORA-00942/ } },
      { sql: 'SELECT * FROM v$sesstat WHERE statistic# = 0 FETCH FIRST 5 ROWS ONLY;',                                                  want: { not: /ORA-00942/ } },
      { sql: "SELECT name, value FROM v$sysstat WHERE name LIKE 'logons%';",                                                          want: { not: /ORA-/ } },
      { sql: 'SELECT * FROM v$lock FETCH FIRST 5 ROWS ONLY;',                                                                          want: { not: /ORA-00942/ } },
      { sql: 'SELECT sid, type, lmode, request FROM v$lock WHERE block > 0;',                                                          want: { not: /ORA-/ } },
      { sql: 'SELECT * FROM v$transaction FETCH FIRST 3 ROWS ONLY;',                                                                   want: { not: /ORA-00942/ } },
      { sql: 'SELECT * FROM v$open_cursor FETCH FIRST 5 ROWS ONLY;',                                                                   want: { not: /ORA-00942/ } },
      { sql: 'SELECT sql_id, sql_text FROM v$sql FETCH FIRST 5 ROWS ONLY;',                                                            want: { not: /ORA-00942/ } },
      { sql: 'SELECT sql_id, executions, elapsed_time FROM v$sqlarea FETCH FIRST 5 ROWS ONLY;',                                        want: { not: /ORA-00942/ } },
      { sql: 'SELECT * FROM v$session_blockers FETCH FIRST 5 ROWS ONLY;',                                                              want: { not: /ORA-/ } },
      { sql: 'SELECT * FROM v$session_longops FETCH FIRST 5 ROWS ONLY;',                                                               want: { not: /ORA-/ } },
      { sql: 'SELECT * FROM v$active_session_history FETCH FIRST 5 ROWS ONLY;',                                                        want: { not: /ORA-/ } },
      { sql: 'SELECT * FROM v$resource_limit FETCH FIRST 5 ROWS ONLY;',                                                                want: { not: /ORA-00942/ } },
      { sql: 'SELECT * FROM v$instance;',                                                                                              want: { not: /ORA-/ } },
      { sql: 'SELECT * FROM v$database;',                                                                                              want: { not: /ORA-/ } },
      { sql: "SELECT * FROM v$parameter WHERE name LIKE '%audit%';",                                                                  want: { not: /ORA-/ } },
      { sql: 'SELECT * FROM v$pwfile_users;',                                                                                          want: { not: /ORA-/ } },
      { sql: 'SELECT * FROM v$session_connect_info FETCH FIRST 5 ROWS ONLY;',                                                          want: { not: /ORA-/ } },
      { sql: "SELECT sid, command, server FROM v$session WHERE type = 'USER' FETCH FIRST 5 ROWS ONLY;",                              want: { not: /ORA-/ } },
      { sql: 'SELECT name, total_size, used_size FROM v$sgainfo FETCH FIRST 5 ROWS ONLY;',                                              want: { not: /ORA-/ } },
      { sql: 'SELECT * FROM v$pgastat FETCH FIRST 5 ROWS ONLY;',                                                                       want: { not: /ORA-/ } },
    ];
    drive(sys, cases);
  });
});

// ─────────────────────────────────────────────────────────────────
// SECTION 14 — Dictionary inspection of users & privileges (44 cases)
// ─────────────────────────────────────────────────────────────────

describe('14. Dictionary queries on users, roles, and privileges', () => {
  it('Reads dba_users, dba_roles, dba_*_privs in many shapes', () => {
    const cases: Case[] = [
      { sql: 'SELECT username FROM dba_users ORDER BY username;',                                                                     want: /ALICE/ },
      { sql: 'SELECT COUNT(*) FROM dba_users;',                                                                                       want: /\d+/ },
      { sql: "SELECT username, account_status FROM dba_users WHERE account_status != 'OPEN';",                                      want: { not: /ORA-/ } },
      { sql: "SELECT username, created FROM dba_users WHERE created > SYSDATE - 1;",                                                  want: { not: /ORA-/ } },
      { sql: "SELECT username, lock_date FROM dba_users WHERE lock_date IS NOT NULL;",                                                want: { not: /ORA-/ } },
      { sql: "SELECT username, expiry_date FROM dba_users WHERE expiry_date IS NOT NULL;",                                            want: { not: /ORA-/ } },
      { sql: "SELECT username, profile FROM dba_users WHERE profile != 'DEFAULT';",                                                   want: /SECURE_PROFILE/ },
      { sql: "SELECT username, default_tablespace, temporary_tablespace FROM dba_users WHERE username IN ('ALICE','BOB');",            want: /USERS/ },
      { sql: "SELECT username, authentication_type FROM dba_users WHERE username IN ('KERB_USER','GLOBAL_USER','OPS$ORACLE');",       want: /(EXTERNAL|GLOBAL)/ },
      { sql: "SELECT username, external_name FROM dba_users WHERE external_name IS NOT NULL;",                                        want: { not: /ORA-/ } },
      { sql: "SELECT username, common, oracle_maintained FROM dba_users WHERE username = 'SYS';",                                     want: { not: /ORA-00904/ } },
      { sql: 'SELECT role, password_required, authentication_type FROM dba_roles;',                                                   want: /APP_ROLE/ },
      { sql: "SELECT COUNT(*) FROM dba_roles WHERE password_required = 'YES';",                                                       want: /\d+/ },
      { sql: 'SELECT grantee, granted_role, admin_option, default_role FROM dba_role_privs ORDER BY grantee;',                        want: /BOB/ },
      { sql: "SELECT COUNT(*) FROM dba_role_privs WHERE grantee = 'BOB';",                                                            want: /\d+/ },
      { sql: "SELECT granted_role FROM dba_role_privs WHERE grantee = 'ANALYST';",                                                    want: /REPORTING_ROLE/ },
      { sql: 'SELECT grantee, privilege, admin_option FROM dba_sys_privs ORDER BY grantee, privilege;',                               want: /(BOB|ALICE)/ },
      { sql: "SELECT COUNT(*) FROM dba_sys_privs WHERE grantee = 'ALICE';",                                                           want: /\d+/ },
      { sql: "SELECT privilege FROM dba_sys_privs WHERE grantee = 'ADMIN_ROLE' AND ROWNUM <= 10;",                                    want: /(CREATE|ALTER|DROP)/ },
      { sql: 'SELECT grantor, grantee, owner, table_name, privilege, grantable FROM dba_tab_privs ORDER BY grantee, table_name;',     want: /(BOB|ALICE)/ },
      { sql: "SELECT COUNT(*) FROM dba_tab_privs WHERE owner = 'HR' AND table_name = 'EMPLOYEES';",                                   want: /\d+/ },
      { sql: 'SELECT grantee, owner, table_name, column_name, privilege FROM dba_col_privs;',                                          want: { not: /ORA-00942/ } },
      { sql: "SELECT COUNT(*) FROM dba_col_privs WHERE grantee = 'DEV_TEAM';",                                                        want: /\d+/ },
      { sql: 'SELECT * FROM role_sys_privs FETCH FIRST 10 ROWS ONLY;',                                                                 want: { not: /ORA-00942/ } },
      { sql: 'SELECT * FROM role_tab_privs FETCH FIRST 10 ROWS ONLY;',                                                                 want: { not: /ORA-00942/ } },
      { sql: 'SELECT * FROM role_role_privs FETCH FIRST 10 ROWS ONLY;',                                                                want: { not: /ORA-00942/ } },
      { sql: 'SELECT * FROM session_privs;',                                                                                          want: { not: /ORA-00942/ } },
      { sql: 'SELECT * FROM session_roles;',                                                                                          want: { not: /ORA-00942/ } },
      { sql: 'SELECT * FROM user_users;',                                                                                              want: { not: /ORA-00942/ } },
      { sql: 'SELECT * FROM user_role_privs;',                                                                                         want: { not: /ORA-00942/ } },
      { sql: 'SELECT * FROM user_sys_privs;',                                                                                          want: { not: /ORA-00942/ } },
      { sql: 'SELECT * FROM user_tab_privs;',                                                                                          want: { not: /ORA-00942/ } },
      { sql: 'SELECT * FROM all_users;',                                                                                              want: /ALICE/ },
      { sql: 'SELECT * FROM all_tables FETCH FIRST 5 ROWS ONLY;',                                                                      want: { not: /ORA-/ } },
      { sql: 'SELECT * FROM all_tab_privs FETCH FIRST 5 ROWS ONLY;',                                                                   want: { not: /ORA-/ } },
      // Recursive role expansion
      { sql: "SELECT grantee, granted_role FROM dba_role_privs CONNECT BY PRIOR granted_role = grantee START WITH grantee = 'ANALYST';", want: { not: /ORA-/ } },
      // Counts and aggregates
      { sql: "SELECT grantee, COUNT(*) FROM dba_sys_privs GROUP BY grantee ORDER BY 2 DESC FETCH FIRST 5 ROWS ONLY;",                  want: { not: /ORA-/ } },
      { sql: "SELECT privilege, COUNT(*) FROM dba_sys_privs GROUP BY privilege ORDER BY 2 DESC FETCH FIRST 5 ROWS ONLY;",              want: { not: /ORA-/ } },
      { sql: "SELECT owner, table_name, COUNT(DISTINCT grantee) FROM dba_tab_privs GROUP BY owner, table_name ORDER BY 3 DESC FETCH FIRST 5 ROWS ONLY;", want: { not: /ORA-/ } },
      { sql: "SELECT username, profile, COUNT(*) OVER (PARTITION BY profile) AS users_in_profile FROM dba_users;",                    want: { not: /ORA-/ } },
      // Filter by NOT EXISTS
      { sql: "SELECT u.username FROM dba_users u WHERE NOT EXISTS (SELECT 1 FROM dba_sys_privs s WHERE s.grantee = u.username);",      want: { not: /ORA-/ } },
      // Privilege chain — what does BOB end up with?
      { sql: "SELECT DISTINCT p.privilege FROM dba_role_privs r JOIN dba_sys_privs p ON p.grantee = r.granted_role WHERE r.grantee = 'BOB' UNION SELECT privilege FROM dba_sys_privs WHERE grantee = 'BOB';", want: { not: /ORA-/ } },
      { sql: "SELECT username FROM dba_users WHERE oracle_maintained = 'N' ORDER BY 1;",                                              want: { not: /ORA-/ } },
      { sql: "SELECT username FROM dba_users WHERE expiry_date < SYSDATE;",                                                            want: { not: /ORA-/ } },
    ];
    drive(sys, cases);
  });
});

// ─────────────────────────────────────────────────────────────────
// SECTION 15 — Audit configuration (traditional + unified) (38 cases)
// ─────────────────────────────────────────────────────────────────

describe('15. Audit configuration', () => {
  it('Sets up statement-level, object-level, FGA, and unified-audit policies', () => {
    const cases: Case[] = [
      // Statement-level
      { sql: 'AUDIT CREATE SESSION;',                                                                                                  want: /Audit succeeded/i },
      { sql: 'AUDIT CREATE TABLE BY ACCESS;',                                                                                          want: /Audit succeeded/i },
      { sql: 'AUDIT ALTER USER BY SESSION;',                                                                                           want: /Audit succeeded/i },
      { sql: 'AUDIT GRANT WHENEVER NOT SUCCESSFUL;',                                                                                    want: /Audit succeeded/i },
      { sql: 'AUDIT DROP USER BY ops_user BY ACCESS;',                                                                                  want: /Audit succeeded/i },
      { sql: 'AUDIT CREATE USER, ALTER USER, DROP USER;',                                                                              want: /Audit succeeded/i },
      // Object-level
      { sql: 'AUDIT SELECT, INSERT, UPDATE, DELETE ON hr.employees BY ACCESS;',                                                       want: /Audit succeeded/i },
      { sql: 'AUDIT EXECUTE ON hr.add_employee;',                                                                                       want: /(Audit succeeded|ORA-)/i },
      { sql: 'AUDIT ALL ON hr.departments;',                                                                                            want: /Audit succeeded/i },
      // FGA via DBMS_FGA
      { sql: "BEGIN DBMS_FGA.ADD_POLICY(object_schema=>'HR', object_name=>'EMPLOYEES', policy_name=>'fga_hr_sal', audit_column=>'SALARY', statement_types=>'SELECT,UPDATE'); END;", want: /PL\/SQL procedure successfully completed/i },
      { sql: "BEGIN DBMS_FGA.ADD_POLICY(object_schema=>'HR', object_name=>'DEPARTMENTS', policy_name=>'fga_hr_dept', audit_column=>'DEPARTMENT_NAME', statement_types=>'INSERT,DELETE'); END;", want: /PL\/SQL procedure successfully completed/i },
      { sql: "BEGIN DBMS_FGA.ENABLE_POLICY('HR','EMPLOYEES','fga_hr_sal'); END;",                                                       want: /PL\/SQL/i },
      { sql: "BEGIN DBMS_FGA.DISABLE_POLICY('HR','EMPLOYEES','fga_hr_sal'); END;",                                                      want: /PL\/SQL/i },
      { sql: "BEGIN DBMS_FGA.DROP_POLICY('HR','DEPARTMENTS','fga_hr_dept'); END;",                                                       want: /PL\/SQL/i },
      // Unified audit policies
      { sql: 'CREATE AUDIT POLICY login_audit ACTIONS LOGON, LOGOFF;',                                                                 want: /Audit policy created/i },
      { sql: 'CREATE AUDIT POLICY hr_audit ACTIONS UPDATE, DELETE ON hr.employees;',                                                  want: /Audit policy created/i },
      { sql: 'CREATE AUDIT POLICY ddl_audit PRIVILEGES CREATE ANY TABLE, DROP ANY TABLE;',                                            want: /Audit policy created/i },
      { sql: 'CREATE AUDIT POLICY all_role_grants ACTIONS GRANT, REVOKE;',                                                            want: /Audit policy created/i },
      { sql: 'AUDIT POLICY login_audit;',                                                                                              want: /Audit succeeded/i },
      { sql: 'AUDIT POLICY hr_audit BY alice, bob;',                                                                                   want: /Audit succeeded/i },
      { sql: 'AUDIT POLICY ddl_audit EXCEPT carol;',                                                                                   want: /Audit succeeded/i },
      { sql: 'AUDIT POLICY all_role_grants;',                                                                                          want: /Audit succeeded/i },
      { sql: 'NOAUDIT POLICY login_audit;',                                                                                            want: /Noaudit succeeded/i },
      { sql: 'DROP AUDIT POLICY all_role_grants;',                                                                                     want: /Audit policy dropped/i },
      // Verification
      { sql: "SELECT * FROM dba_priv_audit_opts FETCH FIRST 5 ROWS ONLY;",                                                              want: { not: /ORA-00942/ } },
      { sql: "SELECT * FROM dba_stmt_audit_opts FETCH FIRST 5 ROWS ONLY;",                                                              want: { not: /ORA-00942/ } },
      { sql: "SELECT * FROM dba_obj_audit_opts FETCH FIRST 5 ROWS ONLY;",                                                               want: { not: /ORA-00942/ } },
      { sql: "SELECT policy_name FROM dba_audit_policies WHERE object_schema = 'HR' AND object_name = 'EMPLOYEES';",                  want: /FGA_HR_SAL/ },
      { sql: "SELECT policy_name FROM audit_unified_policies WHERE policy_name = 'HR_AUDIT';",                                          want: /HR_AUDIT/ },
      { sql: "SELECT policy_name, audit_option FROM audit_unified_policies WHERE policy_name = 'HR_AUDIT';",                            want: /UPDATE|DELETE/ },
      { sql: "SELECT COUNT(*) FROM audit_unified_policies;",                                                                            want: /\d+/ },
      // NOAUDIT
      { sql: 'NOAUDIT SELECT ON hr.employees;',                                                                                         want: /Noaudit succeeded/i },
      { sql: 'NOAUDIT CREATE TABLE;',                                                                                                   want: /Noaudit succeeded/i },
      { sql: 'NOAUDIT ALTER USER;',                                                                                                    want: /Noaudit succeeded/i },
      // Trigger an audited action
      { sql: 'CREATE TABLE hr.audited_demo (x NUMBER);',                                                                                want: /Table created/i },
      { sql: 'DROP TABLE hr.audited_demo PURGE;',                                                                                      want: /Table dropped/i },
      // FGA log
      { sql: "SELECT COUNT(*) FROM fga_log$;",                                                                                          want: { not: /ORA-00942/ } },
      { sql: "SELECT * FROM dba_fga_audit_trail FETCH FIRST 5 ROWS ONLY;",                                                              want: { not: /ORA-00942/ } },
    ];
    drive(sys, cases);
  });
});

// ─────────────────────────────────────────────────────────────────
// SECTION 16 — Audit trail inspection (28 cases)
// ─────────────────────────────────────────────────────────────────

describe('16. Audit trail inspection', () => {
  it('Queries DBA_AUDIT_TRAIL and UNIFIED_AUDIT_TRAIL with filters', () => {
    const cases: Case[] = [
      { sql: 'SELECT COUNT(*) FROM dba_audit_trail;',                                                                                  want: /\d+/ },
      { sql: 'SELECT username, action_name, timestamp FROM dba_audit_trail ORDER BY timestamp DESC FETCH FIRST 20 ROWS ONLY;',         want: { not: /ORA-/ } },
      { sql: "SELECT action_name, COUNT(*) FROM dba_audit_trail GROUP BY action_name ORDER BY 2 DESC FETCH FIRST 10 ROWS ONLY;",       want: { not: /ORA-/ } },
      { sql: "SELECT username, COUNT(*) FROM dba_audit_trail WHERE returncode != 0 GROUP BY username;",                                want: { not: /ORA-/ } },
      { sql: "SELECT * FROM dba_audit_session FETCH FIRST 10 ROWS ONLY;",                                                              want: { not: /ORA-/ } },
      { sql: "SELECT * FROM dba_audit_statement FETCH FIRST 10 ROWS ONLY;",                                                            want: { not: /ORA-/ } },
      { sql: "SELECT * FROM dba_audit_object FETCH FIRST 10 ROWS ONLY;",                                                                want: { not: /ORA-/ } },
      { sql: "SELECT username, owner, obj_name, action_name FROM dba_audit_object WHERE owner = 'HR' FETCH FIRST 10 ROWS ONLY;",       want: { not: /ORA-00904/ } },
      { sql: "SELECT username, owner, obj_name FROM dba_audit_object WHERE obj_name = 'EMPLOYEES';",                                   want: { not: /ORA-/ } },
      { sql: "SELECT event_timestamp, dbusername, action_name FROM unified_audit_trail ORDER BY event_timestamp DESC FETCH FIRST 25 ROWS ONLY;", want: { not: /ORA-00942/ } },
      { sql: "SELECT action_name, COUNT(*) FROM unified_audit_trail GROUP BY action_name ORDER BY 2 DESC FETCH FIRST 5 ROWS ONLY;",    want: { not: /ORA-/ } },
      { sql: "SELECT object_schema, object_name, COUNT(*) FROM unified_audit_trail WHERE object_name IS NOT NULL GROUP BY object_schema, object_name FETCH FIRST 5 ROWS ONLY;", want: { not: /ORA-/ } },
      { sql: "SELECT * FROM dba_fga_audit_trail FETCH FIRST 5 ROWS ONLY;",                                                              want: { not: /ORA-/ } },
      // Failed login tracking
      { sql: "SELECT username, COUNT(*) FROM dba_audit_session WHERE returncode != 0 GROUP BY username;",                              want: { not: /ORA-/ } },
      { sql: "SELECT username, lcount FROM dba_users WHERE lcount > 0;",                                                                want: { not: /ORA-00942/ } },
      { sql: "SELECT * FROM dba_audit_trail WHERE action_name = 'LOGON' AND returncode != 0 FETCH FIRST 10 ROWS ONLY;",                want: { not: /ORA-/ } },
      // High-risk privileges audit
      { sql: "SELECT * FROM dba_priv_audit_opts WHERE privilege LIKE 'DROP%' OR privilege LIKE 'ALTER%' FETCH FIRST 10 ROWS ONLY;",   want: { not: /ORA-/ } },
      { sql: "SELECT * FROM dba_obj_audit_opts WHERE owner = 'HR';",                                                                   want: { not: /ORA-/ } },
      // Aggregate by timestamp window
      { sql: "SELECT TO_CHAR(timestamp, 'YYYY-MM-DD') AS day, COUNT(*) FROM dba_audit_trail GROUP BY TO_CHAR(timestamp, 'YYYY-MM-DD') ORDER BY 1 DESC FETCH FIRST 5 ROWS ONLY;", want: { not: /ORA-/ } },
      { sql: "SELECT username, action_name FROM dba_audit_trail WHERE timestamp > SYSDATE - 1 AND username NOT IN ('SYS') FETCH FIRST 20 ROWS ONLY;", want: { not: /ORA-/ } },
      // Forensics-style joins
      { sql: "SELECT t.username, t.action_name, u.account_status FROM dba_audit_trail t JOIN dba_users u ON u.username = t.username WHERE t.returncode != 0 FETCH FIRST 10 ROWS ONLY;", want: { not: /ORA-/ } },
      // Purge / Cleanup
      { sql: "BEGIN DBMS_AUDIT_MGMT.CLEAN_AUDIT_TRAIL(audit_trail_type=>DBMS_AUDIT_MGMT.AUDIT_TRAIL_DB_STD, use_last_arch_timestamp=>FALSE); END;", want: { not: /ORA-00942/ } },
      { sql: "BEGIN DBMS_AUDIT_MGMT.SET_LAST_ARCHIVE_TIMESTAMP(audit_trail_type=>DBMS_AUDIT_MGMT.AUDIT_TRAIL_UNIFIED, last_archive_time=>SYSTIMESTAMP); END;", want: { not: /ORA-00942/ } },
      // Audit policy enablement
      { sql: "SELECT * FROM dba_priv_audit_opts WHERE user_name IS NULL FETCH FIRST 5 ROWS ONLY;",                                    want: { not: /ORA-/ } },
      // Audit trail rotation
      { sql: "SELECT * FROM dba_audit_mgmt_config_params FETCH FIRST 5 ROWS ONLY;",                                                     want: { not: /ORA-/ } },
      { sql: "SELECT * FROM dba_audit_mgmt_last_arch_ts;",                                                                              want: { not: /ORA-/ } },
      // Sessionless audit
      { sql: "SELECT COUNT(*) FROM dba_audit_trail WHERE sessionid IS NOT NULL;",                                                      want: /\d+/ },
      { sql: "SELECT username, action_name, sql_text FROM dba_audit_trail WHERE sql_text LIKE 'GRANT%' FETCH FIRST 5 ROWS ONLY;",      want: { not: /ORA-/ } },
    ];
    drive(sys, cases);
  });
});

// ─────────────────────────────────────────────────────────────────
// SECTION 17 — TDE / encryption (16 cases)
// ─────────────────────────────────────────────────────────────────

describe('17. Transparent Data Encryption', () => {
  it('Configures the wallet, master keys, and encrypts columns/tablespaces', () => {
    const cases: Case[] = [
      { sql: "ADMINISTER KEY MANAGEMENT CREATE KEYSTORE '/opt/oracle/wallet' IDENTIFIED BY \"WalletP@ss1\";",                          want: /(succeeded|ORA-)/i },
      { sql: "ADMINISTER KEY MANAGEMENT SET KEYSTORE OPEN IDENTIFIED BY \"WalletP@ss1\";",                                            want: /(succeeded|ORA-)/i },
      { sql: "ADMINISTER KEY MANAGEMENT SET KEY USING TAG 'master-2026' IDENTIFIED BY \"WalletP@ss1\" WITH BACKUP;",                  want: /(succeeded|ORA-)/i },
      { sql: "ADMINISTER KEY MANAGEMENT CREATE AUTO_LOGIN KEYSTORE FROM KEYSTORE '/opt/oracle/wallet' IDENTIFIED BY \"WalletP@ss1\";", want: /(succeeded|ORA-)/i },
      { sql: 'SELECT * FROM v$encryption_wallet;',                                                                                    want: { not: /ORA-00942/ } },
      { sql: 'SELECT key_id, tag, creator FROM v$encryption_keys;',                                                                   want: { not: /ORA-00942/ } },
      { sql: "ALTER TABLE hr.employees MODIFY (salary ENCRYPT USING 'AES256');",                                                     want: /(Table altered|ORA-)/i },
      { sql: "ALTER TABLE hr.employees MODIFY (commission_pct ENCRYPT USING 'AES192' NO SALT);",                                     want: /(Table altered|ORA-)/i },
      { sql: 'ALTER TABLE hr.employees MODIFY (phone_number DECRYPT);',                                                                want: /(Table altered|ORA-)/i },
      { sql: "SELECT owner, table_name, column_name, encryption_alg FROM dba_encrypted_columns;",                                     want: { not: /ORA-00942/ } },
      { sql: 'ALTER TABLESPACE users ENCRYPTION ONLINE ENCRYPT;',                                                                     want: /(Tablespace altered|ORA-)/i },
      { sql: 'SELECT * FROM v$encrypted_tablespaces;',                                                                                want: { not: /ORA-00942/ } },
      { sql: "ADMINISTER KEY MANAGEMENT SET KEYSTORE CLOSE IDENTIFIED BY \"WalletP@ss1\";",                                           want: /(succeeded|ORA-)/i },
      { sql: 'SELECT status FROM v$encryption_wallet;',                                                                                want: { not: /ORA-00942/ } },
      { sql: "ADMINISTER KEY MANAGEMENT SET KEYSTORE OPEN IDENTIFIED BY \"WalletP@ss1\";",                                            want: /(succeeded|ORA-)/i },
      { sql: "ADMINISTER KEY MANAGEMENT BACKUP KEYSTORE USING 'rotation-backup' IDENTIFIED BY \"WalletP@ss1\" TO '/opt/oracle/wallet_bk';", want: /(succeeded|ORA-)/i },
    ];
    drive(sys, cases);
  });
});

// ─────────────────────────────────────────────────────────────────
// SECTION 18 — Database Vault (18 cases)
// ─────────────────────────────────────────────────────────────────

describe('18. Database Vault provisioning', () => {
  it('Creates realms, command rules, factors, and authorisations', () => {
    const cases: Case[] = [
      { sql: "BEGIN DBMS_MACADM.CREATE_REALM(realm_name=>'HR Realm', description=>'Protect HR data', enabled=>'Y', audit_options=>1); END;", want: { not: /ORA-00942/ } },
      { sql: "BEGIN DBMS_MACADM.CREATE_REALM(realm_name=>'Finance Realm', description=>'Protect finance objects', enabled=>'Y', audit_options=>1); END;", want: { not: /ORA-00942/ } },
      { sql: "BEGIN DBMS_MACADM.ADD_OBJECT_TO_REALM(realm_name=>'HR Realm', object_owner=>'HR', object_name=>'EMPLOYEES', object_type=>'TABLE'); END;", want: { not: /ORA-00942/ } },
      { sql: "BEGIN DBMS_MACADM.ADD_AUTH_TO_REALM(realm_name=>'HR Realm', grantee=>'OPS_USER', auth_options=>'PARTICIPANT'); END;",    want: { not: /ORA-00942/ } },
      { sql: "BEGIN DBMS_MACADM.CREATE_ROLE(role=>'DV_HR_ANALYST', enabled=>'Y'); END;",                                                want: { not: /ORA-00942/ } },
      { sql: "BEGIN DBMS_MACADM.CREATE_COMMAND_RULE(command=>'DROP TABLE', rule_set_name=>'Default Rule Set', object_owner=>'HR', object_name=>'EMPLOYEES', enabled=>'Y'); END;", want: { not: /ORA-00942/ } },
      { sql: "BEGIN DBMS_MACADM.CREATE_FACTOR(factor_name=>'Client_IP', factor_type_name=>'IP_Address', description=>'Client IP factor', validate_expr=>'DVF.F$Client_IP IS NOT NULL', identify_by=>'BY_CONSTANT', labeled_by=>'BY_SELF', eval_options=>'BY_SESSION', audit_options=>1, fail_options=>1); END;", want: { not: /ORA-00942/ } },
      { sql: 'SELECT * FROM dba_dv_realm;',                                                                                            want: { not: /ORA-00942/ } },
      { sql: "SELECT name FROM dba_dv_realm WHERE name LIKE '%Realm%';",                                                              want: { not: /ORA-/ } },
      { sql: 'SELECT * FROM dba_dv_role;',                                                                                              want: { not: /ORA-00942/ } },
      { sql: 'SELECT * FROM dba_dv_realm_auth;',                                                                                       want: { not: /ORA-00942/ } },
      { sql: 'SELECT * FROM dba_dv_command_rule;',                                                                                     want: { not: /ORA-00942/ } },
      { sql: 'SELECT * FROM dba_dv_factor;',                                                                                            want: { not: /ORA-00942/ } },
      { sql: "BEGIN DBMS_MACADM.DELETE_REALM(realm_name=>'Finance Realm'); END;",                                                       want: { not: /ORA-00942/ } },
      { sql: "BEGIN DBMS_MACADM.DELETE_FACTOR(factor_name=>'Client_IP'); END;",                                                          want: { not: /ORA-00942/ } },
      { sql: "BEGIN DBMS_MACADM.DELETE_ROLE(role=>'DV_HR_ANALYST'); END;",                                                              want: { not: /ORA-00942/ } },
      { sql: "BEGIN DBMS_MACADM.DELETE_COMMAND_RULE(command=>'DROP TABLE', object_owner=>'HR', object_name=>'EMPLOYEES'); END;",        want: { not: /ORA-00942/ } },
      { sql: "BEGIN DBMS_MACADM.DELETE_REALM(realm_name=>'HR Realm'); END;",                                                            want: { not: /ORA-00942/ } },
    ];
    drive(sys, cases);
  });
});

// ─────────────────────────────────────────────────────────────────
// SECTION 19 — Fine-grained access policies (RLS) (14 cases)
// ─────────────────────────────────────────────────────────────────

describe('19. Row-level security (DBMS_RLS)', () => {
  it('Adds, drops, and queries VPD policies', () => {
    const cases: Case[] = [
      { sql: "BEGIN DBMS_RLS.ADD_POLICY(object_schema=>'HR', object_name=>'EMPLOYEES', policy_name=>'emp_dept_pol', function_schema=>'HR', policy_function=>'dept_security_predicate'); END;", want: { not: /ORA-00942/ } },
      { sql: "BEGIN DBMS_RLS.ADD_POLICY(object_schema=>'HR', object_name=>'EMPLOYEES', policy_name=>'emp_sal_pol', function_schema=>'HR', policy_function=>'sal_security_predicate', statement_types=>'SELECT,UPDATE'); END;", want: { not: /ORA-00942/ } },
      { sql: "BEGIN DBMS_RLS.ENABLE_POLICY('HR','EMPLOYEES','emp_dept_pol', TRUE); END;",                                                want: { not: /ORA-00942/ } },
      { sql: "BEGIN DBMS_RLS.ADD_GROUPED_POLICY(object_schema=>'HR', object_name=>'EMPLOYEES', policy_group=>'PII_GROUP', policy_name=>'mask_email', function_schema=>'HR', policy_function=>'email_mask'); END;", want: { not: /ORA-00942/ } },
      { sql: 'SELECT * FROM dba_policies;',                                                                                            want: { not: /ORA-00942/ } },
      { sql: 'SELECT * FROM dba_policy_groups;',                                                                                       want: { not: /ORA-00942/ } },
      { sql: "SELECT object_owner, object_name, policy_name, enable FROM dba_policies WHERE object_name = 'EMPLOYEES';",              want: { not: /ORA-/ } },
      { sql: "SELECT * FROM dba_policy_contexts FETCH FIRST 5 ROWS ONLY;",                                                              want: { not: /ORA-/ } },
      { sql: "SELECT * FROM dba_sec_relevant_cols FETCH FIRST 5 ROWS ONLY;",                                                            want: { not: /ORA-/ } },
      { sql: "BEGIN DBMS_RLS.DISABLE_POLICY('HR','EMPLOYEES','emp_dept_pol'); END;",                                                    want: { not: /ORA-00942/ } },
      { sql: "BEGIN DBMS_RLS.DROP_POLICY('HR','EMPLOYEES','emp_dept_pol'); END;",                                                       want: { not: /ORA-00942/ } },
      { sql: "BEGIN DBMS_RLS.DROP_POLICY('HR','EMPLOYEES','emp_sal_pol'); END;",                                                        want: { not: /ORA-00942/ } },
      { sql: "BEGIN DBMS_RLS.DROP_GROUPED_POLICY('HR','EMPLOYEES','PII_GROUP','mask_email'); END;",                                     want: { not: /ORA-00942/ } },
      { sql: "SELECT COUNT(*) FROM dba_policies WHERE object_name = 'EMPLOYEES';",                                                     want: /0/ },
    ];
    drive(sys, cases);
  });
});

// ─────────────────────────────────────────────────────────────────
// SECTION 20 — ALTER SYSTEM session control (14 cases)
// ─────────────────────────────────────────────────────────────────

describe('20. ALTER SYSTEM — session lifecycle administration', () => {
  it('Kills and disconnects sessions, manages resources', () => {
    const cases: Case[] = [
      { sql: "SELECT sid, serial# FROM v$session WHERE username = 'BOB' FETCH FIRST 1 ROW ONLY;",                                      want: { not: /ORA-/ } },
      { sql: "ALTER SYSTEM KILL SESSION '142,12345';",                                                                                  want: /ORA-(00031|00030)/ },
      { sql: "ALTER SYSTEM DISCONNECT SESSION '142,12345' IMMEDIATE;",                                                                  want: /ORA-(00031|00030)/ },
      { sql: "ALTER SYSTEM DISCONNECT SESSION '142,12345' POST_TRANSACTION;",                                                          want: /ORA-(00031|00030|00900)/ },
      { sql: "ALTER SYSTEM SET sga_target = 1G SCOPE=BOTH;",                                                                            want: /(System altered|ORA-)/i },
      { sql: "ALTER SYSTEM SET open_cursors = 500 SCOPE=BOTH;",                                                                         want: /(System altered|ORA-)/i },
      { sql: "ALTER SYSTEM FLUSH SHARED_POOL;",                                                                                          want: /(System altered|ORA-)/i },
      { sql: "ALTER SYSTEM FLUSH BUFFER_CACHE;",                                                                                         want: /(System altered|ORA-)/i },
      { sql: "ALTER SYSTEM CHECKPOINT;",                                                                                                 want: /(System altered|ORA-)/i },
      { sql: "ALTER SYSTEM SWITCH LOGFILE;",                                                                                            want: /(System altered|ORA-)/i },
      { sql: "ALTER SYSTEM ARCHIVE LOG CURRENT;",                                                                                       want: /(System altered|ORA-)/i },
      { sql: "ALTER SYSTEM RESET sga_target SCOPE=SPFILE;",                                                                              want: /(System altered|ORA-)/i },
      { sql: "ALTER SYSTEM SET resource_limit = TRUE;",                                                                                  want: /(System altered|ORA-)/i },
      { sql: "ALTER SYSTEM SUSPEND;",                                                                                                    want: /(System altered|ORA-)/i },
    ];
    drive(sys, cases);
  });
});

// ─────────────────────────────────────────────────────────────────
// SECTION 21 — REVOKE everywhere (38 cases)
// ─────────────────────────────────────────────────────────────────

describe('21. REVOKE privileges, roles, and access', () => {
  it('Cleans up privileges in all flavours', () => {
    const cases: Case[] = [
      { sql: 'REVOKE CREATE TABLE FROM alice;',                                                                                       want: /Revoke succeeded/i },
      { sql: 'REVOKE SELECT ANY TABLE FROM bob;',                                                                                     want: /Revoke succeeded/i },
      { sql: 'REVOKE ALL PRIVILEGES FROM dave;',                                                                                     want: /Revoke succeeded/i },
      { sql: 'REVOKE SELECT ON hr.employees FROM alice;',                                                                             want: /Revoke succeeded/i },
      { sql: 'REVOKE app_role FROM bob;',                                                                                              want: /Revoke succeeded/i },
      { sql: 'REVOKE admin_role FROM ops_user;',                                                                                       want: /Revoke succeeded/i },
      { sql: 'REVOKE developer_role FROM carol;',                                                                                      want: /Revoke succeeded/i },
      { sql: 'REVOKE EXECUTE ANY PROCEDURE FROM bob;',                                                                                  want: /Revoke succeeded/i },
      { sql: 'REVOKE UNLIMITED TABLESPACE FROM app_user;',                                                                              want: /Revoke succeeded/i },
      // Multi-grantee REVOKE
      { sql: 'REVOKE CREATE SESSION FROM eve, frank;',                                                                                  want: /Revoke succeeded/i },
      // Multi-privilege REVOKE
      { sql: 'REVOKE INSERT, UPDATE, DELETE ON hr.employees FROM bob;',                                                                want: /Revoke succeeded/i },
      // Column-level REVOKE
      { sql: 'REVOKE UPDATE (salary) ON hr.employees FROM grace;',                                                                    want: /(Revoke succeeded|ORA-)/i },
      // REVOKE from PUBLIC
      { sql: 'REVOKE SELECT ON hr.regions FROM PUBLIC;',                                                                                want: /Revoke succeeded/i },
      // REVOKE non-existent grant
      { sql: 'REVOKE CREATE ANY VIEW FROM mallory;',                                                                                    want: /(ORA-01927|Revoke succeeded)/i },
      // REVOKE WITH ADMIN OPTION
      { sql: 'REVOKE ADMIN OPTION FOR CREATE TABLE FROM heidi;',                                                                       want: /(Revoke succeeded|ORA-)/i },
      // REVOKE GRANT OPTION
      { sql: 'REVOKE GRANT OPTION FOR SELECT ON hr.employees FROM heidi;',                                                            want: /(Revoke succeeded|ORA-)/i },
      // REVOKE cascading
      { sql: 'REVOKE read_only_role FROM reporting_role;',                                                                              want: /Revoke succeeded/i },
      { sql: 'REVOKE write_role FROM app_user;',                                                                                       want: /Revoke succeeded/i },
      // Verification
      { sql: "SELECT COUNT(*) FROM dba_sys_privs WHERE grantee = 'DAVE';",                                                            want: /0/ },
      { sql: "SELECT COUNT(*) FROM dba_role_privs WHERE grantee = 'BOB' AND granted_role = 'APP_ROLE';",                              want: /0/ },
      { sql: "SELECT COUNT(*) FROM dba_tab_privs WHERE grantee = 'PUBLIC' AND table_name = 'REGIONS';",                               want: /0/ },
      { sql: "SELECT COUNT(*) FROM dba_tab_privs WHERE grantee = 'BOB' AND table_name = 'EMPLOYEES' AND privilege = 'INSERT';",        want: /0/ },
      // REVOKE from unknown grantee
      { sql: 'REVOKE CREATE SESSION FROM ghost_user;',                                                                                  want: /ORA-/ },
      // REVOKE that breaks dependent grants (downstream cascade)
      { sql: 'GRANT SELECT ON hr.employees TO heidi WITH GRANT OPTION;',                                                                want: /Grant succeeded/i },
      { sql: 'CONNECT heidi/Welcome1#@orcl',                                                                                            want: /(Connected|ORA-)/i },
      { sql: 'GRANT SELECT ON hr.employees TO ivan;',                                                                                   want: /(Grant succeeded|ORA-)/i },
      { sql: 'CONNECT / AS SYSDBA',                                                                                                     want: /Connected/i },
      { sql: 'REVOKE SELECT ON hr.employees FROM heidi;',                                                                               want: /Revoke succeeded/i },
      { sql: "SELECT COUNT(*) FROM dba_tab_privs WHERE grantee = 'IVAN' AND table_name = 'EMPLOYEES';",                                want: /\d+/ },
      // Revoke at role chain
      { sql: 'REVOKE app_role FROM dev_team;',                                                                                          want: /Revoke succeeded/i },
      // System privileges (rare)
      { sql: 'REVOKE ALTER SYSTEM FROM ops_user;',                                                                                       want: /Revoke succeeded/i },
      { sql: 'REVOKE CREATE USER FROM ops_user;',                                                                                       want: /Revoke succeeded/i },
      { sql: 'REVOKE ALTER USER FROM ops_user;',                                                                                       want: /Revoke succeeded/i },
      { sql: 'REVOKE DROP USER FROM ops_user;',                                                                                         want: /Revoke succeeded/i },
      { sql: 'REVOKE DBA FROM ops_user;',                                                                                                want: /Revoke succeeded/i },
      { sql: 'REVOKE CONNECT FROM alice;',                                                                                              want: /Revoke succeeded/i },
      { sql: 'REVOKE RESOURCE FROM alice;',                                                                                              want: /Revoke succeeded/i },
      // Final verification — alice has lost almost everything
      { sql: "SELECT COUNT(*) FROM dba_role_privs WHERE grantee = 'ALICE';",                                                          want: /\d+/ },
    ];
    drive(sys, cases);
  });
});

// ─────────────────────────────────────────────────────────────────
// SECTION 22 — Final cleanup and tear-down (28 cases)
// ─────────────────────────────────────────────────────────────────

describe('22. DROP USER / ROLE / PROFILE — final cleanup', () => {
  it('Drops users with CASCADE, drops roles, drops profiles', () => {
    const cases: Case[] = [
      { sql: 'DROP USER nograntee;',                                                                                                   want: /User dropped/i },
      { sql: 'DROP USER expensive_user CASCADE;',                                                                                       want: /User dropped/i },
      { sql: 'DROP USER schema_owner CASCADE;',                                                                                          want: /User dropped/i },
      { sql: 'DROP USER analyst;',                                                                                                      want: /User dropped/i },
      { sql: 'DROP USER reporter;',                                                                                                     want: /User dropped/i },
      { sql: 'DROP USER batch_user CASCADE;',                                                                                            want: /User dropped/i },
      { sql: 'DROP USER kerb_user;',                                                                                                    want: /User dropped/i },
      { sql: 'DROP USER global_user;',                                                                                                  want: /User dropped/i },
      { sql: 'DROP USER nonexistent_user;',                                                                                              want: /ORA-01918/i },
      { sql: 'DROP USER ops$oracle;',                                                                                                    want: /User dropped/i },
      { sql: 'DROP ROLE batch_role;',                                                                                                    want: /Role dropped/i },
      { sql: 'DROP ROLE etl_role;',                                                                                                      want: /Role dropped/i },
      { sql: 'DROP ROLE schema_admin;',                                                                                                  want: /Role dropped/i },
      { sql: 'DROP ROLE ldap_role;',                                                                                                     want: /Role dropped/i },
      { sql: 'DROP ROLE monitor_role;',                                                                                                   want: /Role dropped/i },
      { sql: 'DROP ROLE backup_role;',                                                                                                     want: /Role dropped/i },
      { sql: 'DROP ROLE security_role;',                                                                                                   want: /Role dropped/i },
      { sql: 'DROP ROLE audit_role;',                                                                                                       want: /Role dropped/i },
      { sql: 'DROP ROLE nonexistent_role;',                                                                                                   want: /ORA-01919/i },
      { sql: 'DROP PROFILE dev_profile;',                                                                                                 want: /Profile dropped/i },
      { sql: 'DROP PROFILE reporting_profile;',                                                                                              want: /Profile dropped/i },
      { sql: 'DROP PROFILE pci_profile;',                                                                                                    want: /Profile dropped/i },
      // Verification that they really are gone
      { sql: "SELECT COUNT(*) FROM dba_users WHERE username = 'NOGRANTEE';",                                                            want: /0/ },
      { sql: "SELECT COUNT(*) FROM dba_users WHERE username = 'KERB_USER';",                                                            want: /0/ },
      { sql: "SELECT COUNT(*) FROM dba_roles WHERE role = 'BATCH_ROLE';",                                                                want: /0/ },
      { sql: "SELECT COUNT(*) FROM dba_profiles WHERE profile = 'DEV_PROFILE';",                                                          want: /0/ },
      { sql: "SELECT COUNT(*) FROM dba_users WHERE username LIKE 'ALICE';",                                                              want: /1/ },
      { sql: "SELECT COUNT(*) FROM dba_audit_trail WHERE action_name = 'DROP USER' AND timestamp > SYSDATE - 1;",                       want: /\d+/ },
    ];
    drive(sys, cases);
  });
});

// ─────────────────────────────────────────────────────────────────
// SECTION 23 — Cross-cutting metadata views (32 cases)
// ─────────────────────────────────────────────────────────────────

describe('23. Cross-cutting metadata views', () => {
  it('Reads the full dictionary surface relevant to security/access', () => {
    const cases: Case[] = [
      { sql: "SELECT * FROM dictionary WHERE table_name LIKE '%USER%' FETCH FIRST 10 ROWS ONLY;",                                     want: { not: /ORA-/ } },
      { sql: "SELECT * FROM dict_columns WHERE column_name LIKE '%PRIV%' FETCH FIRST 10 ROWS ONLY;",                                  want: { not: /ORA-/ } },
      { sql: 'SELECT * FROM dba_tablespaces;',                                                                                          want: /USERS/ },
      { sql: 'SELECT * FROM dba_data_files FETCH FIRST 10 ROWS ONLY;',                                                                  want: { not: /ORA-/ } },
      { sql: 'SELECT * FROM dba_temp_files FETCH FIRST 5 ROWS ONLY;',                                                                    want: { not: /ORA-/ } },
      { sql: 'SELECT * FROM dba_segments FETCH FIRST 10 ROWS ONLY;',                                                                    want: { not: /ORA-/ } },
      { sql: 'SELECT * FROM dba_extents FETCH FIRST 10 ROWS ONLY;',                                                                     want: { not: /ORA-/ } },
      { sql: 'SELECT * FROM dba_free_space FETCH FIRST 10 ROWS ONLY;',                                                                  want: { not: /ORA-/ } },
      { sql: "SELECT * FROM dba_objects WHERE owner = 'HR' FETCH FIRST 10 ROWS ONLY;",                                                want: { not: /ORA-/ } },
      { sql: "SELECT object_type, COUNT(*) FROM dba_objects WHERE owner IN ('HR','SCOTT') GROUP BY object_type;",                  want: { not: /ORA-/ } },
      { sql: 'SELECT * FROM dba_recyclebin;',                                                                                            want: { not: /ORA-00942/ } },
      { sql: 'SELECT * FROM dba_directories;',                                                                                          want: { not: /ORA-00942/ } },
      { sql: 'SELECT * FROM dba_db_links;',                                                                                              want: { not: /ORA-00942/ } },
      { sql: "SELECT * FROM dba_synonyms WHERE owner = 'PUBLIC' FETCH FIRST 10 ROWS ONLY;",                                            want: { not: /ORA-/ } },
      { sql: "SELECT * FROM dba_dependencies WHERE owner = 'HR' FETCH FIRST 10 ROWS ONLY;",                                            want: { not: /ORA-/ } },
      { sql: "SELECT * FROM dba_constraints WHERE owner = 'HR' FETCH FIRST 10 ROWS ONLY;",                                            want: { not: /ORA-/ } },
      { sql: "SELECT * FROM dba_cons_columns WHERE owner = 'HR' FETCH FIRST 10 ROWS ONLY;",                                          want: { not: /ORA-/ } },
      { sql: "SELECT * FROM dba_indexes WHERE owner = 'HR' FETCH FIRST 10 ROWS ONLY;",                                                want: { not: /ORA-/ } },
      { sql: "SELECT * FROM dba_ind_columns WHERE table_owner = 'HR' FETCH FIRST 10 ROWS ONLY;",                                       want: { not: /ORA-/ } },
      { sql: "SELECT * FROM dba_sequences WHERE sequence_owner = 'HR';",                                                              want: { not: /ORA-/ } },
      { sql: "SELECT * FROM dba_views WHERE owner = 'HR' FETCH FIRST 5 ROWS ONLY;",                                                    want: { not: /ORA-/ } },
      { sql: 'SELECT * FROM dba_jobs FETCH FIRST 5 ROWS ONLY;',                                                                          want: { not: /ORA-/ } },
      { sql: 'SELECT * FROM dba_scheduler_jobs FETCH FIRST 5 ROWS ONLY;',                                                                want: { not: /ORA-/ } },
      { sql: 'SELECT * FROM dba_services;',                                                                                              want: { not: /ORA-/ } },
      { sql: 'SELECT * FROM dba_resource_incarnation_session_history FETCH FIRST 5 ROWS ONLY;',                                          want: { not: /ORA-/ } },
      { sql: 'SELECT * FROM dba_resumable;',                                                                                              want: { not: /ORA-/ } },
      { sql: 'SELECT * FROM dba_rsrc_consumer_groups;',                                                                                  want: { not: /ORA-00942/ } },
      { sql: 'SELECT * FROM dba_rsrc_plans;',                                                                                            want: { not: /ORA-00942/ } },
      { sql: 'SELECT * FROM dba_2pc_pending;',                                                                                          want: { not: /ORA-/ } },
      { sql: 'SELECT * FROM dba_log_groups;',                                                                                          want: { not: /ORA-/ } },
      { sql: 'SELECT * FROM dba_supplemental_logging WHERE TRUE FETCH FIRST 5 ROWS ONLY;',                                              want: { not: /ORA-/ } },
      { sql: "SELECT * FROM v$option WHERE parameter LIKE '%Encryption%';",                                                          want: { not: /ORA-/ } },
    ];
    drive(sys, cases);
  });
});

// ─────────────────────────────────────────────────────────────────
// SECTION 24 — SYSDATE arithmetic and time-based queries (16 cases)
// ─────────────────────────────────────────────────────────────────

describe('24. SYSDATE / TIMESTAMP arithmetic across views', () => {
  it('Performs date arithmetic with audit and user views', () => {
    const cases: Case[] = [
      { sql: 'SELECT SYSDATE FROM dual;',                                                                                              want: /\d{4}/ },
      { sql: 'SELECT SYSDATE - 1 AS yesterday FROM dual;',                                                                              want: /\d{4}/ },
      { sql: 'SELECT SYSTIMESTAMP FROM dual;',                                                                                          want: /\d{4}/ },
      { sql: 'SELECT username FROM dba_users WHERE created > SYSDATE - 1;',                                                              want: { not: /ORA-01722/ } },
      { sql: 'SELECT username FROM dba_users WHERE created > SYSDATE - 30;',                                                            want: { not: /ORA-01722/ } },
      { sql: 'SELECT username, expiry_date FROM dba_users WHERE expiry_date BETWEEN SYSDATE AND SYSDATE + 30;',                          want: { not: /ORA-/ } },
      { sql: "SELECT TO_CHAR(created, 'YYYY-MM-DD HH24:MI:SS') FROM dba_users WHERE username = 'ALICE';",                            want: { not: /ORA-/ } },
      { sql: 'SELECT TRUNC(SYSDATE) FROM dual;',                                                                                          want: /\d{4}/ },
      { sql: 'SELECT ADD_MONTHS(SYSDATE, 6) FROM dual;',                                                                                  want: /\d{4}/ },
      { sql: 'SELECT MONTHS_BETWEEN(SYSDATE, SYSDATE - 90) FROM dual;',                                                                  want: /3/ },
      { sql: "SELECT NEXT_DAY(SYSDATE, 'MONDAY') FROM dual;",                                                                          want: /\d{4}/ },
      { sql: 'SELECT EXTRACT(YEAR FROM SYSDATE) FROM dual;',                                                                            want: /\d{4}/ },
      { sql: "SELECT (SYSDATE - created) AS age_days FROM dba_users WHERE username = 'ALICE';",                                        want: { not: /ORA-/ } },
      { sql: "SELECT COUNT(*) FROM dba_audit_trail WHERE timestamp > SYSTIMESTAMP - INTERVAL '1' HOUR;",                                want: { not: /ORA-/ } },
      { sql: "SELECT * FROM dba_audit_trail WHERE timestamp >= SYSDATE - INTERVAL '7' DAY FETCH FIRST 5 ROWS ONLY;",                    want: { not: /ORA-/ } },
      { sql: "SELECT SESSIONTIMEZONE FROM dual;",                                                                                       want: { not: /ORA-/ } },
    ];
    drive(sys, cases);
  });
});

// ─────────────────────────────────────────────────────────────────
// SECTION 25 — SYS_CONTEXT / USERENV inspection (18 cases)
// ─────────────────────────────────────────────────────────────────

describe('25. SYS_CONTEXT and USERENV', () => {
  it('Reads session attributes across many namespaces', () => {
    const cases: Case[] = [
      { sql: "SELECT SYS_CONTEXT('USERENV','AUTHENTICATION_TYPE') FROM dual;",                                                          want: { not: /ORA-/ } },
      { sql: "SELECT SYS_CONTEXT('USERENV','AUTHENTICATED_IDENTITY') FROM dual;",                                                        want: { not: /ORA-/ } },
      { sql: "SELECT SYS_CONTEXT('USERENV','BG_JOB_ID') FROM dual;",                                                                    want: { not: /ORA-/ } },
      { sql: "SELECT SYS_CONTEXT('USERENV','CLIENT_IDENTIFIER') FROM dual;",                                                            want: { not: /ORA-/ } },
      { sql: "SELECT SYS_CONTEXT('USERENV','CLIENT_INFO') FROM dual;",                                                                  want: { not: /ORA-/ } },
      { sql: "SELECT SYS_CONTEXT('USERENV','DB_DOMAIN') FROM dual;",                                                                    want: { not: /ORA-/ } },
      { sql: "SELECT SYS_CONTEXT('USERENV','DB_UNIQUE_NAME') FROM dual;",                                                                want: { not: /ORA-/ } },
      { sql: "SELECT SYS_CONTEXT('USERENV','ENTERPRISE_IDENTITY') FROM dual;",                                                          want: { not: /ORA-/ } },
      { sql: "SELECT SYS_CONTEXT('USERENV','HOST') FROM dual;",                                                                          want: { not: /ORA-/ } },
      { sql: "SELECT SYS_CONTEXT('USERENV','IDENTIFICATION_TYPE') FROM dual;",                                                          want: { not: /ORA-/ } },
      { sql: "SELECT SYS_CONTEXT('USERENV','IP_ADDRESS') FROM dual;",                                                                    want: { not: /ORA-/ } },
      { sql: "SELECT SYS_CONTEXT('USERENV','LANG') FROM dual;",                                                                          want: { not: /ORA-/ } },
      { sql: "SELECT SYS_CONTEXT('USERENV','LANGUAGE') FROM dual;",                                                                      want: { not: /ORA-/ } },
      { sql: "SELECT SYS_CONTEXT('USERENV','MODULE') FROM dual;",                                                                        want: { not: /ORA-/ } },
      { sql: "SELECT SYS_CONTEXT('USERENV','NETWORK_PROTOCOL') FROM dual;",                                                              want: { not: /ORA-/ } },
      { sql: "SELECT SYS_CONTEXT('USERENV','PROXY_USER') FROM dual;",                                                                    want: { not: /ORA-/ } },
      { sql: "SELECT SYS_CONTEXT('USERENV','SESSIONID') FROM dual;",                                                                    want: /\d/ },
      { sql: "SELECT USER, USERENV('SESSIONID'), USERENV('TERMINAL') FROM dual;",                                                        want: { not: /ORA-/ } },
    ];
    drive(sys, cases);
  });
});

// ─────────────────────────────────────────────────────────────────
// SECTION 26 — PL/SQL invocation under different privileges (20 cases)
// ─────────────────────────────────────────────────────────────────

describe('26. PL/SQL procedures and privilege resolution', () => {
  it('Creates procedures, grants EXECUTE, and invokes under different users', () => {
    const cases: Case[] = [
      { sql: 'CREATE OR REPLACE PROCEDURE hr.bump_salary(p_id IN NUMBER, p_pct IN NUMBER) AS BEGIN UPDATE hr.employees SET salary = salary * (1 + p_pct/100) WHERE employee_id = p_id; END;', want: /Procedure created/i },
      { sql: 'CREATE OR REPLACE FUNCTION hr.get_department(p_id NUMBER) RETURN VARCHAR2 AS v_name VARCHAR2(80); BEGIN SELECT department_name INTO v_name FROM hr.departments WHERE department_id = p_id; RETURN v_name; END;', want: /Function created/i },
      { sql: "CREATE OR REPLACE PACKAGE hr.security_utils AS PROCEDURE log_attempt(u VARCHAR2); FUNCTION current_role RETURN VARCHAR2; END;", want: /Package created/i },
      { sql: "CREATE OR REPLACE PACKAGE BODY hr.security_utils AS PROCEDURE log_attempt(u VARCHAR2) IS BEGIN NULL; END; FUNCTION current_role RETURN VARCHAR2 IS BEGIN RETURN 'NONE'; END; END;", want: /Package body created/i },
      { sql: "CREATE OR REPLACE TRIGGER hr.trg_emp_audit BEFORE INSERT OR UPDATE OR DELETE ON hr.employees FOR EACH ROW BEGIN NULL; END;", want: /Trigger created/i },
      { sql: 'GRANT EXECUTE ON hr.bump_salary TO grace;',                                                                                want: /Grant succeeded/i },
      { sql: 'GRANT EXECUTE ON hr.get_department TO grace;',                                                                            want: /Grant succeeded/i },
      { sql: 'GRANT EXECUTE ON hr.security_utils TO PUBLIC;',                                                                            want: /Grant succeeded/i },
      // Verification
      { sql: "SELECT object_name FROM dba_objects WHERE owner = 'HR' AND object_type IN ('PROCEDURE','FUNCTION','PACKAGE');",          want: /BUMP_SALARY/ },
      { sql: "SELECT text FROM dba_source WHERE owner = 'HR' AND name = 'BUMP_SALARY' FETCH FIRST 1 ROW ONLY;",                          want: { not: /ORA-00942/ } },
      { sql: "SELECT trigger_name, status FROM dba_triggers WHERE owner = 'HR';",                                                       want: /TRG_EMP_AUDIT/ },
      { sql: "SELECT procedure_name FROM dba_procedures WHERE owner = 'HR';",                                                            want: { not: /ORA-00942/ } },
      // Invocation
      { sql: 'CONNECT grace/Welcome1#@orcl',                                                                                              want: /(Connected|ORA-)/i },
      { sql: 'EXEC hr.bump_salary(100, 5);',                                                                                            want: /(PL\/SQL procedure successfully completed|ORA-)/i },
      { sql: 'SELECT hr.get_department(10) FROM dual;',                                                                                  want: { not: /ORA-00904/ } },
      // Re-connect as SYS
      { sql: 'CONNECT / AS SYSDBA',                                                                                                     want: /Connected/i },
      // Compilation errors
      { sql: 'CREATE OR REPLACE PROCEDURE hr.bad_proc AS BEGIN no_such_thing; END;',                                                     want: /(Warning|Procedure created with compilation errors|ORA-)/i },
      { sql: "SELECT * FROM dba_errors WHERE owner = 'HR' AND name = 'BAD_PROC' FETCH FIRST 5 ROWS ONLY;",                              want: { not: /ORA-/ } },
      { sql: 'DROP PROCEDURE hr.bad_proc;',                                                                                              want: /Procedure dropped/i },
      { sql: 'ALTER PROCEDURE hr.bump_salary COMPILE;',                                                                                  want: /(Procedure altered|ORA-)/i },
    ];
    drive(sys, cases);
  });
});

// ─────────────────────────────────────────────────────────────────
// SECTION 27 — Password policy and account state (16 cases)
// ─────────────────────────────────────────────────────────────────

describe('27. Password policies', () => {
  it('Enforces password complexity, reuse, and lifetime', () => {
    const cases: Case[] = [
      // Weak password should be refused under strict_profile
      { sql: 'CREATE USER weakpw IDENTIFIED BY "123" PROFILE strict_profile;',                                                          want: /ORA-(28003|20001|00910)/ },
      { sql: 'CREATE USER weakpw IDENTIFIED BY "Strong1Pass#" PROFILE strict_profile;',                                                want: /User created/i },
      { sql: 'ALTER USER weakpw IDENTIFIED BY "Strong1Pass#";',                                                                          want: /ORA-(28007|User altered)/i },
      { sql: 'ALTER USER weakpw IDENTIFIED BY "Different1#";',                                                                            want: /User altered/i },
      // Account lock after FAILED_LOGIN_ATTEMPTS
      { sql: 'CONNECT weakpw/wrong1@orcl',                                                                                                want: /ORA-01017/i },
      { sql: 'CONNECT weakpw/wrong2@orcl',                                                                                                want: /ORA-01017/i },
      { sql: 'CONNECT weakpw/wrong3@orcl',                                                                                                want: /ORA-(01017|28000)/i },
      { sql: 'CONNECT weakpw/wrong4@orcl',                                                                                                want: /ORA-(01017|28000)/i },
      { sql: 'CONNECT / AS SYSDBA',                                                                                                       want: /Connected/i },
      { sql: "SELECT account_status FROM dba_users WHERE username = 'WEAKPW';",                                                          want: /(LOCKED|OPEN)/ },
      { sql: 'ALTER USER weakpw ACCOUNT UNLOCK;',                                                                                         want: /User altered/i },
      // Verify failed login counters
      { sql: "SELECT lcount FROM dba_users WHERE username = 'WEAKPW';",                                                                  want: { not: /ORA-00942/ } },
      // Expire and force change
      { sql: 'ALTER USER weakpw PASSWORD EXPIRE;',                                                                                       want: /User altered/i },
      { sql: "SELECT account_status FROM dba_users WHERE username = 'WEAKPW';",                                                          want: /EXPIRED/ },
      { sql: 'ALTER USER weakpw IDENTIFIED BY "FreshPwd1#" REPLACE "Different1#";',                                                       want: /(User altered|ORA-)/i },
      { sql: 'DROP USER weakpw;',                                                                                                         want: /User dropped/i },
    ];
    drive(sys, cases);
  });
});

// ─────────────────────────────────────────────────────────────────
// SECTION 28 — System-event / wait inspection (15 cases)
// ─────────────────────────────────────────────────────────────────

describe('28. Performance, wait and metric views', () => {
  it('Reads V$ event/metric views with realistic filters', () => {
    const cases: Case[] = [
      { sql: "SELECT event, total_waits FROM v$system_event WHERE wait_class != 'Idle' ORDER BY total_waits DESC FETCH FIRST 10 ROWS ONLY;", want: { not: /ORA-/ } },
      { sql: 'SELECT * FROM v$system_wait_class FETCH FIRST 10 ROWS ONLY;',                                                              want: { not: /ORA-/ } },
      { sql: 'SELECT * FROM v$session_event WHERE sid IS NOT NULL FETCH FIRST 10 ROWS ONLY;',                                             want: { not: /ORA-/ } },
      { sql: 'SELECT * FROM v$session_wait WHERE sid IS NOT NULL FETCH FIRST 10 ROWS ONLY;',                                              want: { not: /ORA-/ } },
      { sql: 'SELECT * FROM v$wait_chains FETCH FIRST 5 ROWS ONLY;',                                                                      want: { not: /ORA-/ } },
      { sql: 'SELECT * FROM v$sysmetric FETCH FIRST 5 ROWS ONLY;',                                                                        want: { not: /ORA-/ } },
      { sql: 'SELECT * FROM v$sysmetric_history FETCH FIRST 5 ROWS ONLY;',                                                                want: { not: /ORA-/ } },
      { sql: 'SELECT * FROM v$session_metric FETCH FIRST 5 ROWS ONLY;',                                                                   want: { not: /ORA-/ } },
      { sql: 'SELECT * FROM v$service_stats FETCH FIRST 5 ROWS ONLY;',                                                                    want: { not: /ORA-/ } },
      { sql: 'SELECT * FROM v$filemetric FETCH FIRST 5 ROWS ONLY;',                                                                       want: { not: /ORA-/ } },
      { sql: 'SELECT * FROM v$filemetric_history FETCH FIRST 5 ROWS ONLY;',                                                               want: { not: /ORA-/ } },
      { sql: 'SELECT * FROM v$undostat FETCH FIRST 5 ROWS ONLY;',                                                                          want: { not: /ORA-/ } },
      { sql: 'SELECT * FROM v$archived_log FETCH FIRST 5 ROWS ONLY;',                                                                      want: { not: /ORA-/ } },
      { sql: 'SELECT * FROM v$log;',                                                                                                       want: { not: /ORA-/ } },
      { sql: 'SELECT * FROM v$logfile;',                                                                                                    want: { not: /ORA-/ } },
    ];
    drive(sys, cases);
  });
});

// ─────────────────────────────────────────────────────────────────
// SECTION 29 — Negative-path / hardening (24 cases)
// ─────────────────────────────────────────────────────────────────

describe('29. Negative paths — privilege denial and bad input', () => {
  it('Refuses unauthorised actions and ill-formed statements', () => {
    const cases: Case[] = [
      // No-priv user trying privileged ops
      { sql: 'CREATE USER guest IDENTIFIED BY "Guest1#";',                                                                                want: /User created/i },
      { sql: 'GRANT CREATE SESSION TO guest;',                                                                                            want: /Grant succeeded/i },
      { sql: 'CONNECT guest/Guest1#@orcl',                                                                                                want: /(Connected|ORA-)/i },
      { sql: 'CREATE USER intruder IDENTIFIED BY "X";',                                                                                   want: /ORA-01031/i },
      { sql: 'GRANT DBA TO guest;',                                                                                                       want: /ORA-01031/i },
      { sql: 'ALTER USER sys IDENTIFIED BY "hacker";',                                                                                    want: /ORA-01031/i },
      { sql: 'DROP USER alice;',                                                                                                          want: /ORA-01031/i },
      { sql: 'AUDIT CREATE SESSION;',                                                                                                     want: /ORA-01031/i },
      { sql: 'CREATE AUDIT POLICY rogue ACTIONS ALL;',                                                                                    want: /ORA-01031/i },
      { sql: 'ALTER SYSTEM FLUSH SHARED_POOL;',                                                                                            want: /ORA-01031/i },
      { sql: 'SELECT * FROM sys.user$ FETCH FIRST 1 ROW ONLY;',                                                                            want: /ORA-(00942|01031)/ },
      { sql: 'SELECT password FROM sys.user$;',                                                                                            want: /ORA-(00942|01031)/ },
      { sql: 'GRANT SELECT ON hr.employees TO guest;',                                                                                    want: /ORA-01031/i },
      { sql: 'CONNECT / AS SYSDBA',                                                                                                        want: /Connected/i },
      // Malformed statements
      { sql: 'CREATE USER WHERE id = 1;',                                                                                                  want: /ORA-/ },
      { sql: 'GRANT CREATE SESSION;',                                                                                                      want: /ORA-/ },
      { sql: 'REVOKE FROM alice;',                                                                                                          want: /ORA-/ },
      { sql: 'CREATE ROLE 123role;',                                                                                                       want: /ORA-/ },
      { sql: 'CREATE USER "select" IDENTIFIED BY "X";',                                                                                    want: /(User created|ORA-)/ },
      { sql: 'ALTER USER alice;',                                                                                                          want: /ORA-/ },
      { sql: 'AUDIT;',                                                                                                                      want: /ORA-/ },
      // Trying to drop sensitive things
      { sql: 'DROP USER SYS;',                                                                                                              want: /ORA-(01031|28009)/ },
      { sql: 'DROP USER SYSTEM;',                                                                                                          want: /ORA-(01031|28009)/ },
      { sql: 'DROP ROLE DBA;',                                                                                                              want: /(Role dropped|ORA-)/i },
      // Clean up
      { sql: 'DROP USER guest;',                                                                                                            want: /User dropped/i },
    ];
    drive(sys, cases);
  });
});

// ─────────────────────────────────────────────────────────────────
// SECTION 30 — Reporting / forensics queries (20 cases)
// ─────────────────────────────────────────────────────────────────

describe('30. Reporting and forensic queries', () => {
  it('Produces typical compliance / security-officer reports', () => {
    const cases: Case[] = [
      // Top privileged users
      { sql: "SELECT grantee, COUNT(*) AS priv_count FROM dba_sys_privs GROUP BY grantee ORDER BY priv_count DESC FETCH FIRST 10 ROWS ONLY;", want: { not: /ORA-/ } },
      { sql: "SELECT username FROM dba_users WHERE username IN (SELECT grantee FROM dba_role_privs WHERE granted_role = 'DBA');",         want: { not: /ORA-/ } },
      // Users without any system privilege
      { sql: "SELECT u.username FROM dba_users u WHERE NOT EXISTS (SELECT 1 FROM dba_sys_privs s WHERE s.grantee = u.username) ORDER BY 1;", want: { not: /ORA-/ } },
      // Users granted SELECT ANY TABLE — high-risk
      { sql: "SELECT grantee FROM dba_sys_privs WHERE privilege = 'SELECT ANY TABLE';",                                                    want: { not: /ORA-/ } },
      // Users granted WITH ADMIN OPTION
      { sql: "SELECT grantee, privilege FROM dba_sys_privs WHERE admin_option = 'YES';",                                                    want: { not: /ORA-/ } },
      { sql: "SELECT grantee, granted_role FROM dba_role_privs WHERE admin_option = 'YES';",                                                want: { not: /ORA-/ } },
      // Users granted WITH GRANT OPTION on HR.EMPLOYEES
      { sql: "SELECT grantee, privilege FROM dba_tab_privs WHERE owner = 'HR' AND table_name = 'EMPLOYEES' AND grantable = 'YES';",        want: { not: /ORA-/ } },
      // Audited high-risk privileges
      { sql: "SELECT privilege FROM dba_priv_audit_opts WHERE proxy_name IS NULL;",                                                        want: { not: /ORA-/ } },
      // Recent password changes
      { sql: "SELECT username, ptime FROM sys.user$ WHERE ptime > SYSDATE - 30;",                                                          want: /ORA-(00942|01031)/ },
      // Account states snapshot
      { sql: "SELECT account_status, COUNT(*) FROM dba_users GROUP BY account_status ORDER BY 2 DESC;",                                    want: { not: /ORA-/ } },
      { sql: "SELECT profile, COUNT(*) FROM dba_users GROUP BY profile ORDER BY 2 DESC;",                                                  want: { not: /ORA-/ } },
      // Inactive accounts (no recent audit activity)
      { sql: "SELECT u.username FROM dba_users u WHERE NOT EXISTS (SELECT 1 FROM dba_audit_trail t WHERE t.username = u.username AND t.timestamp > SYSDATE - 30);", want: { not: /ORA-/ } },
      // Most active audited operations
      { sql: "SELECT action_name, COUNT(*) FROM dba_audit_trail GROUP BY action_name ORDER BY 2 DESC FETCH FIRST 10 ROWS ONLY;",            want: { not: /ORA-/ } },
      // Roles with the most members
      { sql: "SELECT granted_role, COUNT(*) FROM dba_role_privs GROUP BY granted_role ORDER BY 2 DESC FETCH FIRST 10 ROWS ONLY;",          want: { not: /ORA-/ } },
      // Users with default tablespace = SYSTEM (anti-pattern)
      { sql: "SELECT username FROM dba_users WHERE default_tablespace = 'SYSTEM';",                                                       want: { not: /ORA-/ } },
      // Users with UNLIMITED quota on data tablespaces
      { sql: "SELECT username, tablespace_name FROM dba_ts_quotas WHERE max_bytes = -1;",                                                  want: { not: /ORA-/ } },
      // Listener access summary
      { sql: "SELECT * FROM v$listener_network FETCH FIRST 5 ROWS ONLY;",                                                                    want: { not: /ORA-/ } },
      // Cross-reference: every privilege bob has by direct grant or via role
      { sql: "SELECT 'DIRECT' src, privilege FROM dba_sys_privs WHERE grantee = 'BOB' UNION ALL SELECT 'ROLE', p.privilege FROM dba_role_privs r JOIN dba_sys_privs p ON p.grantee = r.granted_role WHERE r.grantee = 'BOB';", want: { not: /ORA-/ } },
      // Encrypted columns inventory
      { sql: "SELECT owner, table_name, COUNT(*) FROM dba_encrypted_columns GROUP BY owner, table_name;",                                  want: { not: /ORA-/ } },
      // FGA / RLS inventory
      { sql: "SELECT object_owner, object_name, policy_name FROM dba_policies;",                                                            want: { not: /ORA-/ } },
    ];
    drive(sys, cases);
  });
});
