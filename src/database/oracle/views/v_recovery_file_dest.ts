/**
 * V$RECOVERY_FILE_DEST — FRA destination size & usage.
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
  name: 'V$RECOVERY_FILE_DEST',
  comment: 'Fast recovery area configuration',
  query({ instance, runtime }) {
    const dest = instance.getParameter('db_recovery_file_dest') ?? '';
    const size = bytes(instance.getParameter('db_recovery_file_dest_size') ?? '4G');
    const used = runtime.backups.reduce((s, b) => s + b.bytes, 0)
      + runtime.archivedLogs.length * 1_048_576;
    return queryResult(
      [
        col.str('NAME', 513),
        col.num('SPACE_LIMIT'),
        col.num('SPACE_USED'),
        col.num('SPACE_RECLAIMABLE'),
        col.num('NUMBER_OF_FILES'),
      ],
      [[dest, size, used, Math.floor(used * 0.1),
        runtime.backups.length + runtime.archivedLogs.length]]
    );
  },
});
