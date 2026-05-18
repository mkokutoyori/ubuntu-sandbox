/**
 * AsmManager — real Automatic Storage Management state for the
 * simulated instance.
 *
 * The manager owns three layers, all mutable through explicit operations:
 *   - diskgroups (CREATE DISKGROUP …)
 *   - disks      (ALTER DISKGROUP … ADD / DROP DISK '…')
 *   - files      (created by DBMS_FILE_TRANSFER / RMAN — none yet)
 *
 * Aliases and templates are derived (no per-row insert API).
 *
 * The V\$ASM_* dictionary views read directly from this manager, so
 * "what the catalog reports" always matches "what the engine holds".
 * No fabricated rows.
 */
export type AsmRedundancy = 'EXTERNAL' | 'NORMAL' | 'HIGH';
export type AsmDiskState = 'NORMAL' | 'ADDING' | 'DROPPING' | 'HUNG' | 'FORCING' | 'UNKNOWN';

export interface AsmDisk {
  diskNumber: number;
  name: string;
  path: string;
  sizeMb: number;
  freeMb: number;
  state: AsmDiskState;
  /** Disk header status — MEMBER once joined to a diskgroup. */
  headerStatus: 'MEMBER' | 'CANDIDATE' | 'FORMER' | 'PROVISIONED';
  mountStatus: 'CACHED' | 'CLOSED' | 'MISSING';
  modeStatus: 'ONLINE' | 'OFFLINE';
  failgroup: string;
  createDate: Date;
}

export interface AsmFile {
  fileNumber: number;
  incarnation: number;
  /** Size in bytes (matches V\$ASM_FILE.BYTES). */
  bytes: number;
  type: string;
  redundancy: 'UNPROT' | 'MIRROR' | 'HIGH';
  striped: 'COARSE' | 'FINE';
  createDate: Date;
}

export interface AsmDiskgroup {
  groupNumber: number;
  name: string;
  redundancy: AsmRedundancy;
  state: 'MOUNTED' | 'DISMOUNTED' | 'BROKEN';
  sectorSize: number;
  blockSize: number;
  allocationUnitSize: number;
  /** disks keyed by diskNumber. */
  disks: Map<number, AsmDisk>;
  /** files keyed by fileNumber. */
  files: Map<number, AsmFile>;
  createDate: Date;
}

/** Templates that real Oracle pre-populates per diskgroup. */
export const DEFAULT_ASM_TEMPLATES: ReadonlyArray<{
  name: string; redundancy: 'UNPROT' | 'MIRROR' | 'HIGH'; stripe: 'COARSE' | 'FINE';
}> = [
  { name: 'CONTROLFILE',     redundancy: 'HIGH',   stripe: 'FINE' },
  { name: 'DATAFILE',        redundancy: 'MIRROR', stripe: 'COARSE' },
  { name: 'ONLINELOG',       redundancy: 'MIRROR', stripe: 'COARSE' },
  { name: 'ARCHIVELOG',      redundancy: 'MIRROR', stripe: 'COARSE' },
  { name: 'TEMPFILE',        redundancy: 'MIRROR', stripe: 'COARSE' },
  { name: 'BACKUPSET',       redundancy: 'MIRROR', stripe: 'COARSE' },
  { name: 'PARAMETERFILE',   redundancy: 'MIRROR', stripe: 'COARSE' },
  { name: 'DATAGUARDCONFIG', redundancy: 'MIRROR', stripe: 'COARSE' },
];

export class AsmManager {
  private diskgroups: Map<number, AsmDiskgroup> = new Map();
  private nextGroupNumber = 1;
  /** Per-diskgroup running disk counter. */
  private nextDiskNumber: Map<number, number> = new Map();
  /** Per-diskgroup running file counter. */
  private nextFileNumber: Map<number, number> = new Map();
  /** Clients connected to this ASM instance (DB instance_name → DB name). */
  private clients: Map<string, { dbName: string; status: string; softwareVersion: string; compatibleVersion: string }> = new Map();

  /**
   * Create a new diskgroup.
   * @returns the freshly created diskgroup.
   */
  createDiskgroup(
    name: string,
    options: Partial<Pick<AsmDiskgroup, 'redundancy' | 'sectorSize' | 'blockSize' | 'allocationUnitSize'>> = {},
  ): AsmDiskgroup {
    const upper = name.toUpperCase();
    for (const g of this.diskgroups.values()) {
      if (g.name === upper) throw new Error(`ORA-15030: diskgroup '${upper}' already exists`);
    }
    const groupNumber = this.nextGroupNumber++;
    const dg: AsmDiskgroup = {
      groupNumber, name: upper,
      redundancy: options.redundancy ?? 'EXTERNAL',
      state: 'MOUNTED',
      sectorSize: options.sectorSize ?? 512,
      blockSize: options.blockSize ?? 4096,
      allocationUnitSize: options.allocationUnitSize ?? 1048576,
      disks: new Map(), files: new Map(),
      createDate: new Date(),
    };
    this.diskgroups.set(groupNumber, dg);
    this.nextDiskNumber.set(groupNumber, 0);
    this.nextFileNumber.set(groupNumber, 256); // ASM files start at #256 like real Oracle
    return dg;
  }

  dropDiskgroup(name: string, includingContents: boolean): { groupNumber: number; diskPaths: string[] } {
    const dg = this.findByName(name);
    if (!dg) throw new Error(`ORA-15001: diskgroup "${name.toUpperCase()}" does not exist`);
    if (!includingContents && (dg.disks.size > 0 || dg.files.size > 0)) {
      throw new Error(`ORA-15039: diskgroup "${dg.name}" is not empty`);
    }
    const paths = Array.from(dg.disks.values()).map(d => d.path);
    this.diskgroups.delete(dg.groupNumber);
    return { groupNumber: dg.groupNumber, diskPaths: paths };
  }

  /** Add a disk to an existing diskgroup. */
  addDisk(
    diskgroupName: string,
    path: string,
    options: { name?: string; sizeMb?: number; failgroup?: string } = {},
  ): { diskgroup: AsmDiskgroup; disk: AsmDisk } {
    const dg = this.findByName(diskgroupName);
    if (!dg) throw new Error(`ORA-15001: diskgroup "${diskgroupName.toUpperCase()}" does not exist`);
    for (const d of dg.disks.values()) {
      if (d.path === path) throw new Error(`ORA-15029: disk '${path}' is already attached to diskgroup "${dg.name}"`);
    }
    const diskNumber = this.nextDiskNumber.get(dg.groupNumber) ?? 0;
    this.nextDiskNumber.set(dg.groupNumber, diskNumber + 1);
    const sizeMb = options.sizeMb ?? 0;
    const disk: AsmDisk = {
      diskNumber,
      name: (options.name ?? `${dg.name}_${String(diskNumber).padStart(4, '0')}`).toUpperCase(),
      path,
      sizeMb,
      freeMb: sizeMb,
      state: 'NORMAL',
      headerStatus: 'MEMBER',
      mountStatus: 'CACHED',
      modeStatus: 'ONLINE',
      failgroup: (options.failgroup ?? disk_failgroupDefault(dg.name, diskNumber)).toUpperCase(),
      createDate: new Date(),
    };
    dg.disks.set(diskNumber, disk);
    return { diskgroup: dg, disk };
  }

  /** Remove a disk by path or by ASM name. */
  dropDisk(diskgroupName: string, identifier: string): { diskgroup: AsmDiskgroup; disk: AsmDisk } {
    const dg = this.findByName(diskgroupName);
    if (!dg) throw new Error(`ORA-15001: diskgroup "${diskgroupName.toUpperCase()}" does not exist`);
    const upper = identifier.toUpperCase();
    let found: AsmDisk | undefined;
    for (const d of dg.disks.values()) {
      if (d.path === identifier || d.name === upper) { found = d; break; }
    }
    if (!found) throw new Error(`ORA-15054: disk '${identifier}' does not exist in diskgroup "${dg.name}"`);
    dg.disks.delete(found.diskNumber);
    return { diskgroup: dg, disk: found };
  }

  /** Register a DB instance that connects to this ASM. */
  attachClient(
    instanceName: string,
    dbName: string,
    softwareVersion: string,
    compatibleVersion: string,
  ): void {
    this.clients.set(instanceName, {
      dbName, softwareVersion, compatibleVersion, status: 'CONNECTED',
    });
  }

  detachClient(instanceName: string): void {
    this.clients.delete(instanceName);
  }

  // ── Read-only accessors ────────────────────────────────────────────

  getAllDiskgroups(): readonly AsmDiskgroup[] { return Array.from(this.diskgroups.values()); }
  getAllDisks(): { groupNumber: number; disk: AsmDisk }[] {
    const out: { groupNumber: number; disk: AsmDisk }[] = [];
    for (const dg of this.diskgroups.values()) for (const d of dg.disks.values()) out.push({ groupNumber: dg.groupNumber, disk: d });
    return out;
  }
  getAllFiles(): { groupNumber: number; file: AsmFile }[] {
    const out: { groupNumber: number; file: AsmFile }[] = [];
    for (const dg of this.diskgroups.values()) for (const f of dg.files.values()) out.push({ groupNumber: dg.groupNumber, file: f });
    return out;
  }
  getClients(): ReadonlyMap<string, { dbName: string; status: string; softwareVersion: string; compatibleVersion: string }> {
    return this.clients;
  }
  findByName(name: string): AsmDiskgroup | undefined {
    const upper = name.toUpperCase();
    for (const g of this.diskgroups.values()) if (g.name === upper) return g;
    return undefined;
  }

  /** Aggregate disk capacity for V\$ASM_DISKGROUP.TOTAL_MB. */
  totalMb(diskgroup: AsmDiskgroup): number {
    let total = 0;
    for (const d of diskgroup.disks.values()) total += d.sizeMb;
    return total;
  }
  freeMb(diskgroup: AsmDiskgroup): number {
    let free = 0;
    for (const d of diskgroup.disks.values()) free += d.freeMb;
    return free;
  }
}

function disk_failgroupDefault(dgName: string, diskNumber: number): string {
  return `${dgName}_${String(diskNumber).padStart(4, '0')}`;
}
