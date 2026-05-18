/**
 * V$IOSTAT_NETWORK — per-network-channel I/O stats.
 */

import { queryResult } from '../../engine/executor/ResultSet';
import { oracleVarchar2, oracleNumber } from '../../engine/catalog/DataType';
import { registerView } from './registry';

registerView({
  name: 'V$IOSTAT_NETWORK',
  comment: 'Per-network-channel I/O statistics',
  query() {
    return queryResult(
      [
        { name: 'NETWORK_INTERFACE_ID', dataType: oracleNumber(10) },
        { name: 'CLIENT_CLASS', dataType: oracleVarchar2(64) },
        { name: 'BYTES_VIA_SDP_RECEIVED', dataType: oracleNumber(20) },
        { name: 'BYTES_RECEIVED', dataType: oracleNumber(20) },
        { name: 'BYTES_SENT', dataType: oracleNumber(20) },
        { name: 'BYTES_VIA_SDP_SENT', dataType: oracleNumber(20) },
        { name: 'IO_REQUESTS_RECEIVED', dataType: oracleNumber(20) },
        { name: 'IO_REQUESTS_SENT', dataType: oracleNumber(20) },
      ],
      []
    );
  },
});
