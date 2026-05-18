/**
 * DBA_OBJECTS — every schema object, from the catalog object
 * enumerator (tables, views, indexes, sequences, dictionary views …).
 */

import { queryResult } from '../../engine/executor/ResultSet';
import { oracleVarchar2, oracleNumber, oracleDate } from '../../engine/catalog/DataType';
import { registerView } from './registry';

registerView({
  name: 'DBA_OBJECTS',
  comment: 'Database objects',
  query({ catalog }) {
    const rows = catalog.enumerateObjects().map(o => [
      o.owner, o.name, o.subobject, o.objectId, o.dataObjectId,
      o.type, o.created.toISOString(), o.lastDdl.toISOString(),
      o.timestamp, o.status, o.temporary, o.generated, o.secondary,
      o.namespace, o.oracleMaintained,
    ]);
    return queryResult(
      [
        { name: 'OWNER', dataType: oracleVarchar2(128) },
        { name: 'OBJECT_NAME', dataType: oracleVarchar2(128) },
        { name: 'SUBOBJECT_NAME', dataType: oracleVarchar2(128) },
        { name: 'OBJECT_ID', dataType: oracleNumber(10) },
        { name: 'DATA_OBJECT_ID', dataType: oracleNumber(10) },
        { name: 'OBJECT_TYPE', dataType: oracleVarchar2(23) },
        { name: 'CREATED', dataType: oracleDate() },
        { name: 'LAST_DDL_TIME', dataType: oracleDate() },
        { name: 'TIMESTAMP', dataType: oracleVarchar2(19) },
        { name: 'STATUS', dataType: oracleVarchar2(7) },
        { name: 'TEMPORARY', dataType: oracleVarchar2(1) },
        { name: 'GENERATED', dataType: oracleVarchar2(1) },
        { name: 'SECONDARY', dataType: oracleVarchar2(1) },
        { name: 'NAMESPACE', dataType: oracleNumber(10) },
        { name: 'ORACLE_MAINTAINED', dataType: oracleVarchar2(1) },
      ],
      rows
    );
  },
});
