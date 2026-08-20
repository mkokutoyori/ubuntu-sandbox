/**
 * NpsSqlAccounting — `Set-NpsAccountingConfiguration -SqlLogging` (PRD-
 * Windows-Server-Advanced.md §5 P22, §2.1.21): redirects the RADIUS
 * accounting records `WindowsNpsRole` already produces into a simulated
 * SQL table built on this project's own `OracleDatabase`/`OracleInstance`
 * engine, rather than inventing a second ad-hoc accounting store. This is
 * an embedded, in-process instance (no TNS network transport exists in
 * this simulator) — "a table styled like `OracleDatabase`", not a
 * separately-addressable Oracle server.
 */
import { OracleDatabase } from '@/database/oracle/OracleDatabase';
import type { OracleExecutor } from '@/database/oracle/OracleExecutor';
import type { ResultSet } from '@/database/engine/executor/ResultSet';

const TABLE_NAME = 'RADIUS_ACCOUNTING';

export interface NpsAccountingRecordInput {
  sessionId: string;
  username: string;
  status: string;
  sessionTimeSec: number;
  inputOctets: number;
  outputOctets: number;
}

function sqlEscape(value: string): string {
  return value.replace(/'/g, "''");
}

export class NpsSqlAccountingTable {
  private readonly db: OracleDatabase;
  private readonly executor: OracleExecutor;

  constructor() {
    this.db = new OracleDatabase();
    this.db.instance.startup();
    const conn = this.db.connectAsSysdba();
    this.executor = conn.executor;
    this.db.executeSql(this.executor, `CREATE TABLE ${TABLE_NAME} (
      SESSION_ID VARCHAR2(64),
      USERNAME VARCHAR2(64),
      STATUS VARCHAR2(16),
      SESSION_TIME_SEC NUMBER,
      INPUT_OCTETS NUMBER,
      OUTPUT_OCTETS NUMBER
    )`);
  }

  insert(record: NpsAccountingRecordInput): void {
    const sql = `INSERT INTO ${TABLE_NAME} `
      + '(SESSION_ID, USERNAME, STATUS, SESSION_TIME_SEC, INPUT_OCTETS, OUTPUT_OCTETS) VALUES '
      + `('${sqlEscape(record.sessionId)}', '${sqlEscape(record.username)}', '${sqlEscape(record.status)}', `
      + `${record.sessionTimeSec}, ${record.inputOctets}, ${record.outputOctets})`;
    this.db.executeSql(this.executor, sql);
  }

  /** Runs an arbitrary read (or write) query against the accounting table/schema — e.g. `SELECT * FROM RADIUS_ACCOUNTING`. */
  query(sql: string): ResultSet {
    return this.db.executeSql(this.executor, sql);
  }
}
