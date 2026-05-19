/**
 * DBA_FREE_SPACE_COALESCED — per-tablespace coalesced-free-space stats.
 * The simulator does not maintain per-extent free space granularity, so
 * the view reports zero coalesced extents per tablespace (truthful).
 */

import { queryResult } from '../../engine/executor/ResultSet';
import { oracleVarchar2, oracleNumber } from '../../engine/catalog/DataType';
import { registerView } from './registry';

registerView({
  name: 'DBA_FREE_SPACE_COALESCED',
  comment: 'Coalesced free space per tablespace',
  query({ storage }) {
    return queryResult(
      [
        { name: 'TABLESPACE_NAME', dataType: oracleVarchar2(30) },
        { name: 'TOTAL_EXTENTS', dataType: oracleNumber(20) },
        { name: 'EXTENTS_COALESCED', dataType: oracleNumber(20) },
        { name: 'PERCENT_EXTENTS_COALESCED', dataType: oracleNumber(20) },
        { name: 'TOTAL_BYTES', dataType: oracleNumber(20) },
        { name: 'BYTES_COALESCED', dataType: oracleNumber(20) },
        { name: 'PERCENT_BYTES_COALESCED', dataType: oracleNumber(20) },
      ],
      storage.getAllTablespaces().map(ts => [ts.name, 0, 0, 0, 0, 0, 0])
    );
  },
});
