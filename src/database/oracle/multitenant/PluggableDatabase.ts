import { md5Hex } from '@/crypto';

export type PdbOpenMode = 'MOUNTED' | 'READ ONLY' | 'READ WRITE' | 'MIGRATE';
export type PdbStatus = 'NORMAL' | 'NEW' | 'UNUSABLE' | 'UNPLUGGED' | 'CREATING';

export class PluggableDatabase {
  readonly conId: number;
  readonly name: string;
  readonly dbid: number;
  readonly guid: string;
  readonly createdAt: Date;
  openMode: PdbOpenMode;
  status: PdbStatus;
  restricted: boolean;
  readonly applicationRoot: boolean;
  readonly applicationPdb: boolean;
  readonly applicationSeed: boolean;
  totalSizeBytes: number;

  constructor(init: {
    conId: number; name: string; dbid?: number;
    openMode?: PdbOpenMode; status?: PdbStatus; restricted?: boolean;
    applicationRoot?: boolean; applicationPdb?: boolean; applicationSeed?: boolean;
    totalSizeBytes?: number; createdAt?: Date;
  }) {
    this.conId = init.conId;
    this.name = init.name.toUpperCase();
    this.dbid = init.dbid ?? (1000000000 + init.conId);
    // Real V$PDBS.GUID is 32 uppercase hex characters. Derive it
    // deterministically from the PDB identity so repeated runs (and the
    // debug transcripts) render a stable, realistic value.
    this.guid = md5Hex(`pdb-guid:${this.name}:${this.dbid}`).toUpperCase();
    this.createdAt = init.createdAt ?? new Date();
    this.openMode = init.openMode ?? 'MOUNTED';
    this.status = init.status ?? 'NORMAL';
    this.restricted = init.restricted ?? false;
    this.applicationRoot = init.applicationRoot ?? false;
    this.applicationPdb = init.applicationPdb ?? false;
    this.applicationSeed = init.applicationSeed ?? false;
    this.totalSizeBytes = init.totalSizeBytes ?? 1_073_741_824;
  }

  open(mode: 'READ ONLY' | 'READ WRITE' = 'READ WRITE', restricted: boolean = false): void {
    this.openMode = mode;
    this.restricted = restricted;
  }

  close(): void { this.openMode = 'MOUNTED'; this.restricted = false; }
}

export class MultitenantManager {
  private readonly pdbs: PluggableDatabase[] = [];
  private nextConId = 2;

  constructor(seedDefaults: boolean = true) {
    if (seedDefaults) this.seed();
  }

  private seed(): void {
    this.pdbs.push(new PluggableDatabase({ conId: 2, name: 'PDB$SEED', openMode: 'READ ONLY', status: 'NORMAL' }));
    this.pdbs.push(new PluggableDatabase({ conId: 3, name: 'ORCLPDB1', openMode: 'READ WRITE', status: 'NORMAL' }));
    this.nextConId = 4;
  }

  createPdb(name: string, fromSeed: boolean = true): PluggableDatabase {
    const pdb = new PluggableDatabase({
      conId: this.nextConId++, name, openMode: 'MOUNTED', status: 'NEW',
      applicationSeed: !fromSeed,
    });
    this.pdbs.push(pdb);
    return pdb;
  }

  dropPdb(name: string): boolean {
    const idx = this.pdbs.findIndex(p => p.name === name.toUpperCase());
    if (idx < 0) return false;
    if (this.pdbs[idx].conId <= 2) return false;
    this.pdbs.splice(idx, 1);
    return true;
  }

  openPdb(name: string, mode: 'READ ONLY' | 'READ WRITE' = 'READ WRITE'): boolean {
    const p = this.findByName(name);
    if (!p) return false;
    p.open(mode);
    return true;
  }

  closePdb(name: string): boolean {
    const p = this.findByName(name);
    if (!p) return false;
    p.close();
    return true;
  }

  findByName(name: string): PluggableDatabase | undefined {
    return this.pdbs.find(p => p.name === name.toUpperCase());
  }

  findByConId(conId: number): PluggableDatabase | undefined {
    return this.pdbs.find(p => p.conId === conId);
  }

  getAll(): readonly PluggableDatabase[] { return this.pdbs; }

  getCdbRoot(): { conId: number; name: string } { return { conId: 1, name: 'CDB$ROOT' }; }
}
