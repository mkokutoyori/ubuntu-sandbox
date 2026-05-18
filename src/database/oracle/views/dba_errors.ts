/**
 * DBA_ERRORS — compilation errors for PL/SQL objects.
 *
 * Listens to runtime alert entries that look like compile errors. A
 * real Oracle records these in SYS.ERROR$; we synthesise the equivalent
 * from the event-fed alert log slice.
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

registerView({
  name: 'DBA_ERRORS',
  comment: 'Compilation errors',
  query({ runtime }) {
    const rows: (string | number)[][] = [];
    runtime.alertEntries.forEach((entry, idx) => {
      const m = entry.line.match(/ORA-(\d+):\s*(.*)/);
      if (!m) return;
      rows.push(['SYS', '', 'PROCEDURE', idx + 1, 0, m[2], parseInt(m[1], 10), 'ERROR']);
    });
    return queryResult(
      [
        col.str('OWNER', 30),
        col.str('NAME', 30),
        col.str('TYPE', 12),
        col.num('SEQUENCE'),
        col.num('LINE'),
        col.str('TEXT', 4000),
        col.num('POSITION'),
        col.str('ATTRIBUTE', 7),
      ],
      rows
    );
  },
});
