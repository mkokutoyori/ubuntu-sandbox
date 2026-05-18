/**
 * V$RECOVERY_AREA_USAGE — FRA usage broken down by file type.
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

function bytes(spec: string): number {
  const m = spec.match(/^(\d+)([KMG])?$/i);
  if (!m) return 0;
  const n = Number(m[1]);
  const unit = (m[2] ?? '').toUpperCase();
  return unit === 'G' ? n * 1024 * 1024 * 1024 : unit === 'M' ? n * 1024 * 1024 : unit === 'K' ? n * 1024 : n;
}

registerView({
  name: 'V$RECOVERY_AREA_USAGE',
  comment: 'FRA usage per file type',
  query({ instance, runtime }) {
    const total = Math.max(1, bytes(instance.getParameter('db_recovery_file_dest_size') ?? '4G'));
    const arch = runtime.archivedLogs.length * 1_048_576;
    const back = runtime.backups.reduce((s, b) => s + b.bytes, 0);
    return queryResult(
      [
        col.str('FILE_TYPE', 20),
        col.num('PERCENT_SPACE_USED'),
        col.num('PERCENT_SPACE_RECLAIMABLE'),
        col.num('NUMBER_OF_FILES'),
      ],
      [
        ['CONTROL FILE', 0, 0, 0],
        ['REDO LOG', 0, 0, 0],
        ['ARCHIVED LOG', (arch / total) * 100, 0, runtime.archivedLogs.length],
        ['BACKUP PIECE', (back / total) * 100, 0, runtime.backups.length],
        ['IMAGE COPY', 0, 0, 0],
        ['FLASHBACK LOG', 0, 0, runtime.flashbackHistory.length],
        ['FOREIGN ARCHIVED LOG', 0, 0, 0],
        ['AUXILIARY DATAFILE COPY', 0, 0, 0],
      ]
    );
  },
});
