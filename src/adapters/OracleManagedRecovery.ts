/**
 * OracleManagedRecovery — le MRP de la standby.
 *
 * Tant que la recuperation geree est active, chaque journal recu par le
 * RFS est APPLIQUE aux datafiles de la standby, et son SCN avance
 * jusqu'a celui du journal applique.
 */

import type { IEventBus, Unsubscribe } from '@/events/EventBus';
import type { Equipment } from '@/network/equipment/Equipment';
import type { OracleDatabase } from '@/database/oracle/OracleDatabase';
import type { OracleStorage } from '@/database/oracle/OracleStorage';
import { parseBackupPieceImage } from '@/terminal/subshells/rman/core/BackupPieceImage';
import {
  parseRedoStream, applyRedoToTablespace, type RedoRecord,
} from '@/database/oracle/storage/RedoStream';
import { parseDatafileImage, renderDatafileImage } from '@/database/oracle/storage/DatafileImage';

export interface OracleManagedRecoveryCtx {
  resolveDevice(deviceId: string): Equipment | null;
  resolveDatabase(deviceId: string): OracleDatabase | null;
}

interface FsDevice {
  writeFileAsOracle?(path: string, content: string, size?: number): boolean;
  writeFileFromEditor(path: string, content: string, size?: number): boolean;
  readFileAsOracle?(path: string): string | null;
  readFileForEditor?(path: string): string | null;
}

export class OracleManagedRecovery {
  private subs: Unsubscribe[] = [];
  private readonly recus = new Map<string, Array<{ name: string; sequence: number; scn: number }>>();

  constructor(
    private readonly bus: IEventBus,
    private readonly ctx: OracleManagedRecoveryCtx,
  ) {}

  start(): void {
    this.subs.push(
      this.bus.subscribe('oracle.standby.redo-received', (e) => {
        const file = this.recus.get(e.payload.deviceId) ?? [];
        file.push({
          name: e.payload.name, sequence: e.payload.sequence, scn: e.payload.scn,
        });
        this.recus.set(e.payload.deviceId, file);
        this.appliquer(e.payload.deviceId);
      }),
      this.bus.subscribe('oracle.standby.managed-recovery-changed', (e) => {
        if (e.payload.active) this.appliquer(e.payload.deviceId);
      }),
    );
  }

  stop(): void {
    for (const u of this.subs) u();
    this.subs = [];
    this.recus.clear();
  }

  private appliquer(deviceId: string): void {
    const db = this.ctx.resolveDatabase(deviceId);
    const dev = this.ctx.resolveDevice(deviceId) as unknown as FsDevice | null;
    if (!db || !dev || !db.instance.managedRecoveryActive) return;
    const attente = (this.recus.get(deviceId) ?? [])
      .filter(j => j.sequence > db.instance.appliedSequence)
      .sort((a, b) => a.sequence - b.sequence);
    for (const journal of attente) {
      const corps = dev.readFileAsOracle?.(journal.name) ?? dev.readFileForEditor?.(journal.name);
      if (!corps) continue;
      this.appliquerUnJournal(db, dev, corps);
      db.instance.noteRedoApplied(journal.sequence, journal.scn);
    }
  }

  private appliquerUnJournal(db: OracleDatabase, dev: FsDevice, corps: string): void {
    const storage = db.storage as OracleStorage;
    const image = parseBackupPieceImage(corps);
    const vecteurs: RedoRecord[] = parseRedoStream(corps);
    const parChemin = image?.datafiles ?? {};
    for (const ts of storage.getAllTablespaces()) {
      if (ts.type === 'TEMPORARY' || ts.encrypted) continue;
      const df = ts.datafiles[0];
      if (!df) continue;
      const lu = dev.readFileAsOracle?.(df.path) ?? dev.readFileForEditor?.(df.path);
      const expedie = parChemin[df.path];
      let payload = parseDatafileImage(expedie ?? lu ?? null);
      if (!payload) continue;
      if (expedie === undefined) {
        for (const rec of vecteurs) payload = applyRedoToTablespace(payload, rec);
      }
      storage.loadTablespace(payload);
      this.ecrire(dev, df.path, renderDatafileImage(
        (expedie ?? lu ?? '').split('\n')[0] || `[ORACLE DATAFILE - ${ts.name} tablespace]`,
        payload));
    }
  }

  private ecrire(dev: FsDevice, path: string, contenu: string): void {
    if (typeof dev.writeFileAsOracle === 'function') dev.writeFileAsOracle(path, contenu);
    else dev.writeFileFromEditor(path, contenu);
  }
}
