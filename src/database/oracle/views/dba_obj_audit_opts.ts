/**
 * DBA_OBJ_AUDIT_OPTS — object-level audit options.
 *
 * Reflects the real object audit configuration set by
 * `AUDIT <action[, …]> ON [schema.]object [BY ACCESS|SESSION]
 * [WHENEVER [NOT] SUCCESSFUL]`. One row per audited object; each
 * per-action column holds `<success>/<failure>` where each side is
 * `A` (BY ACCESS), `S` (BY SESSION) or `-` (not audited). OBJECT_TYPE
 * is resolved from real storage, never hardcoded.
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

// AUDIT action → DBA_OBJ_AUDIT_OPTS column.
const ACTION_COLUMN: Record<string, string> = {
  ALTER: 'ALT', AUDIT: 'AUD', COMMENT: 'COM', DELETE: 'DEL',
  GRANT: 'GRA', INDEX: 'IND', INSERT: 'INS', LOCK: 'LOC',
  RENAME: 'REN', SELECT: 'SEL', UPDATE: 'UPD',
};
const OPTION_COLUMNS = ['ALT', 'AUD', 'COM', 'DEL', 'GRA', 'IND', 'INS', 'LOC', 'REN', 'SEL', 'UPD'];

registerView({
  name: 'DBA_OBJ_AUDIT_OPTS',
  comment: 'Object audit options',
  query({ catalog }) {
    // Group options by owner.object so each object yields one row.
    const byObject = new Map<string, { schema: string; object: string; cells: Record<string, string> }>();
    for (const o of catalog.getObjectAuditOptions()) {
      const colName = ACTION_COLUMN[o.action.toUpperCase()];
      if (!colName) continue;
      const key = `${o.schema}.${o.object}`;
      let entry = byObject.get(key);
      if (!entry) {
        entry = { schema: o.schema, object: o.object, cells: {} };
        for (const c of OPTION_COLUMNS) entry.cells[c] = '-/-';
        byObject.set(key, entry);
      }
      entry.cells[colName] = `${o.success}/${o.failure}`;
    }

    const rows = [...byObject.values()].map(e => [
      e.schema,
      e.object,
      catalog.resolveObjectType(e.schema, e.object),
      ...OPTION_COLUMNS.map(c => e.cells[c]),
    ]);

    return queryResult(
      [
        col.str('OWNER', 128),
        col.str('OBJECT_NAME', 128),
        col.str('OBJECT_TYPE', 23),
        col.str('ALT', 9), col.str('AUD', 9), col.str('COM', 9),
        col.str('DEL', 9), col.str('GRA', 9), col.str('IND', 9),
        col.str('INS', 9), col.str('LOC', 9), col.str('REN', 9),
        col.str('SEL', 9), col.str('UPD', 9),
      ],
      rows
    );
  },
});
