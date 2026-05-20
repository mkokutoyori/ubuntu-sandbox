/**
 * DBA_TAB_PRIVS — object privilege grants, from the catalog registry.
 */

import { queryResult } from '../../engine/executor/ResultSet';
import { oracleVarchar2 } from '../../engine/catalog/DataType';
import { registerView } from './registry';

registerView({
  name: 'DBA_TAB_PRIVS',
  comment: 'Object privileges',
  query({ catalog, storage }) {
    const cat = catalog as unknown as {
      getTablePrivilegeGrants(): { grantee: string; objectSchema?: string; objectName?: string; privilege: string; grantable?: boolean }[];
      getStoredUnits?: () => { schema: string; name: string; type: string }[];
    };
    const storedUnits = cat.getStoredUnits?.() ?? [];
    /** Resolve the runtime object type — TABLE / VIEW / SEQUENCE / PROCEDURE / FUNCTION / PACKAGE. */
    const resolveType = (schema: string, name: string): string => {
      if (storage.getTableMeta(schema, name)) return 'TABLE';
      if (storage.getViewMeta?.(schema, name)) return 'VIEW';
      if (storage.getSequence?.(schema, name)) return 'SEQUENCE';
      const unit = storedUnits.find(u => u.schema === schema && u.name === name);
      if (unit) return unit.type;
      return 'TABLE';
    };
    const rows: (string | number | null)[][] = cat.getTablePrivilegeGrants().map(p => [
      p.grantee,
      p.objectSchema ?? 'SYS',
      p.objectName ?? '',
      p.privilege,
      p.grantable ? 'YES' : 'NO',
      'SYS',
      resolveType(p.objectSchema ?? 'SYS', p.objectName ?? ''),
    ]);
    return queryResult(
      [
        { name: 'GRANTEE', dataType: oracleVarchar2(128) },
        { name: 'OWNER', dataType: oracleVarchar2(128) },
        { name: 'TABLE_NAME', dataType: oracleVarchar2(128) },
        { name: 'PRIVILEGE', dataType: oracleVarchar2(40) },
        { name: 'GRANTABLE', dataType: oracleVarchar2(3) },
        { name: 'GRANTOR', dataType: oracleVarchar2(128) },
        { name: 'TYPE', dataType: oracleVarchar2(24) },
      ],
      rows
    );
  },
});
