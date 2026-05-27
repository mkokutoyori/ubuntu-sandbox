/**
 * DBA_TAB_COLS — superset of DBA_TAB_COLUMNS that also returns hidden
 * columns (HIDDEN_COLUMN='YES'). Native Oracle view used by storage /
 * partitioning monitoring scripts when the visible-only view would
 * miss internal system columns.
 *
 * The simulator does not synthesise system-generated hidden columns
 * yet, so every row currently has HIDDEN_COLUMN='NO'. Surfacing the
 * view however keeps DBA scripts that expect it operational.
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

registerView({
  name: 'DBA_TAB_COLS',
  comment: 'Table columns including hidden / system-generated',
  query({ storage }) {
    const rows: (string | number | null)[][] = [];
    for (const t of storage.getAllTables()) {
      for (const c of t.columns) {
        const isNotNull = t.constraints.some(k =>
          k.type === 'NOT_NULL' && k.columns.length === 1 && k.columns[0] === c.name);
        rows.push([
          t.schema, t.name, c.name, c.dataType.name,
          c.dataType.precision ?? null, c.dataType.scale ?? null,
          (c.dataType.nullable && !isNotNull) ? 'Y' : 'N',
          c.ordinalPosition + 1,
          c.defaultValue !== undefined && c.defaultValue !== null
            ? String(c.defaultValue) : null,
          'NO',                                  // HIDDEN_COLUMN
          'NO',                                  // VIRTUAL_COLUMN
          'NONE',                                // USER_GENERATED
          'NO',                                  // IDENTITY_COLUMN
          'NULLABLE',                            // EVALUATION_EDITION
          1,                                     // INTERNAL_COLUMN_ID
          'NO',                                  // QUALIFIED_COL_NAME
        ]);
      }
    }
    return queryResult(
      [
        col.str('OWNER', 128),
        col.str('TABLE_NAME', 128),
        col.str('COLUMN_NAME', 128),
        col.str('DATA_TYPE', 128),
        col.num('DATA_LENGTH'),
        col.num('DATA_SCALE'),
        col.str('NULLABLE', 1),
        col.num('COLUMN_ID'),
        col.str('DATA_DEFAULT', 4000),
        col.str('HIDDEN_COLUMN', 3),
        col.str('VIRTUAL_COLUMN', 3),
        col.str('USER_GENERATED', 4),
        col.str('IDENTITY_COLUMN', 3),
        col.str('EVALUATION_EDITION', 32),
        col.num('INTERNAL_COLUMN_ID'),
        col.str('QUALIFIED_COL_NAME', 4000),
      ],
      rows,
    );
  },
});
