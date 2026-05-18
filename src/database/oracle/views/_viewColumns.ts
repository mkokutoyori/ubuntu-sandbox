/**
 * Shared column set for DBA_VIEWS / ALL_VIEWS / USER_VIEWS.
 *
 * The order and types match Oracle 19c so auditor scripts that SELECT
 * explicit columns work unmodified. Kept here so the DBA_VIEWS view
 * file and the catalog's ALL_/USER_ filtering share one definition.
 */

import type { ColumnMeta } from '../../engine/executor/ResultSet';
import { oracleVarchar2, oracleNumber } from '../../engine/catalog/DataType';

export const VIEW_COLUMNS: ColumnMeta[] = [
  { name: 'OWNER', dataType: oracleVarchar2(128) },
  { name: 'VIEW_NAME', dataType: oracleVarchar2(128) },
  { name: 'TEXT_LENGTH', dataType: oracleNumber(10) },
  { name: 'TEXT', dataType: oracleVarchar2(4000) },
  { name: 'TYPE_TEXT_LENGTH', dataType: oracleNumber(10) },
  { name: 'TYPE_TEXT', dataType: oracleVarchar2(4000) },
  { name: 'OID_TEXT_LENGTH', dataType: oracleNumber(10) },
  { name: 'OID_TEXT', dataType: oracleVarchar2(4000) },
  { name: 'VIEW_TYPE_OWNER', dataType: oracleVarchar2(128) },
  { name: 'VIEW_TYPE', dataType: oracleVarchar2(128) },
  { name: 'SUPERVIEW_NAME', dataType: oracleVarchar2(128) },
  { name: 'EDITIONING_VIEW', dataType: oracleVarchar2(1) },
  { name: 'READ_ONLY', dataType: oracleVarchar2(1) },
  { name: 'BEQUEATH', dataType: oracleVarchar2(12) },
  { name: 'ORIGIN_CON_ID', dataType: oracleVarchar2(256) },
  { name: 'DEFAULT_COLLATION', dataType: oracleVarchar2(100) },
  { name: 'CONTAINER_DATA', dataType: oracleVarchar2(1) },
];
