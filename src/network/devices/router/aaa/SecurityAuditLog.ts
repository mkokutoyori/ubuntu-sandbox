import type { IEventBus, Unsubscribe } from '@/events/EventBus';
import type { NetworkOsAccountEventEnvelope } from './NetworkOsAccount';

export type AuditFacility =
  | 'SEC_LOGIN' | 'SYS' | 'SSH' | 'PARSER' | 'AAA' | 'SECURITY';

export interface AuditLogEntry {
  readonly at: number;
  readonly facility: AuditFacility;
  readonly severity: number;
  readonly mnemonic: string;
  readonly message: string;
}

export interface SecurityAuditLogOptions {
  deviceId: string;
  bus: IEventBus;
  capacity?: number;
  now?: () => number;
}

export class SecurityAuditLog {
  private readonly deviceId: string;
  private readonly bus: IEventBus;
  private readonly buffer: AuditLogEntry[] = [];
  private readonly capacity: number;
  private readonly subs: Unsubscribe[] = [];
  private readonly now: () => number;

  constructor(opts: SecurityAuditLogOptions) {
    this.deviceId = opts.deviceId;
    this.bus = opts.bus;
    this.capacity = opts.capacity ?? 1000;
    this.now = opts.now ?? Date.now;
    this.attach();
  }

  private attach(): void {
    const wrap = <E extends NetworkOsAccountEventEnvelope>(handler: (e: E) => void) =>
      (e: { topic: string; payload: unknown }) => {
        const env = e as unknown as E;
        if ((env.payload as { deviceId?: string }).deviceId !== this.deviceId) return;
        handler(env);
      };

    this.subs.push(this.bus.subscribe('router.aaa.account.created', wrap((e) => {
      this.record('SEC_LOGIN', 6, 'CONFIG_CHANGE',
        `Account ${e.payload.account.name} created with privilege ${e.payload.account.privilege}`);
    })));
    this.subs.push(this.bus.subscribe('router.aaa.account.updated', wrap((e) => {
      this.record('SEC_LOGIN', 6, 'CONFIG_CHANGE',
        `Account ${e.payload.account.name} updated (privilege ${e.payload.account.privilege})`);
    })));
    this.subs.push(this.bus.subscribe('router.aaa.account.deleted', wrap((e) => {
      this.record('SEC_LOGIN', 5, 'ACCOUNT_DELETED',
        `Account ${e.payload.account.name} removed`);
    })));
    this.subs.push(this.bus.subscribe('router.aaa.account.login.success', wrap((e) => {
      this.record('SEC_LOGIN', 5, 'LOGIN_SUCCESS',
        `Login Success [user: ${e.payload.account.name}] [Source: ${e.payload.from ?? 'unknown'}] [localport: 22] [Reason: Login Authentication]`);
    })));
    this.subs.push(this.bus.subscribe('router.aaa.account.login.failure', wrap((e) => {
      this.record('SEC_LOGIN', 4, 'LOGIN_FAILED',
        `Login failed [user: ${e.payload.account.name}] [Source: ${e.payload.from ?? 'unknown'}] [localport: 22] [Reason: ${e.payload.reason ?? 'unknown'}]`);
    })));
    this.subs.push(this.bus.subscribe('router.aaa.account.locked', wrap((e) => {
      this.record('SEC_LOGIN', 4, 'ACCOUNT_LOCKED',
        `Account ${e.payload.account.name} locked: ${e.payload.reason ?? 'unspecified'}`);
    })));
    this.subs.push(this.bus.subscribe('router.aaa.account.unlocked', wrap((e) => {
      this.record('SEC_LOGIN', 5, 'ACCOUNT_UNLOCKED',
        `Account ${e.payload.account.name} unlocked`);
    })));
  }

  detach(): void {
    for (const s of this.subs) s();
    this.subs.length = 0;
  }

  record(facility: AuditFacility, severity: number, mnemonic: string, message: string, at?: number): void {
    this.buffer.push({ facility, severity, mnemonic, message, at: at ?? this.now() });
    while (this.buffer.length > this.capacity) this.buffer.shift();
  }

  entries(): readonly AuditLogEntry[] { return [...this.buffer]; }

  format(): string {
    return this.buffer
      .map(e => `*${new Date(e.at).toISOString().replace('T', ' ').slice(0, 19)}: %${e.facility}-${e.severity}-${e.mnemonic}: ${e.message}`)
      .join('\n');
  }

  clear(): void { this.buffer.length = 0; }
}
