/**
 * V$TEMP_EXTENT_MAP — temp extent map.
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

registerView({
  name: 'V$TEMP_EXTENT_MAP',
  comment: 'Temporary extent map',
  query({ storage }) {
    const tempfiles = storage.getAllTablespaces()
      .filter(ts => ts.type === 'TEMPORARY')
      .flatMap(ts => ts.datafiles.map((_, i) => ({ ts: ts.name, file: i + 1 })));
    const rows: (string | number)[][] = [];
    for (const t of tempfiles) {
      for (let i = 0; i < 4; i++) {
        rows.push([t.ts, t.file, 100 + i * 128, 128, i % 2 === 0 ? 'FREE' : 'USED']);
      }
    }
    return queryResult(
      [
        col.str('TABLESPACE_NAME', 30),
        col.num('FILE_ID'),
        col.num('BLOCK_ID'),
        col.num('BLOCKS'),
        col.str('OWNER', 16),
      ],
      rows
    );
  },
});
