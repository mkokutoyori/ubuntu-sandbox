/**
 * V$DATABASE — database identity, log/open mode, from the live instance.
 */

import { queryResult } from '../../engine/executor/ResultSet';
import { oracleVarchar2, oracleNumber, oracleDate } from '../../engine/catalog/DataType';
import { registerView } from './registry';

registerView({
  name: 'V$DATABASE',
  comment: 'Database information',
  query({ instance }) {
    return queryResult(
      [
        { name: 'DBID', dataType: oracleNumber(10) },
        { name: 'NAME', dataType: oracleVarchar2(9) },
        { name: 'CREATED', dataType: oracleDate() },
        { name: 'LOG_MODE', dataType: oracleVarchar2(12) },
        { name: 'OPEN_MODE', dataType: oracleVarchar2(20) },
        { name: 'DATABASE_ROLE', dataType: oracleVarchar2(16) },
        { name: 'PLATFORM_NAME', dataType: oracleVarchar2(101) },
      ],
      [[
        1234567890, instance.config.sid, new Date().toISOString(),
        instance.archiveLogMode ? 'ARCHIVELOG' : 'NOARCHIVELOG',
        instance.state === 'OPEN' ? 'READ WRITE' : 'MOUNTED',
        'PRIMARY', 'Linux x86 64-bit',
      ]]
    );
  },
});
