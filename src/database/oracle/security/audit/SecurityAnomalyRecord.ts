/**
 * SecurityAnomalyRecord — concrete `ISecurityAnomalyRecord`.
 */

import type { ISecurityAnomalyRecord, Severity } from './interfaces';
import type { SecurityAnomalyKind } from '../../events';

export class SecurityAnomalyRecord implements ISecurityAnomalyRecord {
  readonly anomalyId: number;
  readonly timestamp: Date;
  readonly kind: SecurityAnomalyKind;
  readonly severity: Severity;
  readonly username: string;
  readonly sessionId: number;
  readonly description: string;
  readonly evidence: Record<string, string | number | boolean>;
  /** Free-form acknowledgment by an operator. */
  acknowledged: boolean = false;
  acknowledgedBy: string | null = null;
  acknowledgedAt: Date | null = null;

  constructor(init: {
    anomalyId: number; kind: SecurityAnomalyKind; severity: Severity;
    username: string; sessionId: number; description: string;
    evidence?: Record<string, string | number | boolean>; timestamp?: Date;
  }) {
    this.anomalyId = init.anomalyId;
    this.timestamp = init.timestamp ?? new Date();
    this.kind = init.kind;
    this.severity = init.severity;
    this.username = init.username.toUpperCase();
    this.sessionId = init.sessionId;
    this.description = init.description;
    this.evidence = init.evidence ?? {};
  }

  acknowledge(by: string): void {
    this.acknowledged = true;
    this.acknowledgedBy = by.toUpperCase();
    this.acknowledgedAt = new Date();
  }
}
