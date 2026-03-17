/**
 * SQL data type descriptors.
 *
 * The base types are shared across dialects. Each dialect extends
 * with vendor-specific types (e.g., Oracle's VARCHAR2, NUMBER).
 */

export type SQLBaseType =
  // Numeric
  | 'INTEGER' | 'SMALLINT' | 'BIGINT'
  | 'NUMERIC' | 'DECIMAL'
  | 'FLOAT' | 'DOUBLE' | 'REAL'
  // Character
  | 'CHAR' | 'VARCHAR'
  // Date/Time
  | 'DATE' | 'TIMESTAMP' | 'TIMESTAMP_TZ'
  | 'INTERVAL_YM' | 'INTERVAL_DS'
  // Binary
  | 'BLOB' | 'CLOB' | 'RAW'
  // Boolean (SQL standard, Oracle 21c+)
  | 'BOOLEAN'
  // Special
  | 'ROWID' | 'NULL';

/** Oracle-specific type names that map to base types. */
export type OracleTypeName =
  | 'NUMBER' | 'VARCHAR2' | 'NVARCHAR2' | 'CHAR' | 'NCHAR'
  | 'DATE' | 'TIMESTAMP' | 'TIMESTAMP WITH TIME ZONE' | 'TIMESTAMP WITH LOCAL TIME ZONE'
  | 'INTERVAL YEAR TO MONTH' | 'INTERVAL DAY TO SECOND'
  | 'CLOB' | 'NCLOB' | 'BLOB' | 'BFILE' | 'RAW' | 'LONG' | 'LONG RAW'
  | 'BINARY_FLOAT' | 'BINARY_DOUBLE'
  | 'BOOLEAN' | 'ROWID' | 'UROWID' | 'XMLTYPE';

/**
 * Column data type descriptor with precision/scale.
 */
export interface ColumnDataType {
  /** Canonical type name (dialect-specific) */
  name: string;
  /** Base SQL type for internal operations */
  baseType: SQLBaseType;
  /** Precision (total digits for NUMBER, max length for CHAR/VARCHAR2) */
  precision?: number;
  /** Scale (decimal digits for NUMBER) */
  scale?: number;
  /** Whether this type allows NULL values */
  nullable: boolean;
}

/**
 * Create an Oracle NUMBER type descriptor.
 */
export function oracleNumber(precision?: number, scale?: number): ColumnDataType {
  return { name: 'NUMBER', baseType: 'NUMERIC', precision, scale, nullable: true };
}

/**
 * Create an Oracle VARCHAR2 type descriptor.
 */
export function oracleVarchar2(maxLength: number): ColumnDataType {
  return { name: 'VARCHAR2', baseType: 'VARCHAR', precision: maxLength, nullable: true };
}

/**
 * Create an Oracle CHAR type descriptor.
 */
export function oracleChar(length: number = 1): ColumnDataType {
  return { name: 'CHAR', baseType: 'CHAR', precision: length, nullable: true };
}

/**
 * Create an Oracle DATE type descriptor.
 */
export function oracleDate(): ColumnDataType {
  return { name: 'DATE', baseType: 'DATE', nullable: true };
}

/**
 * Create an Oracle TIMESTAMP type descriptor.
 */
export function oracleTimestamp(fractionalSeconds: number = 6): ColumnDataType {
  return { name: 'TIMESTAMP', baseType: 'TIMESTAMP', precision: fractionalSeconds, nullable: true };
}

/**
 * Create an Oracle CLOB type descriptor.
 */
export function oracleClob(): ColumnDataType {
  return { name: 'CLOB', baseType: 'CLOB', nullable: true };
}

/**
 * Create an Oracle BLOB type descriptor.
 */
export function oracleBlob(): ColumnDataType {
  return { name: 'BLOB', baseType: 'BLOB', nullable: true };
}

/**
 * Map Oracle type name string to a ColumnDataType.
 */
export function parseOracleType(typeName: string, precision?: number, scale?: number): ColumnDataType {
  const upper = typeName.toUpperCase().trim();
  switch (upper) {
    case 'NUMBER':
      return oracleNumber(precision, scale);
    case 'VARCHAR2':
    case 'NVARCHAR2':
      return oracleVarchar2(precision ?? 4000);
    case 'CHAR':
    case 'NCHAR':
      return oracleChar(precision ?? 1);
    case 'DATE':
      return oracleDate();
    case 'TIMESTAMP':
    case 'TIMESTAMP WITH TIME ZONE':
    case 'TIMESTAMP WITH LOCAL TIME ZONE':
      return oracleTimestamp(precision ?? 6);
    case 'CLOB':
    case 'NCLOB':
      return oracleClob();
    case 'BLOB':
    case 'BFILE':
      return oracleBlob();
    case 'RAW':
      return { name: 'RAW', baseType: 'RAW', precision: precision ?? 2000, nullable: true };
    case 'BINARY_FLOAT':
      return { name: 'BINARY_FLOAT', baseType: 'FLOAT', nullable: true };
    case 'BINARY_DOUBLE':
      return { name: 'BINARY_DOUBLE', baseType: 'DOUBLE', nullable: true };
    case 'BOOLEAN':
      return { name: 'BOOLEAN', baseType: 'BOOLEAN', nullable: true };
    case 'ROWID':
    case 'UROWID':
      return { name: upper, baseType: 'ROWID', nullable: true };
    case 'INTEGER':
    case 'INT':
    case 'SMALLINT':
      return oracleNumber(38, 0);
    case 'FLOAT':
      return { name: 'FLOAT', baseType: 'FLOAT', precision: precision ?? 126, nullable: true };
    case 'LONG':
      return { name: 'LONG', baseType: 'CLOB', nullable: true };
    default:
      return { name: upper, baseType: 'VARCHAR', precision: 4000, nullable: true };
  }
}
