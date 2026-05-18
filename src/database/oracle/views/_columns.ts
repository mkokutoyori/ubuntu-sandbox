/**
 * Tiny helpers for declaring Oracle view columns concisely.
 */

import type { ColumnMeta } from '../../engine/executor/ResultSet';
import { oracleVarchar2, oracleNumber, oracleDate } from '../../engine/catalog/DataType';

export const col = {
  str: (name: string, len = 30): ColumnMeta => ({ name, dataType: oracleVarchar2(len) }),
  num: (name: string, precision = 10): ColumnMeta => ({ name, dataType: oracleNumber(precision) }),
  date: (name: string): ColumnMeta => ({ name, dataType: oracleDate() }),
};
