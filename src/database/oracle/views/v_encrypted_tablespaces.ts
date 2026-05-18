/**
 * V$ENCRYPTED_TABLESPACES — TDE-encrypted tablespaces. Empty unless TDE
 * is enabled.
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

registerView({
  name: 'V$ENCRYPTED_TABLESPACES',
  comment: 'TDE-encrypted tablespaces',
  query() {
    return queryResult(
      [
        col.num('TS#'),
        col.str('ENCRYPTIONALG', 7),
        col.str('ENCRYPTEDTS', 3),
        col.str('KEY_VERSION', 16),
        col.str('STATUS', 16),
      ],
      []
    );
  },
});
