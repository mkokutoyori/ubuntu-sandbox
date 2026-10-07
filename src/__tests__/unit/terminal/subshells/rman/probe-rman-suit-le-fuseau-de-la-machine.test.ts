/**
 * RMAN tourne sur la machine de la base : sa banniere, le TAG d'une sauvegarde (`TAG20261007T064200`),
 * le repertoire date du `backupset` (`2026_10_07`), les colonnes `Completion Time` de `LIST BACKUP` et
 * `REPORT OBSOLETE`, la date de reinitialisation de `LIST INCARNATION` et les lignes
 * `Starting restore at …` sont l'heure MURALE de cette machine. Or elles lisaient les accesseurs
 * locaux d'un `Date` JavaScript — le fuseau du PROCESSUS, en production celui du NAVIGATEUR : 34
 * lectures sans port vers l'horloge de la machine, `IRmanOracleContext` ne portant ni horloge ni
 * fuseau.
 *
 * MESURE : la meme suite, un contexte en UTC, jouee sous `TZ=UTC` puis `TZ=Pacific/Auckland` pour le
 * processus : la banniere passait de `06-OCT-2026 21:42:00` a `07-OCT-2026 10:42:00`, le TAG et le
 * repertoire du piece avec elle, `LIST BACKUP` et `LIST INCARNATION` aussi.
 *
 * Corrige en faisant porter `hostZoneName()` par `IRmanOracleContext` (le port de RMAN vers Oracle,
 * que `LinuxRmanContext` remplit avec le fuseau de la machine) et en passant UNE heure murale
 * (`rmanWall`, un `ZonedDate`) a tout ce qui se formate ou se nomme. Les lignes `Starting restore at`
 * etaient de l'ISO en UTC : elles prennent le format que RMAN imprime partout ailleurs.
 *
 * Discriminee contre l'etat d'avant (sources de `mandeng-fuseaux-oracle`, meme sonde) : 6 des 7 cas
 * tombent. Le seul qui passe des deux cotes est NOMME : le temoin « la suite d'un contexte UTC est
 * stable sous un processus UTC et porte l'heure », qui prouve que le laboratoire est sain.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  RmanSession, RmanSessionOptionsBuilder, BackupKey, DbId, ok, DeviceCatalogRegistry,
  type IRmanOracleContext,
} from '@/terminal/subshells/rman';
import { renderControlFileImage } from '@/database/oracle/storage/ControlFileImage';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { ReactiveRmanSubShell } from '@/terminal/subshells/rman/ReactiveRmanSubShell';
import { resetAllOracleInstances } from '@/terminal/commands/database';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { SimulationClock, installSimulationClock, __resetSimulationClock } from '@/events/SimulationClock';

const ORIGINAL_TZ = process.env.TZ;
const ORIGIN_MS = Date.UTC(2026, 9, 6, 21, 42, 0);
const SYSTEM01 = '/u01/oradata/ORCL/system01.dbf';
const DATAFILE_IMAGE = new TextEncoder().encode('[ORACLE DATAFILE - SYSTEM tablespace - 1M]');
const CONTROL_IMAGE = new TextEncoder().encode(renderControlFileImage(
  '[ORACLE RMAN BACKUP PIECE - 9650176 bytes]',
  { dbName: 'ORCL', dbId: DbId.DEFAULT.value, datafiles: [], backupSets: [] },
));
const written: string[] = [];

function context(zone: string | undefined, state: 'OPEN' | 'NOMOUNT' = 'OPEN'): IRmanOracleContext {
  return {
    dbId: DbId.DEFAULT, dbName: 'ORCL',
    vfs: {
      writeFile: (path: string) => { written.push(path); return ok(undefined); },
      readFile: (path: string) => ok(path === SYSTEM01 ? DATAFILE_IMAGE : CONTROL_IMAGE),
      fileExists: () => true, deleteFile: () => ok(undefined), availableBytes: () => 1e10,
    },
    getDatafiles: () => [{ fileNo: 1, path: SYSTEM01, sizeBytes: 1_000, tablespace: 'SYSTEM' }],
    getSpfileParam: () => undefined,
    getInstanceState: () => state,
    getControlFilePath: () => '/u01/oradata/ORCL/control01.ctl',
    getArchivelogPaths: () => [],
    ...(zone === undefined ? {} : { hostZoneName: () => zone }),
  } as unknown as IRmanOracleContext;
}

function lab(processZone: string, zone?: string, state: 'OPEN' | 'NOMOUNT' = 'OPEN') {
  process.env.TZ = processZone;
  BackupKey._reset(); DeviceCatalogRegistry._reset(); written.length = 0;
  const clock = installSimulationClock(new SimulationClock({ startPump: () => () => undefined, originMs: ORIGIN_MS }));
  const session = new RmanSession(new RmanSessionOptionsBuilder().build(), context(zone, state));
  session.connect();
  const run = (command: string): string => {
    const result = session.processLine(command);
    return result.ok === false ? JSON.stringify(result.error) : result.value.join('\n');
  };
  return { session, run, clock };
}

const maskRandom = (text: string): string => text.replace(/_[0-9a-z]{8}_\.bkp/g, '_xxxxxxxx_.bkp');

function transcript(processZone: string): string[] {
  const { session, run } = lab(processZone, 'UTC');
  const out = [session.getBanner().join('\n')];
  for (const command of ['BACKUP DATABASE', 'LIST BACKUP SUMMARY', 'LIST BACKUP', 'LIST INCARNATION']) out.push(run(command));
  out.push(written.join('\n'));
  return out.map(maskRandom);
}

afterEach(() => {
  if (ORIGINAL_TZ === undefined) delete process.env.TZ; else process.env.TZ = ORIGINAL_TZ;
  __resetSimulationClock();
});

describe('RMAN prints the time of its machine, not the one of the process', () => {
  beforeEach(() => { BackupKey._reset(); DeviceCatalogRegistry._reset(); });

  it('witness: the transcript of a UTC context is stable under a UTC process and carries the time', () => {
    const first = transcript('UTC');
    const second = transcript('UTC');
    expect(second).toEqual(first);
    expect(first[0]).toContain('06-OCT-2026 21:42:00');
  });

  it('the transcript of a UTC context does not depend on the zone of the process', () => {
    const utc = transcript('UTC');
    const auckland = transcript('Pacific/Auckland');
    const names = ['banner', 'backup', 'list summary', 'list backup', 'list incarnation', 'pieces'];
    expect(names.filter((_, i) => utc[i] !== auckland[i])).toEqual([]);
  });

  describe('a machine set to Tokyo', () => {
    it('the banner, the tag and the dated piece directory are the Tokyo wall clock', () => {
      const { session, run } = lab('UTC', 'Asia/Tokyo');
      expect(session.getBanner().join('\n')).toContain('07-OCT-2026 06:42:00');
      run('BACKUP DATABASE');
      expect(written.some((path) => path.includes('/backupset/2026_10_07/') && path.includes('TAG20261007T064200'))).toBe(true);
    });

    it('LIST BACKUP and LIST INCARNATION show the Tokyo wall clock', () => {
      const { run } = lab('UTC', 'Asia/Tokyo');
      run('BACKUP DATABASE');
      expect(run('LIST BACKUP SUMMARY')).toContain('07-OCT-2026 06:42:00');
      expect(run('LIST BACKUP')).toContain('07-OCT-2026 06:42:00');
      expect(run('LIST INCARNATION')).toContain('2026-10-07');
    });

    it('REPORT OBSOLETE shows the completion time of the obsolete set in Tokyo time', async () => {
      const { run, clock } = lab('UTC', 'Asia/Tokyo');
      run('CONFIGURE RETENTION POLICY TO RECOVERY WINDOW OF 1 DAYS');
      run('BACKUP DATABASE');
      await clock.advance(2 * 86_400_000);
      run('BACKUP DATABASE');
      await clock.advance(2 * 86_400_000);
      run('BACKUP DATABASE');
      await clock.advance(86_400_000);
      expect(run('REPORT OBSOLETE')).toContain('07-OCT-2026 06:42:00');
    });

    it('RESTORE CONTROLFILE FROM AUTOBACKUP announces the Tokyo day', () => {
      lab('UTC', 'Asia/Tokyo');
      const catalog = DeviceCatalogRegistry.get('probe-tokyo');
      const open = new RmanSession(new RmanSessionOptionsBuilder().withCatalog(catalog).build(), context('Asia/Tokyo'));
      open.connect();
      open.processLine('CONFIGURE CONTROLFILE AUTOBACKUP ON');
      open.processLine('BACKUP DATABASE');
      const offline = new RmanSession(
        new RmanSessionOptionsBuilder().withCatalog(catalog).build(), context('Asia/Tokyo', 'NOMOUNT'));
      offline.connect();
      const result = offline.processLine('RESTORE CONTROLFILE FROM AUTOBACKUP');
      expect(result.ok ? result.value.join('\n') : JSON.stringify(result)).toContain('looking for AUTOBACKUP on day: 20261007');
    });
  });

  it('a real machine set to Tokyo gives RMAN its own zone', async () => {
    process.env.TZ = 'UTC';
    EquipmentRegistry.resetInstance(); resetAllOracleInstances(); DeviceCatalogRegistry._reset();
    installSimulationClock(new SimulationClock({ startPump: () => () => undefined, originMs: ORIGIN_MS }));
    const server = new LinuxServer('linux-server', 'S1');
    await server.executeCommand('timedatectl set-timezone Asia/Tokyo');
    const { banner } = ReactiveRmanSubShell.create(server, ['target', '/']);
    expect(banner.join('\n')).toContain('07-OCT-2026 06:42:00');
  });
});
