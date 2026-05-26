/**
 * DBA_SENSITIVE_COLUMNS — columns tagged as sensitive by Transparent
 * Sensitive Data Protection (TSDP — DBMS_TSDP_MANAGE, 12c+).
 *
 * Backed by the simulator's SensitiveObjectRegistry: each sensitive
 * column declared on a registered object becomes one row here. When a
 * sensitive object has an empty `sensitiveColumns` list we surface a
 * single sentinel `*` column, matching Oracle's "whole-table" tag.
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

registerView({
  name: 'DBA_SENSITIVE_COLUMNS',
  comment: 'Sensitive columns (TSDP)',
  query({ instance }) {
    const reg = instance.getAuditJournal().getSensitiveObjectRegistry();
    const rows: (string | null)[][] = [];
    for (const o of reg.list()) {
      const cols = o.sensitiveColumns.length > 0 ? o.sensitiveColumns : ['*'];
      for (const c of cols) {
        rows.push([o.schema, o.object, c, o.classification, o.description]);
      }
    }
    return queryResult(
      [
        col.str('OWNER', 128),
        col.str('TABLE_NAME', 128),
        col.str('COLUMN_NAME', 128),
        col.str('TYPE', 128),
        col.str('COMMENTS', 4000),
      ],
      rows,
    );
  },
});
