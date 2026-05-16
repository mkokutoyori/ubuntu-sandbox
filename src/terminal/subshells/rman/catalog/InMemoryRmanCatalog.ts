/**
 * InMemoryRmanCatalog — in-memory implementation of IRmanCatalogRepository.
 *
 * Stores sets and pieces in two Maps; every write also emits a
 * CATALOG_UPDATED event on the catalog's own changes$ stream
 * (RmanSession forwards it to the central bus).
 */

import { RmanSubject, type RmanObservable } from '../reactive/RmanSubject';
import { ok, err, type Result } from '../core/Result';
import type { RmanError } from '../core/RmanError';
import type { IRmanCatalogRepository } from './IRmanCatalogRepository';
import type { BackupSet, BackupPiece, CatalogSnapshot } from './types';
import type { BackupKey } from '../values/BackupKey';
import type { RmanTag } from '../values/RmanTag';
import type { RmanEvent } from '../core/types';
import { DbId } from '../values/DbId';

function pieceKeyStr(k: BackupKey): string { return `${k.bsKey}:${k.bpKey}`; }

export class InMemoryRmanCatalog implements IRmanCatalogRepository {
  private readonly _sets   = new Map<number, BackupSet>();
  private readonly _pieces = new Map<string, BackupPiece>();
  private readonly _changes$ = new RmanSubject<Extract<RmanEvent, { type: 'CATALOG_UPDATED' }>>();

  readonly changes$: RmanObservable<Extract<RmanEvent, { type: 'CATALOG_UPDATED' }>>
    = this._changes$.asObservable();

  // ── Writer ────────────────────────────────────────────────────────

  recordBackupSet(set: BackupSet): Result<void, RmanError> {
    try {
      this._sets.set(set.bsKey, set);
      for (const p of set.pieces) this._pieces.set(pieceKeyStr(p.key), p);
      for (const p of set.pieces) {
        this._changes$.next({ type: 'CATALOG_UPDATED', operation: 'INSERT', key: p.key });
      }
      return ok(undefined);
    } catch (e) {
      return err({ code: 'CATALOG_WRITE_ERROR', message: String(e) });
    }
  }

  expirePiece(key: BackupKey): Result<void, RmanError> {
    const str = pieceKeyStr(key);
    const p = this._pieces.get(str);
    if (!p) return err({ code: 'BACKUP_KEY_NOT_FOUND', message: `Piece ${str} not found`, key: str });
    this._pieces.set(str, { ...p, status: 'EXPIRED' });
    this._changes$.next({ type: 'CATALOG_UPDATED', operation: 'EXPIRE', key });
    return ok(undefined);
  }

  deleteBackupSet(bsKey: number): Result<void, RmanError> {
    const set = this._sets.get(bsKey);
    if (!set) return err({ code: 'BACKUP_KEY_NOT_FOUND', message: `BS ${bsKey} not found`, key: String(bsKey) });
    for (const p of set.pieces) this._pieces.delete(pieceKeyStr(p.key));
    this._sets.delete(bsKey);
    for (const p of set.pieces) {
      this._changes$.next({ type: 'CATALOG_UPDATED', operation: 'DELETE', key: p.key });
    }
    return ok(undefined);
  }

  // ── Reader ────────────────────────────────────────────────────────

  findByKey(key: BackupKey): Result<BackupSet, RmanError> {
    const str = pieceKeyStr(key);
    const p = this._pieces.get(str);
    if (!p) return err({ code: 'BACKUP_KEY_NOT_FOUND', message: `Piece ${str} not found`, key: str });
    const set = this._sets.get(p.bsKey);
    if (!set) return err({ code: 'BACKUP_KEY_NOT_FOUND', message: `BS ${p.bsKey} not found`, key: String(p.bsKey) });
    return ok(set);
  }

  findByTag(tag: RmanTag): Result<BackupSet[], RmanError> {
    const out: BackupSet[] = [];
    for (const s of this._sets.values()) if (s.tag.label === tag.label) out.push(s);
    return ok(out);
  }

  listAll(): Result<CatalogSnapshot, RmanError> {
    const sets = [...this._sets.values()];
    const dbId = sets[0]?.dbId ?? DbId.DEFAULT;
    return ok({ sets, pieces: [...this._pieces.values()], dbId });
  }

  listExpired(): Result<BackupPiece[], RmanError> {
    return ok([...this._pieces.values()].filter(p => p.status === 'EXPIRED'));
  }

  listObsolete(redundancy: number): Result<BackupSet[], RmanError> {
    const sorted = [...this._sets.values()].sort((a, b) => b.completionTime - a.completionTime);
    return ok(sorted.slice(redundancy));
  }

  dispose(): void { this._changes$.complete(); }
}
