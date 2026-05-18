/**
 * Debug — Gestion des accès Oracle.
 *
 * Utilisateurs, rôles, privilèges système et objet, profils, quotas,
 * verrouillage de compte, politique de mot de passe, audit, GRANT/REVOKE.
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

describe('debug — Oracle access management', () => {
  it('parcourt toutes les facettes de la gestion des accès', () => {
    const srv = new LinuxServer('linux-server', 'ora-access', 100, 100);
    getOracleDatabase(srv.id);
    const runner = createSqlPlusRunner(srv);

    const lines: OracleDebugLine[] = [
      // ── Section 1: découverte des comptes existants ───────────────
      { section: 'discover existing users', cmd: 'SELECT username, account_status FROM dba_users ORDER BY username;' },
      'SELECT username, account_status, lock_date, expiry_date FROM dba_users;',
      "SELECT username, default_tablespace, temporary_tablespace FROM dba_users WHERE username NOT IN ('SYS','SYSTEM','OUTLN','XDB','DBSNMP');",
      'SELECT COUNT(*) AS total_users FROM dba_users;',
      "SELECT username FROM dba_users WHERE account_status LIKE '%LOCKED%';",
      "SELECT username FROM dba_users WHERE account_status = 'OPEN';",
      'SELECT * FROM dba_users WHERE username = \'SYS\';',
      'SELECT * FROM dba_users WHERE username = \'SYSTEM\';',
      'SELECT * FROM dba_users WHERE username = \'HR\';',
      'SELECT * FROM all_users ORDER BY created;',
      'SELECT user FROM dual;',
      'SHOW USER;',

      // ── Section 2: création d'utilisateurs ────────────────────────
      { section: 'create users', cmd: 'CREATE USER alice IDENTIFIED BY "Welcome1#";' },
      'CREATE USER bob IDENTIFIED BY "BobPass2024#";',
      'CREATE USER carol IDENTIFIED BY "Carol9876$";',
      'CREATE USER dave IDENTIFIED BY "DavePass#1";',
      'CREATE USER eve IDENTIFIED BY "EveSecret2024";',
      'CREATE USER frank IDENTIFIED BY "FrankPwd#1";',
      'CREATE USER grace IDENTIFIED BY "Grace#Pass1";',
      'CREATE USER henry IDENTIFIED BY "HenryPwd#2";',
      'CREATE USER iris IDENTIFIED BY "IrisP@ssw0rd";',
      'CREATE USER jack IDENTIFIED BY "JackPwd#2024";',
      'CREATE USER app_user IDENTIFIED BY "AppUser123#" DEFAULT TABLESPACE users TEMPORARY TABLESPACE temp;',
      'CREATE USER reporter IDENTIFIED BY "Reporter1#" DEFAULT TABLESPACE users TEMPORARY TABLESPACE temp QUOTA 100M ON users;',
      'CREATE USER analyst IDENTIFIED BY "Analyst1#" QUOTA UNLIMITED ON users;',
      'CREATE USER readonly IDENTIFIED BY "ReadOnly1#" PROFILE default;',
      'CREATE USER batch_user IDENTIFIED BY "Batch1#" QUOTA 500M ON users;',
      'CREATE USER schema_owner IDENTIFIED BY "Owner1#" QUOTA UNLIMITED ON users TEMPORARY TABLESPACE temp;',
      'CREATE USER dev_team IDENTIFIED BY "DevTeam1#";',
      'CREATE USER qa_team IDENTIFIED BY "QaTeam1#";',
      'CREATE USER ops_user IDENTIFIED BY "Ops1#";',
      'CREATE USER monitor IDENTIFIED BY "Monitor1#";',
      'SELECT username FROM dba_users WHERE created > SYSDATE - 1 ORDER BY username;',

      // ── Section 3: identification par OS / externe ────────────────
      { section: 'OS / external identification', cmd: 'CREATE USER ops$oracle IDENTIFIED EXTERNALLY;' },
      'CREATE USER global_user IDENTIFIED GLOBALLY AS \'CN=global,O=Acme\';',
      'CREATE USER kerberos_user IDENTIFIED EXTERNALLY AS \'kerberos@REALM.LOCAL\';',
      "ALTER USER alice IDENTIFIED EXTERNALLY;",
      "ALTER USER alice IDENTIFIED BY \"NewPass1#\";",

      // ── Section 4: privilèges système ──────────────────────────────
      { section: 'system privileges', cmd: 'GRANT CREATE SESSION TO alice;' },
      'GRANT CREATE SESSION TO bob, carol, dave;',
      'GRANT CREATE TABLE TO alice;',
      'GRANT CREATE VIEW TO alice;',
      'GRANT CREATE PROCEDURE TO alice;',
      'GRANT CREATE SEQUENCE TO alice;',
      'GRANT CREATE SYNONYM TO alice;',
      'GRANT CREATE TRIGGER TO alice;',
      'GRANT CREATE TYPE TO alice;',
      'GRANT CREATE INDEX TO alice;',
      'GRANT CREATE MATERIALIZED VIEW TO alice;',
      'GRANT CREATE ANY TABLE TO bob;',
      'GRANT SELECT ANY TABLE TO bob;',
      'GRANT INSERT ANY TABLE TO bob;',
      'GRANT UPDATE ANY TABLE TO bob;',
      'GRANT DELETE ANY TABLE TO bob;',
      'GRANT EXECUTE ANY PROCEDURE TO bob;',
      'GRANT CREATE ANY VIEW TO carol;',
      'GRANT DROP ANY TABLE TO dave;',
      'GRANT ALTER ANY TABLE TO dave;',
      'GRANT CREATE TABLESPACE TO ops_user;',
      'GRANT DROP TABLESPACE TO ops_user;',
      'GRANT ALTER TABLESPACE TO ops_user;',
      'GRANT MANAGE TABLESPACE TO ops_user;',
      'GRANT CREATE USER TO ops_user;',
      'GRANT ALTER USER TO ops_user;',
      'GRANT DROP USER TO ops_user;',
      'GRANT ALTER SYSTEM TO ops_user;',
      'GRANT ALTER SESSION TO ops_user;',
      'GRANT UNLIMITED TABLESPACE TO app_user;',

      // ── Section 5: lecture des privilèges accordés ─────────────────
      { section: 'inspect granted system privileges', cmd: "SELECT * FROM dba_sys_privs WHERE grantee = 'ALICE' ORDER BY privilege;" },
      "SELECT grantee, privilege, admin_option FROM dba_sys_privs WHERE grantee = 'BOB';",
      "SELECT * FROM dba_sys_privs WHERE grantee = 'OPS_USER';",
      'SELECT grantee, COUNT(*) AS priv_count FROM dba_sys_privs GROUP BY grantee ORDER BY priv_count DESC;',
      "SELECT privilege FROM session_privs;",
      'SELECT COUNT(*) FROM session_privs;',
      "SELECT grantee, privilege FROM dba_sys_privs WHERE privilege LIKE 'CREATE%';",
      "SELECT grantee FROM dba_sys_privs WHERE privilege = 'CREATE SESSION';",
      "SELECT grantee FROM dba_sys_privs WHERE privilege = 'ALTER SYSTEM';",
      "SELECT grantee FROM dba_sys_privs WHERE admin_option = 'YES';",

      // ── Section 6: privilèges objet ────────────────────────────────
      { section: 'object privileges', cmd: 'GRANT SELECT ON hr.employees TO alice;' },
      'GRANT INSERT ON hr.employees TO bob;',
      'GRANT UPDATE ON hr.employees TO bob;',
      'GRANT DELETE ON hr.employees TO bob;',
      'GRANT REFERENCES ON hr.employees TO carol;',
      'GRANT SELECT (employee_id, first_name) ON hr.employees TO dave;',
      'GRANT UPDATE (salary) ON hr.employees TO eve;',
      'GRANT ALL ON hr.departments TO frank;',
      'GRANT EXECUTE ON hr.add_employee TO grace;',
      'GRANT ALTER ON hr.employees TO ops_user;',
      'GRANT DEBUG ON hr.add_employee TO ops_user;',
      'GRANT INDEX ON hr.employees TO ops_user;',
      "SELECT * FROM dba_tab_privs WHERE grantee = 'ALICE';",
      "SELECT * FROM dba_tab_privs WHERE table_name = 'EMPLOYEES';",
      "SELECT * FROM dba_col_privs WHERE grantee = 'DAVE';",
      'SELECT grantee, owner, table_name, privilege FROM all_tab_privs ORDER BY grantee, table_name;',
      'SELECT COUNT(*) FROM dba_tab_privs;',
      'SELECT COUNT(*) FROM dba_col_privs;',

      // ── Section 7: rôles ───────────────────────────────────────────
      { section: 'roles', cmd: 'CREATE ROLE app_role;' },
      'CREATE ROLE read_only_role;',
      'CREATE ROLE write_role;',
      'CREATE ROLE admin_role IDENTIFIED BY "Admin1#";',
      'CREATE ROLE manager_role;',
      'CREATE ROLE developer_role;',
      'CREATE ROLE tester_role;',
      'CREATE ROLE reporting_role NOT IDENTIFIED;',
      'CREATE ROLE batch_role;',
      'CREATE ROLE etl_role;',
      'GRANT CREATE SESSION TO app_role;',
      'GRANT CREATE TABLE TO app_role;',
      'GRANT CREATE VIEW TO app_role;',
      'GRANT CREATE PROCEDURE TO app_role;',
      'GRANT SELECT ANY TABLE TO read_only_role;',
      'GRANT INSERT ANY TABLE, UPDATE ANY TABLE, DELETE ANY TABLE TO write_role;',
      'GRANT ALL PRIVILEGES TO admin_role;',
      'GRANT app_role TO bob;',
      'GRANT read_only_role TO readonly;',
      'GRANT write_role TO app_user;',
      'GRANT admin_role TO ops_user;',
      'GRANT app_role TO dev_team;',
      'GRANT developer_role TO alice, bob, carol;',
      'GRANT tester_role TO qa_team;',
      'GRANT manager_role TO grace WITH ADMIN OPTION;',
      'GRANT read_only_role TO reporting_role;',
      'SELECT * FROM dba_roles ORDER BY role;',
      "SELECT * FROM dba_role_privs WHERE grantee = 'BOB';",
      "SELECT * FROM dba_role_privs WHERE granted_role = 'APP_ROLE';",
      "SELECT * FROM role_role_privs;",
      "SELECT * FROM role_sys_privs WHERE role = 'APP_ROLE';",
      "SELECT * FROM role_tab_privs WHERE role = 'READ_ONLY_ROLE';",
      'SELECT * FROM session_roles;',
      'SET ROLE app_role;',
      'SET ROLE NONE;',
      'SET ROLE ALL;',
      'SET ROLE ALL EXCEPT admin_role;',

      // ── Section 8: rôles par défaut ────────────────────────────────
      { section: 'default roles', cmd: 'ALTER USER bob DEFAULT ROLE app_role;' },
      'ALTER USER alice DEFAULT ROLE ALL EXCEPT admin_role;',
      'ALTER USER carol DEFAULT ROLE NONE;',
      'ALTER USER dave DEFAULT ROLE app_role, developer_role;',
      "SELECT username, default_role FROM dba_role_privs WHERE grantee = 'BOB';",

      // ── Section 9: profiles + politique de mot de passe ───────────
      { section: 'profiles + password policy', cmd: 'CREATE PROFILE secure_profile LIMIT FAILED_LOGIN_ATTEMPTS 5 PASSWORD_LIFE_TIME 90 PASSWORD_REUSE_TIME 365 PASSWORD_REUSE_MAX 5 PASSWORD_LOCK_TIME 1/24 PASSWORD_GRACE_TIME 7 SESSIONS_PER_USER 10 IDLE_TIME 30 CONNECT_TIME 240 LOGICAL_READS_PER_SESSION DEFAULT;' },
      'CREATE PROFILE app_profile LIMIT SESSIONS_PER_USER 100 IDLE_TIME 60 CPU_PER_CALL UNLIMITED;',
      'CREATE PROFILE batch_profile LIMIT SESSIONS_PER_USER 5 CONNECT_TIME UNLIMITED CPU_PER_CALL UNLIMITED;',
      'CREATE PROFILE strict_profile LIMIT FAILED_LOGIN_ATTEMPTS 3 PASSWORD_LIFE_TIME 30 PASSWORD_LOCK_TIME UNLIMITED;',
      'ALTER USER alice PROFILE secure_profile;',
      'ALTER USER bob PROFILE app_profile;',
      'ALTER USER batch_user PROFILE batch_profile;',
      "ALTER PROFILE secure_profile LIMIT FAILED_LOGIN_ATTEMPTS 10;",
      'SELECT * FROM dba_profiles ORDER BY profile, resource_name;',
      "SELECT * FROM dba_profiles WHERE profile = 'SECURE_PROFILE';",
      "SELECT profile, resource_name, limit FROM dba_profiles WHERE resource_name = 'FAILED_LOGIN_ATTEMPTS';",
      "SELECT username, profile FROM dba_users WHERE profile != 'DEFAULT';",

      // ── Section 10: verrouillage / déverrouillage de comptes ──────
      { section: 'lock / unlock accounts', cmd: 'ALTER USER alice ACCOUNT LOCK;' },
      'ALTER USER bob ACCOUNT LOCK;',
      'ALTER USER carol ACCOUNT UNLOCK;',
      'ALTER USER alice ACCOUNT UNLOCK;',
      'ALTER USER eve PASSWORD EXPIRE;',
      'ALTER USER frank IDENTIFIED BY VALUES \'S:abcd1234...\';', // hashed
      'ALTER USER iris IDENTIFIED BY "NewIris1#" REPLACE "IrisP@ssw0rd";',
      "SELECT username, account_status FROM dba_users WHERE username IN ('ALICE','BOB','CAROL','EVE');",
      'ALTER USER bob ACCOUNT UNLOCK;',
      'ALTER USER eve PASSWORD EXPIRE;',

      // ── Section 11: REVOKE ────────────────────────────────────────
      { section: 'revoke privileges', cmd: 'REVOKE CREATE TABLE FROM alice;' },
      'REVOKE SELECT ANY TABLE FROM bob;',
      'REVOKE ALL PRIVILEGES FROM dave;',
      'REVOKE SELECT ON hr.employees FROM alice;',
      'REVOKE UPDATE (salary) ON hr.employees FROM eve;',
      'REVOKE app_role FROM bob;',
      'REVOKE admin_role FROM ops_user;',
      'REVOKE developer_role FROM carol;',
      'REVOKE EXECUTE ANY PROCEDURE FROM bob;',
      'REVOKE UNLIMITED TABLESPACE FROM app_user;',

      // ── Section 12: quotas tablespace ─────────────────────────────
      { section: 'quotas', cmd: 'ALTER USER alice QUOTA 100M ON users;' },
      'ALTER USER bob QUOTA 500M ON users;',
      'ALTER USER carol QUOTA UNLIMITED ON users;',
      'ALTER USER dave QUOTA 0 ON users;',
      'ALTER USER eve QUOTA 50M ON users TEMPORARY;',
      'SELECT * FROM dba_ts_quotas ORDER BY username, tablespace_name;',
      "SELECT username, tablespace_name, bytes, max_bytes FROM dba_ts_quotas WHERE username = 'ALICE';",
      "SELECT username, tablespace_name, max_bytes FROM dba_ts_quotas WHERE max_bytes = -1;",

      // ── Section 13: audit ─────────────────────────────────────────
      { section: 'audit', cmd: 'AUDIT SELECT TABLE BY alice;' },
      'AUDIT INSERT, UPDATE, DELETE ON hr.employees;',
      'AUDIT ALL ON hr.employees BY ACCESS;',
      'AUDIT CREATE TABLE BY bob;',
      'AUDIT DROP ANY TABLE;',
      'AUDIT SESSION BY alice WHENEVER SUCCESSFUL;',
      'AUDIT SESSION BY bob WHENEVER NOT SUCCESSFUL;',
      'AUDIT GRANT ANY PRIVILEGE;',
      'AUDIT ALTER USER;',
      'AUDIT CREATE SESSION;',
      'NOAUDIT SELECT TABLE BY alice;',
      "SELECT * FROM dba_audit_trail WHERE username = 'ALICE' ORDER BY timestamp DESC FETCH FIRST 50 ROWS ONLY;",
      "SELECT * FROM dba_audit_session ORDER BY timestamp DESC FETCH FIRST 50 ROWS ONLY;",
      "SELECT * FROM dba_audit_object WHERE owner = 'HR' AND obj_name = 'EMPLOYEES';",
      "SELECT * FROM dba_obj_audit_opts WHERE owner = 'HR';",
      "SELECT * FROM dba_stmt_audit_opts;",
      "SELECT * FROM dba_priv_audit_opts;",

      // ── Section 14: politique d'audit unifié (12c+) ───────────────
      { section: 'unified audit', cmd: 'CREATE AUDIT POLICY login_audit ACTIONS LOGON, LOGOFF;' },
      'CREATE AUDIT POLICY hr_audit ACTIONS UPDATE, DELETE ON hr.employees;',
      'CREATE AUDIT POLICY ddl_audit PRIVILEGES CREATE ANY TABLE, DROP ANY TABLE;',
      'AUDIT POLICY login_audit;',
      'AUDIT POLICY hr_audit BY alice, bob;',
      'AUDIT POLICY ddl_audit EXCEPT carol;',
      'NOAUDIT POLICY login_audit;',
      'DROP AUDIT POLICY hr_audit;',
      "SELECT * FROM audit_unified_policies WHERE policy_name = 'LOGIN_AUDIT';",
      "SELECT * FROM unified_audit_trail ORDER BY event_timestamp DESC FETCH FIRST 100 ROWS ONLY;",

      // ── Section 15: VPD / fine-grained access (FGAC) ──────────────
      { section: 'fine-grained access control', cmd:
        "BEGIN DBMS_RLS.ADD_POLICY(object_schema=>'HR', object_name=>'EMPLOYEES', policy_name=>'emp_dept_pol', function_schema=>'HR', policy_function=>'dept_security_predicate'); END;" },
      "BEGIN DBMS_RLS.DROP_POLICY('HR','EMPLOYEES','emp_dept_pol'); END;",
      'SELECT * FROM dba_policies;',
      'SELECT * FROM dba_policy_groups;',
      'SELECT * FROM dba_sec_relevant_cols;',

      // ── Section 16: Database Vault (16+) ──────────────────────────
      { section: 'Database Vault', cmd: 'SELECT * FROM dba_dv_realm;' },
      'SELECT * FROM dba_dv_role;',
      'SELECT * FROM dba_dv_realm_auth;',
      'SELECT * FROM dba_dv_command_rule;',
      'SELECT * FROM dba_dv_factor;',

      // ── Section 17: TDE / chiffrement transparent ─────────────────
      { section: 'TDE', cmd: 'SELECT * FROM v$encryption_keys;' },
      'SELECT * FROM v$encryption_wallet;',
      'SELECT * FROM dba_encrypted_columns;',
      'SELECT * FROM v$encrypted_tablespaces;',
      "ALTER TABLE hr.employees MODIFY (salary ENCRYPT USING 'AES256');",
      'ALTER TABLESPACE users ENCRYPTION ONLINE ENCRYPT;',

      // ── Section 18: PROXY users / connect-through ─────────────────
      { section: 'proxy users', cmd: 'ALTER USER alice GRANT CONNECT THROUGH bob;' },
      'ALTER USER alice GRANT CONNECT THROUGH bob WITH ROLE app_role;',
      'ALTER USER alice REVOKE CONNECT THROUGH bob;',
      'SELECT * FROM proxy_users;',

      // ── Section 19: SESSION management ─────────────────────────────
      { section: 'session inspection', cmd: 'SELECT sid, serial#, username, status, program, machine, osuser FROM v$session WHERE username IS NOT NULL;' },
      'SELECT COUNT(*) FROM v$session;',
      "SELECT COUNT(*) FROM v$session WHERE username = 'ALICE';",
      'SELECT sid, serial#, username, status, last_call_et FROM v$session WHERE status = \'ACTIVE\';',
      'SELECT sid, serial#, sql_id FROM v$session WHERE sql_id IS NOT NULL;',
      "ALTER SYSTEM KILL SESSION '142,12345';",
      "ALTER SYSTEM DISCONNECT SESSION '142,12345' IMMEDIATE;",
      "ALTER SYSTEM DISCONNECT SESSION '142,12345' POST_TRANSACTION;",

      // ── Section 20: connexion test croisée ────────────────────────
      { section: 'test cross-user select', cmd: 'CONNECT alice/Welcome1#@orcl' },
      'SELECT user FROM dual;',
      'SELECT * FROM session_roles;',
      'SELECT * FROM session_privs;',
      'CONNECT bob/BobPass2024#@orcl',
      'SELECT user FROM dual;',
      'CONNECT system/oracle as sysdba',
      'SHOW USER;',

      // ── Section 21: tracker des connexions en échec ──────────────
      { section: 'failed logins / lockouts', cmd: 'SELECT * FROM dba_audit_session WHERE returncode != 0 ORDER BY timestamp DESC FETCH FIRST 20 ROWS ONLY;' },
      "SELECT username, lock_date FROM dba_users WHERE account_status LIKE '%LOCKED%';",
      "SELECT username, lcount FROM dba_users WHERE lcount > 0;",

      // ── Section 22: cleanup ───────────────────────────────────────
      { section: 'cleanup', cmd: 'DROP USER alice CASCADE;' },
      'DROP USER bob CASCADE;',
      'DROP USER carol CASCADE;',
      'DROP USER dave CASCADE;',
      'DROP USER eve CASCADE;',
      'DROP USER frank CASCADE;',
      'DROP USER grace CASCADE;',
      'DROP USER henry CASCADE;',
      'DROP USER iris CASCADE;',
      'DROP USER jack CASCADE;',
      'DROP USER app_user CASCADE;',
      'DROP USER reporter CASCADE;',
      'DROP USER analyst CASCADE;',
      'DROP USER readonly CASCADE;',
      'DROP USER batch_user CASCADE;',
      'DROP USER schema_owner CASCADE;',
      'DROP USER dev_team CASCADE;',
      'DROP USER qa_team CASCADE;',
      'DROP USER ops_user CASCADE;',
      'DROP USER monitor CASCADE;',
      'DROP ROLE app_role;',
      'DROP ROLE read_only_role;',
      'DROP ROLE write_role;',
      'DROP ROLE admin_role;',
      'DROP ROLE manager_role;',
      'DROP ROLE developer_role;',
      'DROP ROLE tester_role;',
      'DROP ROLE reporting_role;',
      'DROP ROLE batch_role;',
      'DROP ROLE etl_role;',
      'DROP PROFILE secure_profile CASCADE;',
      'DROP PROFILE app_profile CASCADE;',
      'DROP PROFILE batch_profile CASCADE;',
      'DROP PROFILE strict_profile CASCADE;',
      'SELECT COUNT(*) FROM dba_users;',
      'SELECT COUNT(*) FROM dba_roles;',
      'SELECT COUNT(*) FROM dba_profiles;',

      // ── Section 23: edge / erreurs ────────────────────────────────
      { section: 'edge cases', cmd: 'CREATE USER nopassword;' },
      'CREATE USER weakpass IDENTIFIED BY "abc";', // password too short
      "GRANT CREATE SESSION TO nonexistent_user;",
      'GRANT BOGUS_PRIVILEGE TO bob;',
      'REVOKE BOGUS_PRIVILEGE FROM bob;',
      'DROP USER nonexistent_user;',
      'DROP ROLE nonexistent_role;',
      'CREATE USER alice IDENTIFIED BY "X1#";', // duplicate
      'ALTER USER nonexistent IDENTIFIED BY x;',
      ...monitoringSweep('access-management'),
      'EXIT;',
    ];

    runOracleDump('oracle-access-management',
      'LinuxServer ora-access (10.0.0.10) — Oracle ORCL OPEN', lines, runner);
    runner.dispose();
    removeOracleDatabase(srv.id);
  });
});
