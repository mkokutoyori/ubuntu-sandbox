/**
 * DBA_TS_QUOTAS — tablespace quotas per user, from the SecurityEngine
 * QuotaManager (real allocations, not synthesised).
 */

import { queryResult } from '../../engine/executor/ResultSet';
import { oracleVarchar2, oracleNumber } from '../../engine/catalog/DataType';
import { registerView } from './registry';

registerView({
  name: 'DBA_TS_QUOTAS',
  comment: 'Tablespace quotas',
  query({ catalog }) {
    const cols = [
      { name: 'USERNAME', dataType: oracleVarchar2(128) },
      { name: 'TABLESPACE_NAME', dataType: oracleVarchar2(30) },
      { name: 'BYTES', dataType: oracleNumber(20) },
      { name: 'MAX_BYTES', dataType: oracleNumber(20) },
      { name: 'BLOCKS', dataType: oracleNumber(20) },
      { name: 'MAX_BLOCKS', dataType: oracleNumber(20) },
      { name: 'DROPPED', dataType: oracleVarchar2(3) },
    ];
    const engine = catalog.getSecurityEngine();
    if (!engine) return queryResult(cols, []);
    const blockSize = 8192;
    return queryResult(cols, engine.quotas.getAllQuotas().map(q => {
      const maxBytes = q.maxBytes === -1 ? -1 : q.maxBytes;
      return [
        q.username, q.tablespace, q.bytesUsed, maxBytes,
        Math.ceil(q.bytesUsed / blockSize),
        maxBytes === -1 ? -1 : Math.ceil(maxBytes / blockSize),
        'NO',
      ];
    }));
  },
});
