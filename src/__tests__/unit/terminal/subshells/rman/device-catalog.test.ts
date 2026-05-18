/**
 * Device-scoped catalog persistence.
 *
 * Verifies that backups taken in one RmanSession are visible to a
 * subsequent session bound to the same device — the canonical
 * "shutdown → mount → restore" recipe wouldn't work otherwise because
 * the OracleInstanceWatcherActor disposes the original session.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  RmanSession, RmanSessionOptionsBuilder, BackupKey, DbId, ok,
  DeviceCatalogRegistry,
  type IRmanOracleContext,
} from '@/terminal/subshells/rman';

function ctx(state: 'OPEN' | 'MOUNT' = 'OPEN'): IRmanOracleContext {
  return {
    dbId: DbId.DEFAULT, dbName: 'ORCL',
    vfs: {
      writeFile: () => ok(undefined), readFile: () => ok(new Uint8Array(0)),
      fileExists: () => true, deleteFile: () => ok(undefined), availableBytes: () => 1e10,
    },
    getDatafiles: () => [
      { fileNo: 1, path: '/u01/oradata/ORCL/system01.dbf', sizeBytes: 1_000, tablespace: 'SYSTEM' },
    ],
    getSpfileParam: () => undefined,
    getInstanceState: () => state,
  } as unknown as IRmanOracleContext;
}

describe('DeviceCatalogRegistry', () => {
  beforeEach(() => { BackupKey._reset(); DeviceCatalogRegistry._reset(); });
  afterEach(() => DeviceCatalogRegistry._reset());

  it('returns the same catalog instance for the same deviceId', () => {
    const c1 = DeviceCatalogRegistry.get('dev-A');
    const c2 = DeviceCatalogRegistry.get('dev-A');
    expect(c1).toBe(c2);
  });

  it('returns distinct catalogs for distinct deviceIds', () => {
    const c1 = DeviceCatalogRegistry.get('dev-A');
    const c2 = DeviceCatalogRegistry.get('dev-B');
    expect(c1).not.toBe(c2);
  });

  it('survives session disposal and restores from the same catalog', () => {
    const sharedCatalog = DeviceCatalogRegistry.get('dev-A');

    // Session 1 (OPEN) — takes a backup
    const s1 = new RmanSession(
      new RmanSessionOptionsBuilder().withCatalog(sharedCatalog).build(),
      ctx('OPEN'),
    );
    s1.connect();
    s1.processLine('BACKUP DATABASE');
    s1.dispose();

    // sharedCatalog should still hold the backup set
    const snap = sharedCatalog.listAll();
    expect(snap.ok).toBe(true);
    if (snap.ok) expect(snap.value.sets.length).toBe(1);

    // Session 2 (MOUNT) — restore using the surviving catalog
    const s2 = new RmanSession(
      new RmanSessionOptionsBuilder().withCatalog(sharedCatalog).build(),
      ctx('MOUNT'),
    );
    s2.connect();
    const r = s2.processLine('RESTORE DATABASE');
    expect(r.ok).toBe(true); // catalog non-empty → restore proceeds
    s2.dispose();
  });

  it('a new session without the shared catalog sees an empty one', () => {
    const sharedCatalog = DeviceCatalogRegistry.get('dev-A');

    const s1 = new RmanSession(
      new RmanSessionOptionsBuilder().withCatalog(sharedCatalog).build(),
      ctx('OPEN'),
    );
    s1.connect();
    s1.processLine('BACKUP DATABASE');
    s1.dispose();

    // No .withCatalog → fresh local catalog
    const s2 = new RmanSession(new RmanSessionOptionsBuilder().build(), ctx('MOUNT'));
    s2.connect();
    const types: string[] = [];
    s2.events$.subscribe(e => types.push(e.type));
    s2.processLine('RESTORE DATABASE');
    expect(types).toContain('JOB_FAILED'); // empty catalog → engine fires JOB_FAILED
    s2.dispose();
  });

  it('dispose(deviceId) tears down the catalog for that device', () => {
    DeviceCatalogRegistry.get('dev-A');
    expect(DeviceCatalogRegistry._size()).toBe(1);
    DeviceCatalogRegistry.dispose('dev-A');
    expect(DeviceCatalogRegistry._size()).toBe(0);
  });
});
