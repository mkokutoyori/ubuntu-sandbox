import { ok, err, type Result } from '../core/Result';
import type { RmanError } from '../core/RmanError';
import type { IRmanCatalogRepository } from './IRmanCatalogRepository';
import type { BackupSet, BackupPiece, CatalogSnapshot } from './types';
import type { BackupKey } from '../values/BackupKey';
import type { RmanTag } from '../values/RmanTag';
import type { RmanObservable } from '../reactive/RmanSubject';
import type { RmanEvent } from '../core/types';
import { InMemoryRmanCatalog } from './InMemoryRmanCatalog';

import type { SqlStatementOutcome } from '../integration/IRmanOracleContext';

export interface CatalogSqlRunner {
  run(statement: string): SqlStatementOutcome;
}

export const RC_DATABASE = 'RC_DATABASE';
export const RC_BACKUP_SET = 'RC_BACKUP_SET';

const CREATE_RC_DATABASE = `CREATE TABLE ${RC_DATABASE} (`
  + 'DB_KEY NUMBER, DBID NUMBER, NAME VARCHAR2(8), RESETLOGS_CHANGE# NUMBER)';

const CREATE_RC_BACKUP_SET = `CREATE TABLE ${RC_BACKUP_SET} (`
  + 'DB_KEY NUMBER, BS_KEY NUMBER, DBID NUMBER, PAYLOAD VARCHAR2(4000))';

function quote(text: string): string {
  return `'${text.replace(/'/g, "''")}'`;
}

export class RemoteRecoveryCatalog implements IRmanCatalogRepository {
  private readonly local = new InMemoryRmanCatalog();
  private registered = false;

  readonly changes$: RmanObservable<Extract<RmanEvent, { type: 'CATALOG_UPDATED' }>>;

  constructor(
    private readonly sql: CatalogSqlRunner,
    private readonly dbName: string,
    private readonly dbId: number,
  ) {
    this.changes$ = this.local.changes$;
  }

  createSchema(): Result<void, RmanError> {
    for (const statement of [CREATE_RC_DATABASE, CREATE_RC_BACKUP_SET]) {
      const outcome = this.sql.run(statement);
      if (outcome.ok === false && !/ORA-00955/.test(outcome.error)) {
        return err({ code: 'RMAN_04004', message: outcome.error });
      }
    }
    return ok(undefined);
  }

  schemaExists(): boolean {
    const outcome = this.sql.run(`SELECT COUNT(*) FROM ${RC_DATABASE}`);
    return outcome.ok === true;
  }

  registerDatabase(): Result<void, RmanError> {
    if (!this.schemaExists()) {
      return err({
        code: 'RMAN_06428',
        message: 'recovery catalog is not installed',
      });
    }
    const existing = this.sql.run(
      `SELECT DB_KEY FROM ${RC_DATABASE} WHERE DBID = ${this.dbId}`);
    if (existing.ok === true && existing.lines.some((line) => /\d/.test(line))) {
      return err({
        code: 'RMAN_20002',
        message: 'target database already registered in recovery catalog',
      });
    }
    const outcome = this.sql.run(
      `INSERT INTO ${RC_DATABASE} (DB_KEY, DBID, NAME, RESETLOGS_CHANGE#) `
      + `VALUES (1, ${this.dbId}, ${quote(this.dbName)}, 1)`);
    if (outcome.ok === false) return err({ code: 'RMAN_04004', message: outcome.error });
    this.sql.run('COMMIT');
    this.registered = true;
    return ok(undefined);
  }

  unregisterDatabase(): Result<void, RmanError> {
    const outcome = this.sql.run(`DELETE FROM ${RC_DATABASE} WHERE DBID = ${this.dbId}`);
    if (outcome.ok === false) return err({ code: 'RMAN_04004', message: outcome.error });
    this.sql.run('COMMIT');
    this.registered = false;
    return ok(undefined);
  }

  isRegistered(): boolean {
    const outcome = this.sql.run(
      `SELECT DBID FROM ${RC_DATABASE} WHERE DBID = ${this.dbId}`);
    return outcome.ok === true && outcome.lines.some((line) => line.includes(String(this.dbId)));
  }

  resyncFrom(snapshot: CatalogSnapshot): Result<number, RmanError> {
    if (!this.schemaExists()) {
      return err({ code: 'RMAN_06428', message: 'recovery catalog is not installed' });
    }
    let written = 0;
    for (const set of snapshot.sets) {
      const already = this.sql.run(
        `SELECT BS_KEY FROM ${RC_BACKUP_SET} WHERE DBID = ${this.dbId} AND BS_KEY = ${set.bsKey}`);
      if (already.ok === true && already.lines.some((line) => /\d/.test(line))) continue;
      const outcome = this.sql.run(
        `INSERT INTO ${RC_BACKUP_SET} (DB_KEY, BS_KEY, DBID, PAYLOAD) `
        + `VALUES (1, ${set.bsKey}, ${this.dbId}, ${quote(serializeSet(set))})`);
      if (outcome.ok === false) return err({ code: 'RMAN_04004', message: outcome.error });
      written++;
    }
    if (written > 0) this.sql.run('COMMIT');
    return ok(written);
  }

  catalogedSetCount(): number {
    const outcome = this.sql.run(
      `SELECT COUNT(*) FROM ${RC_BACKUP_SET} WHERE DBID = ${this.dbId}`);
    if (outcome.ok === false) return 0;
    for (const line of outcome.lines) {
      const digits = /^\s*(\d+)\s*$/.exec(line);
      if (digits) return Number(digits[1]);
    }
    return 0;
  }

  recordBackupSet(set: BackupSet): Result<void, RmanError> {
    const written = this.local.recordBackupSet(set);
    if (written.ok === false) return written;
    if (!this.registered && !this.isRegistered()) return ok(undefined);
    const snapshot = this.local.listAll();
    if (snapshot.ok === false) return ok(undefined);
    const resynced = this.resyncFrom({ ...snapshot.value, sets: [set] });
    return resynced.ok === false ? err(resynced.error) : ok(undefined);
  }

  expirePiece(key: BackupKey): Result<void, RmanError> {
    return this.local.expirePiece(key);
  }

  deleteBackupSet(bsKey: number): Result<void, RmanError> {
    this.sql.run(`DELETE FROM ${RC_BACKUP_SET} WHERE DBID = ${this.dbId} AND BS_KEY = ${bsKey}`);
    this.sql.run('COMMIT');
    return this.local.deleteBackupSet(bsKey);
  }

  setSetStatus(bsKey: number, status: 'AVAILABLE' | 'UNAVAILABLE'): Result<void, RmanError> {
    return this.local.setSetStatus(bsKey, status);
  }

  findByKey(key: BackupKey): Result<BackupSet, RmanError> {
    return this.local.findByKey(key);
  }

  findByTag(tag: RmanTag): Result<BackupSet[], RmanError> {
    return this.local.findByTag(tag);
  }

  listAll(): Result<CatalogSnapshot, RmanError> {
    return this.local.listAll();
  }

  listExpired(): Result<BackupPiece[], RmanError> {
    return this.local.listExpired();
  }

  listObsolete(redundancy: number): Result<BackupSet[], RmanError> {
    return this.local.listObsolete(redundancy);
  }

  adoptLocal(snapshot: CatalogSnapshot): void {
    for (const set of snapshot.sets) this.local.recordBackupSet(set);
  }

  dispose(): void {
    this.local.dispose();
  }
}

function serializeSet(set: BackupSet): string {
  return JSON.stringify({
    bsKey: set.bsKey,
    type: set.type,
    level: set.level,
    tag: set.tag.label,
    completionTime: set.completionTime,
    sizeBytes: set.sizeBytes,
    pieces: set.pieces.map((piece) => piece.path),
  });
}
