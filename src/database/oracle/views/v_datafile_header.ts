/**
 * V$DATAFILE_HEADER — header status of each datafile. Real Oracle
 * exposes a creation timestamp and a checkpoint timestamp, which DBA
 * recovery scripts (RMAN, flashback) routinely read; ERROR is NULL
 * for a healthy file so that
 *   SELECT * FROM v\$datafile_header WHERE error IS NOT NULL
 * returns no rows in steady state.
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';
import { parseSize } from './_fileSize';

const SEED_TIME = new Date('2026-01-01T00:00:00Z');

registerView({
  name: 'V$DATAFILE_HEADER',
  comment: 'Datafile header status',
  query({ storage, instance }) {
    const rows: (string | number | Date | null)[][] = [];
    let fileNum = 1;
    for (const ts of storage.getAllTablespaces()) {
      for (const df of ts.datafiles) {
        rows.push([
          fileNum++,
          ts.name,
          df.path,
          instance.state === 'OPEN' ? 'ONLINE' : 'OFFLINE',
          null,                         // ERROR — NULL when healthy
          'NO',                         // FUZZY
          'AVAILABLE',                  // RECOVER
          parseSize(df.size),           // BYTES (numeric, like real Oracle)
          ts.blockSize || 8192,
          instance.getCheckpointScn(),  // CHECKPOINT_CHANGE# — same SCN as V$DATAFILE
          1,                            // CHECKPOINT_COUNT
          instance.getCheckpointTime(), // CHECKPOINT_TIME
          SEED_TIME,                    // CREATION_TIME
          100,                          // CREATION_CHANGE#
        ]);
      }
    }
    return queryResult(
      [
        col.num('FILE#'),
        col.str('TABLESPACE_NAME', 30),
        col.str('NAME', 513),
        col.str('STATUS', 7),
        col.str('ERROR', 18),
        col.str('FUZZY', 9),
        col.str('RECOVER', 9),
        col.num('BYTES'),
        col.num('BLOCK_SIZE'),
        col.num('CHECKPOINT_CHANGE#'),
        col.num('CHECKPOINT_COUNT'),
        col.date('CHECKPOINT_TIME'),
        col.date('CREATION_TIME'),
        col.num('CREATION_CHANGE#'),
      ],
      rows
    );
  },
});
