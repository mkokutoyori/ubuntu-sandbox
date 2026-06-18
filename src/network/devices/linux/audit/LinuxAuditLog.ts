/**
 * LinuxAuditLog — the kernel audit subsystem's record store and `audit.log`
 * projection (the "piste d'audit" of a real Debian/Ubuntu host).
 *
 * `auditd` records security-relevant events — account changes, logins,
 * authentication, privilege use, service lifecycle — as structured
 * `type=… msg=audit(ts:serial): k=v …` lines under `/var/log/audit/`.
 * `LinuxAuditRecord` is the value object for one such line;
 * `LinuxAuditLog` is the append-only store that also materialises the file.
 *
 * The store is the single source of truth: `audit.log` is re-rendered from
 * it on every append, and `ausearch` / `aureport` query it — so the file
 * and the model never drift.
 */

import type { VirtualFileSystem } from '../VirtualFileSystem';

/** Canonical audit-subsystem filesystem locations. */
export const AUDIT_PATHS = {
  dir: '/var/log/audit',
  log: '/var/log/audit/audit.log',
  rules: '/etc/audit/audit.rules',
  config: '/etc/audit/auditd.conf',
} as const;

/** A single auditd record — one `type=… msg=audit(...)` line. */
export class LinuxAuditRecord {
  readonly type: string;
  readonly timestampMs: number;
  readonly serial: number;
  readonly fields: Readonly<Record<string, string | number>>;

  constructor(
    type: string,
    serial: number,
    fields: Record<string, string | number> = {},
    timestampMs: number = Date.now(),
  ) {
    this.type = type;
    this.serial = serial;
    this.fields = { ...fields };
    this.timestampMs = timestampMs;
  }

  /** Read one field, or `undefined` when absent. */
  get(key: string): string | number | undefined {
    return this.fields[key];
  }

  /** True when the record carries `res=success`. */
  get succeeded(): boolean {
    return String(this.fields.res ?? '') === 'success';
  }

  /** Render the canonical `audit.log` line. */
  render(): string {
    const epoch = (this.timestampMs / 1000).toFixed(3);
    const body = Object.entries(this.fields)
      .map(([k, v]) => `${k}=${formatValue(v)}`)
      .join(' ');
    return `type=${this.type} msg=audit(${epoch}:${this.serial}): ${body}`.trimEnd();
  }
}

/** Filter passed to {@link LinuxAuditLog.query}. */
export interface AuditQuery {
  /** Restrict to one record type (`ausearch -m`). */
  type?: string;
  /** Restrict to records carrying `key=value` (`ausearch -ui`, `-k`, …). */
  key?: string;
  value?: string | number;
  /** Restrict to successes / failures (`ausearch --success`). */
  success?: boolean;
}

export class LinuxAuditLog {
  private readonly records: LinuxAuditRecord[] = [];
  private serialCounter = 0;

  constructor(private readonly vfs: VirtualFileSystem) {
    this.vfs.mkdirp(AUDIT_PATHS.dir, 0o750, 0, 0);
    // Materialise an empty audit.log so its root-only perms apply even before
    // the first record (unprivileged reads are denied).
    this.materialize();
  }

  /**
   * Append a new audit record, re-materialise `audit.log`, and return it.
   * The serial number is allocated monotonically, as the kernel does.
   */
  record(type: string, fields: Record<string, string | number> = {}): LinuxAuditRecord {
    const entry = new LinuxAuditRecord(type, ++this.serialCounter, fields);
    this.records.push(entry);
    this.materialize();
    return entry;
  }

  /** Every record, in chronological order. */
  all(): readonly LinuxAuditRecord[] {
    return this.records;
  }

  /** Records matching every supplied filter clause. */
  query(filter: AuditQuery = {}): LinuxAuditRecord[] {
    return this.records.filter((r) => {
      if (filter.type && r.type !== filter.type) return false;
      if (filter.key !== undefined) {
        const v = r.get(filter.key);
        if (v === undefined) return false;
        if (filter.value !== undefined && String(v) !== String(filter.value)) return false;
      }
      if (filter.success !== undefined && r.succeeded !== filter.success) return false;
      return true;
    });
  }

  /** Count of records grouped by type — backs `aureport`. */
  countByType(): Map<string, number> {
    const counts = new Map<string, number>();
    for (const r of this.records) {
      counts.set(r.type, (counts.get(r.type) ?? 0) + 1);
    }
    return counts;
  }

  /** The full rendered `audit.log` content. */
  renderAuditLog(): string {
    return this.records.map((r) => r.render()).join('\n') + (this.records.length ? '\n' : '');
  }

  private materialize(): void {
    this.vfs.writeFile(AUDIT_PATHS.log, this.renderAuditLog(), 0, 0, 0o037);
  }
}

/** Quote an audit field value when it contains whitespace. */
function formatValue(value: string | number): string {
  const text = String(value);
  return /\s/.test(text) ? `"${text}"` : text;
}
