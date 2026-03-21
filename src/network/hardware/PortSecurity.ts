/**
 * PortSecurity — Extracted port security logic (Cisco-style 802.1X)
 *
 * Fixes:
 * - 1.5: SRP violation — Port.ts had 15+ concerns, security is now standalone
 * - 1.5: Side effect — checkPortSecurity() returned boolean but modified state
 *
 * Now `evaluate()` returns a SecurityVerdict object instead of a boolean,
 * making the side effects explicit and testable.
 */

import type { MACAddress } from '../core/types';
import type { PortViolationMode } from '../core/types';
import { Logger } from '../core/Logger';

/**
 * Result of a port security evaluation.
 * Makes side effects explicit instead of hidden behind a boolean.
 */
export interface SecurityVerdict {
  /** Whether the frame should be accepted */
  allowed: boolean;
  /** Whether the port should be shut down (violation mode = 'shutdown') */
  shouldShutdown: boolean;
  /** Whether a violation was detected */
  violation: boolean;
  /** Violation reason (if any) */
  reason?: string;
}

/**
 * Port security manager for a single port.
 *
 * Manages MAC address learning, violation detection, and enforcement.
 * Extracted from Port.ts to follow Single Responsibility Principle.
 *
 * @example
 * ```ts
 * const security = new PortSecurity('GigabitEthernet0/1', 'equip-123');
 * security.enable();
 * security.setMaxMACAddresses(2);
 * security.setViolationMode('restrict');
 *
 * const verdict = security.evaluate(incomingMAC);
 * if (!verdict.allowed) {
 *   // drop frame, increment counters
 * }
 * if (verdict.shouldShutdown) {
 *   port.setUp(false);
 * }
 * ```
 */
export class PortSecurity {
  private enabled: boolean = false;
  private maxMACs: number = 1;
  private learnedMACs: MACAddress[] = [];
  private violationMode: PortViolationMode = 'shutdown';
  private violationCount: number = 0;

  constructor(
    private readonly portName: string,
    private readonly equipmentId: string,
  ) {}

  // ─── Configuration ────────────────────────────────────────────────

  enable(): void {
    this.enabled = true;
    Logger.info(this.equipmentId, 'port:security', `${this.portName}: port security enabled`);
  }

  disable(): void {
    this.enabled = false;
    this.learnedMACs = [];
    this.violationCount = 0;
    Logger.info(this.equipmentId, 'port:security', `${this.portName}: port security disabled`);
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  getMaxMACAddresses(): number { return this.maxMACs; }

  setMaxMACAddresses(max: number): void {
    if (max < 1) throw new Error('Max MAC addresses must be at least 1');
    this.maxMACs = max;
  }

  getLearnedMACs(): MACAddress[] { return [...this.learnedMACs]; }

  addStaticMAC(mac: MACAddress): void {
    if (!this.learnedMACs.some(m => m.equals(mac))) {
      this.learnedMACs.push(mac);
    }
  }

  getViolationMode(): PortViolationMode { return this.violationMode; }

  setViolationMode(mode: PortViolationMode): void {
    this.violationMode = mode;
  }

  getViolationCount(): number { return this.violationCount; }

  // ─── Evaluation ───────────────────────────────────────────────────

  /**
   * Evaluate whether a source MAC address passes port security.
   *
   * Returns a verdict object instead of a boolean, making all
   * side effects (learning, violation counting) explicit.
   */
  evaluate(srcMAC: MACAddress): SecurityVerdict {
    if (!this.enabled) {
      return { allowed: true, shouldShutdown: false, violation: false };
    }

    // Already learned
    if (this.learnedMACs.some(m => m.equals(srcMAC))) {
      return { allowed: true, shouldShutdown: false, violation: false };
    }

    // Room to learn
    if (this.learnedMACs.length < this.maxMACs) {
      this.learnedMACs.push(srcMAC);
      Logger.debug(this.equipmentId, 'port:security-learn',
        `${this.portName}: learned MAC ${srcMAC}`);
      return { allowed: true, shouldShutdown: false, violation: false };
    }

    // Violation
    this.violationCount++;
    Logger.warn(this.equipmentId, 'port:security-violation',
      `${this.portName}: security violation from ${srcMAC} (mode: ${this.violationMode})`);

    switch (this.violationMode) {
      case 'shutdown':
        Logger.warn(this.equipmentId, 'port:security-shutdown',
          `${this.portName}: port shut down due to security violation`);
        return {
          allowed: false,
          shouldShutdown: true,
          violation: true,
          reason: `Security violation: ${srcMAC} exceeds max MACs (${this.maxMACs})`,
        };

      case 'restrict':
        return {
          allowed: false,
          shouldShutdown: false,
          violation: true,
          reason: `Security violation (restrict): ${srcMAC}`,
        };

      case 'protect':
        return {
          allowed: false,
          shouldShutdown: false,
          violation: true,
          reason: `Security violation (protect): ${srcMAC}`,
        };

      default:
        return { allowed: false, shouldShutdown: false, violation: true };
    }
  }
}
