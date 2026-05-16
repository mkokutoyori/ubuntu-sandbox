/**
 * InMemoryRmanCatalog — reactive repository for BackupSets / BackupPieces.
 *
 * Validates the IRmanCatalogRepository contract (Reader + Writer + the
 * changes$ stream) and BackupSetFactory.createBackupSet().
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { InMemoryRmanCatalog } from '@/terminal/subshells/rman/catalog/InMemoryRmanCatalog';
import { BackupSetFactory } from '@/terminal/subshells/rman/catalog/BackupSetFactory';
import { BackupKey } from '@/terminal/subshells/rman/values/BackupKey';
import { RmanTag } from '@/terminal/subshells/rman/values/RmanTag';
import type { RmanEvent } from '@/terminal/subshells/rman/core/types';

describe('BackupSetFactory.createBackupSet', () => {
  beforeEach(() => BackupKey._reset());

  it('produces a frozen set with one piece, monotonic key, AVAILABLE status', () => {
    const set = BackupSetFactory.createBackupSet({
      type: 'FULL', level: 0,
      path: '/u01/bk/x.bkp', sizeBytes: 1024,
      datafiles: [],
    });
    expect(set.bsKey).toBe(1);
    expect(set.pieces.length).toBe(1);
    expect(set.pieces[0].status).toBe('AVAILABLE');
    expect(Object.isFrozen(set)).toBe(true);
    expect(Object.isFrozen(set.pieces)).toBe(true);
  });

  it('uses the provided tag when supplied, otherwise generates one', () => {
    const custom = BackupSetFactory.createBackupSet({
      type: 'FULL', level: 0,
      path: '/u01/bk/x.bkp', sizeBytes: 1, datafiles: [],
      tag: RmanTag.of('MYTAG'),
    });
    expect(custom.tag.label).toBe('MYTAG');

    const auto = BackupSetFactory.createBackupSet({
      type: 'FULL', level: 0,
      path: '/u01/bk/y.bkp', sizeBytes: 1, datafiles: [],
    });
    expect(auto.tag.label).toMatch(/^TAG\d{8}T\d{6}$/);
  });
});

describe('InMemoryRmanCatalog — writer', () => {
  let cat: InMemoryRmanCatalog;
  beforeEach(() => { cat = new InMemoryRmanCatalog(); BackupKey._reset(); });

  it('recordBackupSet stores the set and emits CATALOG_UPDATED(INSERT)', () => {
    const events: Extract<RmanEvent, { type: 'CATALOG_UPDATED' }>[] = [];
    cat.changes$.subscribe(e => events.push(e));
    const set = BackupSetFactory.createBackupSet({
      type: 'FULL', level: 0, path: '/u01/bk/x.bkp', sizeBytes: 100, datafiles: [],
    });
    const r = cat.recordBackupSet(set);
    expect(r.ok).toBe(true);
    expect(events[0].operation).toBe('INSERT');
    expect(events[0].key.bsKey).toBe(set.bsKey);
  });

  it('expirePiece flips status and emits CATALOG_UPDATED(EXPIRE)', () => {
    const set = BackupSetFactory.createBackupSet({
      type: 'FULL', level: 0, path: '/u01/bk/x.bkp', sizeBytes: 100, datafiles: [],
    });
    cat.recordBackupSet(set);
    const events: Extract<RmanEvent, { type: 'CATALOG_UPDATED' }>[] = [];
    cat.changes$.subscribe(e => events.push(e));
    const r = cat.expirePiece(set.pieces[0].key);
    expect(r.ok).toBe(true);
    expect(events[0].operation).toBe('EXPIRE');

    const expired = cat.listExpired();
    expect(expired.ok).toBe(true);
    if (expired.ok) expect(expired.value.length).toBe(1);
  });

  it('expirePiece on unknown key returns err BACKUP_KEY_NOT_FOUND', () => {
    const r = cat.expirePiece({ _tag: 'BackupKey', bsKey: 999, bpKey: 999, copy: 1 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('BACKUP_KEY_NOT_FOUND');
  });

  it('deleteBackupSet removes both the set and its pieces, emits DELETE', () => {
    const set = BackupSetFactory.createBackupSet({
      type: 'FULL', level: 0, path: '/u01/bk/x.bkp', sizeBytes: 100, datafiles: [],
    });
    cat.recordBackupSet(set);
    const events: Extract<RmanEvent, { type: 'CATALOG_UPDATED' }>[] = [];
    cat.changes$.subscribe(e => events.push(e));
    const r = cat.deleteBackupSet(set.bsKey);
    expect(r.ok).toBe(true);
    expect(events[0].operation).toBe('DELETE');

    const snap = cat.listAll();
    if (snap.ok) {
      expect(snap.value.sets.length).toBe(0);
      expect(snap.value.pieces.length).toBe(0);
    }
  });
});

describe('InMemoryRmanCatalog — reader', () => {
  let cat: InMemoryRmanCatalog;
  beforeEach(() => { cat = new InMemoryRmanCatalog(); BackupKey._reset(); });

  it('findByTag returns every set with matching tag', () => {
    cat.recordBackupSet(BackupSetFactory.createBackupSet({
      type: 'FULL', level: 0, path: '/a', sizeBytes: 1, datafiles: [], tag: RmanTag.of('MYTAG'),
    }));
    cat.recordBackupSet(BackupSetFactory.createBackupSet({
      type: 'FULL', level: 0, path: '/b', sizeBytes: 1, datafiles: [], tag: RmanTag.of('OTHER'),
    }));
    const r = cat.findByTag(RmanTag.of('MYTAG'));
    if (r.ok) expect(r.value.length).toBe(1);
  });

  it('listAll exposes a snapshot in insertion order', () => {
    for (let i = 0; i < 3; i++) {
      cat.recordBackupSet(BackupSetFactory.createBackupSet({
        type: 'FULL', level: 0, path: `/p${i}`, sizeBytes: 1, datafiles: [],
      }));
    }
    const r = cat.listAll();
    if (r.ok) expect(r.value.sets.map(s => s.bsKey)).toEqual([1, 2, 3]);
  });

  it('listObsolete(n) returns sets beyond redundancy n', () => {
    cat.recordBackupSet(BackupSetFactory.createBackupSet({
      type: 'FULL', level: 0, path: '/a', sizeBytes: 1, datafiles: [],
    }));
    cat.recordBackupSet(BackupSetFactory.createBackupSet({
      type: 'FULL', level: 0, path: '/b', sizeBytes: 1, datafiles: [],
    }));
    const r = cat.listObsolete(1);
    if (r.ok) expect(r.value.length).toBe(1);
  });
});
