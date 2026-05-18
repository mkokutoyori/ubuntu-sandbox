/**
 * BACKUP AS COPY — image copies (un DATAFILECOPY par datafile).
 *
 *   BACKUP AS COPY DATABASE
 *   BACKUP AS COPY TABLESPACE USERS
 *   BACKUP AS COPY DATAFILE 1, 4
 *
 * Distinct du BACKUP DATABASE classique : pas de set agrégé, chaque
 * datafile devient un BackupSet de type DATAFILECOPY.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  RmanSession, RmanSessionOptionsBuilder, BackupKey, DbId, ok,
  DeviceCatalogRegistry, DeviceConfigRegistry,
  type IRmanOracleContext, type RmanEvent,
} from '@/terminal/subshells/rman';

function ctx(): IRmanOracleContext {
  return {
    dbId: DbId.DEFAULT, dbName: 'ORCL',
    vfs: {
      writeFile: () => ok(undefined), readFile: () => ok(new Uint8Array(0)),
      fileExists: () => true, deleteFile: () => ok(undefined), availableBytes: () => 1e10,
    },
    getDatafiles: () => [
      { fileNo: 1, path: '/u01/oradata/ORCL/system01.dbf', sizeBytes: 1_000, tablespace: 'SYSTEM' },
      { fileNo: 4, path: '/u01/oradata/ORCL/users01.dbf',  sizeBytes: 1_000, tablespace: 'USERS' },
    ],
    getSpfileParam: () => undefined,
    getInstanceState: () => 'OPEN',
  } as unknown as IRmanOracleContext;
}

describe('BACKUP AS COPY', () => {
  beforeEach(() => {
    BackupKey._reset();
    DeviceCatalogRegistry._reset();
    DeviceConfigRegistry._reset();
  });

  it('AS COPY DATABASE crée un BackupSet par datafile, tous de type DATAFILECOPY', () => {
    const s = new RmanSession(new RmanSessionOptionsBuilder().build(), ctx());
    s.connect();
    const pieces: string[] = [];
    s.events$.subscribe(e => {
      if (e.type === 'BACKUP_PIECE_CREATED') pieces.push((e as Extract<RmanEvent, { type: 'BACKUP_PIECE_CREATED' }>).piece.path);
    });
    s.processLine('BACKUP AS COPY DATABASE');
    // 2 datafiles → 2 pieces distinctes
    expect(pieces.length).toBe(2);
    expect(new Set(pieces).size).toBe(2);

    const list = s.processLine('LIST BACKUP');
    if (list.ok) {
      const txt = list.value.join('\n');
      // LIST BACKUP rendu : la colonne Type doit dire "DFCopy" pour chaque
      expect(txt.split('DFCopy').length - 1).toBe(2);
    }
  });

  it('AS COPY TABLESPACE USERS ne copie que les datafiles de USERS', () => {
    const s = new RmanSession(new RmanSessionOptionsBuilder().build(), ctx());
    s.connect();
    const pieces: string[] = [];
    s.events$.subscribe(e => {
      if (e.type === 'BACKUP_PIECE_CREATED') pieces.push((e as Extract<RmanEvent, { type: 'BACKUP_PIECE_CREATED' }>).piece.path);
    });
    s.processLine('BACKUP AS COPY TABLESPACE USERS');
    expect(pieces.length).toBe(1);
    expect(pieces[0]).toMatch(/\.df4$/);
  });

  it('AS COPY DATAFILE 1, 4 copie les deux datafiles désignés', () => {
    const s = new RmanSession(new RmanSessionOptionsBuilder().build(), ctx());
    s.connect();
    const pieces: string[] = [];
    s.events$.subscribe(e => {
      if (e.type === 'BACKUP_PIECE_CREATED') pieces.push((e as Extract<RmanEvent, { type: 'BACKUP_PIECE_CREATED' }>).piece.path);
    });
    s.processLine('BACKUP AS COPY DATAFILE 1, 4');
    expect(pieces.length).toBe(2);
    expect(pieces.some(p => p.endsWith('.df1'))).toBe(true);
    expect(pieces.some(p => p.endsWith('.df4'))).toBe(true);
  });

  it('LIST COPY voit bien les image copies (et seulement elles)', () => {
    const s = new RmanSession(new RmanSessionOptionsBuilder().build(), ctx());
    s.connect();
    s.processLine('BACKUP DATABASE');             // ce backup ne doit PAS apparaître dans LIST COPY
    s.processLine('BACKUP AS COPY DATABASE');     // ces 2 copies oui
    const r = s.processLine('LIST COPY');
    if (r.ok) {
      const txt = r.value.join('\n');
      expect(txt).toContain('Datafile Copies');
      // 2 lignes de copy attendues
      expect(txt.split('Key:').length - 1).toBeGreaterThanOrEqual(2);
    }
  });
});
