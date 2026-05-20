/**
 * V$ENCRYPTION_KEYS — TDE master keys held in the wallet. Rows come
 * from `OracleCatalog.getTdeMasterKeys()`, which is fed by
 * `ADMINISTER KEY MANAGEMENT SET KEY …`. No fabricated data: empty
 * until an admin provisions at least one key.
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

registerView({
  name: 'V$ENCRYPTION_KEYS',
  comment: 'TDE master keys',
  query({ catalog }) {
    const c = catalog as unknown as {
      getTdeMasterKeys?: () => { keyId: string; tag: string; creator: string; creationTime: Date; activationTime: Date; active: boolean }[];
    };
    const keys = c.getTdeMasterKeys ? c.getTdeMasterKeys() : [];
    return queryResult(
      [
        col.str('KEY_ID', 80),
        col.str('TAG', 80),
        col.date('CREATION_TIME'),
        col.date('ACTIVATION_TIME'),
        col.str('CREATOR', 30),
        col.str('CREATOR_DBNAME', 30),
        col.str('CREATOR_DBID', 30),
        col.str('USER', 30),
        col.str('KEY_USE', 16),
        col.str('KEYSTORE_TYPE', 16),
        col.str('ORIGIN', 16),
      ],
      keys.map(k => [
        k.keyId, k.tag,
        k.creationTime.toISOString(), k.activationTime.toISOString(),
        k.creator, '', '', k.creator,
        'TDE IN WALLET', 'SOFTWARE KEYSTORE', 'LOCAL',
      ])
    );
  },
});
