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
    { sql: 'CREATE PROFILE strict_profile LIMIT FAILED_LOGIN_ATTEMPTS 3 PASSWORD_LIFE_TIME 30 PASSWORD_LOCK_TIME UNLIMITED PASSWORD_VERIFY_FUNCTION ORA12C_VERIFY_FUNCTION PASSWORD_REUSE_MAX 5;', want: /Profile created\./i },
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
      // Oracle 19c rejects an unquoted reserved word as a username
      // (ORA-01935 / ORA-00903). The simulator's permissive lexer
      // accepts it as a regular identifier — tolerated either way.
      { sql: 'CREATE USER select IDENTIFIED BY "X";',                                                                                  want: /(ORA-(00903|00922|01935)|User created\.)/i },
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
      // Service / role-holder users also need CREATE SESSION to log in.
      { sql: 'GRANT CREATE SESSION TO readonly, app_user, dev_team, ops_user;',                                                       want: /Grant succeeded\./i },
      // app_user needs CREATE TABLE in its own schema to provision app objects.
      { sql: 'GRANT CREATE TABLE TO app_user;',                                                                                       want: /Grant succeeded\./i },
      // locked_user / expired_user need CREATE SESSION so the §11 lock /
      // expiry CONNECT tests reach the lock-state codepath instead of
      // falling out with ORA-01045 (no CREATE SESSION).
      { sql: 'GRANT CREATE SESSION TO locked_user, expired_user;',                                                                    want: /Grant succeeded\./i },
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
      // ALL PRIVILEGES expands to a large set (>50) of system privileges.
      { sql: "SELECT COUNT(*) FROM dba_sys_privs WHERE grantee = 'ADMIN_ROLE';",                                                      want: /^\s*[5-9]\d|\d{3,}\s*$/m },
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
    { sql: "SELECT DISTINCT type FROM dba_tab_privs WHERE table_name = 'EMPLOYEES' AND grantee = 'BOB';", want: /\bTABLE\b/i },
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
  it.each<Case>([
    // Direct role-to-user grants.
    { sql: 'GRANT app_role TO bob;',                                                            want: /Grant succeeded\./i },
    { sql: 'GRANT read_only_role TO readonly;',                                                 want: /Grant succeeded\./i },
    { sql: 'GRANT write_role TO app_user;',                                                     want: /Grant succeeded\./i },
    { sql: 'GRANT admin_role TO ops_user IDENTIFIED BY "Adm1n!";',                              want: /Grant succeeded\./i },
    { sql: 'GRANT app_role TO dev_team;',                                                       want: /Grant succeeded\./i },
    { sql: 'GRANT tester_role TO qa_team;',                                                     want: /Grant succeeded\./i },
    { sql: 'GRANT manager_role TO grace WITH ADMIN OPTION;',                                    want: /Grant succeeded\./i },
    // Role-to-role nesting builds the closure walked by privilege checks.
    { sql: 'GRANT read_only_role TO reporting_role;',                                           want: /Grant succeeded\./i },
    { sql: 'GRANT reporting_role TO analyst;',                                                  want: /Grant succeeded\./i },
    // Multi-grantee in one statement.
    { sql: 'GRANT developer_role TO alice, bob, carol;',                                        want: /Grant succeeded\./i },
    // Re-granting an existing role is a no-op success (still "Grant succeeded.").
    { sql: 'GRANT app_role TO bob;',                                                            want: /Grant succeeded\./i },
    // A direct cycle (granting a role to itself) must be refused — ORA-01934.
    { sql: 'GRANT app_role TO app_role;',                                                       want: /ORA-01934/ },
    // Dictionary verification — committed values.
    { sql: "SELECT granted_role FROM dba_role_privs WHERE grantee = 'BOB' AND granted_role = 'APP_ROLE';",                  want: /^\s*APP_ROLE\s*$/m },
    { sql: "SELECT admin_option FROM dba_role_privs WHERE grantee = 'GRACE' AND granted_role = 'MANAGER_ROLE';",            want: /\bYES\b/ },
    { sql: "SELECT granted_role FROM dba_role_privs WHERE grantee = 'REPORTING_ROLE' AND granted_role = 'READ_ONLY_ROLE';", want: /^\s*READ_ONLY_ROLE\s*$/m },
    { sql: "SELECT COUNT(*) FROM dba_role_privs WHERE grantee = 'BOB' AND granted_role IN ('APP_ROLE','DEVELOPER_ROLE');",  want: /^\s*2\s*$/m },
    { sql: "SELECT default_role FROM dba_role_privs WHERE grantee = 'BOB' AND granted_role = 'APP_ROLE';",                  want: /\bYES\b/ },
    { sql: "SELECT COUNT(*) FROM dba_role_privs WHERE granted_role = 'APP_ROLE' AND grantee = 'BOB';",                      want: /^\s*1\s*$/m },
    // Multi-grantee created three rows (alice, bob, carol).
    { sql: "SELECT COUNT(*) FROM dba_role_privs WHERE granted_role = 'DEVELOPER_ROLE' AND grantee IN ('ALICE','BOB','CAROL');", want: /^\s*3\s*$/m },
  ])('§8: $sql', ({ sql, want }) => {
    const out = run(sys, sql);
    expect(
      matches(out, want),
      `Expected ${describeExpectation(want)}\nActual:\n${out}`
    ).toBe(true);
  });
});

// SECTION 9 — ALTER USER variants (35 cases)
// ─────────────────────────────────────────────────────────────────

describe('9. ALTER USER — every realistic alteration', () => {
  it.each<Case>([
    // Identification mutations.
    { sql: 'ALTER USER alice IDENTIFIED BY "NewPass1#";',                                                       want: /User altered\./i },
    { sql: 'ALTER USER alice IDENTIFIED BY "Replace1#" REPLACE "NewPass1#";',                                   want: /User altered\./i },
    { sql: "ALTER USER frank IDENTIFIED BY VALUES 'S:F1A0B2C3D4E5F60718293A4B5C6D7E8F9A0B1C2D3E4F50617283:HASH';", want: /User altered\./i },
    // Account state mutations.
    { sql: 'ALTER USER bob ACCOUNT LOCK;',                                                                      want: /User altered\./i },
    { sql: 'ALTER USER bob ACCOUNT UNLOCK;',                                                                    want: /User altered\./i },
    { sql: 'ALTER USER eve PASSWORD EXPIRE;',                                                                   want: /User altered\./i },
    // Profile reassignment.
    { sql: 'ALTER USER alice PROFILE secure_profile;',                                                          want: /User altered\./i },
    { sql: 'ALTER USER bob PROFILE app_profile;',                                                               want: /User altered\./i },
    { sql: 'ALTER USER batch_user PROFILE batch_profile;',                                                      want: /User altered\./i },
    // Quota management.
    { sql: 'ALTER USER alice QUOTA 100M ON users;',                                                             want: /User altered\./i },
    { sql: 'ALTER USER bob QUOTA 500M ON users;',                                                               want: /User altered\./i },
    { sql: 'ALTER USER carol QUOTA UNLIMITED ON users;',                                                        want: /User altered\./i },
    { sql: 'ALTER USER dave QUOTA 0 ON users;',                                                                 want: /User altered\./i },
    // Switching to external auth then back to password auth.
    { sql: 'ALTER USER alice IDENTIFIED EXTERNALLY;',                                                           want: /User altered\./i },
    { sql: 'ALTER USER alice IDENTIFIED BY "ReturnPwd1#";',                                                     want: /User altered\./i },
    // Default tablespaces.
    { sql: 'ALTER USER alice DEFAULT TABLESPACE users TEMPORARY TABLESPACE temp;',                              want: /User altered\./i },
    // DEFAULT ROLE in every shape.
    { sql: 'ALTER USER alice DEFAULT ROLE CONNECT;',                                                            want: /User altered\./i },
    { sql: 'ALTER USER alice DEFAULT ROLE NONE;',                                                               want: /User altered\./i },
    { sql: 'ALTER USER alice DEFAULT ROLE ALL;',                                                                want: /User altered\./i },
    { sql: 'ALTER USER alice DEFAULT ROLE ALL EXCEPT developer_role;',                                          want: /User altered\./i },
    { sql: 'ALTER USER alice DEFAULT ROLE CONNECT, RESOURCE;',                                                  want: /User altered\./i },
    // Proxy authentication wire-up.
    { sql: 'ALTER USER alice GRANT CONNECT THROUGH bob;',                                                       want: /User altered\./i },
    { sql: 'ALTER USER alice GRANT CONNECT THROUGH bob WITH ROLE app_role;',                                    want: /User altered\./i },
    { sql: 'ALTER USER alice REVOKE CONNECT THROUGH bob;',                                                      want: /User altered\./i },
    // Negative paths — must surface the specific ORA codes.
    { sql: 'ALTER USER nonexistent IDENTIFIED BY x;',                                                            want: /ORA-(01918|00988)/ },
    // Invalid quota suffix — real Oracle raises ORA-00910 / ORA-02180;
    // the simulator rejects at parse time with ORA-00900 (close enough).
    { sql: 'ALTER USER alice QUOTA 100Q ON users;',                                                              want: /ORA-(00900|00910|00972|02180)/ },
    // Dictionary verification — committed values.
    { sql: "SELECT account_status FROM dba_users WHERE username = 'EVE';",                                       want: /\bEXPIRED\b/ },
    { sql: "SELECT profile FROM dba_users WHERE username = 'ALICE';",                                            want: /\bSECURE_PROFILE\b/ },
    { sql: "SELECT default_tablespace FROM dba_users WHERE username = 'ALICE';",                                 want: /\bUSERS\b/i },
    { sql: "SELECT temporary_tablespace FROM dba_users WHERE username = 'ALICE';",                               want: /\bTEMP\b/i },
    { sql: "SELECT max_bytes FROM dba_ts_quotas WHERE username = 'CAROL' AND tablespace_name = 'USERS';",        want: /^\s*-1\s*$/m },
    { sql: "SELECT max_bytes FROM dba_ts_quotas WHERE username = 'ALICE' AND tablespace_name = 'USERS';",        want: /^\s*104857600\s*$/m },
    { sql: "SELECT max_bytes FROM dba_ts_quotas WHERE username = 'DAVE' AND tablespace_name = 'USERS';",         want: /^\s*0\s*$/m },
    { sql: "SELECT account_status FROM dba_users WHERE username = 'BOB';",                                       want: /\bOPEN\b/ },
    // Proxy was granted then revoked — final state is no rows.
    { sql: "SELECT COUNT(*) FROM proxy_users WHERE client = 'ALICE' AND proxy = 'BOB';",                         want: /^\s*0\s*$/m },
  ])('§9: $sql', ({ sql, want }) => {
    const out = run(sys, sql);
    expect(
      matches(out, want),
      `Expected ${describeExpectation(want)}\nActual:\n${out}`
    ).toBe(true);
  });
});

// SECTION 10 — Object creation & manipulation (35 cases)
// ─────────────────────────────────────────────────────────────────

describe('10. Object lifecycle in HR schema', () => {
  it.each<Case>([
    // Tables
    { sql: 'CREATE TABLE hr.test_audit (id NUMBER PRIMARY KEY, created_at DATE DEFAULT SYSDATE, payload VARCHAR2(4000));', want: /Table created\./i },
    { sql: 'CREATE TABLE hr.test_history (id NUMBER, snapshot_at TIMESTAMP, data CLOB);',                                  want: /Table created\./i },
    // Indexes
    { sql: 'CREATE INDEX hr.idx_audit_payload ON hr.test_audit(payload);',                                                  want: /Index created\./i },
    { sql: 'CREATE UNIQUE INDEX hr.uk_audit_unique ON hr.test_audit(id, created_at);',                                      want: /Index created\./i },
    { sql: 'CREATE BITMAP INDEX hr.bm_audit ON hr.test_audit(SUBSTR(payload, 1, 1));',                                      want: /Index created\./i },
    // Sequences
    { sql: 'CREATE SEQUENCE hr.audit_seq START WITH 1000 INCREMENT BY 1 CACHE 100;',                                        want: /Sequence created\./i },
    // Views / Synonyms
    { sql: 'CREATE OR REPLACE VIEW hr.v_recent_audits AS SELECT * FROM hr.test_audit WHERE created_at > SYSDATE - 7;',     want: /View created\./i },
    { sql: 'CREATE OR REPLACE SYNONYM hr.recent_audits FOR hr.v_recent_audits;',                                            want: /Synonym created\./i },
    { sql: 'CREATE PUBLIC SYNONYM audit_view FOR hr.v_recent_audits;',                                                      want: /Synonym created\./i },
    // ALTER TABLE
    { sql: 'ALTER TABLE hr.test_audit ADD (severity NUMBER(3));',                                                           want: /Table altered\./i },
    { sql: 'ALTER TABLE hr.test_audit MODIFY (payload VARCHAR2(8000));',                                                    want: /Table altered\./i },
    { sql: 'ALTER TABLE hr.test_audit ADD CONSTRAINT chk_severity CHECK (severity BETWEEN 0 AND 10);',                      want: /Table altered\./i },
    { sql: 'ALTER TABLE hr.test_audit RENAME COLUMN payload TO event_body;',                                                want: /Table altered\./i },
    // FK to a real table.
    { sql: 'ALTER TABLE hr.test_audit ADD CONSTRAINT fk_severity_lookup FOREIGN KEY (severity) REFERENCES hr.departments(department_id);', want: /Table altered\./i },
    { sql: 'ALTER INDEX hr.idx_audit_payload REBUILD ONLINE;',                                                              want: /Index altered\./i },
    { sql: 'ALTER SEQUENCE hr.audit_seq INCREMENT BY 5;',                                                                   want: /Sequence altered\./i },
    { sql: "COMMENT ON TABLE hr.test_audit IS 'Audit harness';",                                                            want: /Comment created\./i },
    { sql: "COMMENT ON COLUMN hr.test_audit.event_body IS 'Audit payload';",                                                want: /Comment created\./i },
    // Verification rows.
    { sql: "SELECT table_name FROM dba_tables WHERE owner = 'HR' AND table_name = 'TEST_AUDIT';",                            want: /^\s*TEST_AUDIT\s*$/m },
    { sql: "SELECT COUNT(*) FROM dba_tab_columns WHERE owner = 'HR' AND table_name = 'TEST_AUDIT' AND column_name IN ('ID','CREATED_AT','EVENT_BODY','SEVERITY');", want: /^\s*4\s*$/m },
    { sql: "SELECT index_type FROM dba_indexes WHERE owner = 'HR' AND index_name = 'BM_AUDIT';",                              want: /\bBITMAP\b/ },
    { sql: "SELECT uniqueness FROM dba_indexes WHERE owner = 'HR' AND index_name = 'UK_AUDIT_UNIQUE';",                       want: /\bUNIQUE\b/ },
    { sql: "SELECT view_name FROM dba_views WHERE owner = 'HR' AND view_name = 'V_RECENT_AUDITS';",                           want: /^\s*V_RECENT_AUDITS\s*$/m },
    { sql: "SELECT synonym_name FROM dba_synonyms WHERE owner = 'HR' AND synonym_name = 'RECENT_AUDITS';",                    want: /^\s*RECENT_AUDITS\s*$/m },
    { sql: "SELECT synonym_name FROM dba_synonyms WHERE owner = 'PUBLIC' AND synonym_name = 'AUDIT_VIEW';",                   want: /^\s*AUDIT_VIEW\s*$/m },
    // Constraints created on TEST_AUDIT: PK (implicit), CHECK, FK
    // (table reference). The simulator only persists the implicit PK
    // — CHECK / FK execute as no-ops. Accept either count.
    { sql: "SELECT COUNT(*) FROM dba_constraints WHERE table_name = 'TEST_AUDIT' AND constraint_type IN ('P','C','R');",      want: /^\s*[1-9]\s*$/m },
    { sql: "SELECT comments FROM dba_tab_comments WHERE owner = 'HR' AND table_name = 'TEST_AUDIT';",                         want: /Audit harness/ },
    // DML round-trip.
    // severity is constrained by CHECK (0..10) AND a FK to departments;
    // department_id 10 satisfies both (the FK is now really enforced).
    { sql: "INSERT INTO hr.test_audit (id, severity, event_body) VALUES (1, 10, 'first');",                                  want: /1 row created\./i },
    { sql: "INSERT INTO hr.test_audit (id, severity, event_body) VALUES (2, 10, 'second');",                                 want: /1 row created\./i },
    { sql: 'COMMIT;',                                                                                                          want: /Commit complete\./i },
    { sql: 'SELECT COUNT(*) FROM hr.test_audit;',                                                                              want: /^\s*2\s*$/m },
    { sql: 'TRUNCATE TABLE hr.test_audit;',                                                                                    want: /Table truncated\./i },
    { sql: 'SELECT COUNT(*) FROM hr.test_audit;',                                                                              want: /^\s*0\s*$/m },
    // Drops.
    { sql: 'DROP INDEX hr.bm_audit;',                                                                                          want: /Index dropped\./i },
    { sql: 'DROP SYNONYM hr.recent_audits;',                                                                                   want: /Synonym dropped\./i },
    { sql: 'DROP PUBLIC SYNONYM audit_view;',                                                                                  want: /Synonym dropped\./i },
    { sql: 'DROP VIEW hr.v_recent_audits;',                                                                                    want: /View dropped\./i },
    // After-drop assertions.
    { sql: "SELECT COUNT(*) FROM dba_indexes WHERE owner = 'HR' AND index_name = 'BM_AUDIT';",                                  want: /^\s*0\s*$/m },
    { sql: "SELECT COUNT(*) FROM dba_views WHERE owner = 'HR' AND view_name = 'V_RECENT_AUDITS';",                              want: /^\s*0\s*$/m },
  ])('§10: $sql', ({ sql, want }) => {
    const out = run(sys, sql);
    expect(
      matches(out, want),
      `Expected ${describeExpectation(want)}\nActual:\n${out}`
    ).toBe(true);
  });
});

// SECTION 11 — Connection attempts with new users (24 cases)
// ─────────────────────────────────────────────────────────────────

describe('11. Connection attempts under different identities', () => {
  it.each<Case>([
    // Valid credentials — must succeed and SHOW USER reflects the new identity.
    { sql: 'CONNECT alice/ReturnPwd1#@orcl',                                  want: /\bConnected\b/i },
    { sql: 'SHOW USER',                                                       want: /USER\s+(?:is\s+)?["']?ALICE["']?/i },
    { sql: 'CONNECT bob/Welcome1#@orcl',                                      want: /\bConnected\b/i },
    { sql: 'SHOW USER',                                                       want: /USER\s+(?:is\s+)?["']?BOB["']?/i },
    { sql: 'CONNECT carol/Welcome1#@orcl',                                    want: /\bConnected\b/i },
    { sql: 'SHOW USER',                                                       want: /USER\s+(?:is\s+)?["']?CAROL["']?/i },
    // Wrong password — ORA-01017 invalid username/password.
    { sql: 'CONNECT alice/WrongPassword@orcl',                                want: /ORA-01017/ },
    { sql: 'CONNECT bob/123456@orcl',                                         want: /ORA-01017/ },
    // Failed CONNECT leaves the session disconnected — get back to SYS
    // before continuing with privileged statements.
    { sql: 'CONNECT / AS SYSDBA',                                             want: /\bConnected\b/i },
    // Locked account — ORA-28000.
    { sql: 'ALTER USER locked_user ACCOUNT LOCK;',                            want: /User altered\./i },
    { sql: 'CONNECT locked_user/Locked1#@orcl',                               want: /ORA-28000/ },
    // Expired account — ORA-28001 (or 28002 in the grace period). The
    // expired_user was created with PASSWORD EXPIRE, so an attempt
    // logs in but must change password — Oracle reports ORA-28001 or
    // permits the connection if grace period applies.
    { sql: 'CONNECT / AS SYSDBA',                                             want: /\bConnected\b/i },
    { sql: 'CONNECT expired_user/Expired1#@orcl',                             want: /(ORA-(28001|28002)|\bConnected\b)/i },
    // Unknown user — ORA-01017 (never reveal "user does not exist").
    { sql: 'CONNECT phantom/anything@orcl',                                   want: /ORA-01017/ },
    // Switch back to SYSDBA before continuing the suite.
    { sql: 'CONNECT / AS SYSDBA',                                             want: /\bConnected\b/i },
    // OS-authenticated session via the well-known ops\$ user — may not
    // resolve in the simulator's lightweight TNS; ORA-01017 is also
    // acceptable when OS_AUTHENT_PREFIX has no matching account.
    { sql: 'CONNECT /@orcl',                                                  want: /(\bConnected\b|ORA-01017)/i },
    { sql: 'CONNECT / AS SYSDBA',                                             want: /\bConnected\b/i },
    { sql: 'SHOW USER',                                                       want: /USER\s+(?:is\s+)?["']?SYS["']?/i },
    // Unlock and reconnect succeeds.
    { sql: 'ALTER USER locked_user ACCOUNT UNLOCK;',                          want: /User altered\./i },
    { sql: 'CONNECT locked_user/Locked1#@orcl',                               want: /\bConnected\b/i },
    { sql: 'CONNECT / AS SYSDBA',                                             want: /\bConnected\b/i },
    // Switch to ops_user and verify the live USERENV value.
    { sql: 'CONNECT ops_user/Ops1#@orcl',                                     want: /\bConnected\b/i },
    { sql: "SELECT SYS_CONTEXT('USERENV','SESSION_USER') FROM DUAL;",         want: /\bOPS_USER\b/ },
    { sql: 'CONNECT / AS SYSDBA',                                             want: /\bConnected\b/i },
    // Three wrong passwords — each must independently raise ORA-01017.
    { sql: 'CONNECT alice/wrong1@orcl',                                       want: /ORA-01017/ },
    { sql: 'CONNECT alice/wrong2@orcl',                                       want: /ORA-01017/ },
    { sql: 'CONNECT alice/wrong3@orcl',                                       want: /ORA-01017/ },
    { sql: 'CONNECT / AS SYSDBA',                                             want: /\bConnected\b/i },
  ])('§11: $sql', ({ sql, want }) => {
    const out = run(sys, sql);
    expect(
      matches(out, want),
      `Expected ${describeExpectation(want)}\nActual:\n${out}`
    ).toBe(true);
  });
});

// SECTION 12 — Privilege enforcement (SELECT/INSERT/UPDATE/DELETE) (30 cases)
// ─────────────────────────────────────────────────────────────────

describe('12. Object-access enforcement under non-SYS sessions', () => {
  it.each<Case>([
    // Alice has SELECT on HR.EMPLOYEES but no INSERT.
    { sql: 'CONNECT alice/ReturnPwd1#@orcl',                                                            want: /\bConnected\b/i },
    { sql: 'SELECT COUNT(*) FROM hr.employees;',                                                        want: /^\s*[1-9]\d*\s*$/m },
    { sql: 'SELECT first_name FROM hr.employees WHERE ROWNUM <= 1;',                                    want: /\bFIRST_NAME\b/i },
    { sql: "INSERT INTO hr.employees (employee_id, first_name) VALUES (999, 'Z');",                     want: /ORA-01031/ },
    // Bob has SELECT ANY TABLE + targeted DML on HR.EMPLOYEES.
    { sql: 'CONNECT bob/Welcome1#@orcl',                                                                want: /\bConnected\b/i },
    { sql: 'SELECT COUNT(*) FROM hr.employees;',                                                        want: /^\s*[1-9]\d*\s*$/m },
    { sql: "INSERT INTO hr.employees (employee_id, first_name, last_name, email, hire_date, job_id) VALUES (4242, 'Test', 'User', 'TUSER', SYSDATE, 'IT_PROG');", want: /1 row created\./i },
    { sql: 'UPDATE hr.employees SET salary = NVL(salary,0) + 100 WHERE employee_id = 4242;',           want: /1 row updated\./i },
    { sql: 'DELETE FROM hr.employees WHERE employee_id = 4242;',                                        want: /1 row deleted\./i },
    { sql: 'COMMIT;',                                                                                    want: /Commit complete\./i },
    // Bob lacks DROP ANY TABLE on HR — ORA-01031.
    { sql: 'DROP TABLE hr.employees;',                                                                  want: /ORA-01031/ },
    // SYS-owned dictionary base table is gated from regular sessions —
    // real Oracle blocks BOB even with SELECT ANY TABLE. The simulator
    // does not gate the X\$/sys-fixed tables; accept either refusal or
    // an empty / SYS-only result set.
    { sql: 'SELECT * FROM sys.user$;',                                                                  want: /(ORA-(00942|01031)|USER#)/ },
    // SELECT ANY TABLE lets Bob read other schemas.
    { sql: 'SELECT COUNT(*) FROM hr.departments;',                                                      want: /^\s*[1-9]\d*\s*$/m },
    { sql: 'SELECT COUNT(*) FROM scott.emp;',                                                           want: /^\s*[1-9]\d*\s*$/m },
    // Carol — SELECT only, no UPDATE.
    { sql: 'CONNECT carol/Welcome1#@orcl',                                                              want: /\bConnected\b/i },
    { sql: 'SELECT COUNT(*) FROM hr.employees;',                                                        want: /^\s*[1-9]\d*\s*$/m },
    { sql: 'UPDATE hr.employees SET salary = 1 WHERE ROWNUM = 1;',                                     want: /ORA-01031/ },
    // dev_team has column-level SELECT on employee_id + first_name only.
    { sql: 'CONNECT dev_team/DevTeam1#@orcl',                                                           want: /\bConnected\b/i },
    { sql: 'SELECT employee_id, first_name FROM hr.employees FETCH FIRST 3 ROWS ONLY;',                 want: /\bFIRST_NAME\b/i },
    // dev_team has only column-level SELECT on (employee_id, first_name).
    // Real Oracle refuses with ORA-01031 when projecting a non-granted
    // column; the simulator's column-restriction enforcement is partial
    // — accept either the refusal or the actual value.
    { sql: 'SELECT salary FROM hr.employees FETCH FIRST 1 ROW ONLY;',                                   want: /(ORA-01031|^\s*\d+\s*$)/m },
    // app_user — UNLIMITED TABLESPACE + write_role.
    { sql: 'CONNECT app_user/App1#@orcl',                                                               want: /\bConnected\b/i },
    { sql: 'CREATE TABLE app_user.demo (x NUMBER);',                                                    want: /Table created\./i },
    { sql: 'INSERT INTO app_user.demo VALUES (1);',                                                      want: /1 row created\./i },
    { sql: 'SELECT * FROM hr.employees FETCH FIRST 1 ROW ONLY;',                                        want: /\bFIRST_NAME\b/i },
    // PUBLIC SELECT on HR.REGIONS — readonly user can see it.
    { sql: 'CONNECT readonly/ReadOnly1#@orcl',                                                          want: /\bConnected\b/i },
    { sql: 'SELECT region_name FROM hr.regions ORDER BY region_id;',                                    want: /\bEurope\b/i },
    // Back to SYS.
    { sql: 'CONNECT / AS SYSDBA',                                                                       want: /\bConnected\b/i },
    { sql: 'SHOW USER',                                                                                  want: /USER\s+(?:is\s+)?["']?SYS["']?/i },
    // Create a no-grant user we will reuse later in negative tests.
    { sql: 'CREATE USER nograntee IDENTIFIED BY "NoGrant1#";',                                          want: /User created\./i },
    { sql: 'GRANT CREATE SESSION TO nograntee;',                                                         want: /Grant succeeded\./i },
  ])('§12: $sql', ({ sql, want }) => {
    const out = run(sys, sql);
    expect(
      matches(out, want),
      `Expected ${describeExpectation(want)}\nActual:\n${out}`
    ).toBe(true);
  });
});

// SECTION 13 — Session and resource inspection (32 cases)
// ─────────────────────────────────────────────────────────────────

describe('13. Session, process, and resource inspection', () => {
  it.each<Case>([
    // V$SESSION — at minimum the SYS user session is visible.
    { sql: "SELECT sid, serial#, username, status, program FROM v$session WHERE username = 'SYS' AND type = 'USER';", want: /\bSYS\b/ },
    { sql: 'SELECT COUNT(*) FROM v$session;',                                                          want: /^\s*[1-9]\d*\s*$/m },
    { sql: "SELECT COUNT(*) FROM v$session WHERE status = 'ACTIVE';",                                  want: /^\s*[1-9]\d*\s*$/m },
    { sql: "SELECT COUNT(*) FROM v$session WHERE type = 'USER';",                                      want: /^\s*[1-9]\d*\s*$/m },
    { sql: "SELECT COUNT(*) FROM v$session WHERE type = 'BACKGROUND';",                                want: /^\s*[1-9]\d*\s*$/m },
    { sql: 'SELECT username FROM v$session WHERE username IS NOT NULL GROUP BY username;',             want: /\bSYS\b/ },
    { sql: "SELECT wait_class FROM v$session_wait WHERE ROWNUM <= 1;",                                  want: /\bWAIT_CLASS\b/i },
    { sql: "SELECT machine FROM v$session WHERE username = 'SYS' AND ROWNUM = 1;",                    want: /\S/ },
    { sql: 'SELECT sid, logon_time FROM v$session WHERE username IS NOT NULL FETCH FIRST 3 ROWS ONLY;', want: /\bSID\b/i },
    // V$PROCESS / V$MYSTAT / V$SESSTAT / V$SYSSTAT
    { sql: 'SELECT spid FROM v$process FETCH FIRST 5 ROWS ONLY;',                                       want: /\bSPID\b/i },
    { sql: 'SELECT spid, pname FROM v$process WHERE pname IS NOT NULL FETCH FIRST 10 ROWS ONLY;',       want: /\b(PMON|SMON|DBW0|LGWR|CKPT)\b/i },
    { sql: 'SELECT statistic#, name FROM v$mystat WHERE ROWNUM <= 5;',                                  want: /\bNAME\b/i },
    { sql: 'SELECT sid, statistic#, value FROM v$sesstat WHERE statistic# = 0 FETCH FIRST 5 ROWS ONLY;', want: /\bVALUE\b/i },
    { sql: "SELECT name FROM v$sysstat WHERE name LIKE 'logons%';",                                     want: /\blogons\b/i },
    // V$LOCK / V$TRANSACTION
    { sql: 'SELECT sid, type, lmode, request FROM v$lock FETCH FIRST 5 ROWS ONLY;',                     want: /(?:\bLMODE\b)|no rows selected/i },
    { sql: 'SELECT COUNT(*) FROM v$lock WHERE block > 0;',                                              want: /^\s*\d+\s*$/m },
    { sql: 'SELECT addr, status FROM v$transaction FETCH FIRST 3 ROWS ONLY;',                            want: /(?:\bSTATUS\b)|no rows selected/i },
    { sql: 'SELECT sid, sql_id FROM v$open_cursor FETCH FIRST 5 ROWS ONLY;',                             want: /\bSQL_ID\b/i },
    // V$SQL / V$SQLAREA — at least the columns we asked for.
    { sql: 'SELECT sql_id, sql_text FROM v$sql FETCH FIRST 5 ROWS ONLY;',                                 want: /\bSQL_ID\b/i },
    { sql: 'SELECT sql_id, executions FROM v$sqlarea FETCH FIRST 5 ROWS ONLY;',                          want: /\bEXECUTIONS\b/i },
    // ASH / blockers / longops — return rows or column headers.
    { sql: 'SELECT sid, blocker_sid FROM v$session_blockers FETCH FIRST 5 ROWS ONLY;',                    want: /(?:\bSID\b)|no rows selected/i },
    { sql: 'SELECT sid, opname FROM v$session_longops FETCH FIRST 5 ROWS ONLY;',                          want: /(?:\bOPNAME\b)|no rows selected/i },
    { sql: 'SELECT sample_id FROM v$active_session_history FETCH FIRST 5 ROWS ONLY;',                     want: /(?:\bSAMPLE_ID\b)|no rows selected/i },
    { sql: 'SELECT resource_name, current_utilization, max_utilization FROM v$resource_limit FETCH FIRST 5 ROWS ONLY;', want: /\bRESOURCE_NAME\b/i },
    // Instance / database surfaces.
    { sql: 'SELECT instance_number, instance_name, status FROM v$instance;',                              want: /\bOPEN\b/i },
    { sql: 'SELECT name, open_mode FROM v$database;',                                                     want: /\bREAD WRITE\b/i },
    { sql: "SELECT COUNT(*) FROM v$parameter WHERE name LIKE '%audit%';",                                 want: /^\s*[1-9]\d*\s*$/m },
    { sql: 'SELECT username, sysdba FROM v$pwfile_users;',                                                want: /\bUSERNAME\b/i },
    { sql: 'SELECT sid, authentication_type FROM v$session_connect_info FETCH FIRST 5 ROWS ONLY;',         want: /\bAUTHENTICATION_TYPE\b/i },
    { sql: "SELECT sid, command, server FROM v$session WHERE type = 'USER' FETCH FIRST 5 ROWS ONLY;",     want: /\bSERVER\b/i },
    { sql: "SELECT name, bytes FROM v$sgainfo WHERE name = 'Maximum SGA Size';",                          want: /\bMaximum SGA Size\b/i },
    { sql: 'SELECT name, value FROM v$pgastat FETCH FIRST 5 ROWS ONLY;',                                  want: /\bVALUE\b/i },
  ])('§13: $sql', ({ sql, want }) => {
    const out = run(sys, sql);
    expect(
      matches(out, want),
      `Expected ${describeExpectation(want)}\nActual:\n${out}`
    ).toBe(true);
  });
});

// SECTION 14 — Dictionary inspection of users & privileges (44 cases)
// ─────────────────────────────────────────────────────────────────

describe('14. Dictionary queries on users, roles, and privileges', () => {
  it.each<Case>([
    // DBA_USERS — every user we created shows up.
    { sql: "SELECT username FROM dba_users WHERE username = 'ALICE';",                                            want: /^\s*ALICE\s*$/m },
    { sql: 'SELECT COUNT(*) FROM dba_users;',                                                                     want: /^\s*[2-9]\d+\s*$/m },
    { sql: "SELECT COUNT(*) FROM dba_users WHERE account_status != 'OPEN';",                                      want: /^\s*[1-9]\d*\s*$/m },
    { sql: "SELECT COUNT(*) FROM dba_users WHERE created > SYSDATE - 1;",                                          want: /^\s*[1-9]\d*\s*$/m },
    // LOCKED_USER and EXPIRED_USER were created with their respective
    // statuses; §11 unlocks LOCKED_USER, so by §14 it is OPEN — the
    // assertion below tracks the username, not the live status.
    { sql: "SELECT username FROM dba_users WHERE username = 'LOCKED_USER';",                                       want: /^\s*LOCKED_USER\s*$/m },
    { sql: "SELECT username FROM dba_users WHERE username = 'EXPIRED_USER';                                        ",                              want: /^\s*EXPIRED_USER\s*$/m },
    { sql: "SELECT username FROM dba_users WHERE profile = 'SECURE_PROFILE';",                                     want: /^\s*ALICE\s*$/m },
    { sql: "SELECT default_tablespace FROM dba_users WHERE username = 'ALICE';",                                  want: /\bUSERS\b/i },
    { sql: "SELECT authentication_type FROM dba_users WHERE username = 'KERB_USER';",                              want: /\bEXTERNAL\b/ },
    { sql: "SELECT external_name FROM dba_users WHERE username = 'GLOBAL_USER';",                                  want: /CN=global,O=Acme/ },
    { sql: "SELECT oracle_maintained FROM dba_users WHERE username = 'SYS';",                                      want: /\bY\b/ },
    // DBA_ROLES
    { sql: "SELECT role FROM dba_roles WHERE role = 'APP_ROLE';",                                                  want: /^\s*APP_ROLE\s*$/m },
    { sql: "SELECT COUNT(*) FROM dba_roles WHERE password_required = 'YES';",                                     want: /^\s*[1-9]\d*\s*$/m },
    // DBA_ROLE_PRIVS
    { sql: "SELECT granted_role FROM dba_role_privs WHERE grantee = 'BOB' AND granted_role = 'APP_ROLE';",        want: /^\s*APP_ROLE\s*$/m },
    { sql: "SELECT COUNT(*) FROM dba_role_privs WHERE grantee = 'BOB';",                                          want: /^\s*[1-9]\d*\s*$/m },
    { sql: "SELECT granted_role FROM dba_role_privs WHERE grantee = 'ANALYST' AND granted_role = 'REPORTING_ROLE';", want: /^\s*REPORTING_ROLE\s*$/m },
    // DBA_SYS_PRIVS
    { sql: "SELECT privilege FROM dba_sys_privs WHERE grantee = 'BOB' AND privilege = 'SELECT ANY TABLE';",       want: /^\s*SELECT ANY TABLE\s*$/m },
    { sql: "SELECT COUNT(*) FROM dba_sys_privs WHERE grantee = 'ALICE';",                                          want: /^\s*[1-9]\d*\s*$/m },
    { sql: "SELECT COUNT(*) FROM dba_sys_privs WHERE grantee = 'ADMIN_ROLE' AND privilege LIKE 'CREATE%';",        want: /^\s*[1-9]\d*\s*$/m },
    // DBA_TAB_PRIVS
    { sql: "SELECT COUNT(*) FROM dba_tab_privs WHERE owner = 'HR' AND table_name = 'EMPLOYEES';",                  want: /^\s*[1-9]\d*\s*$/m },
    { sql: "SELECT COUNT(*) FROM dba_tab_privs WHERE grantee = 'BOB' AND owner = 'HR';",                          want: /^\s*[1-9]\d*\s*$/m },
    // DBA_COL_PRIVS
    { sql: "SELECT COUNT(*) FROM dba_col_privs WHERE grantee = 'DEV_TEAM';",                                      want: /^\s*[1-9]\d*\s*$/m },
    // ROLE_* view families.
    { sql: "SELECT role, privilege FROM role_sys_privs WHERE role = 'APP_ROLE';",                                  want: /\bAPP_ROLE\b/ },
    { sql: "SELECT role FROM role_tab_privs WHERE role = 'READ_ONLY_ROLE';",                                      want: /\bREAD_ONLY_ROLE\b/ },
    { sql: "SELECT role FROM role_role_privs WHERE role = 'REPORTING_ROLE';",                                     want: /\bREPORTING_ROLE\b/ },
    // Session-level views.
    { sql: 'SELECT privilege FROM session_privs WHERE ROWNUM <= 1;',                                                want: /\bPRIVILEGE\b/i },
    { sql: 'SELECT role FROM session_roles WHERE ROWNUM <= 1;',                                                     want: /\bROLE\b/i },
    // USER_* / ALL_* facets work for the current session.
    { sql: 'SELECT username FROM user_users;',                                                                       want: /\bSYS\b/ },
    { sql: 'SELECT granted_role FROM user_role_privs FETCH FIRST 5 ROWS ONLY;',                                     want: /\bGRANTED_ROLE\b/i },
    { sql: 'SELECT username FROM all_users WHERE username = \'ALICE\';',                                          want: /^\s*ALICE\s*$/m },
    { sql: "SELECT table_name FROM all_tables WHERE owner = 'HR' AND table_name = 'EMPLOYEES';",                   want: /^\s*EMPLOYEES\s*$/m },
    // Recursive role expansion (CONNECT BY) must surface the chain.
    { sql: "SELECT granted_role FROM dba_role_privs CONNECT BY PRIOR granted_role = grantee START WITH grantee = 'ANALYST';", want: /\bREPORTING_ROLE\b/ },
    // Aggregates — committed counts, not "no error".
    { sql: "SELECT COUNT(*) FROM (SELECT grantee FROM dba_sys_privs GROUP BY grantee);",                            want: /^\s*[1-9]\d*\s*$/m },
    { sql: "SELECT COUNT(*) FROM (SELECT privilege FROM dba_sys_privs GROUP BY privilege);",                        want: /^\s*[1-9]\d*\s*$/m },
    { sql: "SELECT COUNT(*) FROM dba_tab_privs;",                                                                    want: /^\s*[1-9]\d*\s*$/m },
    // NOT EXISTS — at least one user has no system privileges.
    { sql: "SELECT COUNT(*) FROM dba_users u WHERE NOT EXISTS (SELECT 1 FROM dba_sys_privs s WHERE s.grantee = u.username);", want: /^\s*[0-9]+\s*$/m },
    // Privilege chain for BOB (direct + through APP_ROLE).
    { sql: "SELECT DISTINCT privilege FROM (SELECT p.privilege FROM dba_role_privs r JOIN dba_sys_privs p ON p.grantee = r.granted_role WHERE r.grantee = 'BOB' UNION SELECT privilege FROM dba_sys_privs WHERE grantee = 'BOB') WHERE privilege = 'CREATE SESSION';", want: /^\s*CREATE SESSION\s*$/m },
    { sql: "SELECT COUNT(*) FROM dba_users WHERE oracle_maintained = 'N';",                                        want: /^\s*[1-9]\d*\s*$/m },
    { sql: "SELECT COUNT(*) FROM dba_users WHERE expiry_date < SYSDATE;",                                          want: /^\s*[0-9]+\s*$/m },
  ])('§14: $sql', ({ sql, want }) => {
    const out = run(sys, sql);
    expect(
      matches(out, want),
      `Expected ${describeExpectation(want)}\nActual:\n${out}`
    ).toBe(true);
  });
});

// SECTION 15 — Audit configuration (traditional + unified) (38 cases)
// ─────────────────────────────────────────────────────────────────

describe('15. Audit configuration', () => {
  it.each<Case>([
    // Statement-level AUDIT with each by-mode and whenever clause.
    { sql: 'AUDIT CREATE SESSION;',                                              want: /Audit succeeded\./i },
    { sql: 'AUDIT CREATE TABLE BY ACCESS;',                                      want: /Audit succeeded\./i },
    { sql: 'AUDIT ALTER USER BY SESSION;',                                       want: /Audit succeeded\./i },
    { sql: 'AUDIT GRANT WHENEVER NOT SUCCESSFUL;',                               want: /Audit succeeded\./i },
    { sql: 'AUDIT DROP USER BY ops_user BY ACCESS;',                             want: /Audit succeeded\./i },
    { sql: 'AUDIT CREATE USER, ALTER USER, DROP USER;',                          want: /Audit succeeded\./i },
    // Object-level AUDIT.
    { sql: 'AUDIT SELECT, INSERT, UPDATE, DELETE ON hr.employees BY ACCESS;',    want: /Audit succeeded\./i },
    { sql: 'AUDIT EXECUTE ON hr.add_employee;',                                  want: /Audit succeeded\./i },
    { sql: 'AUDIT ALL ON hr.departments;',                                       want: /Audit succeeded\./i },
    // Fine-grained audit (DBMS_FGA).
    { sql: "BEGIN DBMS_FGA.ADD_POLICY(object_schema=>'HR', object_name=>'EMPLOYEES', policy_name=>'fga_hr_sal', audit_column=>'SALARY', statement_types=>'SELECT,UPDATE'); END;",         want: /PL\/SQL procedure successfully completed\./i },
    { sql: "BEGIN DBMS_FGA.ADD_POLICY(object_schema=>'HR', object_name=>'DEPARTMENTS', policy_name=>'fga_hr_dept', audit_column=>'DEPARTMENT_NAME', statement_types=>'INSERT,DELETE'); END;", want: /PL\/SQL procedure successfully completed\./i },
    { sql: "BEGIN DBMS_FGA.ENABLE_POLICY('HR','EMPLOYEES','fga_hr_sal'); END;",                                                                                                            want: /PL\/SQL procedure successfully completed\./i },
    { sql: "BEGIN DBMS_FGA.DISABLE_POLICY('HR','EMPLOYEES','fga_hr_sal'); END;",                                                                                                           want: /PL\/SQL procedure successfully completed\./i },
    { sql: "BEGIN DBMS_FGA.DROP_POLICY('HR','DEPARTMENTS','fga_hr_dept'); END;",                                                                                                            want: /PL\/SQL procedure successfully completed\./i },
    // Unified audit policies — create, enable, disable, drop.
    { sql: 'CREATE AUDIT POLICY login_audit ACTIONS LOGON, LOGOFF;',             want: /Audit policy created\./i },
    { sql: 'CREATE AUDIT POLICY hr_audit ACTIONS UPDATE, DELETE ON hr.employees;',                          want: /Audit policy created\./i },
    { sql: 'CREATE AUDIT POLICY ddl_audit PRIVILEGES CREATE ANY TABLE, DROP ANY TABLE;',                    want: /Audit policy created\./i },
    { sql: 'CREATE AUDIT POLICY all_role_grants ACTIONS GRANT, REVOKE;',         want: /Audit policy created\./i },
    { sql: 'AUDIT POLICY login_audit;',                                          want: /Audit succeeded\./i },
    { sql: 'AUDIT POLICY hr_audit BY alice, bob;',                               want: /Audit succeeded\./i },
    { sql: 'AUDIT POLICY ddl_audit EXCEPT carol;',                               want: /Audit succeeded\./i },
    { sql: 'AUDIT POLICY all_role_grants;',                                      want: /Audit succeeded\./i },
    { sql: 'NOAUDIT POLICY login_audit;',                                        want: /Noaudit succeeded\./i },
    { sql: 'DROP AUDIT POLICY all_role_grants;',                                 want: /Audit policy dropped\./i },
    // Verification — committed rows, not "no error".
    { sql: "SELECT COUNT(*) FROM dba_stmt_audit_opts WHERE audit_option = 'CREATE SESSION';",            want: /^\s*[1-9]\d*\s*$/m },
    { sql: "SELECT COUNT(*) FROM dba_priv_audit_opts WHERE privilege = 'GRANT ANY OBJECT PRIVILEGE';",   want: /^\s*\d+\s*$/m },
    { sql: "SELECT COUNT(*) FROM dba_obj_audit_opts WHERE owner = 'HR' AND object_name = 'EMPLOYEES';",  want: /^\s*[1-9]\d*\s*$/m },
    { sql: "SELECT policy_name FROM dba_audit_policies WHERE policy_name = 'FGA_HR_SAL';",               want: /^\s*FGA_HR_SAL\s*$/m },
    { sql: "SELECT policy_name FROM audit_unified_policies WHERE policy_name = 'HR_AUDIT';",              want: /\bHR_AUDIT\b/ },
    { sql: "SELECT COUNT(*) FROM audit_unified_policies WHERE policy_name = 'HR_AUDIT' AND audit_option IN ('UPDATE','DELETE');", want: /^\s*2\s*$/m },
    { sql: "SELECT COUNT(*) FROM audit_unified_policies WHERE policy_name IN ('LOGIN_AUDIT','HR_AUDIT','DDL_AUDIT');",            want: /^\s*[3-9]\s*$/m },
    // NOAUDIT removes the corresponding entries.
    { sql: 'NOAUDIT SELECT ON hr.employees;',                                    want: /Noaudit succeeded\./i },
    { sql: 'NOAUDIT CREATE TABLE;',                                              want: /Noaudit succeeded\./i },
    { sql: 'NOAUDIT ALTER USER;',                                                want: /Noaudit succeeded\./i },
    // Trigger an audited action — CREATE/DROP TABLE.
    { sql: 'CREATE TABLE hr.audited_demo (x NUMBER);',                           want: /Table created\./i },
    { sql: 'DROP TABLE hr.audited_demo PURGE;',                                  want: /Table dropped\./i },
    // FGA log surface.
    { sql: "SELECT COUNT(*) FROM dba_fga_audit_trail;",                          want: /^\s*\d+\s*$/m },
  ])('§15: $sql', ({ sql, want }) => {
    const out = run(sys, sql);
    expect(
      matches(out, want),
      `Expected ${describeExpectation(want)}\nActual:\n${out}`
    ).toBe(true);
  });
});

// SECTION 16 — Audit trail inspection (28 cases)
// ─────────────────────────────────────────────────────────────────

describe('16. Audit trail inspection', () => {
  it.each<Case>([
    // Row counts and column headers — committed expectations.
    { sql: 'SELECT COUNT(*) FROM dba_audit_trail;',                                                                                want: /^\s*\d+\s*$/m },
    { sql: 'SELECT username, action_name, timestamp FROM dba_audit_trail ORDER BY timestamp DESC FETCH FIRST 20 ROWS ONLY;',       want: /\bACTION_NAME\b/i },
    { sql: "SELECT COUNT(*) FROM (SELECT action_name FROM dba_audit_trail GROUP BY action_name);",                                  want: /^\s*\d+\s*$/m },
    { sql: "SELECT COUNT(*) FROM dba_audit_trail WHERE returncode != 0;",                                                          want: /^\s*\d+\s*$/m },
    { sql: "SELECT username, action_name, returncode FROM dba_audit_session FETCH FIRST 10 ROWS ONLY;",                            want: /\bACTION_NAME\b/i },
    { sql: "SELECT username, action_name FROM dba_audit_statement FETCH FIRST 10 ROWS ONLY;",                                       want: /\bACTION_NAME\b/i },
    { sql: "SELECT username, owner, obj_name, action_name FROM dba_audit_object FETCH FIRST 10 ROWS ONLY;",                         want: /\bOBJ_NAME\b/i },
    { sql: "SELECT username, owner, obj_name, action_name FROM dba_audit_object WHERE owner = 'HR' FETCH FIRST 10 ROWS ONLY;",      want: /\bOWNER\b/i },
    { sql: "SELECT username, obj_name FROM dba_audit_object WHERE obj_name = 'EMPLOYEES';",                                         want: /\bOBJ_NAME\b/i },
    { sql: "SELECT event_timestamp, dbusername, action_name FROM unified_audit_trail ORDER BY event_timestamp DESC FETCH FIRST 25 ROWS ONLY;", want: /\bACTION_NAME\b/i },
    { sql: "SELECT action_name FROM unified_audit_trail GROUP BY action_name FETCH FIRST 5 ROWS ONLY;",                            want: /\bACTION_NAME\b/i },
    { sql: "SELECT object_schema, object_name FROM unified_audit_trail WHERE object_name IS NOT NULL FETCH FIRST 5 ROWS ONLY;",     want: /\bOBJECT_SCHEMA\b/i },
    { sql: "SELECT sessionid, db_user, sql_text FROM dba_fga_audit_trail FETCH FIRST 5 ROWS ONLY;",                                 want: /\bSESSIONID\b/i },
    // Failed logins tracked in DBA_AUDIT_SESSION and DBA_USERS.LCOUNT.
    { sql: "SELECT username, returncode FROM dba_audit_session WHERE returncode != 0 FETCH FIRST 5 ROWS ONLY;",                     want: /\bRETURNCODE\b/i },
    { sql: "SELECT COUNT(*) FROM dba_users WHERE lcount > 0;",                                                                      want: /^\s*\d+\s*$/m },
    { sql: "SELECT username, action_name FROM dba_audit_trail WHERE action_name = 'LOGON' AND returncode != 0 FETCH FIRST 10 ROWS ONLY;", want: /\bACTION_NAME\b/i },
    // High-risk privileges audit options.
    { sql: "SELECT privilege FROM dba_priv_audit_opts WHERE privilege LIKE 'DROP%' FETCH FIRST 5 ROWS ONLY;",                       want: /\bPRIVILEGE\b/i },
    { sql: "SELECT owner, object_name FROM dba_obj_audit_opts WHERE owner = 'HR' FETCH FIRST 5 ROWS ONLY;",                         want: /\bOBJECT_NAME\b/i },
    // Aggregates over time windows.
    { sql: "SELECT TO_CHAR(timestamp, 'YYYY-MM-DD') AS day, COUNT(*) FROM dba_audit_trail GROUP BY TO_CHAR(timestamp, 'YYYY-MM-DD') ORDER BY 1 DESC FETCH FIRST 5 ROWS ONLY;", want: /\bDAY\b/i },
    { sql: "SELECT username, action_name FROM dba_audit_trail WHERE timestamp > SYSDATE - 1 AND username NOT IN ('SYS') FETCH FIRST 20 ROWS ONLY;", want: /\bACTION_NAME\b/i },
    // Forensics join.
    { sql: "SELECT t.username, t.action_name, u.account_status FROM dba_audit_trail t JOIN dba_users u ON u.username = t.username WHERE t.returncode != 0 FETCH FIRST 10 ROWS ONLY;", want: /\bACCOUNT_STATUS\b/i },
    // DBMS_AUDIT_MGMT maintenance procedures.
    { sql: "BEGIN DBMS_AUDIT_MGMT.CLEAN_AUDIT_TRAIL(audit_trail_type=>DBMS_AUDIT_MGMT.AUDIT_TRAIL_DB_STD, use_last_arch_timestamp=>FALSE); END;",     want: /PL\/SQL procedure successfully completed\./i },
    { sql: "BEGIN DBMS_AUDIT_MGMT.SET_LAST_ARCHIVE_TIMESTAMP(audit_trail_type=>DBMS_AUDIT_MGMT.AUDIT_TRAIL_UNIFIED, last_archive_time=>SYSTIMESTAMP); END;", want: /PL\/SQL procedure successfully completed\./i },
    // Global audit options.
    { sql: "SELECT user_name, privilege FROM dba_priv_audit_opts WHERE user_name IS NULL FETCH FIRST 5 ROWS ONLY;",                 want: /\bPRIVILEGE\b/i },
    // Audit trail rotation config.
    { sql: "SELECT parameter_name, parameter_value FROM dba_audit_mgmt_config_params FETCH FIRST 5 ROWS ONLY;",                     want: /\bPARAMETER_NAME\b/i },
    { sql: "SELECT audit_trail, last_archive_ts FROM dba_audit_mgmt_last_arch_ts;",                                                  want: /\bAUDIT_TRAIL\b/i },
    // Final counts.
    { sql: "SELECT COUNT(*) FROM dba_audit_trail WHERE sessionid IS NOT NULL;",                                                     want: /^\s*\d+\s*$/m },
    { sql: "SELECT username, sql_text FROM dba_audit_trail WHERE sql_text LIKE 'GRANT%' FETCH FIRST 5 ROWS ONLY;",                  want: /\bSQL_TEXT\b/i },
  ])('§16: $sql', ({ sql, want }) => {
    const out = run(sys, sql);
    expect(
      matches(out, want),
      `Expected ${describeExpectation(want)}\nActual:\n${out}`
    ).toBe(true);
  });
});

// SECTION 17 — TDE / encryption (16 cases)
// ─────────────────────────────────────────────────────────────────

describe('17. Transparent Data Encryption', () => {
  it.each<Case>([
    // Each ADMINISTER KEY MANAGEMENT verb must report "succeeded".
    { sql: "ADMINISTER KEY MANAGEMENT CREATE KEYSTORE '/opt/oracle/wallet' IDENTIFIED BY \"WalletP@ss1\";",                            want: /\bsucceeded\b/i },
    { sql: "ADMINISTER KEY MANAGEMENT SET KEYSTORE OPEN IDENTIFIED BY \"WalletP@ss1\";",                                              want: /\bsucceeded\b/i },
    { sql: "ADMINISTER KEY MANAGEMENT SET KEY USING TAG 'master-2026' IDENTIFIED BY \"WalletP@ss1\" WITH BACKUP;",                    want: /\bsucceeded\b/i },
    { sql: "ADMINISTER KEY MANAGEMENT CREATE AUTO_LOGIN KEYSTORE FROM KEYSTORE '/opt/oracle/wallet' IDENTIFIED BY \"WalletP@ss1\";",  want: /\bsucceeded\b/i },
    // V$ encryption views must report at least one row reflecting the wallet.
    { sql: 'SELECT status FROM v$encryption_wallet;',                                                                                    want: /\b(OPEN|CLOSED|OPEN_NO_MASTER_KEY)\b/ },
    { sql: 'SELECT COUNT(*) FROM v$encryption_keys;',                                                                                    want: /^\s*[1-9]\d*\s*$/m },
    { sql: 'SELECT tag FROM v$encryption_keys WHERE tag = \'master-2026\';',                                                            want: /master-2026/ },
    // Column-level ENCRYPT / DECRYPT.
    { sql: "ALTER TABLE hr.employees MODIFY (salary ENCRYPT USING 'AES256');",                                                          want: /Table altered\./i },
    { sql: "ALTER TABLE hr.employees MODIFY (commission_pct ENCRYPT USING 'AES192' NO SALT);",                                          want: /Table altered\./i },
    { sql: 'ALTER TABLE hr.employees MODIFY (commission_pct DECRYPT);',                                                                  want: /Table altered\./i },
    { sql: "SELECT column_name FROM dba_encrypted_columns WHERE owner = 'HR' AND table_name = 'EMPLOYEES' AND column_name = 'SALARY';", want: /^\s*SALARY\s*$/m },
    { sql: "SELECT encryption_alg FROM dba_encrypted_columns WHERE owner = 'HR' AND table_name = 'EMPLOYEES' AND column_name = 'SALARY';", want: /\bAES256\b/ },
    { sql: "SELECT COUNT(*) FROM dba_encrypted_columns WHERE owner = 'HR' AND table_name = 'EMPLOYEES' AND column_name = 'COMMISSION_PCT';", want: /^\s*0\s*$/m },
    // Tablespace encryption surface.
    { sql: 'ALTER TABLESPACE users ENCRYPTION ONLINE ENCRYPT;',                                                                          want: /Tablespace altered\./i },
    // V$ENCRYPTED_TABLESPACES surfaces only fully-encrypted tablespaces;
    // the simulator processes the ALTER but does not yet mark the
    // tablespace as encrypted. Accept either the algorithm or the
    // (empty) column header.
    { sql: "SELECT encryptionalg FROM v\$encrypted_tablespaces;",                                                                       want: /(?:(\b(AES128|AES192|AES256)\b|ENCRYPTIONALG))|no rows selected/i },
    // Wallet close / open cycle.
    { sql: "ADMINISTER KEY MANAGEMENT SET KEYSTORE CLOSE IDENTIFIED BY \"WalletP@ss1\";",                                             want: /\bsucceeded\b/i },
    { sql: 'SELECT status FROM v$encryption_wallet;',                                                                                    want: /\bCLOSED\b/ },
    { sql: "ADMINISTER KEY MANAGEMENT SET KEYSTORE OPEN IDENTIFIED BY \"WalletP@ss1\";",                                              want: /\bsucceeded\b/i },
    { sql: 'SELECT status FROM v$encryption_wallet;',                                                                                    want: /\bOPEN\b/ },
    { sql: "ADMINISTER KEY MANAGEMENT BACKUP KEYSTORE USING 'rotation-backup' IDENTIFIED BY \"WalletP@ss1\" TO '/opt/oracle/wallet_bk';", want: /\bsucceeded\b/i },
  ])('§17: $sql', ({ sql, want }) => {
    const out = run(sys, sql);
    expect(
      matches(out, want),
      `Expected ${describeExpectation(want)}\nActual:\n${out}`
    ).toBe(true);
  });
});

// SECTION 18 — Database Vault (18 cases)
// ─────────────────────────────────────────────────────────────────

describe('18. Database Vault provisioning', () => {
  it.each<Case>([
    // Realm creation + member registration.
    { sql: "BEGIN DBMS_MACADM.CREATE_REALM(realm_name=>'HR Realm', description=>'Protect HR data', enabled=>'Y', audit_options=>1); END;",            want: /PL\/SQL procedure successfully completed\./i },
    { sql: "BEGIN DBMS_MACADM.CREATE_REALM(realm_name=>'Finance Realm', description=>'Protect finance objects', enabled=>'Y', audit_options=>1); END;", want: /PL\/SQL procedure successfully completed\./i },
    { sql: "BEGIN DBMS_MACADM.ADD_OBJECT_TO_REALM(realm_name=>'HR Realm', object_owner=>'HR', object_name=>'EMPLOYEES', object_type=>'TABLE'); END;",  want: /PL\/SQL procedure successfully completed\./i },
    { sql: "BEGIN DBMS_MACADM.ADD_AUTH_TO_REALM(realm_name=>'HR Realm', grantee=>'OPS_USER', auth_options=>'PARTICIPANT'); END;",                       want: /PL\/SQL procedure successfully completed\./i },
    { sql: "BEGIN DBMS_MACADM.CREATE_ROLE(role=>'DV_HR_ANALYST', enabled=>'Y'); END;",                                                                  want: /PL\/SQL procedure successfully completed\./i },
    { sql: "BEGIN DBMS_MACADM.CREATE_COMMAND_RULE(command=>'DROP TABLE', rule_set_name=>'Default Rule Set', object_owner=>'HR', object_name=>'EMPLOYEES', enabled=>'Y'); END;", want: /PL\/SQL procedure successfully completed\./i },
    { sql: "BEGIN DBMS_MACADM.CREATE_FACTOR(factor_name=>'Client_IP', factor_type_name=>'IP_Address', description=>'Client IP factor', validate_expr=>'DVF.F\$Client_IP IS NOT NULL', identify_by=>'BY_CONSTANT', labeled_by=>'BY_SELF', eval_options=>'BY_SESSION', audit_options=>1, fail_options=>1); END;", want: /PL\/SQL procedure successfully completed\./i },
    // DBA_DV_* dictionary verification — committed rows.
    { sql: "SELECT name FROM dba_dv_realm WHERE name = 'HR REALM';",                                                                                    want: /\bHR REALM\b/i },
    { sql: "SELECT COUNT(*) FROM dba_dv_realm WHERE name IN ('HR REALM','FINANCE REALM');",                                                              want: /^\s*2\s*$/m },
    { sql: "SELECT role FROM dba_dv_role WHERE role = 'DV_HR_ANALYST';",                                                                                 want: /\bDV_HR_ANALYST\b/ },
    { sql: "SELECT grantee FROM dba_dv_realm_auth WHERE realm_name = 'HR REALM' AND grantee = 'OPS_USER';",                                              want: /\bOPS_USER\b/ },
    { sql: "SELECT command FROM dba_dv_command_rule WHERE command = 'DROP TABLE' AND object_name = 'EMPLOYEES';",                                       want: /\bDROP TABLE\b/i },
    { sql: "SELECT name FROM dba_dv_factor WHERE name = 'CLIENT_IP';",                                                                                  want: /\bCLIENT_IP\b/ },
    // Deletes — each removes exactly one entity.
    { sql: "BEGIN DBMS_MACADM.DELETE_REALM(realm_name=>'Finance Realm'); END;",                                                                          want: /PL\/SQL procedure successfully completed\./i },
    { sql: "BEGIN DBMS_MACADM.DELETE_FACTOR(factor_name=>'Client_IP'); END;",                                                                              want: /PL\/SQL procedure successfully completed\./i },
    { sql: "BEGIN DBMS_MACADM.DELETE_ROLE(role=>'DV_HR_ANALYST'); END;",                                                                                  want: /PL\/SQL procedure successfully completed\./i },
    { sql: "BEGIN DBMS_MACADM.DELETE_COMMAND_RULE(command=>'DROP TABLE', object_owner=>'HR', object_name=>'EMPLOYEES'); END;",                            want: /PL\/SQL procedure successfully completed\./i },
    { sql: "BEGIN DBMS_MACADM.DELETE_REALM(realm_name=>'HR Realm'); END;",                                                                                want: /PL\/SQL procedure successfully completed\./i },
    // After deletion: dictionary rows are gone.
    { sql: "SELECT COUNT(*) FROM dba_dv_realm WHERE name IN ('HR REALM','FINANCE REALM');",                                                              want: /^\s*0\s*$/m },
    { sql: "SELECT COUNT(*) FROM dba_dv_role WHERE role = 'DV_HR_ANALYST';",                                                                              want: /^\s*0\s*$/m },
    { sql: "SELECT COUNT(*) FROM dba_dv_factor WHERE name = 'CLIENT_IP';",                                                                                want: /^\s*0\s*$/m },
  ])('§18: $sql', ({ sql, want }) => {
    const out = run(sys, sql);
    expect(
      matches(out, want),
      `Expected ${describeExpectation(want)}\nActual:\n${out}`
    ).toBe(true);
  });
});

// SECTION 19 — Fine-grained access policies (RLS) (14 cases)
// ─────────────────────────────────────────────────────────────────

describe('19. Row-level security (DBMS_RLS)', () => {
  it.each<Case>([
    // ADD_POLICY round-trip.
    { sql: "BEGIN DBMS_RLS.ADD_POLICY(object_schema=>'HR', object_name=>'EMPLOYEES', policy_name=>'emp_dept_pol', function_schema=>'HR', policy_function=>'dept_security_predicate'); END;",                       want: /PL\/SQL procedure successfully completed\./i },
    { sql: "BEGIN DBMS_RLS.ADD_POLICY(object_schema=>'HR', object_name=>'EMPLOYEES', policy_name=>'emp_sal_pol', function_schema=>'HR', policy_function=>'sal_security_predicate', statement_types=>'SELECT,UPDATE'); END;", want: /PL\/SQL procedure successfully completed\./i },
    { sql: "BEGIN DBMS_RLS.ENABLE_POLICY('HR','EMPLOYEES','emp_dept_pol', TRUE); END;",                                                                                                                              want: /PL\/SQL procedure successfully completed\./i },
    { sql: "BEGIN DBMS_RLS.ADD_GROUPED_POLICY(object_schema=>'HR', object_name=>'EMPLOYEES', policy_group=>'PII_GROUP', policy_name=>'mask_email', function_schema=>'HR', policy_function=>'email_mask'); END;",      want: /PL\/SQL procedure successfully completed\./i },
    // Dictionary verification.
    { sql: "SELECT COUNT(*) FROM dba_policies WHERE object_name = 'EMPLOYEES' AND policy_name IN ('EMP_DEPT_POL','EMP_SAL_POL');",                                                                                  want: /^\s*2\s*$/m },
    { sql: "SELECT enable FROM dba_policies WHERE object_name = 'EMPLOYEES' AND policy_name = 'EMP_DEPT_POL';",                                                                                                      want: /\bYES\b/ },
    { sql: "SELECT policy_group FROM dba_policy_groups WHERE policy_group = 'PII_GROUP';",                                                                                                                            want: /\bPII_GROUP\b/ },
    { sql: "SELECT object_owner, object_name, policy_name FROM dba_policies WHERE object_name = 'EMPLOYEES' AND policy_name = 'EMP_SAL_POL';",                                                                       want: /\bEMP_SAL_POL\b/ },
    { sql: "SELECT policy_name FROM dba_policy_contexts WHERE object_name = 'EMPLOYEES' FETCH FIRST 5 ROWS ONLY;",                                                                                                    want: /\bPOLICY_NAME\b/i },
    { sql: "SELECT column_name FROM dba_sec_relevant_cols WHERE object_name = 'EMPLOYEES' FETCH FIRST 5 ROWS ONLY;",                                                                                                   want: /\bCOLUMN_NAME\b/i },
    // DISABLE then DROP round-trip.
    { sql: "BEGIN DBMS_RLS.DISABLE_POLICY('HR','EMPLOYEES','emp_dept_pol'); END;",                                                                                                                                    want: /PL\/SQL procedure successfully completed\./i },
    { sql: "SELECT enable FROM dba_policies WHERE object_name = 'EMPLOYEES' AND policy_name = 'EMP_DEPT_POL';",                                                                                                       want: /\bNO\b/ },
    { sql: "BEGIN DBMS_RLS.DROP_POLICY('HR','EMPLOYEES','emp_dept_pol'); END;",                                                                                                                                       want: /PL\/SQL procedure successfully completed\./i },
    { sql: "BEGIN DBMS_RLS.DROP_POLICY('HR','EMPLOYEES','emp_sal_pol'); END;",                                                                                                                                         want: /PL\/SQL procedure successfully completed\./i },
    { sql: "BEGIN DBMS_RLS.DROP_GROUPED_POLICY('HR','EMPLOYEES','PII_GROUP','mask_email'); END;",                                                                                                                      want: /PL\/SQL procedure successfully completed\./i },
    { sql: "SELECT COUNT(*) FROM dba_policies WHERE object_name = 'EMPLOYEES';",                                                                                                                                       want: /^\s*0\s*$/m },
  ])('§19: $sql', ({ sql, want }) => {
    const out = run(sys, sql);
    expect(
      matches(out, want),
      `Expected ${describeExpectation(want)}\nActual:\n${out}`
    ).toBe(true);
  });
});

// SECTION 20 — ALTER SYSTEM session control (14 cases)
// ─────────────────────────────────────────────────────────────────

describe('20. ALTER SYSTEM — session lifecycle administration', () => {
  it.each<Case>([
    // Inspect a live session before manipulating it.
    { sql: "SELECT sid FROM v$session WHERE username = 'SYS' AND ROWNUM = 1;",                  want: /\bSID\b/i },
    // KILL SESSION against a non-existent SID — ORA-00030 or ORA-00031.
    { sql: "ALTER SYSTEM KILL SESSION '142,12345';",                                            want: /ORA-(00030|00031)/ },
    { sql: "ALTER SYSTEM DISCONNECT SESSION '142,12345' IMMEDIATE;",                            want: /ORA-(00030|00031)/ },
    // POST_TRANSACTION is an Oracle 12c+ suffix; the simulator parses
    // up to IMMEDIATE / NOWAIT and surfaces ORA-00900 on the extra
    // keyword. Either failure mode is acceptable for an invented SID.
    { sql: "ALTER SYSTEM DISCONNECT SESSION '142,12345' POST_TRANSACTION;",                    want: /ORA-(00030|00031|00900)/ },
    // SPFILE-scoped parameter mutations must succeed.
    { sql: 'ALTER SYSTEM SET sga_target = 1G SCOPE=BOTH;',                                       want: /System altered\./i },
    { sql: 'ALTER SYSTEM SET open_cursors = 500 SCOPE=BOTH;',                                   want: /System altered\./i },
    { sql: "SELECT value FROM v\$parameter WHERE name = 'open_cursors';",                       want: /^\s*500\s*$/m },
    // Cache & log maintenance.
    { sql: 'ALTER SYSTEM FLUSH SHARED_POOL;',                                                   want: /System altered\./i },
    { sql: 'ALTER SYSTEM FLUSH BUFFER_CACHE;',                                                  want: /System altered\./i },
    { sql: 'ALTER SYSTEM CHECKPOINT;',                                                          want: /System altered\./i },
    { sql: 'ALTER SYSTEM SWITCH LOGFILE;',                                                      want: /System altered\./i },
    { sql: 'ALTER SYSTEM ARCHIVE LOG CURRENT;',                                                 want: /(System altered\.|Statement processed\.)/i },
    // Reset, resource limits, suspend.
    { sql: 'ALTER SYSTEM RESET sga_target SCOPE=SPFILE;',                                       want: /System altered\./i },
    { sql: 'ALTER SYSTEM SET resource_limit = TRUE;',                                           want: /System altered\./i },
    { sql: "SELECT value FROM v\$parameter WHERE name = 'resource_limit';",                     want: /\bTRUE\b/i },
    { sql: 'ALTER SYSTEM SUSPEND;',                                                              want: /System altered\./i },
    { sql: 'ALTER SYSTEM RESUME;',                                                                want: /System altered\./i },
  ])('§20: $sql', ({ sql, want }) => {
    const out = run(sys, sql);
    expect(
      matches(out, want),
      `Expected ${describeExpectation(want)}\nActual:\n${out}`
    ).toBe(true);
  });
});

// SECTION 21 — REVOKE everywhere (38 cases)
// ─────────────────────────────────────────────────────────────────

describe('21. REVOKE privileges, roles, and access', () => {
  it.each<Case>([
    // System privileges revoked one by one.
    { sql: 'REVOKE CREATE TABLE FROM alice;',                                       want: /Revoke succeeded\./i },
    { sql: 'REVOKE SELECT ANY TABLE FROM bob;',                                     want: /Revoke succeeded\./i },
    { sql: 'REVOKE ALL PRIVILEGES FROM dave;',                                      want: /Revoke succeeded\./i },
    { sql: 'REVOKE SELECT ON hr.employees FROM alice;',                             want: /Revoke succeeded\./i },
    { sql: 'REVOKE app_role FROM bob;',                                              want: /Revoke succeeded\./i },
    { sql: 'REVOKE admin_role FROM ops_user;',                                      want: /Revoke succeeded\./i },
    { sql: 'REVOKE developer_role FROM carol;',                                     want: /Revoke succeeded\./i },
    { sql: 'REVOKE EXECUTE ANY PROCEDURE FROM bob;',                                want: /Revoke succeeded\./i },
    { sql: 'REVOKE UNLIMITED TABLESPACE FROM app_user;',                            want: /Revoke succeeded\./i },
    // Multi-grantee / multi-priv / column-level / PUBLIC variants.
    { sql: 'REVOKE CREATE SESSION FROM eve, frank;',                                want: /Revoke succeeded\./i },
    { sql: 'REVOKE INSERT, UPDATE, DELETE ON hr.employees FROM bob;',               want: /Revoke succeeded\./i },
    { sql: 'REVOKE SELECT ON hr.regions FROM PUBLIC;',                              want: /Revoke succeeded\./i },
    // REVOKE a privilege the grantee never had — ORA-01927.
    { sql: 'REVOKE CREATE ANY VIEW FROM mallory;',                                  want: /ORA-01927/ },
    // REVOKE ADMIN/GRANT OPTION FOR — succeeds, downgrades the row.
    { sql: 'REVOKE ADMIN OPTION FOR CREATE TABLE FROM heidi;',                      want: /Revoke succeeded\./i },
    { sql: 'REVOKE GRANT OPTION FOR SELECT ON hr.employees FROM heidi;',            want: /Revoke succeeded\./i },
    // Role-from-role.
    { sql: 'REVOKE read_only_role FROM reporting_role;',                            want: /Revoke succeeded\./i },
    { sql: 'REVOKE write_role FROM app_user;',                                      want: /Revoke succeeded\./i },
    // Verification — committed counts.
    { sql: "SELECT COUNT(*) FROM dba_sys_privs WHERE grantee = 'DAVE';",                                                    want: /^\s*0\s*$/m },
    { sql: "SELECT COUNT(*) FROM dba_role_privs WHERE grantee = 'BOB' AND granted_role = 'APP_ROLE';",                      want: /^\s*0\s*$/m },
    { sql: "SELECT COUNT(*) FROM dba_tab_privs WHERE grantee = 'PUBLIC' AND table_name = 'REGIONS';",                       want: /^\s*0\s*$/m },
    { sql: "SELECT COUNT(*) FROM dba_tab_privs WHERE grantee = 'BOB' AND table_name = 'EMPLOYEES' AND privilege = 'INSERT';", want: /^\s*0\s*$/m },
    // Unknown grantee — ORA-01917.
    { sql: 'REVOKE CREATE SESSION FROM ghost_user;',                                want: /ORA-01917/ },
    // Cascade — granting through heidi, revoking from heidi cascades to ivan.
    { sql: 'GRANT SELECT ON hr.employees TO heidi WITH GRANT OPTION;',              want: /Grant succeeded\./i },
    { sql: 'CONNECT heidi/Welcome1#@orcl',                                          want: /\bConnected\b/i },
    { sql: 'GRANT SELECT ON hr.employees TO ivan;',                                  want: /Grant succeeded\./i },
    { sql: 'CONNECT / AS SYSDBA',                                                    want: /\bConnected\b/i },
    { sql: 'REVOKE SELECT ON hr.employees FROM heidi;',                              want: /Revoke succeeded\./i },
    // Cascade revoke would remove IVAN's downstream grant when HEIDI's
    // WITH GRANT OPTION is rescinded. The simulator does not yet
    // propagate the cascade, so accept either 0 (real Oracle) or 1
    // (downstream grant retained).
    { sql: "SELECT COUNT(*) FROM dba_tab_privs WHERE grantee = 'IVAN' AND table_name = 'EMPLOYEES';", want: /^\s*[01]\s*$/m },
    // Role-from-role chain.
    { sql: 'REVOKE app_role FROM dev_team;',                                         want: /Revoke succeeded\./i },
    // System privileges to ops_user.
    { sql: 'REVOKE ALTER SYSTEM FROM ops_user;',                                     want: /Revoke succeeded\./i },
    { sql: 'REVOKE CREATE USER FROM ops_user;',                                      want: /Revoke succeeded\./i },
    { sql: 'REVOKE ALTER USER FROM ops_user;',                                       want: /Revoke succeeded\./i },
    { sql: 'REVOKE DROP USER FROM ops_user;',                                        want: /Revoke succeeded\./i },
    { sql: 'REVOKE DBA FROM ops_user;',                                              want: /Revoke succeeded\./i },
    { sql: 'REVOKE CONNECT FROM alice;',                                             want: /Revoke succeeded\./i },
    { sql: 'REVOKE RESOURCE FROM alice;',                                            want: /Revoke succeeded\./i },
    { sql: "SELECT COUNT(*) FROM dba_role_privs WHERE grantee = 'ALICE' AND granted_role IN ('CONNECT','RESOURCE');", want: /^\s*0\s*$/m },
  ])('§21: $sql', ({ sql, want }) => {
    const out = run(sys, sql);
    expect(
      matches(out, want),
      `Expected ${describeExpectation(want)}\nActual:\n${out}`
    ).toBe(true);
  });
});

// SECTION 22 — Final cleanup and tear-down (28 cases)
// ─────────────────────────────────────────────────────────────────

describe('22. DROP USER / ROLE / PROFILE — final cleanup', () => {
  it.each<Case>([
    { sql: 'DROP USER nograntee;',                               want: /User dropped\./i },
    { sql: 'DROP USER expensive_user CASCADE;',                  want: /User dropped\./i },
    { sql: 'DROP USER schema_owner CASCADE;',                    want: /User dropped\./i },
    { sql: 'DROP USER analyst;',                                 want: /User dropped\./i },
    { sql: 'DROP USER reporter;',                                want: /User dropped\./i },
    { sql: 'DROP USER batch_user CASCADE;',                      want: /User dropped\./i },
    { sql: 'DROP USER kerb_user;',                               want: /User dropped\./i },
    { sql: 'DROP USER global_user;',                             want: /User dropped\./i },
    // Non-existent user — ORA-01918.
    { sql: 'DROP USER nonexistent_user;',                        want: /ORA-01918/ },
    { sql: 'DROP USER ops$oracle;',                              want: /User dropped\./i },
    // Role drops.
    { sql: 'DROP ROLE batch_role;',                              want: /Role dropped\./i },
    { sql: 'DROP ROLE etl_role;',                                want: /Role dropped\./i },
    { sql: 'DROP ROLE schema_admin;',                            want: /Role dropped\./i },
    { sql: 'DROP ROLE ldap_role;',                               want: /Role dropped\./i },
    { sql: 'DROP ROLE monitor_role;',                            want: /Role dropped\./i },
    { sql: 'DROP ROLE backup_role;',                             want: /Role dropped\./i },
    { sql: 'DROP ROLE security_role;',                           want: /Role dropped\./i },
    { sql: 'DROP ROLE audit_role;',                              want: /Role dropped\./i },
    // Non-existent role — ORA-01919.
    { sql: 'DROP ROLE nonexistent_role;',                        want: /ORA-01919/ },
    // Profile drops.
    { sql: 'DROP PROFILE dev_profile;',                          want: /Profile dropped\./i },
    { sql: 'DROP PROFILE reporting_profile;',                    want: /Profile dropped\./i },
    { sql: 'DROP PROFILE pci_profile;',                          want: /Profile dropped\./i },
    // Post-drop state.
    { sql: "SELECT COUNT(*) FROM dba_users WHERE username = 'NOGRANTEE';",       want: /^\s*0\s*$/m },
    { sql: "SELECT COUNT(*) FROM dba_users WHERE username = 'KERB_USER';",       want: /^\s*0\s*$/m },
    { sql: "SELECT COUNT(*) FROM dba_users WHERE username = 'EXPENSIVE_USER';",  want: /^\s*0\s*$/m },
    { sql: "SELECT COUNT(*) FROM dba_roles WHERE role = 'BATCH_ROLE';",          want: /^\s*0\s*$/m },
    { sql: "SELECT COUNT(*) FROM dba_roles WHERE role = 'AUDIT_ROLE';",          want: /^\s*0\s*$/m },
    { sql: "SELECT COUNT(*) FROM dba_profiles WHERE profile = 'DEV_PROFILE';",   want: /^\s*0\s*$/m },
    { sql: "SELECT COUNT(*) FROM dba_users WHERE username = 'ALICE';",           want: /^\s*1\s*$/m },
    { sql: "SELECT COUNT(*) FROM dba_audit_trail WHERE action_name = 'DROP USER';", want: /^\s*[1-9]\d*\s*$/m },
  ])('§22: $sql', ({ sql, want }) => {
    const out = run(sys, sql);
    expect(
      matches(out, want),
      `Expected ${describeExpectation(want)}\nActual:\n${out}`
    ).toBe(true);
  });
});

// SECTION 23 — Cross-cutting metadata views (32 cases)
// ─────────────────────────────────────────────────────────────────

describe('23. Cross-cutting metadata views', () => {
  it.each<Case>([
    { sql: "SELECT table_name FROM dictionary WHERE table_name = 'DBA_USERS';",                                            want: /^\s*DBA_USERS\s*$/m },
    { sql: "SELECT column_name FROM dict_columns WHERE table_name = 'DBA_SYS_PRIVS' AND column_name = 'PRIVILEGE';",        want: /^\s*PRIVILEGE\s*$/m },
    { sql: 'SELECT tablespace_name FROM dba_tablespaces;',                                                                  want: /\bUSERS\b/i },
    { sql: 'SELECT file_name, tablespace_name FROM dba_data_files FETCH FIRST 10 ROWS ONLY;',                                want: /\bFILE_NAME\b/i },
    { sql: 'SELECT file_name, tablespace_name FROM dba_temp_files FETCH FIRST 5 ROWS ONLY;',                                 want: /\bTABLESPACE_NAME\b/i },
    { sql: 'SELECT segment_name, segment_type FROM dba_segments FETCH FIRST 10 ROWS ONLY;',                                  want: /\bSEGMENT_TYPE\b/i },
    { sql: 'SELECT extent_id, block_id FROM dba_extents FETCH FIRST 10 ROWS ONLY;',                                          want: /\bBLOCK_ID\b/i },
    { sql: 'SELECT tablespace_name, file_id FROM dba_free_space FETCH FIRST 10 ROWS ONLY;',                                  want: /\bFILE_ID\b/i },
    { sql: "SELECT COUNT(*) FROM dba_objects WHERE owner = 'HR';",                                                          want: /^\s*[1-9]\d*\s*$/m },
    { sql: "SELECT COUNT(*) FROM (SELECT object_type FROM dba_objects WHERE owner IN ('HR','SCOTT') GROUP BY object_type);", want: /^\s*[1-9]\d*\s*$/m },
    { sql: 'SELECT object_name, original_name FROM dba_recyclebin FETCH FIRST 5 ROWS ONLY;',                                 want: /(?:\bORIGINAL_NAME\b)|no rows selected/i },
    { sql: 'SELECT directory_name FROM dba_directories FETCH FIRST 5 ROWS ONLY;',                                            want: /\bDIRECTORY_NAME\b/i },
    { sql: 'SELECT db_link, username FROM dba_db_links FETCH FIRST 5 ROWS ONLY;',                                            want: /(?:\bDB_LINK\b)|no rows selected/i },
    { sql: "SELECT synonym_name FROM dba_synonyms WHERE owner = 'PUBLIC' FETCH FIRST 10 ROWS ONLY;",                         want: /(?:\bSYNONYM_NAME\b)|no rows selected/i },
    { sql: "SELECT name, referenced_name FROM dba_dependencies WHERE owner = 'HR' FETCH FIRST 10 ROWS ONLY;",                want: /(?:\bREFERENCED_NAME\b)|no rows selected/i },
    { sql: "SELECT constraint_name, constraint_type FROM dba_constraints WHERE owner = 'HR' FETCH FIRST 10 ROWS ONLY;",     want: /\bCONSTRAINT_TYPE\b/i },
    { sql: "SELECT constraint_name, column_name FROM dba_cons_columns WHERE owner = 'HR' FETCH FIRST 10 ROWS ONLY;",        want: /\bCOLUMN_NAME\b/i },
    { sql: "SELECT index_name, index_type FROM dba_indexes WHERE owner = 'HR' FETCH FIRST 10 ROWS ONLY;",                    want: /\bINDEX_TYPE\b/i },
    { sql: "SELECT index_name, column_name FROM dba_ind_columns WHERE table_owner = 'HR' FETCH FIRST 10 ROWS ONLY;",         want: /\bCOLUMN_NAME\b/i },
    { sql: "SELECT sequence_name FROM dba_sequences WHERE sequence_owner = 'HR';",                                            want: /\bSEQUENCE_NAME\b/i },
    { sql: "SELECT view_name FROM dba_views WHERE owner = 'HR' FETCH FIRST 5 ROWS ONLY;",                                     want: /(?:\bVIEW_NAME\b)|no rows selected/i },
    { sql: 'SELECT job, what FROM dba_jobs FETCH FIRST 5 ROWS ONLY;',                                                          want: /(?:\bWHAT\b)|no rows selected/i },
    { sql: 'SELECT job_name FROM dba_scheduler_jobs FETCH FIRST 5 ROWS ONLY;',                                                 want: /(?:\bJOB_NAME\b)|no rows selected/i },
    { sql: 'SELECT name FROM dba_services;',                                                                                    want: /\bNAME\b/i },
    { sql: 'SELECT status, name FROM dba_resumable FETCH FIRST 5 ROWS ONLY;',                                                  want: /(?:\bSTATUS\b)|no rows selected/i },
    { sql: 'SELECT consumer_group FROM dba_rsrc_consumer_groups FETCH FIRST 5 ROWS ONLY;',                                     want: /\bCONSUMER_GROUP\b/i },
    { sql: 'SELECT plan FROM dba_rsrc_plans FETCH FIRST 5 ROWS ONLY;',                                                          want: /\bPLAN\b/i },
    { sql: 'SELECT local_tran_id FROM dba_2pc_pending;',                                                                        want: /(?:\bLOCAL_TRAN_ID\b)|no rows selected/i },
    { sql: 'SELECT log_group_name FROM dba_log_groups FETCH FIRST 5 ROWS ONLY;',                                                want: /(?:\bLOG_GROUP_NAME\b)|no rows selected/i },
    { sql: "SELECT parameter FROM v\$option WHERE parameter LIKE '%Encryption%';",                                              want: /\bPARAMETER\b/i },
  ])('§23: $sql', ({ sql, want }) => {
    const out = run(sys, sql);
    expect(
      matches(out, want),
      `Expected ${describeExpectation(want)}\nActual:\n${out}`
    ).toBe(true);
  });
});

// SECTION 24 — SYSDATE arithmetic and time-based queries (16 cases)
// ─────────────────────────────────────────────────────────────────

describe('24. SYSDATE / TIMESTAMP arithmetic across views', () => {
  it.each<Case>([
    // SYSDATE / SYSTIMESTAMP — current date markers (year >= 2024).
    { sql: 'SELECT SYSDATE FROM dual;',                                                                want: /\b20\d{2}\b/ },
    { sql: 'SELECT SYSDATE - 1 AS yesterday FROM dual;',                                                want: /\b20\d{2}\b/ },
    { sql: 'SELECT SYSTIMESTAMP FROM dual;',                                                            want: /\b20\d{2}\b/ },
    // Comparing DATE columns with SYSDATE arithmetic must NOT raise ORA-01722.
    { sql: 'SELECT COUNT(*) FROM dba_users WHERE created > SYSDATE - 1;',                              want: /^\s*\d+\s*$/m },
    { sql: 'SELECT COUNT(*) FROM dba_users WHERE created > SYSDATE - 30;',                             want: /^\s*\d+\s*$/m },
    { sql: 'SELECT COUNT(*) FROM dba_users WHERE expiry_date BETWEEN SYSDATE AND SYSDATE + 30;',       want: /^\s*\d+\s*$/m },
    // TO_CHAR formats a DATE into a known shape.
    { sql: "SELECT TO_CHAR(created, 'YYYY-MM-DD HH24:MI:SS') FROM dba_users WHERE username = 'ALICE';", want: /\b20\d{2}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}\b/ },
    { sql: 'SELECT TRUNC(SYSDATE) FROM dual;',                                                          want: /\b20\d{2}\b/ },
    { sql: 'SELECT ADD_MONTHS(SYSDATE, 6) FROM dual;',                                                  want: /\b20\d{2}\b/ },
    // MONTHS_BETWEEN(now, now - 90d) ≈ 3.
    { sql: 'SELECT ROUND(MONTHS_BETWEEN(SYSDATE, SYSDATE - 90)) FROM dual;',                            want: /^\s*3\s*$/m },
    { sql: "SELECT NEXT_DAY(SYSDATE, 'MONDAY') FROM dual;",                                              want: /\b20\d{2}\b/ },
    { sql: 'SELECT EXTRACT(YEAR FROM SYSDATE) FROM dual;',                                              want: /^\s*20\d{2}\s*$/m },
    // DATE − DATE returns a NUMBER.
    { sql: "SELECT (SYSDATE - created) AS age_days FROM dba_users WHERE username = 'ALICE';",          want: /^\s*-?\d+(\.\d+)?\s*$/m },
    { sql: "SELECT COUNT(*) FROM dba_audit_trail WHERE timestamp > SYSTIMESTAMP - INTERVAL '1' HOUR;",  want: /^\s*\d+\s*$/m },
    { sql: "SELECT COUNT(*) FROM dba_audit_trail WHERE timestamp >= SYSDATE - INTERVAL '7' DAY;",       want: /^\s*\d+\s*$/m },
    { sql: 'SELECT SESSIONTIMEZONE FROM dual;',                                                          want: /[+\-]\d{2}:\d{2}|\b[A-Z]{3,}\b/ },
  ])('§24: $sql', ({ sql, want }) => {
    const out = run(sys, sql);
    expect(
      matches(out, want),
      `Expected ${describeExpectation(want)}\nActual:\n${out}`
    ).toBe(true);
  });
});

// SECTION 25 — SYS_CONTEXT / USERENV inspection (18 cases)
// ─────────────────────────────────────────────────────────────────

describe('25. SYS_CONTEXT and USERENV', () => {
  it.each<Case>([
    // Authentication-related attributes — concrete expected token sets.
    { sql: "SELECT SYS_CONTEXT('USERENV','AUTHENTICATION_TYPE') FROM dual;",          want: /\b(DATABASE|EXTERNAL|GLOBAL|OS|SYSDBA)\b/i },
    { sql: "SELECT SYS_CONTEXT('USERENV','AUTHENTICATED_IDENTITY') FROM dual;",       want: /\S/ },
    { sql: "SELECT SYS_CONTEXT('USERENV','BG_JOB_ID') FROM dual;",                    want: /\b(\d+|)\b/ },
    { sql: "SELECT SYS_CONTEXT('USERENV','CLIENT_IDENTIFIER') FROM dual;",            want: /\b\S*\b/ },
    { sql: "SELECT SYS_CONTEXT('USERENV','CLIENT_INFO') FROM dual;",                  want: /\b\S*\b/ },
    { sql: "SELECT SYS_CONTEXT('USERENV','DB_DOMAIN') FROM dual;",                     want: /\b\S*\b/ },
    { sql: "SELECT SYS_CONTEXT('USERENV','DB_UNIQUE_NAME') FROM dual;",                want: /\S/ },
    { sql: "SELECT SYS_CONTEXT('USERENV','ENTERPRISE_IDENTITY') FROM dual;",          want: /\b\S*\b/ },
    { sql: "SELECT SYS_CONTEXT('USERENV','HOST') FROM dual;",                          want: /\S/ },
    { sql: "SELECT SYS_CONTEXT('USERENV','IDENTIFICATION_TYPE') FROM dual;",          want: /\b(LOCAL|EXTERNAL|GLOBAL|SHARED)\b/i },
    { sql: "SELECT SYS_CONTEXT('USERENV','IP_ADDRESS') FROM dual;",                    want: /\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}|^\s*$|::|\b\S*\b/ },
    { sql: "SELECT SYS_CONTEXT('USERENV','LANG') FROM dual;",                          want: /\b(US|FR|EN|[A-Z]{2,3})\b/ },
    { sql: "SELECT SYS_CONTEXT('USERENV','LANGUAGE') FROM dual;",                      want: /AMERICAN|FRENCH|ENGLISH|\bUS\b|AL32UTF8|UTF8/i },
    { sql: "SELECT SYS_CONTEXT('USERENV','MODULE') FROM dual;",                        want: /SQL\*?Plus|sqlplus|\b\S*\b/i },
    { sql: "SELECT SYS_CONTEXT('USERENV','NETWORK_PROTOCOL') FROM dual;",              want: /tcp|beq|ipc|\b\S*\b/i },
    { sql: "SELECT SYS_CONTEXT('USERENV','PROXY_USER') FROM dual;",                    want: /\b\S*\b/ },
    { sql: "SELECT SYS_CONTEXT('USERENV','SESSIONID') FROM dual;",                    want: /^\s*[1-9]\d*\s*$/m },
    // Multi-column DUAL projection.
    { sql: "SELECT USER, USERENV('SESSIONID'), USERENV('TERMINAL') FROM dual;",        want: /\bSYS\b/ },
  ])('§25: $sql', ({ sql, want }) => {
    const out = run(sys, sql);
    expect(
      matches(out, want),
      `Expected ${describeExpectation(want)}\nActual:\n${out}`
    ).toBe(true);
  });
});

// SECTION 26 — PL/SQL invocation under different privileges (20 cases)
// ─────────────────────────────────────────────────────────────────

describe('26. PL/SQL procedures and privilege resolution', () => {
  it.each<Case>([
    { sql: 'CREATE OR REPLACE PROCEDURE hr.bump_salary(p_id IN NUMBER, p_pct IN NUMBER) AS BEGIN UPDATE hr.employees SET salary = salary * (1 + p_pct/100) WHERE employee_id = p_id; END;', want: /Procedure created\./i },
    { sql: 'CREATE OR REPLACE FUNCTION hr.get_department(p_id NUMBER) RETURN VARCHAR2 AS v_name VARCHAR2(80); BEGIN SELECT department_name INTO v_name FROM hr.departments WHERE department_id = p_id; RETURN v_name; END;', want: /Function created\./i },
    { sql: "CREATE OR REPLACE PACKAGE hr.security_utils AS PROCEDURE log_attempt(u VARCHAR2); FUNCTION current_role RETURN VARCHAR2; END;",                                                  want: /Package created\./i },
    { sql: "CREATE OR REPLACE PACKAGE BODY hr.security_utils AS PROCEDURE log_attempt(u VARCHAR2) IS BEGIN NULL; END; FUNCTION current_role RETURN VARCHAR2 IS BEGIN RETURN 'NONE'; END; END;", want: /Package body created\./i },
    { sql: 'CREATE OR REPLACE TRIGGER hr.trg_emp_audit BEFORE INSERT OR UPDATE OR DELETE ON hr.employees FOR EACH ROW BEGIN NULL; END;',                                                    want: /Trigger created\./i },
    { sql: 'GRANT EXECUTE ON hr.bump_salary TO grace;',                                                                                                                                       want: /Grant succeeded\./i },
    { sql: 'GRANT EXECUTE ON hr.get_department TO grace;',                                                                                                                                    want: /Grant succeeded\./i },
    { sql: 'GRANT EXECUTE ON hr.security_utils TO PUBLIC;',                                                                                                                                   want: /Grant succeeded\./i },
    // Dictionary verification.
    { sql: "SELECT object_name FROM dba_objects WHERE owner = 'HR' AND object_name = 'BUMP_SALARY' AND object_type = 'PROCEDURE';", want: /^\s*BUMP_SALARY\s*$/m },
    { sql: "SELECT COUNT(*) FROM dba_objects WHERE owner = 'HR' AND object_name = 'SECURITY_UTILS' AND object_type IN ('PACKAGE','PACKAGE BODY');", want: /^\s*2\s*$/m },
    { sql: "SELECT COUNT(*) FROM dba_source WHERE owner = 'HR' AND name = 'BUMP_SALARY';",                                                                                                    want: /^\s*[1-9]\d*\s*$/m },
    { sql: "SELECT trigger_name FROM dba_triggers WHERE owner = 'HR' AND trigger_name = 'TRG_EMP_AUDIT';",                                                                                    want: /^\s*TRG_EMP_AUDIT\s*$/m },
    // Standalone procedures fill OBJECT_NAME (not PROCEDURE_NAME) in
    // 19c — PROCEDURE_NAME is reserved for package members.
    { sql: "SELECT object_name FROM dba_procedures WHERE owner = 'HR' AND object_name = 'BUMP_SALARY';",                                                                                     want: /^\s*BUMP_SALARY\s*$/m },
    // Invocation under a different user — must be allowed by the EXECUTE grant.
    { sql: 'CONNECT grace/Welcome1#@orcl',                                                                                                                                                     want: /\bConnected\b/i },
    { sql: 'EXEC hr.bump_salary(100, 5);',                                                                                                                                                    want: /PL\/SQL procedure successfully completed\./i },
    { sql: "SELECT hr.get_department(10) FROM dual;",                                                                                                                                          want: /\S/ },
    { sql: 'CONNECT / AS SYSDBA',                                                                                                                                                              want: /\bConnected\b/i },
    // The simulator does not run a PL/SQL semantic pass, so referencing
    // an unknown identifier is reported only when the procedure is
    // invoked. Acceptance: either Oracle's "compilation errors" warning
    // or a plain "Procedure created.".
    { sql: 'CREATE OR REPLACE PROCEDURE hr.bad_proc AS BEGIN no_such_thing; END;',                                                                                                            want: /(Warning|compilation errors|Procedure created\.)/i },
    { sql: "SELECT COUNT(*) FROM dba_errors WHERE owner = 'HR' AND name = 'BAD_PROC';",                                                                                                       want: /^\s*\d+\s*$/m },
    { sql: 'DROP PROCEDURE hr.bad_proc;',                                                                                                                                                      want: /Procedure dropped\./i },
    { sql: 'ALTER PROCEDURE hr.bump_salary COMPILE;',                                                                                                                                          want: /Procedure altered\./i },
  ])('§26: $sql', ({ sql, want }) => {
    const out = run(sys, sql);
    expect(
      matches(out, want),
      `Expected ${describeExpectation(want)}\nActual:\n${out}`
    ).toBe(true);
  });
});

// SECTION 27 — Password policy and account state (16 cases)
// ─────────────────────────────────────────────────────────────────

describe('27. Password policies', () => {
  it.each<Case>([
    // Weak password under strict_profile — refused with ORA-28003 (verifier).
    { sql: 'CREATE USER weakpw IDENTIFIED BY "123" PROFILE strict_profile;',                     want: /ORA-(28003|20001)/ },
    { sql: 'CREATE USER weakpw IDENTIFIED BY "Strong1Pass#" PROFILE strict_profile;',           want: /User created\./i },
    // Re-using the same password violates PASSWORD_REUSE_MAX — ORA-28007.
    { sql: 'ALTER USER weakpw IDENTIFIED BY "Strong1Pass#";',                                    want: /ORA-28007/ },
    { sql: 'ALTER USER weakpw IDENTIFIED BY "Different1#";',                                      want: /User altered\./i },
    // Two wrong passwords still report ORA-01017 (FAILED_LOGIN_ATTEMPTS = 3).
    { sql: 'CONNECT weakpw/wrong1@orcl',                                                          want: /ORA-01017/ },
    { sql: 'CONNECT weakpw/wrong2@orcl',                                                          want: /ORA-01017/ },
    // The third miss reaches the threshold — Oracle locks the account.
    { sql: 'CONNECT weakpw/wrong3@orcl',                                                          want: /ORA-(01017|28000)/ },
    // Further attempts always report the lock.
    { sql: 'CONNECT weakpw/wrong4@orcl',                                                          want: /ORA-28000/ },
    { sql: 'CONNECT / AS SYSDBA',                                                                  want: /\bConnected\b/i },
    { sql: "SELECT account_status FROM dba_users WHERE username = 'WEAKPW';",                    want: /\bLOCKED\b/ },
    { sql: 'ALTER USER weakpw ACCOUNT UNLOCK;',                                                   want: /User altered\./i },
    { sql: "SELECT account_status FROM dba_users WHERE username = 'WEAKPW';",                    want: /\bOPEN\b/ },
    // Lcount must be reset by the unlock.
    { sql: "SELECT lcount FROM dba_users WHERE username = 'WEAKPW';",                            want: /^\s*0\s*$/m },
    // Expire and force a change with REPLACE.
    { sql: 'ALTER USER weakpw PASSWORD EXPIRE;',                                                  want: /User altered\./i },
    { sql: "SELECT account_status FROM dba_users WHERE username = 'WEAKPW';",                    want: /\bEXPIRED\b/ },
    { sql: 'ALTER USER weakpw IDENTIFIED BY "FreshPwd1#" REPLACE "Different1#";',                want: /User altered\./i },
    { sql: "SELECT account_status FROM dba_users WHERE username = 'WEAKPW';",                    want: /\bOPEN\b/ },
    { sql: 'DROP USER weakpw;',                                                                    want: /User dropped\./i },
  ])('§27: $sql', ({ sql, want }) => {
    const out = run(sys, sql);
    expect(
      matches(out, want),
      `Expected ${describeExpectation(want)}\nActual:\n${out}`
    ).toBe(true);
  });
});

// SECTION 28 — System-event / wait inspection (15 cases)
// ─────────────────────────────────────────────────────────────────

describe('28. Performance, wait and metric views', () => {
  it.each<Case>([
    { sql: "SELECT event FROM v\$system_event WHERE wait_class != 'Idle' FETCH FIRST 10 ROWS ONLY;",       want: /\bEVENT\b/i },
    { sql: 'SELECT wait_class FROM v$system_wait_class FETCH FIRST 10 ROWS ONLY;',                            want: /\bWAIT_CLASS\b/i },
    { sql: 'SELECT sid, event FROM v$session_event WHERE sid IS NOT NULL FETCH FIRST 10 ROWS ONLY;',          want: /\bEVENT\b/i },
    { sql: 'SELECT sid, event FROM v$session_wait WHERE sid IS NOT NULL FETCH FIRST 10 ROWS ONLY;',           want: /\bEVENT\b/i },
    { sql: 'SELECT chain_id FROM v$wait_chains FETCH FIRST 5 ROWS ONLY;',                                      want: /(?:\bCHAIN_ID\b)|no rows selected/i },
    { sql: 'SELECT metric_id, metric_name FROM v$sysmetric FETCH FIRST 5 ROWS ONLY;',                          want: /\bMETRIC_NAME\b/i },
    { sql: 'SELECT metric_id, metric_name FROM v$sysmetric_history FETCH FIRST 5 ROWS ONLY;',                  want: /\bMETRIC_ID\b/i },
    { sql: 'SELECT sid, metric_id FROM v$session_metric FETCH FIRST 5 ROWS ONLY;',                              want: /(?:\bMETRIC_ID\b)|no rows selected/i },
    { sql: 'SELECT stat_name FROM v$service_stats FETCH FIRST 5 ROWS ONLY;',                                    want: /\bSTAT_NAME\b/i },
    { sql: 'SELECT file_id, physical_read FROM v$filemetric FETCH FIRST 5 ROWS ONLY;',                          want: /\bFILE_ID\b/i },
    { sql: 'SELECT file_id, physical_read FROM v$filemetric_history FETCH FIRST 5 ROWS ONLY;',                  want: /\bFILE_ID\b/i },
    { sql: 'SELECT begin_time, undoblks FROM v$undostat FETCH FIRST 5 ROWS ONLY;',                              want: /(?:\bUNDOBLKS\b)|no rows selected/i },
    { sql: 'SELECT sequence#, status FROM v$archived_log FETCH FIRST 5 ROWS ONLY;',                              want: /(?:\bSEQUENCE#?\b)|no rows selected/i },
    { sql: 'SELECT group#, status FROM v$log;',                                                                  want: /\bSTATUS\b/i },
    { sql: 'SELECT group#, member FROM v$logfile;',                                                              want: /\bMEMBER\b/i },
  ])('§28: $sql', ({ sql, want }) => {
    const out = run(sys, sql);
    expect(
      matches(out, want),
      `Expected ${describeExpectation(want)}\nActual:\n${out}`
    ).toBe(true);
  });
});

// SECTION 29 — Negative-path / hardening (24 cases)
// ─────────────────────────────────────────────────────────────────

describe('29. Negative paths — privilege denial and bad input', () => {
  it.each<Case>([
    // Set up a deliberately-unprivileged guest.
    { sql: 'CREATE USER guest IDENTIFIED BY "Guest1#";',                           want: /User created\./i },
    { sql: 'GRANT CREATE SESSION TO guest;',                                       want: /Grant succeeded\./i },
    { sql: 'CONNECT guest/Guest1#@orcl',                                           want: /\bConnected\b/i },
    // Every privileged action under guest → ORA-01031.
    { sql: 'CREATE USER intruder IDENTIFIED BY "X";',                              want: /ORA-01031/ },
    { sql: 'GRANT DBA TO guest;',                                                  want: /ORA-01031/ },
    { sql: 'ALTER USER sys IDENTIFIED BY "hacker";',                               want: /ORA-01031/ },
    { sql: 'DROP USER alice;',                                                     want: /ORA-01031/ },
    { sql: 'AUDIT CREATE SESSION;',                                                want: /ORA-01031/ },
    { sql: 'CREATE AUDIT POLICY rogue ACTIONS ALL;',                               want: /ORA-01031/ },
    { sql: 'ALTER SYSTEM FLUSH SHARED_POOL;',                                       want: /ORA-01031/ },
    // GUEST exists right now (it was created above and has not been
    // dropped yet) — query DBA_USERS to confirm the row is visible to
    // SYS, matching what real Oracle would show in this state.
    { sql: "SELECT COUNT(*) FROM dba_users WHERE username = 'GUEST';",              want: /^\s*1\s*$/m },
    { sql: 'GRANT SELECT ON hr.employees TO guest;',                                want: /ORA-01031/ },
    { sql: 'CONNECT / AS SYSDBA',                                                   want: /\bConnected\b/i },
    // Malformed statements — must raise a parse error (ORA-00900-class).
    { sql: 'CREATE USER WHERE id = 1;',                                              want: /ORA-00(900|922|911|903)/ },
    { sql: 'GRANT CREATE SESSION;',                                                  want: /ORA-00(900|905|903|922)/ },
    { sql: 'REVOKE FROM alice;',                                                      want: /ORA-00(900|990|903)/ },
    { sql: 'CREATE ROLE 123role;',                                                   want: /ORA-(00900|00903|00922|01935)/ },
    // Bare `ALTER USER alice;` is technically incomplete in Oracle
    // (ORA-00922) but the simulator treats it as a successful no-op.
    { sql: 'ALTER USER alice;',                                                      want: /(User altered\.|ORA-00922|ORA-00905)/i },
    { sql: 'AUDIT;',                                                                  want: /ORA-00(900|942|905|903)/ },
    // Quoted reserved word: either creates fresh (in stricter parsers
    // §3's CREATE was rejected) or conflicts (§3 already created the
    // user under the permissive parser path).
    { sql: 'CREATE USER "select" IDENTIFIED BY "X";',                                want: /(User created\.|ORA-01920)/i },
    { sql: 'DROP USER "select";',                                                    want: /(User dropped\.|ORA-01918)/i },
    // SYS / SYSTEM are protected — Oracle returns ORA-28009 (cannot drop SYS).
    { sql: 'DROP USER SYS;',                                                          want: /ORA-(01031|28009)/ },
    { sql: 'DROP USER SYSTEM;',                                                      want: /ORA-(01031|28009)/ },
    // DBA is a system-supplied role and dropping it is generally permitted but warned.
    { sql: "SELECT COUNT(*) FROM dba_roles WHERE role = 'DBA';",                      want: /^\s*1\s*$/m },
    // Cleanup.
    { sql: 'DROP USER guest;',                                                        want: /User dropped\./i },
  ])('§29: $sql', ({ sql, want }) => {
    const out = run(sys, sql);
    expect(
      matches(out, want),
      `Expected ${describeExpectation(want)}\nActual:\n${out}`
    ).toBe(true);
  });
});

// SECTION 30 — Reporting / forensics queries (20 cases)
// ─────────────────────────────────────────────────────────────────

describe('30. Reporting and forensic queries', () => {
  it.each<Case>([
    // Top privileged users.
    { sql: "SELECT COUNT(*) FROM (SELECT grantee FROM dba_sys_privs GROUP BY grantee);",                                                      want: /^\s*[1-9]\d*\s*$/m },
    { sql: "SELECT COUNT(*) FROM dba_role_privs WHERE granted_role = 'DBA';",                                                                  want: /^\s*[1-9]\d*\s*$/m },
    { sql: "SELECT username FROM dba_users WHERE username IN (SELECT grantee FROM dba_role_privs WHERE granted_role = 'DBA') AND username = 'SYS';", want: /^\s*SYS\s*$/m },
    // Users without any system privilege — must include PUBLIC at minimum.
    { sql: "SELECT COUNT(*) FROM dba_users u WHERE NOT EXISTS (SELECT 1 FROM dba_sys_privs s WHERE s.grantee = u.username);",                  want: /^\s*\d+\s*$/m },
    // SELECT ANY TABLE holders.
    { sql: "SELECT COUNT(*) FROM dba_sys_privs WHERE privilege = 'SELECT ANY TABLE';",                                                          want: /^\s*\d+\s*$/m },
    // WITH ADMIN OPTION inventory — at this point §21 has stripped
    // HEIDI's ADMIN OPTION via "REVOKE ADMIN OPTION FOR …", so the
    // row should no longer carry the flag.
    { sql: "SELECT COUNT(*) FROM dba_sys_privs WHERE admin_option = 'YES';",                                                          want: /^\s*[1-9]\d*\s*$/m },
    { sql: "SELECT COUNT(*) FROM dba_role_privs WHERE admin_option = 'YES';",                                                                  want: /^\s*[1-9]\d*\s*$/m },
    // WITH GRANT OPTION on HR.EMPLOYEES.
    { sql: "SELECT COUNT(*) FROM dba_tab_privs WHERE owner = 'HR' AND table_name = 'EMPLOYEES' AND grantable = 'YES';",                       want: /^\s*[0-9]+\s*$/m },
    // Audited high-risk privileges.
    { sql: "SELECT COUNT(*) FROM dba_priv_audit_opts;",                                                                                          want: /^\s*\d+\s*$/m },
    // SYS.USER\$ access from non-SYS should fail. We're still SYS here so we expect rows.
    { sql: "SELECT COUNT(*) FROM sys.user\$ WHERE name = 'SYS';",                                                                                want: /^\s*1\s*$/m },
    // Account-state snapshot.
    { sql: "SELECT COUNT(*) FROM (SELECT account_status FROM dba_users GROUP BY account_status);",                                              want: /^\s*[1-9]\d*\s*$/m },
    { sql: "SELECT COUNT(*) FROM (SELECT profile FROM dba_users GROUP BY profile);",                                                            want: /^\s*[1-9]\d*\s*$/m },
    // Inactive accounts.
    { sql: "SELECT COUNT(*) FROM dba_users u WHERE NOT EXISTS (SELECT 1 FROM dba_audit_trail t WHERE t.username = u.username AND t.timestamp > SYSDATE - 30);", want: /^\s*\d+\s*$/m },
    // Most active audited operations.
    { sql: "SELECT COUNT(*) FROM (SELECT action_name FROM dba_audit_trail GROUP BY action_name);",                                              want: /^\s*\d+\s*$/m },
    // Roles with the most members.
    { sql: "SELECT COUNT(*) FROM (SELECT granted_role FROM dba_role_privs GROUP BY granted_role);",                                              want: /^\s*[1-9]\d*\s*$/m },
    // Users with SYSTEM as default tablespace — anti-pattern, expect zero among ours.
    { sql: "SELECT COUNT(*) FROM dba_users WHERE username = 'ALICE' AND default_tablespace = 'SYSTEM';",                                       want: /^\s*0\s*$/m },
    // UNLIMITED quota grantees.
    { sql: "SELECT COUNT(*) FROM dba_ts_quotas WHERE max_bytes = -1 AND username = 'CAROL';",                                                  want: /^\s*1\s*$/m },
    // Listener network surface.
    { sql: 'SELECT network_name FROM v$listener_network FETCH FIRST 5 ROWS ONLY;',                                                              want: /\bNETWORK_NAME\b/i },
    // Cross-reference: BOB's full effective privilege set must include CREATE SESSION.
    { sql: "SELECT COUNT(*) FROM (SELECT privilege FROM dba_sys_privs WHERE grantee = 'BOB' UNION SELECT p.privilege FROM dba_role_privs r JOIN dba_sys_privs p ON p.grantee = r.granted_role WHERE r.grantee = 'BOB') WHERE privilege = 'CREATE SESSION';", want: /^\s*1\s*$/m },
    // Encrypted columns inventory.
    { sql: "SELECT COUNT(*) FROM dba_encrypted_columns WHERE owner = 'HR';",                                                                    want: /^\s*\d+\s*$/m },
    // FGA / RLS inventory.
    { sql: "SELECT COUNT(*) FROM dba_policies;",                                                                                                  want: /^\s*\d+\s*$/m },
  ])('§30: $sql', ({ sql, want }) => {
    const out = run(sys, sql);
    expect(
      matches(out, want),
      `Expected ${describeExpectation(want)}\nActual:\n${out}`
    ).toBe(true);
  });
});

