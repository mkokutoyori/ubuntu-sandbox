/**
 * V$BACKUP_FILES — unified files-protected view.
 *
 * Lists each backup piece by handle; alias for V$BACKUP_PIECE in this
 * simulator. Fed by `oracle.backup.recorded`.
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

registerView({
  name: 'V$BACKUP_FILES',
  comment: 'Unified files-protected view',
  query({ runtime }) {
    return queryResult(
      [
        col.str('FNAME', 513),
        col.str('FTYPE', 16),
        col.str('STATUS', 9),
        col.num('BYTES'),
        col.date('FILE_TIME'),
      ],
      runtime.backups.map(b => [
        b.handle, b.type, b.status === 'COMPLETED' ? 'AVAILABLE' : 'EXPIRED',
        b.bytes, new Date(b.completedAt).toISOString(),
      ])
    );
  },
});
