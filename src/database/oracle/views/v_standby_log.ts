import { queryResult } from '../../engine/executor/ResultSet';
import { oracleVarchar2, oracleNumber } from '../../engine/catalog/DataType';
import { registerView } from './registry';

registerView({
  name: 'V$STANDBY_LOG',
  comment: 'Standby redo log groups',
  query({ instance }) {
    return queryResult(
      [
        { name: 'GROUP#', dataType: oracleNumber(10) },
        { name: 'DBID', dataType: oracleVarchar2(40) },
        { name: 'THREAD#', dataType: oracleNumber(10) },
        { name: 'SEQUENCE#', dataType: oracleNumber(10) },
        { name: 'BYTES', dataType: oracleNumber(20) },
        { name: 'BLOCKSIZE', dataType: oracleNumber(10) },
        { name: 'USED', dataType: oracleNumber(20) },
        { name: 'ARCHIVED', dataType: oracleVarchar2(3) },
        { name: 'STATUS', dataType: oracleVarchar2(10) },
      ],
      instance.getStandbyLogs().map((g) => [g.group, g.dbid ?? 'UNASSIGNED', g.thread, g.sequence, g.bytes, 512, g.used, g.archived, g.status]),
    );
  },
});
