/**
 * V$ARCHIVE_DEST — archive log destinations from `log_archive_dest_*`
 * init parameters.
 *
 * Bound to the live parameter store via `oracle.instance.parameter-changed`.
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

registerView({
  name: 'V$ARCHIVE_DEST',
  comment: 'Archive log destination configuration',
  query({ instance }) {
    const rows: (string | number | null)[][] = [];
    const params = instance.getAllParameters();
    for (let i = 1; i <= 31; i++) {
      const val = params.get(`log_archive_dest_${i}`);
      if (!val) {
        rows.push([i, `LOG_ARCHIVE_DEST_${i}`, 'INACTIVE', null, 'OPTIONAL', 0, 0, '', 'VALID', 'PRIMARY', 'ARCH', 'ACTIVE']);
        continue;
      }
      const m = val.match(/LOCATION=([^,\s]+)/i);
      const dest = m ? m[1] : val;
      rows.push([i, `LOG_ARCHIVE_DEST_${i}`, 'VALID', dest, 'MANDATORY', 0, 0, val, 'VALID', 'PRIMARY', 'ARCH', 'ACTIVE']);
    }
    return queryResult(
      [
        col.num('DEST_ID'),
        col.str('DEST_NAME', 30),
        col.str('STATUS', 9),
        col.str('DESTINATION', 256),
        col.str('BINDING', 9),
        col.num('LOG_SEQUENCE'),
        col.num('REOPEN_SECS'),
        col.str('TARGET', 7),
        col.str('VALID_TYPE', 16),
        col.str('VALID_ROLE', 11),
        col.str('ARCHIVER', 10),
        col.str('SCHEDULE', 8),
      ],
      rows
    );
  },
});
