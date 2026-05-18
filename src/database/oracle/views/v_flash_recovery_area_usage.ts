/**
 * V$FLASH_RECOVERY_AREA_USAGE — pre-19c alias of V$RECOVERY_AREA_USAGE.
 * Same projection — keeps tools written for 11g/12c working.
 */

import { queryView } from './registry';
import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

registerView({
  name: 'V$FLASH_RECOVERY_AREA_USAGE',
  comment: 'Alias of V$RECOVERY_AREA_USAGE (pre-19c)',
  query(ctx) {
    return queryView('V$RECOVERY_AREA_USAGE', ctx) ?? queryResult(
      [col.str('FILE_TYPE', 20), col.num('PERCENT_SPACE_USED'), col.num('PERCENT_SPACE_RECLAIMABLE'), col.num('NUMBER_OF_FILES')],
      []
    );
  },
});
