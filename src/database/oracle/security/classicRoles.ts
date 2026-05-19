/**
 * Classic Oracle 19c role catalogue.
 *
 * One declarative table — name, description, the system privileges
 * granted to it, and the nested roles it includes. OracleCatalog
 * consumes this list at boot time so the role inventory matches what
 * `dba_roles` reports on a real 19c instance.
 *
 * Object-level grants (e.g. SELECT_CATALOG_ROLE getting SELECT on every
 * SYS.DBA_* view) are seeded separately by `seedCatalogRoleObjectGrants`
 * so the dictionary views aren't tied to a hardcoded list — they read
 * the live view registry instead.
 */

import type { OracleCatalog } from '../OracleCatalog';
import { listRegisteredViews } from '../views/registry';

export interface ClassicRoleDef {
  name: string;
  description: string;
  sysPrivs: readonly string[];
  /** Roles included via GRANT role TO this role. */
  inheritedRoles?: readonly string[];
}

/** The 19c default role catalogue. */
export const CLASSIC_ROLES: readonly ClassicRoleDef[] = [
  // ── Application-level legacy roles ────────────────────────────────
  {
    name: 'CONNECT',
    description: 'Login privilege (Oracle 10.2+: just CREATE SESSION).',
    sysPrivs: ['CREATE SESSION'],
  },
  {
    name: 'RESOURCE',
    description: 'Object-creation privileges for application schemas.',
    sysPrivs: [
      'CREATE TABLE', 'CREATE VIEW', 'CREATE SEQUENCE',
      'CREATE PROCEDURE', 'CREATE TRIGGER', 'CREATE TYPE',
      'CREATE CLUSTER', 'CREATE INDEXTYPE', 'CREATE OPERATOR',
    ],
  },
  {
    name: 'DBA',
    description: 'Full database administration.',
    sysPrivs: [
      'CREATE SESSION', 'CREATE TABLE', 'CREATE VIEW', 'CREATE SEQUENCE',
      'CREATE PROCEDURE', 'CREATE TRIGGER', 'CREATE INDEX', 'CREATE USER',
      'ALTER USER', 'DROP USER', 'CREATE ROLE', 'GRANT ANY PRIVILEGE',
      'GRANT ANY ROLE', 'SELECT ANY TABLE', 'INSERT ANY TABLE',
      'UPDATE ANY TABLE', 'DELETE ANY TABLE', 'CREATE ANY TABLE',
      'DROP ANY TABLE', 'ALTER ANY TABLE', 'CREATE TABLESPACE',
      'ALTER TABLESPACE', 'DROP TABLESPACE', 'ALTER SYSTEM',
      'ALTER DATABASE', 'UNLIMITED TABLESPACE', 'CREATE ANY DIRECTORY',
      'AUDIT SYSTEM', 'AUDIT ANY', 'CREATE PROFILE', 'ALTER PROFILE',
      'DROP PROFILE',
    ],
  },

  // ── Catalog access roles ─────────────────────────────────────────
  {
    name: 'SELECT_CATALOG_ROLE',
    description: 'SELECT on every SYS dictionary view.',
    sysPrivs: [],
  },
  {
    name: 'EXECUTE_CATALOG_ROLE',
    description: 'EXECUTE on every catalog DBMS_* package.',
    sysPrivs: [],
  },
  {
    name: 'DELETE_CATALOG_ROLE',
    description: 'DELETE on AUD$ and the FGA_LOG$ audit trail tables.',
    sysPrivs: [],
  },

  // ── Export / Import / Data Pump ──────────────────────────────────
  {
    name: 'EXP_FULL_DATABASE',
    description: 'Full database export (legacy exp).',
    sysPrivs: ['SELECT ANY TABLE', 'SELECT ANY DICTIONARY', 'BACKUP ANY TABLE'],
    inheritedRoles: ['EXECUTE_CATALOG_ROLE', 'SELECT_CATALOG_ROLE'],
  },
  {
    name: 'IMP_FULL_DATABASE',
    description: 'Full database import (legacy imp).',
    sysPrivs: [
      'CREATE ANY TABLE', 'CREATE ANY INDEX', 'CREATE ANY SEQUENCE',
      'CREATE ANY VIEW', 'CREATE ANY PROCEDURE', 'CREATE ANY TRIGGER',
      'INSERT ANY TABLE', 'UPDATE ANY TABLE', 'DELETE ANY TABLE',
      'CREATE USER', 'ALTER USER', 'CREATE TABLESPACE',
      'UNLIMITED TABLESPACE',
    ],
    inheritedRoles: ['EXECUTE_CATALOG_ROLE', 'SELECT_CATALOG_ROLE'],
  },
  {
    name: 'DATAPUMP_EXP_FULL_DATABASE',
    description: 'Data Pump full export (expdp).',
    sysPrivs: [],
    inheritedRoles: ['EXP_FULL_DATABASE', 'SELECT_CATALOG_ROLE'],
  },
  {
    name: 'DATAPUMP_IMP_FULL_DATABASE',
    description: 'Data Pump full import (impdp).',
    sysPrivs: [],
    inheritedRoles: ['IMP_FULL_DATABASE', 'SELECT_CATALOG_ROLE', 'EXECUTE_CATALOG_ROLE'],
  },

  // ── Advanced Queuing ─────────────────────────────────────────────
  {
    name: 'AQ_USER_ROLE',
    description: 'Advanced Queueing — basic user access.',
    sysPrivs: [],
  },
  {
    name: 'AQ_ADMINISTRATOR_ROLE',
    description: 'Advanced Queueing — administration.',
    sysPrivs: [],
  },

  // ── Scheduler / Backup / Stats ───────────────────────────────────
  {
    name: 'SCHEDULER_ADMIN',
    description: 'DBMS_SCHEDULER administration.',
    sysPrivs: [
      'CREATE JOB', 'CREATE ANY JOB', 'EXECUTE ANY PROGRAM',
      'EXECUTE ANY CLASS', 'MANAGE SCHEDULER',
    ],
  },
  {
    name: 'RECOVERY_CATALOG_OWNER',
    description: 'Owner of the RMAN recovery catalog.',
    sysPrivs: [
      'CREATE SESSION', 'ALTER SESSION', 'CREATE TABLE',
      'CREATE VIEW', 'CREATE PROCEDURE', 'CREATE SEQUENCE',
      'CREATE TRIGGER', 'CREATE TYPE', 'CREATE SYNONYM',
      'CREATE CLUSTER', 'CREATE DATABASE LINK',
    ],
  },
  {
    name: 'GATHER_SYSTEM_STATISTICS',
    description: 'Run DBMS_STATS.GATHER_SYSTEM_STATS.',
    sysPrivs: [],
  },

  // ── Heterogeneous Services ───────────────────────────────────────
  {
    name: 'HS_ADMIN_EXECUTE_ROLE',
    description: 'Heterogeneous Services — EXECUTE on admin packages.',
    sysPrivs: [],
  },
  {
    name: 'HS_ADMIN_SELECT_ROLE',
    description: 'Heterogeneous Services — SELECT on admin views.',
    sysPrivs: [],
  },
  {
    name: 'HS_ADMIN_ROLE',
    description: 'Heterogeneous Services — full administration.',
    sysPrivs: [],
    inheritedRoles: ['HS_ADMIN_EXECUTE_ROLE', 'HS_ADMIN_SELECT_ROLE'],
  },

  // ── Auditing (Unified Auditing) ──────────────────────────────────
  {
    name: 'AUDIT_ADMIN',
    description: 'Manages unified-audit policies and trail.',
    sysPrivs: ['AUDIT SYSTEM', 'AUDIT ANY'],
  },
  {
    name: 'AUDIT_VIEWER',
    description: 'Read-only access to the unified audit trail.',
    sysPrivs: [],
  },

  // ── Modern access roles ─────────────────────────────────────────
  {
    name: 'SODA_APP',
    description: 'Simple Oracle Document Access (SODA) for JSON.',
    sysPrivs: ['CREATE TABLE', 'CREATE VIEW'],
  },
  {
    name: 'XS_CONNECT',
    description: 'Real Application Security — basic session.',
    sysPrivs: ['CREATE SESSION'],
  },
  {
    name: 'XS_SESSION_ADMIN',
    description: 'Real Application Security — session administration.',
    sysPrivs: [],
  },
  {
    name: 'OPTIMIZER_PROCESSING_RATE',
    description: 'Manage DBMS_STATS optimizer processing-rate stats.',
    sysPrivs: [],
  },
  {
    name: 'PDB_DBA',
    description: 'Local DBA inside a Pluggable Database.',
    sysPrivs: ['CREATE SESSION'],
  },
];

/**
 * Provision every classic role in the catalog along with its system
 * privileges and nested-role grants. Idempotent — running twice has
 * no effect because BaseCatalog dedupes.
 */
export function provisionClassicRoles(catalog: OracleCatalog): void {
  for (const r of CLASSIC_ROLES) {
    if (!catalog.getAllRoles().some(x => x.name === r.name)) {
      catalog.createRole(r.name);
    }
    for (const p of r.sysPrivs) catalog.grantSystemPrivilege(r.name, p);
    for (const ir of r.inheritedRoles ?? []) catalog.grantRole(r.name, ir);
  }
}

/**
 * Seed object-level grants for the catalog access roles — derived
 * from the live view registry so adding a view automatically extends
 * the role's coverage, and no fabricated table list ever drifts.
 */
export function seedCatalogRoleObjectGrants(catalog: OracleCatalog): void {
  const views = listRegisteredViews();
  for (const v of views) {
    const upper = v.name.toUpperCase();
    if (upper.startsWith('V$') || upper.startsWith('V_$')
        || upper.startsWith('DBA_') || upper.startsWith('ALL_')
        || upper.startsWith('USER_') || upper.startsWith('SYS.')) {
      catalog.grantTablePrivilege('SELECT_CATALOG_ROLE', 'SELECT', 'SYS', upper);
    }
  }
}
