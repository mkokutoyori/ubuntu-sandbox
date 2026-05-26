/**
 * UNIFIED_AUDIT_TRAIL — unified audit trail (12c+ unified auditing).
 *
 * Surfaces every audit event the catalog has recorded — LOGON, LOGOFF,
 * DDL, DCL, DML configured for auditing, FGA hits, fine-grained
 * connection traces, sensitive-object accesses, SoD violations and
 * security anomalies. Each row carries the canonical
 * `AUDIT_TYPE` discriminator real Oracle uses (Standard / Fine
 * GrainedAudit / DatabaseVault / Datapump / RMAN / …) so reporting
 * scripts can filter exactly as they would in production.
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

registerView({
  name: 'UNIFIED_AUDIT_TRAIL',
  comment: 'Unified audit trail',
  query({ catalog, instance }) {
    const rows: (string | number | null)[][] = [];
    let entryId = 1;

    // Catalog AUD$ entries (LOGON / LOGOFF / DDL / configured DML).
    for (const e of catalog.getAuditTrail()) {
      rows.push([
        e.timestamp.toISOString(), 'Standard', e.sessionId, e.username,
        e.userhost, e.terminal, e.osUsername,
        e.actionName, e.returncode, e.sqlText,
        e.objOwner, e.objName, e.statementType,
        e.privUsed, entryId++,
      ]);
    }

    // Fine-grained audit hits.
    for (const f of catalog.getFgaTrail()) {
      rows.push([
        f.timestamp.toISOString(), 'FineGrainedAudit', f.sessionId,
        f.dbUser, 'localhost', 'pts/0', f.osUser,
        f.statementType, 0, f.sqlText,
        f.objectSchema, f.objectName, f.statementType,
        f.policyName, entryId++,
      ]);
    }

    // Rich connection traces from the security-audit journal.
    const journal = instance.getAuditJournal();
    for (const t of journal.getConnectionTraces()) {
      rows.push([
        t.timestamp.toISOString(), 'Standard', t.sessionId, t.username,
        t.userhost, t.terminal, t.osUser,
        t.outcome === 'LOGOFF' ? 'LOGOFF' : 'LOGON',
        t.returncode, null,
        null, null, t.outcome === 'LOGOFF' ? 'LOGOFF' : 'LOGON',
        t.role === 'SYSDBA' ? 'SYSDBA'
          : t.role === 'SYSOPER' ? 'SYSOPER'
          : 'CREATE SESSION',
        entryId++,
      ]);
    }

    // Sensitive-object access — surfaced as FineGrainedAudit so existing
    // monitoring of AUDIT_TYPE='FineGrainedAudit' picks them up.
    for (const a of journal.getSensitiveAccessRecords()) {
      rows.push([
        a.timestamp.toISOString(), 'FineGrainedAudit', a.sessionId,
        a.username, 'localhost', 'pts/0', 'oracle',
        a.action, 0, a.sqlText,
        a.objectSchema, a.objectName, a.action,
        `ORA_SIM_${a.classification}`, entryId++,
      ]);
    }

    // SoD violations → DatabaseVault audit type (real DV does the same).
    for (const v of journal.getSodViolations()) {
      rows.push([
        v.timestamp.toISOString(), 'DatabaseVault', v.sessionId,
        v.username, 'localhost', 'pts/0', 'oracle',
        'POLICY VIOLATION', 20000, v.description,
        null, null, 'DV_RULE_SET',
        v.policyName, entryId++,
      ]);
    }

    return queryResult(
      [
        col.date('EVENT_TIMESTAMP'),
        col.str('AUDIT_TYPE', 64),
        col.num('SESSIONID'),
        col.str('DBUSERNAME', 128),
        col.str('USERHOST', 128),
        col.str('TERMINAL', 128),
        col.str('OS_USER', 128),
        col.str('ACTION_NAME', 28),
        col.num('RETURN_CODE'),
        col.str('SQL_TEXT', 2000),
        col.str('OBJECT_SCHEMA', 128),
        col.str('OBJECT_NAME', 128),
        col.str('STATEMENT_TYPE', 28),
        col.str('SYSTEM_PRIVILEGE_USED', 100),
        col.num('ENTRY_ID'),
      ],
      rows,
    );
  },
});
