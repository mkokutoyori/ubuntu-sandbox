/**
 * DeviceConfigRegistry + ARCHIVELOG_APPLIED.
 *
 * 1. CONFIGURE survit à une re-création de session pour le même device
 *    (le DeviceConfigRegistry partage l'instance RmanConfig).
 * 2. RECOVER émet un ARCHIVELOG_APPLIED par archivelog disponible,
 *    rendu par le SubShell comme la vraie Oracle.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  RmanSession, RmanSessionOptionsBuilder, BackupKey, DbId, ok,
  DeviceCatalogRegistry, DeviceConfigRegistry,
  type IRmanOracleContext, type RmanEvent,
} from '@/terminal/subshells/rman';

function ctx(state: 'OPEN' | 'MOUNT' = 'OPEN', arcs: string[] = []): IRmanOracleContext {
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
    getArchivelogPaths: () => arcs,
  } as unknown as IRmanOracleContext;
}

describe('DeviceConfigRegistry', () => {
  beforeEach(() => {
    BackupKey._reset();
    DeviceCatalogRegistry._reset();
    DeviceConfigRegistry._reset();
  });
  afterEach(() => { DeviceConfigRegistry._reset(); });

  it('returns the same RmanConfig instance for the same deviceId', () => {
    const a = DeviceConfigRegistry.get('dev-A');
    const b = DeviceConfigRegistry.get('dev-A');
    expect(a).toBe(b);
  });

  it('a CONFIGURE in one session survives into the next session for the same device', () => {
    const sharedCfg = DeviceConfigRegistry.get('dev-X');

    const s1 = new RmanSession(new RmanSessionOptionsBuilder().withConfig(sharedCfg).build(), ctx('OPEN'));
    s1.connect();
    s1.processLine('CONFIGURE RETENTION POLICY TO REDUNDANCY 3');
    s1.processLine('CONFIGURE CONTROLFILE AUTOBACKUP ON');
    s1.dispose();

    const s2 = new RmanSession(new RmanSessionOptionsBuilder().withConfig(sharedCfg).build(), ctx('OPEN'));
    s2.connect();
    const r = s2.processLine('SHOW ALL');
    expect(r.ok).toBe(true);
    if (r.ok) {
      const txt = r.value.join('\n');
      expect(txt).toMatch(/REDUNDANCY 3/i);
      expect(txt).toMatch(/CONTROLFILE AUTOBACKUP ON/i);
    }
    s2.dispose();
  });

  it('without .withConfig(), each session starts fresh', () => {
    const s1 = new RmanSession(new RmanSessionOptionsBuilder().build(), ctx('OPEN'));
    s1.connect();
    s1.processLine('CONFIGURE RETENTION POLICY TO REDUNDANCY 5');
    s1.dispose();

    const s2 = new RmanSession(new RmanSessionOptionsBuilder().build(), ctx('OPEN'));
    s2.connect();
    const r = s2.processLine('SHOW ALL');
    if (r.ok) expect(r.value.join('\n')).toMatch(/REDUNDANCY 1/i); // back to default
    s2.dispose();
  });
});

describe('ARCHIVELOG_APPLIED — RECOVER émet une ligne par log appliqué', () => {
  beforeEach(() => {
    BackupKey._reset();
    DeviceCatalogRegistry._reset();
    DeviceConfigRegistry._reset();
  });

  it('zéro archivelog → aucun event ARCHIVELOG_APPLIED', () => {
    const s = new RmanSession(new RmanSessionOptionsBuilder().build(), ctx('OPEN', []));
    s.connect();
    const types: string[] = [];
    s.events$.subscribe(e => types.push(e.type));
    s.processLine('RECOVER DATABASE');
    expect(types).toContain('RECOVER_COMPLETED');
    expect(types).not.toContain('ARCHIVELOG_APPLIED');
  });

  it('N archivelogs → N events ARCHIVELOG_APPLIED dans l\'ordre', () => {
    const arcs = [
      '/u01/arch/arch_1_42.arc',
      '/u01/arch/arch_1_43.arc',
      '/u01/arch/arch_1_44.arc',
    ];
    const s = new RmanSession(new RmanSessionOptionsBuilder().build(), ctx('OPEN', arcs));
    s.connect();
    const applied: Array<Extract<RmanEvent, { type: 'ARCHIVELOG_APPLIED' }>> = [];
    s.events$.subscribe(e => { if (e.type === 'ARCHIVELOG_APPLIED') applied.push(e); });
    s.processLine('RECOVER DATABASE');
    expect(applied.length).toBe(3);
    expect(applied[0].sequence).toBe(1);
    expect(applied[1].sequence).toBe(2);
    expect(applied[2].sequence).toBe(3);
    expect(applied.map(a => a.path)).toEqual(arcs);
    expect(applied.every(a => a.thread === 1)).toBe(true);
  });

  it('chaque ARCHIVELOG_APPLIED a firstScn < nextScn (consistance temporelle)', () => {
    const arcs = ['/u01/arch/arch_1_1.arc', '/u01/arch/arch_1_2.arc'];
    const s = new RmanSession(new RmanSessionOptionsBuilder().build(), ctx('OPEN', arcs));
    s.connect();
    const applied: Array<Extract<RmanEvent, { type: 'ARCHIVELOG_APPLIED' }>> = [];
    s.events$.subscribe(e => { if (e.type === 'ARCHIVELOG_APPLIED') applied.push(e); });
    s.processLine('RECOVER DATABASE');
    for (const a of applied) {
      expect(a.firstScn).toBeLessThan(a.nextScn);
    }
  });
});
