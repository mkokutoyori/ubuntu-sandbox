/**
 * V$PARAMETER2 — one row per value where parameters are lists.
 *
 * Same source as V$PARAMETER but multi-value parameters (control_files,
 * log_archive_dest_*, etc.) are split into one row per element.
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

registerView({
  name: 'V$PARAMETER2',
  comment: 'List-valued parameters split per element',
  query({ instance }) {
    const params = instance.getAllParameters();
    const rows: (string | number | boolean)[][] = [];
    let num = 1;
    for (const [name, value] of params) {
      const isList = value.includes(',');
      const parts = isList ? value.split(',').map(s => s.trim()) : [value];
      parts.forEach((v, ordinal) => {
        rows.push([num, name, 2, v, v, ordinal + 1, instance.isParameterModified(name) ? 'FALSE' : 'TRUE']);
      });
      num++;
    }
    return queryResult(
      [
        col.num('NUM'),
        col.str('NAME', 80),
        col.num('TYPE'),
        col.str('VALUE', 512),
        col.str('DISPLAY_VALUE', 512),
        col.num('ORDINAL'),
        col.str('ISDEFAULT', 9),
      ],
      rows
    );
  },
});
