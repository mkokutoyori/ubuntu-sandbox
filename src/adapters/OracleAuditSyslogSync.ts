/**
 * OracleAuditSyslogSync — routes Oracle audit records to the host syslog
 * when AUDIT_SYSLOG_LEVEL is set, exactly like a real database.
 *
 * Real Oracle keeps audit records in the database trail or the
 * `audit_file_dest` (.aud files) by default. When the static parameter
 * `AUDIT_SYSLOG_LEVEL = facility.priority` is configured, OS audit
 * records are *also* sent to the operating-system syslog at that
 * facility/priority — the canonical way to forward an audit trail to a
 * central rsyslog/SIEM. The adump `.aud` files are produced by
 * OracleFilesystemSync; this adapter adds the conditional syslog leg.
 *
 * Faithful default: when the parameter is unset (the out-of-the-box
 * state), nothing is written to syslog. Mirrors OracleSystemdSync /
 * OracleFilesystemSync — device-agnostic through a thin capability.
 */

import type { IEventBus, Unsubscribe } from '@/events/EventBus';
import type { Equipment } from '@/network/equipment/Equipment';
import type { OracleDatabase } from '@/database/oracle/OracleDatabase';
import type { OracleAuditRecordedPayload } from '@/database/oracle/events';

/** Minimal capability surface this adapter needs from the device. */
export interface SyslogHost {
  /**
   * Append a syslog record at the given `facility.priority` spec (e.g.
   * `local0.info`). Returns false when the spec is malformed.
   */
  logSyslog(facilityPrioritySpec: string, tag: string, message: string): boolean;
}

export interface OracleAuditSyslogSyncCtx {
  resolveDevice(deviceId: string): Equipment | null;
  resolveDatabase(deviceId: string): OracleDatabase | null;
}

export class OracleAuditSyslogSync {
  private subs: Unsubscribe[] = [];

  constructor(
    private readonly bus: IEventBus,
    private readonly ctx: OracleAuditSyslogSyncCtx,
  ) {}

  start(): void {
    if (this.subs.length > 0) return;
    this.subs.push(
      this.bus.subscribe('oracle.audit.recorded', (e) => this.onAudit(e.payload)),
    );
  }

  stop(): void {
    for (const u of this.subs) u();
    this.subs.length = 0;
  }

  private onAudit(p: OracleAuditRecordedPayload): void {
    const db = this.ctx.resolveDatabase(p.deviceId);
    // AUDIT_SYSLOG_LEVEL unset → audit stays in the trail/adump only.
    const level = db?.instance.getParameter('audit_syslog_level');
    if (!level) return;
    const host = this.host(p.deviceId);
    if (!host) return;
    host.logSyslog(level, 'Oracle Audit', formatAuditLine(p));
  }

  private host(deviceId: string): SyslogHost | null {
    const dev = this.ctx.resolveDevice(deviceId) as unknown as Partial<SyslogHost> | null;
    return dev && typeof dev.logSyslog === 'function' ? (dev as SyslogHost) : null;
  }
}

/**
 * Render an audit record as a structured Oracle-audit syslog line. The
 * `FIELD:[len] "value"` shape mirrors the real "Oracle Audit" syslog
 * format closely enough to be recognisable and greppable.
 */
function formatAuditLine(p: OracleAuditRecordedPayload): string {
  const f = (name: string, value: string): string => `${name}:[${value.length}] "${value}"`;
  const parts = [
    f('SESSIONID', String(p.sessionId)),
    f('DBUSERID', p.username),
    f('ACTION', p.actionName),
    f('RETURNCODE', String(p.returncode)),
    f('OS$USERID', p.osUsername),
    f('USERHOST', p.userhost),
    f('TERMINAL', p.terminal),
  ];
  if (p.objName) {
    const obj = p.objOwner ? `${p.objOwner}.${p.objName}` : p.objName;
    parts.push(f('OBJ$NAME', obj));
  }
  return parts.join(' ');
}
