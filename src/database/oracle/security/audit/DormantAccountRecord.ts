/**
 * DormantAccountRecord — snapshot of an account that has not logged on
 * for at least `thresholdDays`. Produced by `DormantAccountAnalyzer`.
 */

import type { IDormantAccountRecord } from './interfaces';

export class DormantAccountRecord implements IDormantAccountRecord {
  readonly username: string;
  readonly accountStatus: string;
  readonly lastLoginAt: Date | null;
  readonly daysSinceLastLogin: number;
  readonly thresholdDays: number;
  readonly profile: string;
  readonly createdAt: Date;
  readonly detectedAt: Date;
  /** Email of the owner, if known — kept for future notifications. */
  readonly contactEmail: string | null;
  /** Last password change — fed by PasswordManager when available. */
  readonly lastPasswordChangeAt: Date | null;

  constructor(init: {
    username: string; accountStatus: string; lastLoginAt: Date | null;
    daysSinceLastLogin: number; thresholdDays: number; profile: string;
    createdAt: Date; contactEmail?: string | null;
    lastPasswordChangeAt?: Date | null; detectedAt?: Date;
  }) {
    this.username = init.username.toUpperCase();
    this.accountStatus = init.accountStatus;
    this.lastLoginAt = init.lastLoginAt;
    this.daysSinceLastLogin = init.daysSinceLastLogin;
    this.thresholdDays = init.thresholdDays;
    this.profile = init.profile.toUpperCase();
    this.createdAt = init.createdAt;
    this.detectedAt = init.detectedAt ?? new Date();
    this.contactEmail = init.contactEmail ?? null;
    this.lastPasswordChangeAt = init.lastPasswordChangeAt ?? null;
  }
}
