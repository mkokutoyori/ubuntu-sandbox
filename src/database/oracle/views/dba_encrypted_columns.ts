/**
 * DBA_ENCRYPTED_COLUMNS — per-column TDE settings. Reads live state
 * populated by `ALTER TABLE … MODIFY (col ENCRYPT …)`.
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

registerView({
  name: 'DBA_ENCRYPTED_COLUMNS',
  comment: 'Encrypted columns',
  query({ catalog }) {
    const c = catalog as unknown as {
      getEncryptedColumns?: () => { owner: string; tableName: string; columnName: string; encryptionAlg: string; salt: boolean; integrityAlg: string }[];
    };
    const cols = c.getEncryptedColumns ? c.getEncryptedColumns() : [];
    return queryResult(
      [
        col.str('OWNER', 128),
        col.str('TABLE_NAME', 128),
        col.str('COLUMN_NAME', 128),
        col.str('ENCRYPTION_ALG', 29),
        col.str('SALT', 3),
        col.str('INTEGRITY_ALG', 6),
      ],
      cols.map(e => [e.owner, e.tableName, e.columnName, e.encryptionAlg, e.salt ? 'YES' : 'NO', e.integrityAlg])
    );
  },
});
