/**
 * Debug — Oracle roles, profiles, provisioning, object access.
 *
 * Exercises everything DBA scripts use to inspect and manage the
 * role/privilege/profile layer:
 *
 *   - DBA_ROLES inventory (classic 19c roles)
 *   - DBA_ROLE_PRIVS / ROLE_ROLE_PRIVS / SESSION_ROLES
 *   - DBA_SYS_PRIVS / ROLE_SYS_PRIVS / SESSION_PRIVS
 *   - DBA_TAB_PRIVS / ROLE_TAB_PRIVS
 *   - DBA_PROFILES + resource limits
 *   - PROVISIONING: CREATE USER … IDENTIFIED BY … PROFILE / DEFAULT
 *     TABLESPACE / TEMPORARY TABLESPACE / QUOTA, GRANT/REVOKE on
 *     objects, SET ROLE, ALTER USER … LOCK / UNLOCK / PASSWORD EXPIRE.
 *   - SELECT ANY TABLE / CREATE ANY TABLE / etc. — verify the
 *     privilege check actually fires.
 *
 * No assertions — the dump file IS the deliverable.
 */

import { describe, it, beforeEach } from 'vitest';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { removeOracleDatabase, getOracleDatabase } from '@/terminal/commands/database';
import { createSqlPlusRunner, runOracleDump, type OracleDebugLine } from './_oracle-dump';
import { monitoringSweep } from './_padding';

beforeEach(() => { resetCounters(); resetDeviceCounters(); Logger.reset(); });

describe('debug — Oracle roles & profiles', () => {
  it('inventories every classic role/profile and exercises the provisioning flow', () => {
    const srv = new LinuxServer('linux-server', 'ora-roles', 100, 100);
    getOracleDatabase(srv.id);
    const runner = createSqlPlusRunner(srv);

    const lines: OracleDebugLine[] = [
      // ── 1. role inventory ────────────────────────────────────────
      { section: 'role inventory', cmd: 'SELECT role, password_required, authentication_type FROM dba_roles ORDER BY role;' },
      'SELECT COUNT(*) FROM dba_roles;',
      "SELECT role FROM dba_roles WHERE role LIKE 'AUDIT_%';",
      "SELECT role FROM dba_roles WHERE role LIKE '%CATALOG%';",
      "SELECT role FROM dba_roles WHERE role LIKE 'DATAPUMP%';",
      "SELECT role FROM dba_roles WHERE role LIKE 'AQ_%';",
      "SELECT role FROM dba_roles WHERE role LIKE '%PDB%';",

      // ── 2. who holds which role ──────────────────────────────────
      { section: 'who holds which role', cmd:
        "SELECT grantee, granted_role, admin_option, default_role FROM dba_role_privs ORDER BY grantee, granted_role;" },
      "SELECT grantee, COUNT(*) AS roles FROM dba_role_privs GROUP BY grantee ORDER BY roles DESC;",
      "SELECT granted_role, COUNT(*) AS grantees FROM dba_role_privs GROUP BY granted_role ORDER BY grantees DESC;",
      "SELECT grantee FROM dba_role_privs WHERE granted_role = 'DBA';",
      "SELECT grantee FROM dba_role_privs WHERE granted_role = 'CONNECT';",
      "SELECT grantee FROM dba_role_privs WHERE granted_role = 'RESOURCE';",

      // ── 3. role-to-role hierarchy ────────────────────────────────
      { section: 'role-to-role hierarchy', cmd:
        "SELECT role, granted_role, admin_option FROM role_role_privs ORDER BY role, granted_role;" },
      "SELECT role, granted_role FROM role_role_privs WHERE role = 'DBA';",
      "SELECT role, granted_role FROM role_role_privs WHERE role = 'SELECT_CATALOG_ROLE';",

      // ── 4. system privileges by role ─────────────────────────────
      { section: 'system privileges by role', cmd:
        "SELECT role, privilege, admin_option FROM role_sys_privs ORDER BY role, privilege;" },
      "SELECT role, COUNT(*) AS privs FROM role_sys_privs GROUP BY role ORDER BY privs DESC;",
      "SELECT privilege FROM role_sys_privs WHERE role = 'DBA' ORDER BY privilege;",
      "SELECT privilege FROM role_sys_privs WHERE role = 'CONNECT' ORDER BY privilege;",
      "SELECT privilege FROM role_sys_privs WHERE role = 'RESOURCE' ORDER BY privilege;",
      "SELECT role FROM role_sys_privs WHERE privilege = 'SELECT ANY TABLE';",

      // ── 5. object privileges by role ─────────────────────────────
      { section: 'object privileges by role', cmd:
        "SELECT role, owner, table_name, privilege FROM role_tab_privs ORDER BY role, owner, table_name FETCH FIRST 30 ROWS ONLY;" },
      "SELECT role, COUNT(*) AS objects FROM role_tab_privs GROUP BY role ORDER BY objects DESC;",
      "SELECT COUNT(*) FROM role_tab_privs WHERE role = 'SELECT_CATALOG_ROLE';",
      "SELECT COUNT(*) FROM role_tab_privs WHERE role = 'EXECUTE_CATALOG_ROLE';",

      // ── 6. session view (as SYS) ─────────────────────────────────
      { section: 'session view (SYS)', cmd: 'SELECT role FROM session_roles ORDER BY role;' },
      'SELECT privilege FROM session_privs ORDER BY privilege FETCH FIRST 30 ROWS ONLY;',
      'SELECT COUNT(*) FROM session_privs;',
      'SELECT COUNT(*) FROM session_roles;',

      // ── 7. user roles (DBA_USERS) ────────────────────────────────
      { section: 'user roles', cmd:
        "SELECT username, account_status, default_tablespace, temporary_tablespace, profile FROM dba_users ORDER BY username;" },
      "SELECT u.username, COUNT(r.granted_role) AS roles_held FROM dba_users u LEFT JOIN dba_role_privs r ON r.grantee = u.username GROUP BY u.username ORDER BY roles_held DESC;",
      "SELECT grantee, granted_role FROM dba_role_privs WHERE grantee = 'HR';",
      "SELECT grantee, granted_role FROM dba_role_privs WHERE grantee = 'SCOTT';",

      // ── 8. profile inventory ─────────────────────────────────────
      { section: 'profile inventory', cmd:
        "SELECT DISTINCT profile FROM dba_profiles ORDER BY profile;" },
      "SELECT profile, resource_name, limit FROM dba_profiles WHERE profile = 'DEFAULT' ORDER BY resource_name;",
      "SELECT profile, resource_name, limit FROM dba_profiles WHERE resource_name = 'FAILED_LOGIN_ATTEMPTS';",
      "SELECT profile, resource_name, limit FROM dba_profiles WHERE resource_name = 'PASSWORD_LIFE_TIME';",
      "SELECT profile, resource_name, limit FROM dba_profiles WHERE resource_name = 'SESSIONS_PER_USER';",
      "SELECT profile, resource_name, limit FROM dba_profiles WHERE resource_name = 'IDLE_TIME';",

      // ── 9. provisioning — CREATE USER variants ──────────────────
      { section: 'CREATE USER variants', cmd:
        "CREATE USER alice IDENTIFIED BY \"AliceP4ss!\" DEFAULT TABLESPACE users TEMPORARY TABLESPACE temp QUOTA 100M ON users PROFILE DEFAULT;" },
      "CREATE USER bob IDENTIFIED BY \"BobP4ss!\" PROFILE DEFAULT;",
      "CREATE USER carol IDENTIFIED BY \"CarolP4ss!\" QUOTA UNLIMITED ON users;",
      "ALTER USER alice ACCOUNT LOCK;",
      "ALTER USER alice ACCOUNT UNLOCK;",
      "ALTER USER bob PASSWORD EXPIRE;",
      "ALTER USER carol DEFAULT TABLESPACE users;",
      "ALTER USER carol QUOTA 50M ON users;",
      "SELECT username, account_status FROM dba_users WHERE username IN ('ALICE', 'BOB', 'CAROL');",

      // ── 10. GRANT/REVOKE on roles ───────────────────────────────
      { section: 'GRANT/REVOKE on roles', cmd: 'GRANT CONNECT TO alice;' },
      'GRANT RESOURCE TO alice;',
      'GRANT SELECT_CATALOG_ROLE TO bob;',
      'GRANT DBA TO carol WITH ADMIN OPTION;',
      "SELECT grantee, granted_role, admin_option FROM dba_role_privs WHERE grantee IN ('ALICE','BOB','CAROL');",
      'REVOKE RESOURCE FROM alice;',
      "SELECT grantee, granted_role FROM dba_role_privs WHERE grantee = 'ALICE';",

      // ── 11. CREATE ROLE custom ──────────────────────────────────
      { section: 'CREATE ROLE custom', cmd: 'CREATE ROLE app_reader;' },
      'CREATE ROLE app_writer;',
      'CREATE ROLE app_admin;',
      'GRANT app_reader TO app_writer;',
      'GRANT app_writer TO app_admin;',
      'GRANT SELECT ANY TABLE TO app_reader;',
      'GRANT INSERT ANY TABLE, UPDATE ANY TABLE, DELETE ANY TABLE TO app_writer;',
      'GRANT CREATE ANY TABLE, DROP ANY TABLE TO app_admin;',
      'GRANT app_admin TO alice WITH ADMIN OPTION;',
      "SELECT role, granted_role FROM role_role_privs WHERE role IN ('APP_ADMIN','APP_WRITER','APP_READER');",
      "SELECT role, privilege FROM role_sys_privs WHERE role IN ('APP_ADMIN','APP_WRITER','APP_READER') ORDER BY role, privilege;",

      // ── 12. provisioning — object-level grants ──────────────────
      { section: 'object-level grants', cmd: 'CREATE TABLE hr.audit_log (id NUMBER PRIMARY KEY, msg VARCHAR2(200));' },
      'GRANT SELECT, INSERT ON hr.audit_log TO alice;',
      'GRANT SELECT ON hr.audit_log TO app_reader;',
      'GRANT ALL ON hr.audit_log TO bob WITH GRANT OPTION;',
      "SELECT grantee, owner, table_name, privilege, grantable FROM dba_tab_privs WHERE table_name = 'AUDIT_LOG';",
      "SELECT role, owner, table_name, privilege FROM role_tab_privs WHERE role = 'APP_READER';",
      "REVOKE INSERT ON hr.audit_log FROM alice;",
      "SELECT grantee, privilege FROM dba_tab_privs WHERE table_name = 'AUDIT_LOG' AND grantee = 'ALICE';",

      // ── 13. PROFILE management ──────────────────────────────────
      { section: 'PROFILE management', cmd:
        "CREATE PROFILE app_profile LIMIT SESSIONS_PER_USER 5 IDLE_TIME 30 PASSWORD_LIFE_TIME 90 FAILED_LOGIN_ATTEMPTS 5;" },
      "ALTER USER alice PROFILE app_profile;",
      "SELECT username, profile FROM dba_users WHERE username = 'ALICE';",
      "SELECT profile, resource_name, limit FROM dba_profiles WHERE profile = 'APP_PROFILE' ORDER BY resource_name;",
      "ALTER PROFILE app_profile LIMIT SESSIONS_PER_USER 10;",
      "SELECT limit FROM dba_profiles WHERE profile='APP_PROFILE' AND resource_name='SESSIONS_PER_USER';",
      "DROP PROFILE app_profile CASCADE;",
      "SELECT COUNT(*) FROM dba_profiles WHERE profile = 'APP_PROFILE';",

      // ── 14. role enforcement at SELECT time ─────────────────────
      // (these will fail or succeed depending on the current SYSDBA bypass)
      { section: 'role enforcement', cmd: "SELECT * FROM hr.employees FETCH FIRST 2 ROWS ONLY;" },
      "SELECT COUNT(*) FROM scott.emp;",
      "SELECT username, default_tablespace FROM dba_users WHERE username = 'HR';",

      // ── 15. drop & cleanup ──────────────────────────────────────
      { section: 'drop & cleanup', cmd: 'DROP ROLE app_admin;' },
      'DROP ROLE app_writer;',
      'DROP ROLE app_reader;',
      'DROP USER alice CASCADE;',
      'DROP USER bob CASCADE;',
      'DROP USER carol CASCADE;',
      'DROP TABLE hr.audit_log;',
      "SELECT username FROM dba_users WHERE username IN ('ALICE','BOB','CAROL');",
      "SELECT role FROM dba_roles WHERE role LIKE 'APP_%';",

      // ── 16. summary ─────────────────────────────────────────────
      { section: 'summary', cmd:
        "SELECT (SELECT COUNT(*) FROM dba_users) AS users, " +
        "(SELECT COUNT(*) FROM dba_roles) AS roles, " +
        "(SELECT COUNT(*) FROM dba_role_privs) AS role_grants, " +
        "(SELECT COUNT(*) FROM dba_sys_privs) AS sys_grants, " +
        "(SELECT COUNT(*) FROM dba_tab_privs) AS tab_grants, " +
        "(SELECT COUNT(*) FROM dba_profiles) AS profile_rows FROM dual;" },
      ...monitoringSweep('roles'),
      'EXIT;',
    ];

    runOracleDump('oracle-roles', 'LinuxServer ora-roles — Oracle ORCL OPEN', lines, runner);
    runner.dispose();
    removeOracleDatabase(srv.id);
  });
});
