/**
 * V$PROCESS_MEMORY — per-process memory categories.
 *
 * One row per background process for each category (SQL/PLSQL/Other).
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

const CATEGORIES = ['SQL', 'PL/SQL', 'OLAP', 'JAVA', 'Freeable', 'Other'];

registerView({
  name: 'V$PROCESS_MEMORY',
  comment: 'Per-process memory by category',
  query({ instance }) {
    const rows: (string | number)[][] = [];
    for (const p of instance.getBackgroundProcesses()) {
      for (const cat of CATEGORIES) {
        rows.push([p.pid, p.pid, cat, 256 * 1024, 1024 * 1024, 1024 * 1024, 0]);
      }
    }
    return queryResult(
      [
        col.num('PID'),
        col.num('SERIAL#'),
        col.str('CATEGORY', 16),
        col.num('ALLOCATED'),
        col.num('USED'),
        col.num('MAX_ALLOCATED'),
        col.num('CON_ID'),
      ],
      rows
    );
  },
});
