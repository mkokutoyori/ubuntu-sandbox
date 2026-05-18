/**
 * V$CONTROLFILE_RECORD_SECTION — record sections of the control file.
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

const SECTIONS: Array<[string, number, number]> = [
  ['DATABASE', 316, 1],
  ['CKPT PROGRESS', 8180, 5],
  ['REDO THREAD', 256, 8],
  ['REDO LOG', 56, 16],
  ['DATAFILE', 520, 200],
  ['FILENAME', 524, 4146],
  ['TABLESPACE', 68, 12],
  ['TEMPORARY FILENAME', 56, 200],
  ['RMAN CONFIGURATION', 1108, 50],
  ['LOG HISTORY', 56, 292],
  ['OFFLINE RANGE', 200, 163],
  ['ARCHIVED LOG', 584, 31],
  ['BACKUP SET', 40, 4096],
  ['BACKUP PIECE', 736, 4203],
  ['BACKUP DATAFILE', 200, 4163],
];

registerView({
  name: 'V$CONTROLFILE_RECORD_SECTION',
  comment: 'Control file record sections',
  query() {
    return queryResult(
      [
        col.str('TYPE', 17),
        col.num('RECORD_SIZE'),
        col.num('RECORDS_TOTAL'),
        col.num('RECORDS_USED'),
        col.num('FIRST_INDEX'),
        col.num('LAST_INDEX'),
        col.num('LAST_RECID'),
      ],
      SECTIONS.map(([type, sz, total]) => [
        type, sz, total, Math.floor(total / 10), 0, 0, 0,
      ])
    );
  },
});
