/**
 * V$SQL_TEXT_WITH_NEWLINES — identical to V$SQL_TEXT but preserves
 * line breaks in the SQL text (uses 64-char pieces from runtime cache).
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

registerView({
  name: 'V$SQL_TEXT_WITH_NEWLINES',
  comment: 'SQL text in 64-char pieces, newlines preserved',
  query({ runtime }) {
    const rows: (string | number)[][] = [];
    for (const s of runtime.sqlCache.values()) {
      // Split on \n first, then chunk each line so newlines are kept.
      const lines = s.text.split('\n');
      let piece = 0;
      for (const l of lines) {
        if (l.length === 0) {
          rows.push([0, 0, s.sqlId, piece++, '\n']);
          continue;
        }
        for (let i = 0; i < l.length; i += 64) {
          rows.push([0, 0, s.sqlId, piece++, l.slice(i, i + 64)]);
        }
      }
    }
    return queryResult(
      [
        col.num('ADDRESS'),
        col.num('HASH_VALUE'),
        col.str('SQL_ID', 13),
        col.num('PIECE'),
        col.str('SQL_TEXT', 64),
      ],
      rows
    );
  },
});
