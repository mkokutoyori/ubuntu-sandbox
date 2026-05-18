/**
 * Base error class for all database errors.
 * Subclassed per dialect (OracleError, PostgresError, etc.).
 */
export class DatabaseError extends Error {
  readonly code: string;
  readonly position?: number;

  constructor(code: string, message: string, position?: number) {
    super(message);
    this.name = 'DatabaseError';
    this.code = code;
    this.position = position;
  }

  /** Format error for terminal display. */
  format(): string {
    return `${this.code}: ${this.message}`;
  }
}

/**
 * Oracle-specific error (ORA-XXXXX).
 */
export class OracleError extends DatabaseError {
  constructor(code: number, message: string, position?: number) {
    const oraCode = `ORA-${String(code).padStart(5, '0')}`;
    // Real SQL*Plus prefixes the code on the message line; keep `.message` in sync
    // so callers that surface `err.message` (terminal, tests) see "ORA-XXXXX: …".
    const prefixed = message.startsWith('ORA-') ? message : `${oraCode}: ${message}`;
    super(oraCode, prefixed, position);
    this.name = 'OracleError';
  }
}
