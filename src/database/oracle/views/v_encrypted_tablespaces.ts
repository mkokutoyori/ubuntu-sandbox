/**
 * V$ENCRYPTED_TABLESPACES — TDE-encrypted tablespaces, from real storage.
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

registerView({
  name: 'V$ENCRYPTED_TABLESPACES',
  comment: 'TDE-encrypted tablespaces',
  query({ storage, catalog }) {
    const wallet = (catalog as unknown as {
      getTdeWallet?: () => { status: string } | null;
    }).getTdeWallet?.();
    const status = wallet?.status === 'OPEN' ? 'NORMAL' : 'REKEY REQUIRED';
    const rows = storage.getAllTablespaces()
      .map((ts, i) => ({ ts, tsNo: i }))
      .filter(({ ts }) => ts.encrypted)
      .map(({ ts, tsNo }) => [tsNo, 'AES256', 'YES', '1', status]);
    return queryResult(
      [
        col.num('TS#'),
        col.str('ENCRYPTIONALG', 7),
        col.str('ENCRYPTEDTS', 3),
        col.str('KEY_VERSION', 16),
        col.str('STATUS', 16),
      ],
      rows
    );
  },
});
