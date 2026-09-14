/**
 * V$CONTROLFILE_RECORD_SECTION — record sections of the control file.
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView, queryView } from './registry';
import type { ViewContext } from './types';

const SECTION_SIZES: ReadonlyArray<readonly [string, number, number]> = [
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

const SECTION_RECORDS: Readonly<Record<string, readonly string[]>> = {
  'DATABASE': ['V$DATABASE'],
  'CKPT PROGRESS': [],
  'REDO THREAD': ['V$THREAD'],
  'REDO LOG': ['V$LOGFILE'],
  'DATAFILE': ['V$DATAFILE'],
  'FILENAME': ['V$DATAFILE', 'V$TEMPFILE', 'V$LOGFILE', 'V$CONTROLFILE'],
  'TABLESPACE': ['V$TABLESPACE'],
  'TEMPORARY FILENAME': ['V$TEMPFILE'],
  'RMAN CONFIGURATION': [],
  'LOG HISTORY': ['V$LOG_HISTORY'],
  'OFFLINE RANGE': [],
  'ARCHIVED LOG': ['V$ARCHIVED_LOG'],
  'BACKUP SET': ['V$BACKUP_SET'],
  'BACKUP PIECE': ['V$BACKUP_PIECE'],
  'BACKUP DATAFILE': ['V$BACKUP_DATAFILE'],
};

function recordsUsed(section: string, ctx: ViewContext): number {
  let used = 0;
  for (const view of SECTION_RECORDS[section] ?? []) {
    used += queryView(view, ctx)?.rows.length ?? 0;
  }
  return used;
}

registerView({
  name: 'V$CONTROLFILE_RECORD_SECTION',
  comment: 'Control file record sections',
  query(ctx) {
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
      SECTION_SIZES.map(([type, size, total]) => {
        const used = Math.min(recordsUsed(type, ctx), total);
        const circular = type === 'LOG HISTORY' || type === 'ARCHIVED LOG'
          || type === 'OFFLINE RANGE' || type.startsWith('BACKUP');
        return [
          type, size, total, used,
          circular && used > 0 ? 1 : 0,
          circular ? used : 0,
          used,
        ];
      }),
    );
  },
});
