/**
 * DBA_ROLES — database roles, from the catalog role registry. Mirrors
 * the 19c column set (AUTHENTICATION_TYPE / COMMON / ORACLE_MAINTAINED
 * / IMPLICIT / INHERITED / INHERITED_ROLE) so the standard DBA queries
 * parse without ORA-00904.
 */

import { queryResult } from '../../engine/executor/ResultSet';
import { oracleVarchar2 } from '../../engine/catalog/DataType';
import { registerView } from './registry';

/** Roles that ship with the database — never visible as user-created. */
const ORACLE_MAINTAINED_ROLES = new Set([
  'CONNECT', 'RESOURCE', 'DBA', 'PUBLIC',
  'SELECT_CATALOG_ROLE', 'EXECUTE_CATALOG_ROLE', 'DELETE_CATALOG_ROLE',
  'EXP_FULL_DATABASE', 'IMP_FULL_DATABASE',
  'DATAPUMP_EXP_FULL_DATABASE', 'DATAPUMP_IMP_FULL_DATABASE',
  'AQ_USER_ROLE', 'AQ_ADMINISTRATOR_ROLE',
  'SCHEDULER_ADMIN', 'RECOVERY_CATALOG_OWNER',
  'GATHER_SYSTEM_STATISTICS',
  'HS_ADMIN_EXECUTE_ROLE', 'HS_ADMIN_SELECT_ROLE', 'HS_ADMIN_ROLE',
  'AUDIT_ADMIN', 'AUDIT_VIEWER',
  'SODA_APP', 'XS_CONNECT', 'XS_SESSION_ADMIN',
  'OPTIMIZER_PROCESSING_RATE',
  'PDB_DBA',
]);

registerView({
  name: 'DBA_ROLES',
  comment: 'Database roles',
  query({ catalog }) {
    return queryResult(
      [
        { name: 'ROLE', dataType: oracleVarchar2(128) },
        { name: 'PASSWORD_REQUIRED', dataType: oracleVarchar2(8) },
        { name: 'AUTHENTICATION_TYPE', dataType: oracleVarchar2(11) },
        { name: 'COMMON', dataType: oracleVarchar2(3) },
        { name: 'ORACLE_MAINTAINED', dataType: oracleVarchar2(1) },
        { name: 'INHERITED', dataType: oracleVarchar2(3) },
        { name: 'IMPLICIT', dataType: oracleVarchar2(3) },
      ],
      catalog.getAllRoles().map(r => [
        r.name,
        r.passwordRequired ? 'YES' : 'NO',
        r.passwordRequired ? 'PASSWORD' : 'NONE',
        'NO',
        ORACLE_MAINTAINED_ROLES.has(r.name) ? 'Y' : 'N',
        'NO',
        'NO',
      ]),
    );
  },
});
