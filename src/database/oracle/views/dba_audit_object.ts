/**
 * DBA_AUDIT_OBJECT — object-level audit events.
 *
 * Filters the catalog audit trail to events that target a specific
 * schema object (CREATE/ALTER/DROP TABLE, GRANT, INSERT, etc.), which
 * is the discriminator Oracle uses for this view in real life.
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

const OBJECT_ACTIONS = new Set([
  'CREATE TABLE', 'DROP TABLE', 'ALTER TABLE', 'TRUNCATE TABLE',
  'CREATE INDEX', 'DROP INDEX', 'ALTER INDEX',
  'CREATE VIEW', 'DROP VIEW', 'ALTER VIEW',
  'CREATE SEQUENCE', 'DROP SEQUENCE', 'ALTER SEQUENCE',
  'CREATE PROCEDURE', 'CREATE FUNCTION', 'CREATE PACKAGE',
  'CREATE TRIGGER', 'DROP TRIGGER',
  'CREATE SYNONYM', 'DROP SYNONYM',
  'GRANT', 'REVOKE',
  'INSERT', 'UPDATE', 'DELETE', 'SELECT',
  'AUDIT OBJECT', 'NOAUDIT OBJECT',
]);

registerView({
  name: 'DBA_AUDIT_OBJECT',
  comment: 'Object-level audit trail',
  query({ catalog }) {
    const trail = catalog.getAuditTrail();
    const rows: (string | number | null)[][] = [];
    for (const e of trail) {
      if (!e.objName) continue;
      if (!OBJECT_ACTIONS.has(e.actionName)) continue;
      rows.push([
        e.osUsername, e.username, e.userhost, e.terminal,
        e.timestamp.toISOString(), e.actionName,
        e.objName, e.objOwner, e.sessionId,
        e.returncode, e.sqlText,
      ]);
    }
    return queryResult(
      [
        col.str('OS_USERNAME', 30),
        col.str('USERNAME', 128),
        col.str('USERHOST', 128),
        col.str('TERMINAL', 128),
        col.date('TIMESTAMP'),
        col.str('ACTION_NAME', 28),
        col.str('OBJ_NAME', 128),
        // Oracle 19c spelling — the column was renamed from OBJ_OWNER
        // → OWNER in 11g; transcripts query it under the new name.
        col.str('OWNER', 128),
        col.num('SESSIONID'),
        col.num('RETURNCODE'),
        col.str('SQL_TEXT', 2000),
      ],
      rows
    );
  },
});
