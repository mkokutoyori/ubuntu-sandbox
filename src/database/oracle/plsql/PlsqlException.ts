/**
 * PL/SQL exception hierarchy — concrete classes for every predefined
 * exception in the STANDARD package, plus the user-defined family.
 *
 * Real Oracle ships ~25 named exceptions in `STANDARD` (NO_DATA_FOUND,
 * TOO_MANY_ROWS, ZERO_DIVIDE, INVALID_NUMBER, …) plus the
 * RAISE_APPLICATION_ERROR family at codes 20000-20999. We model both
 * here so the interpreter can match on either name or code with a
 * single registry.
 */

export class PlsqlException extends Error {
  /** Oracle-style ORA-/SP2- error code. */
  readonly errorCode: number;
  /** Canonical name in the STANDARD package (NO_DATA_FOUND, …). */
  readonly exceptionName: string;
  /** True for user-defined errors raised via RAISE_APPLICATION_ERROR. */
  readonly userDefined: boolean;

  constructor(name: string, code: number, message: string, userDefined: boolean = false) {
    super(message);
    this.exceptionName = name.toUpperCase();
    this.errorCode = code;
    this.userDefined = userDefined;
    this.name = 'PlsqlException';
  }
}

/** Definition of one predefined exception. */
export interface PredefinedException {
  readonly name: string;
  readonly errorCode: number;
  readonly defaultMessage: string;
}

/** Oracle 19c STANDARD-package predefined exceptions (subset, the most
 *  commonly used). */
export const PREDEFINED_EXCEPTIONS: ReadonlyArray<PredefinedException> = [
  { name: 'ACCESS_INTO_NULL',         errorCode: 6530, defaultMessage: 'ORA-06530: Reference to uninitialized composite' },
  { name: 'CASE_NOT_FOUND',           errorCode: 6592, defaultMessage: 'ORA-06592: CASE not found while executing CASE statement' },
  { name: 'COLLECTION_IS_NULL',       errorCode: 6531, defaultMessage: 'ORA-06531: Reference to uninitialized collection' },
  { name: 'CURSOR_ALREADY_OPEN',      errorCode: 6511, defaultMessage: 'ORA-06511: PL/SQL: cursor already open' },
  { name: 'DUP_VAL_ON_INDEX',         errorCode: 1,    defaultMessage: 'ORA-00001: unique constraint violated' },
  { name: 'INVALID_CURSOR',           errorCode: 1001, defaultMessage: 'ORA-01001: invalid cursor' },
  { name: 'INVALID_NUMBER',           errorCode: 1722, defaultMessage: 'ORA-01722: invalid number' },
  { name: 'LOGIN_DENIED',             errorCode: 1017, defaultMessage: 'ORA-01017: invalid username/password' },
  { name: 'NO_DATA_FOUND',            errorCode: 1403, defaultMessage: 'ORA-01403: no data found' },
  { name: 'NOT_LOGGED_ON',            errorCode: 1012, defaultMessage: 'ORA-01012: not logged on' },
  { name: 'PROGRAM_ERROR',            errorCode: 6501, defaultMessage: 'ORA-06501: PL/SQL: program error' },
  { name: 'ROWTYPE_MISMATCH',         errorCode: 6504, defaultMessage: 'ORA-06504: PL/SQL: Return types of result set variables do not match' },
  { name: 'SELF_IS_NULL',             errorCode: 30625, defaultMessage: 'ORA-30625: method dispatch on NULL SELF argument is disallowed' },
  { name: 'STORAGE_ERROR',            errorCode: 6500, defaultMessage: 'ORA-06500: PL/SQL: storage error' },
  { name: 'SUBSCRIPT_BEYOND_COUNT',   errorCode: 6533, defaultMessage: 'ORA-06533: Subscript beyond count' },
  { name: 'SUBSCRIPT_OUTSIDE_LIMIT',  errorCode: 6532, defaultMessage: 'ORA-06532: Subscript outside of limit' },
  { name: 'SYS_INVALID_ROWID',        errorCode: 1410, defaultMessage: 'ORA-01410: invalid ROWID' },
  { name: 'TIMEOUT_ON_RESOURCE',      errorCode: 51,   defaultMessage: 'ORA-00051: timeout occurred while waiting for a resource' },
  { name: 'TOO_MANY_ROWS',            errorCode: 1422, defaultMessage: 'ORA-01422: exact fetch returns more than requested number of rows' },
  { name: 'VALUE_ERROR',              errorCode: 6502, defaultMessage: 'ORA-06502: PL/SQL: numeric or value error' },
  { name: 'ZERO_DIVIDE',              errorCode: 1476, defaultMessage: 'ORA-01476: divisor is equal to zero' },
];

/** Look up a predefined exception by name. */
export function findPredefinedException(name: string): PredefinedException | undefined {
  return PREDEFINED_EXCEPTIONS.find(e => e.name === name.toUpperCase());
}

/** Match a runtime error message to a predefined exception name. */
export function matchPredefinedException(message: string): PredefinedException | undefined {
  for (const e of PREDEFINED_EXCEPTIONS) {
    if (message.includes(e.defaultMessage)) return e;
    if (message.includes(`ORA-${e.errorCode.toString().padStart(5, '0')}`)) return e;
  }
  return undefined;
}
