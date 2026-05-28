/**
 * SystemTrigger — concrete representation of a database-level event
 * trigger (`CREATE TRIGGER name AFTER LOGON ON DATABASE` and the
 * other 9 system events Oracle supports).
 *
 * Oracle's full taxonomy (from the SQL Reference, "CREATE TRIGGER"):
 *   AFTER  STARTUP   ON DATABASE
 *   BEFORE SHUTDOWN  ON DATABASE
 *   AFTER  LOGON     ON {DATABASE | SCHEMA}
 *   BEFORE LOGOFF    ON {DATABASE | SCHEMA}
 *   AFTER  SERVERERROR ON DATABASE
 *   AFTER  CREATE / ALTER / DROP ON {DATABASE | SCHEMA}
 *
 * We model each with `timing`, `event`, `scope`, an optional owner
 * schema (when scope=SCHEMA), the verbatim PL/SQL body, and an
 * `enabled` flag flipped by ALTER TRIGGER … {ENABLE|DISABLE}.
 */

export type TriggerTiming = 'BEFORE' | 'AFTER';
export type TriggerEvent =
  | 'STARTUP' | 'SHUTDOWN'
  | 'LOGON'   | 'LOGOFF'
  | 'SERVERERROR'
  | 'CREATE'  | 'ALTER' | 'DROP';
export type TriggerScope = 'DATABASE' | 'SCHEMA';

export class SystemTrigger {
  readonly owner: string;
  readonly name: string;
  readonly timing: TriggerTiming;
  readonly event: TriggerEvent;
  readonly scope: TriggerScope;
  readonly scopeSchema: string | null;
  body: string;
  enabled: boolean;
  readonly created: Date;
  /** Updated at every successful firing — used by DBA_TRIGGERS / V$TRIGGERS. */
  lastFiredAt: Date | null = null;
  /** Cumulative firing count. */
  fireCount: number = 0;

  constructor(init: {
    owner: string; name: string;
    timing: TriggerTiming; event: TriggerEvent;
    scope: TriggerScope; scopeSchema?: string | null;
    body: string; enabled?: boolean; created?: Date;
  }) {
    this.owner = init.owner.toUpperCase();
    this.name = init.name.toUpperCase();
    this.timing = init.timing;
    this.event = init.event;
    this.scope = init.scope;
    this.scopeSchema = init.scopeSchema ? init.scopeSchema.toUpperCase() : null;
    this.body = init.body;
    this.enabled = init.enabled ?? true;
    this.created = init.created ?? new Date();
  }

  /** Does this trigger apply for the given event + (schema, ifScope)? */
  matches(event: TriggerEvent, username?: string): boolean {
    if (!this.enabled) return false;
    if (this.event !== event) return false;
    if (this.scope === 'SCHEMA') {
      return !!username && this.scopeSchema === username.toUpperCase();
    }
    return true; // DATABASE-scoped fires for every user
  }

  /** Stamp a successful firing. */
  recordFiring(at: Date = new Date()): void {
    this.lastFiredAt = at;
    this.fireCount++;
  }
}
