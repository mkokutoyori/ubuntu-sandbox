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
        rows.push([i, 'INACTIVE', null, 'OPTIONAL', 0, 0, '', 'VALID', 'PRIMARY']);
        continue;
      }
      const m = val.match(/LOCATION=([^,\s]+)/i);
      const dest = m ? m[1] : val;
      rows.push([i, 'VALID', dest, 'MANDATORY', 0, 0, val, 'VALID', 'PRIMARY']);
    }
    return queryResult(
      [
        col.num('DEST_ID'),
        col.str('STATUS', 9),
        col.str('DESTINATION', 256),
        col.str('BINDING', 9),
        col.num('LOG_SEQUENCE'),
        col.num('REOPEN_SECS'),
        col.str('TARGET', 7),
        col.str('VALID_TYPE', 16),
        col.str('VALID_ROLE', 11),
      ],
      rows
    );
  },
});
