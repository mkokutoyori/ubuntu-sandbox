/**
 * V$ENCRYPTION_WALLET — keystore status. Reads live wallet state from
 * the catalog (configured by `ADMINISTER KEY MANAGEMENT CREATE
 * KEYSTORE …`). No row is emitted when the DBA has not provisioned a
 * wallet — that matches a fresh instance.
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

registerView({
  name: 'V$ENCRYPTION_WALLET',
  comment: 'Encryption wallet status',
  query({ catalog }) {
    const c = catalog as unknown as { getTdeWallet?: () => { location: string; status: string; walletType: string; fullyBackedUp: boolean } | null };
    const w = c.getTdeWallet ? c.getTdeWallet() : null;
    return queryResult(
      [
        col.str('WRL_TYPE', 20),
        col.str('WRL_PARAMETER', 4000),
        col.str('STATUS', 30),
        col.str('WALLET_TYPE', 20),
        col.str('WALLET_ORDER', 16),
        col.str('FULLY_BACKED_UP', 5),
        col.num('CON_ID'),
      ],
      w ? [['FILE', w.location, w.status, w.walletType, 'SINGLE', w.fullyBackedUp ? 'YES' : 'NO', 0]] : []
    );
  },
});
