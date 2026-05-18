/**
 * V$SQL_TEXT — SQL text in 64-byte chunks per cursor.
 *
 * Projection of `runtime.sqlCache`; each cached cursor is split into
 * pieces of 64 chars as the canonical view does.
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

registerView({
  name: 'V$SQL_TEXT',
  comment: 'SQL text split into 64-char pieces',
  query({ runtime }) {
    const rows: (string | number)[][] = [];
    for (const s of runtime.sqlCache.values()) {
      const chunks = chunk(s.text, 64);
      chunks.forEach((c, idx) => {
        rows.push([0, 0, s.sqlId, idx, c]);
      });
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

function chunk(s: string, size: number): string[] {
  if (!s) return [''];
  const out: string[] = [];
  for (let i = 0; i < s.length; i += size) out.push(s.slice(i, i + size));
  return out;
}
