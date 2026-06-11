/**
 * DBA_PROCEDURES — stored procedures/functions, from the stored-units
 * provider.
 */

import { queryResult } from '../../engine/executor/ResultSet';
import { oracleVarchar2 } from '../../engine/catalog/DataType';
import { registerView } from './registry';

registerView({
  name: 'DBA_PROCEDURES',
  comment: 'Stored procedures and functions',
  query({ catalog }) {
    // Oracle 19c DBA_PROCEDURES columns. Standalone procedures fill
    // OBJECT_NAME and leave PROCEDURE_NAME null; package members carry
    // the package in OBJECT_NAME and the member in PROCEDURE_NAME.
    return queryResult(
      [
        { name: 'OWNER', dataType: oracleVarchar2(30) },
        { name: 'OBJECT_NAME', dataType: oracleVarchar2(30) },
        { name: 'PROCEDURE_NAME', dataType: oracleVarchar2(30) },
        { name: 'OBJECT_ID', dataType: oracleVarchar2(10) },
        { name: 'OBJECT_TYPE', dataType: oracleVarchar2(13) },
        { name: 'AGGREGATE', dataType: oracleVarchar2(3) },
        { name: 'PIPELINED', dataType: oracleVarchar2(3) },
        { name: 'IMPLTYPEOWNER', dataType: oracleVarchar2(30) },
        { name: 'IMPLTYPENAME', dataType: oracleVarchar2(30) },
        { name: 'PARALLEL', dataType: oracleVarchar2(3) },
        { name: 'INTERFACE', dataType: oracleVarchar2(3) },
        { name: 'DETERMINISTIC', dataType: oracleVarchar2(3) },
        { name: 'AUTHID', dataType: oracleVarchar2(12) },
        { name: 'RESULT_CACHE', dataType: oracleVarchar2(3) },
      ],
      [
        // Standalone units: OBJECT_NAME is the unit, PROCEDURE_NAME null.
        ...catalog.getStoredUnits()
          .filter(u => u.type === 'PROCEDURE' || u.type === 'FUNCTION')
          .map((u, i): (string | null)[] => [
            u.schema, u.name, null,
            String(1000 + i), u.type,
            'NO', 'NO', null, null,
            'NO', 'NO', 'NO',
            'DEFINER', 'NO',
          ]),
        // Package members: OBJECT_NAME carries the package, PROCEDURE_NAME
        // the member, OBJECT_TYPE 'PACKAGE' — Oracle 19c semantics.
        ...catalog.getPackageMembers()
          .map((m, i): (string | null)[] => [
            m.schema, m.pkg, m.member,
            String(5000 + i), 'PACKAGE',
            'NO', 'NO', null, null,
            'NO', 'NO', 'NO',
            'DEFINER', 'NO',
          ]),
      ]
    );
  },
});
