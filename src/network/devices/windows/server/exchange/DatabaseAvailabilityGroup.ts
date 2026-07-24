export type CopyStatus = 'Mounted' | 'Healthy' | 'FailedAndSuspended' | 'Resynchronizing';

export interface MailboxDatabaseCopy {
  readonly database: string;
  readonly server: string;
  readonly status: CopyStatus;
  readonly copyQueueLength: number;
  readonly lastSyncedAt: number;
}

export interface DagOpResult { ok: boolean; message: string }

interface CopyRecord {
  readonly database: string;
  readonly server: string;
  syncedGeneration: number;
  lastSyncedAt: number;
}

export class DatabaseAvailabilityGroup {
  readonly members = new Set<string>();
  private generation = 0;
  private readonly copies = new Map<string, CopyRecord>();

  constructor(readonly name: string) {}

  addServer(hostname: string): DagOpResult {
    if (this.members.has(hostname)) {
      return { ok: false, message: `Add-DatabaseAvailabilityGroupServer : '${hostname}' is already a member of the DAG '${this.name}'.` };
    }
    this.members.add(hostname);
    return { ok: true, message: '' };
  }

  addDatabaseCopy(database: string, server: string, now: number): DagOpResult {
    if (!this.members.has(server)) {
      return { ok: false, message: `Add-MailboxDatabaseCopy : '${server}' is not a member of the DAG '${this.name}'.` };
    }
    const key = copyKey(database, server);
    if (this.copies.has(key)) {
      return { ok: false, message: `Add-MailboxDatabaseCopy : A copy of database '${database}' already exists on server '${server}'.` };
    }
    this.copies.set(key, { database, server, syncedGeneration: this.generation, lastSyncedAt: now });
    return { ok: true, message: '' };
  }

  /** Called once per accepted delivery against this org's mailboxes — advances every copy's replication lag (§ PRD-Exchange.md §2.1 P11, explicitly-triggered sync, no continuous log shipping). */
  recordChange(): void {
    this.generation += 1;
  }

  updateCopy(database: string, server: string, now: number): DagOpResult {
    const copy = this.copies.get(copyKey(database, server));
    if (!copy) return { ok: false, message: `Update-MailboxDatabaseCopy : No copy of database '${database}' found on server '${server}'.` };
    copy.syncedGeneration = this.generation;
    copy.lastSyncedAt = now;
    return { ok: true, message: '' };
  }

  getCopyStatus(database: string, server: string): MailboxDatabaseCopy | null {
    const copy = this.copies.get(copyKey(database, server));
    return copy ? this.toPublic(copy) : null;
  }

  listCopyStatuses(database?: string): MailboxDatabaseCopy[] {
    return [...this.copies.values()]
      .filter((c) => !database || c.database.toLowerCase() === database.toLowerCase())
      .map((c) => this.toPublic(c));
  }

  private toPublic(copy: CopyRecord): MailboxDatabaseCopy {
    const copyQueueLength = this.generation - copy.syncedGeneration;
    return {
      database: copy.database, server: copy.server, lastSyncedAt: copy.lastSyncedAt, copyQueueLength,
      status: copyQueueLength > 0 ? 'Resynchronizing' : 'Healthy',
    };
  }
}

function copyKey(database: string, server: string): string {
  return `${database.toLowerCase()}:${server.toLowerCase()}`;
}
