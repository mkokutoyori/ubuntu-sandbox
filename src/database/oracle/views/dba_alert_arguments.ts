/**
 * DBA_ALERT_ARGUMENTS — arguments substituted into alert messages.
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

registerView({
  name: 'DBA_ALERT_ARGUMENTS',
  comment: 'Alert argument substitutions',
  query() {
    return queryResult(
      [
        col.num('SEQUENCE_ID'),
        col.num('ARGUMENT_POS'),
        col.str('ARGUMENT_NAME', 30),
        col.str('ARGUMENT_TYPE', 30),
        col.str('ARGUMENT_VALUE', 4000),
      ],
      []
    );
  },
});
