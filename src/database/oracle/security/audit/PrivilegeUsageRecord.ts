/**
 * PrivilegeUsageRecord — concrete `IPrivilegeUsageRecord`.
 *
 * Tracks how a granted privilege is actually exercised so DBAs can
 * identify over-privileged accounts (`DBA_PRIV_USAGE` in Oracle 18c+).
 */

import type { IPrivilegeUsageRecord } from './interfaces';

export class PrivilegeUsageRecord implements IPrivilegeUsageRecord {
  readonly username: string;
  readonly privilege: string;
  readonly action: string;
  readonly objectSchema: string | null;
  readonly objectName: string | null;
  lastUsedAt: Date;
  useCount: number;
  /** First time we saw this combination — useful for "privilege of last resort" reporting. */
  readonly firstUsedAt: Date;

  constructor(init: {
    username: string; privilege: string; action: string;
    objectSchema?: string | null; objectName?: string | null;
    timestamp?: Date;
  }) {
    this.username = init.username.toUpperCase();
    this.privilege = init.privilege.toUpperCase();
    this.action = init.action.toUpperCase();
    this.objectSchema = init.objectSchema ? init.objectSchema.toUpperCase() : null;
    this.objectName = init.objectName ? init.objectName.toUpperCase() : null;
    this.firstUsedAt = init.timestamp ?? new Date();
    this.lastUsedAt = this.firstUsedAt;
    this.useCount = 1;
  }

  touch(at: Date = new Date()): void {
    this.lastUsedAt = at;
    this.useCount++;
  }

  /** Stable key for de-duplication. */
  key(): string {
    return `${this.username}|${this.privilege}|${this.action}|${this.objectSchema ?? ''}|${this.objectName ?? ''}`;
  }
}
