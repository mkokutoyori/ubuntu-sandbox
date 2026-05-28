export class FlashbackArchiveTablespace {
  readonly archiveName: string;
  readonly tablespaceName: string;
  readonly quotaInMb: number | null;

  constructor(archiveName: string, tablespaceName: string, quotaInMb: number | null = null) {
    this.archiveName = archiveName.toUpperCase();
    this.tablespaceName = tablespaceName.toUpperCase();
    this.quotaInMb = quotaInMb;
  }
}

export class FlashbackArchive {
  readonly flashbackArchiveName: string;
  readonly owner: string;
  readonly retentionInDays: number;
  readonly createTime: Date;
  lastPurgeTime: Date | null;
  status: 'ACTIVE' | 'INACTIVE' | 'SCHEDULED FOR PURGE';
  isDefault: boolean;
  readonly tablespaces: FlashbackArchiveTablespace[];

  constructor(init: {
    flashbackArchiveName: string; owner?: string;
    retentionInDays: number; tablespaces: FlashbackArchiveTablespace[];
    isDefault?: boolean;
  }) {
    this.flashbackArchiveName = init.flashbackArchiveName.toUpperCase();
    this.owner = (init.owner ?? 'SYS').toUpperCase();
    this.retentionInDays = init.retentionInDays;
    this.createTime = new Date();
    this.lastPurgeTime = null;
    this.status = 'ACTIVE';
    this.isDefault = init.isDefault ?? false;
    this.tablespaces = init.tablespaces;
  }
}

export class FlashbackArchiveTable {
  readonly tableName: string;
  readonly ownerName: string;
  readonly flashbackArchiveName: string;
  readonly archiveTableName: string;
  status: 'ENABLED' | 'DISABLED';

  constructor(init: {
    ownerName: string; tableName: string;
    flashbackArchiveName: string;
  }) {
    this.ownerName = init.ownerName.toUpperCase();
    this.tableName = init.tableName.toUpperCase();
    this.flashbackArchiveName = init.flashbackArchiveName.toUpperCase();
    this.archiveTableName = `SYS_FBA_HIST_${this.ownerName}_${this.tableName}`.slice(0, 30);
    this.status = 'ENABLED';
  }
}

export class FlashbackArchiveManager {
  private archives = new Map<string, FlashbackArchive>();
  private tables: FlashbackArchiveTable[] = [];

  createArchive(a: FlashbackArchive): void {
    this.archives.set(a.flashbackArchiveName, a);
    if (a.isDefault) {
      for (const other of this.archives.values()) {
        if (other.flashbackArchiveName !== a.flashbackArchiveName) other.isDefault = false;
      }
    }
  }

  dropArchive(name: string): boolean {
    const upper = name.toUpperCase();
    const ok = this.archives.delete(upper);
    if (ok) this.tables = this.tables.filter(t => t.flashbackArchiveName !== upper);
    return ok;
  }

  setDefault(name: string): boolean {
    const a = this.archives.get(name.toUpperCase());
    if (!a) return false;
    for (const other of this.archives.values()) other.isDefault = false;
    a.isDefault = true;
    return true;
  }

  setRetention(name: string, days: number): boolean {
    const a = this.archives.get(name.toUpperCase());
    if (!a) return false;
    (a as { retentionInDays: number }).retentionInDays = days;
    return true;
  }

  enableTable(owner: string, tableName: string, archiveName?: string): FlashbackArchiveTable | null {
    const arch = archiveName
      ? this.archives.get(archiveName.toUpperCase())
      : [...this.archives.values()].find(a => a.isDefault) ?? [...this.archives.values()][0];
    if (!arch) return null;
    const t = new FlashbackArchiveTable({
      ownerName: owner, tableName, flashbackArchiveName: arch.flashbackArchiveName,
    });
    this.tables = this.tables.filter(x => !(x.ownerName === t.ownerName && x.tableName === t.tableName));
    this.tables.push(t);
    return t;
  }

  disableTable(owner: string, tableName: string): boolean {
    const o = owner.toUpperCase(), t = tableName.toUpperCase();
    const idx = this.tables.findIndex(x => x.ownerName === o && x.tableName === t);
    if (idx < 0) return false;
    this.tables.splice(idx, 1);
    return true;
  }

  getArchives(): readonly FlashbackArchive[] { return [...this.archives.values()]; }
  getTables(): readonly FlashbackArchiveTable[] { return this.tables; }
  getTablespaces(): Array<{ archive: string; ts: string; quota: number | null }> {
    const out: Array<{ archive: string; ts: string; quota: number | null }> = [];
    for (const a of this.archives.values()) {
      for (const ts of a.tablespaces) out.push({ archive: a.flashbackArchiveName, ts: ts.tablespaceName, quota: ts.quotaInMb });
    }
    return out;
  }
}
