/**
 * SensitiveAccessRecord — concrete `ISensitiveAccessRecord`.
 */

import type { ISensitiveAccessRecord, AccessAction, SensitivityClass } from './interfaces';

export class SensitiveAccessRecord implements ISensitiveAccessRecord {
  readonly accessId: number;
  readonly timestamp: Date;
  readonly sessionId: number;
  readonly username: string;
  readonly action: AccessAction;
  readonly objectSchema: string;
  readonly objectName: string;
  readonly classification: SensitivityClass;
  readonly rowsAffected: number;
  readonly sqlText: string | null;
  readonly offHours: boolean;
  /** Columns the registry has marked sensitive on the target object. */
  readonly sensitiveColumns: string[];

  constructor(init: {
    accessId: number; sessionId: number; username: string;
    action: AccessAction; objectSchema: string; objectName: string;
    classification: SensitivityClass; rowsAffected: number;
    sqlText?: string | null; offHours: boolean;
    sensitiveColumns?: string[]; timestamp?: Date;
  }) {
    this.accessId = init.accessId;
    this.timestamp = init.timestamp ?? new Date();
    this.sessionId = init.sessionId;
    this.username = init.username.toUpperCase();
    this.action = init.action;
    this.objectSchema = init.objectSchema.toUpperCase();
    this.objectName = init.objectName.toUpperCase();
    this.classification = init.classification;
    this.rowsAffected = init.rowsAffected;
    this.sqlText = init.sqlText ?? null;
    this.offHours = init.offHours;
    this.sensitiveColumns = (init.sensitiveColumns ?? []).map(c => c.toUpperCase());
  }
}
