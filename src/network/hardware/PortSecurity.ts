/**
 * PortSecurity — Cisco-style port security with sticky / aging / static
 * bindings.
 *
 * Realistic features mirrored from a Catalyst 2960 / 3650:
 *
 *   - Three entry types: `static` (manually configured, never ages),
 *     `sticky` (dynamically learned but written into running-config
 *     when `mac-address sticky` is enabled — so they survive reload via
 *     `write mem`), and `dynamic` (in-RAM only).
 *   - Per-port `maximum` (defaults to 1, max 8192 on real IOS).
 *   - Three violation modes: `shutdown` (err-disable the port — frame is
 *     dropped AND port goes down), `restrict` (drop + notify), `protect`
 *     (silent drop, no counter / notification on real IOS but we still
 *     count for observability).
 *   - Aging types: `absolute` (entry expires N minutes after learning)
 *     and `inactivity` (entry expires N minutes after the last frame).
 *   - `agingStatic` (default off): aging applies only to dynamic /
 *     sticky entries unless this toggle is on (matches `aging static`).
 *   - Sticky-saved entries can be pulled back to dynamic via
 *     `clear port-security sticky`.
 *
 * The evaluation logic returns an explicit `SecurityVerdict` so the
 * caller can decide whether to drop the frame, shut the port down or
 * just count the violation — matching the side-effect-free contract
 * that the Port layer relies on.
 */
import { MACAddress, type PortViolationMode } from '../core/types';
import { Logger } from '../core/Logger';

export type LearnedMacType = 'static' | 'sticky' | 'dynamic';
export type AgingType = 'absolute' | 'inactivity';

export interface SecureMacEntry {
  mac: MACAddress;
  vlan: number;
  type: LearnedMacType;
  learnedAtMs: number;
  lastSeenMs: number;
}

export interface SecurityVerdict {
  allowed: boolean;
  shouldShutdown: boolean;
  violation: boolean;
  reason?: string;
  /** Populated when this evaluation caused a new entry to be installed. */
  learned?: { mac: MACAddress; vlan: number; type: LearnedMacType };
}

export class PortSecurity {
  private enabled = false;
  private maxMACs = 1;
  private violationMode: PortViolationMode = 'shutdown';
  private violationCount = 0;
  private stickyEnabled = false;

  private agingTimeMin = 0;
  private agingType: AgingType = 'absolute';
  private agingStatic = false;

  private entries: SecureMacEntry[] = [];

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
    this.entries = this.entries.filter(e => e.type === 'static');
    this.violationCount = 0;
    Logger.info(this.equipmentId, 'port:security', `${this.portName}: port security disabled`);
  }

  isEnabled(): boolean { return this.enabled; }

  getMaxMACAddresses(): number { return this.maxMACs; }
  setMaxMACAddresses(max: number): void {
    if (max < 1) throw new Error('Max MAC addresses must be at least 1');
    this.maxMACs = max;
  }

  getViolationMode(): PortViolationMode { return this.violationMode; }
  setViolationMode(mode: PortViolationMode): void { this.violationMode = mode; }

  getViolationCount(): number { return this.violationCount; }
  resetViolationCount(): void { this.violationCount = 0; }

  isStickyEnabled(): boolean { return this.stickyEnabled; }
  enableSticky(): void {
    this.stickyEnabled = true;
    for (const e of this.entries) {
      if (e.type === 'dynamic') e.type = 'sticky';
    }
  }
  disableSticky(): void {
    this.stickyEnabled = false;
    for (const e of this.entries) {
      if (e.type === 'sticky') e.type = 'dynamic';
    }
  }

  getAgingTimeMin(): number { return this.agingTimeMin; }
  setAgingTimeMin(min: number): void { this.agingTimeMin = Math.max(0, min); }
  getAgingType(): AgingType { return this.agingType; }
  setAgingType(t: AgingType): void { this.agingType = t; }
  getAgingStatic(): boolean { return this.agingStatic; }
  setAgingStatic(v: boolean): void { this.agingStatic = v; }

  // ─── Entry management ─────────────────────────────────────────────

  /** Read-only view, in insertion order. */
  getEntries(): readonly SecureMacEntry[] { return this.entries; }

  /** Legacy accessor — returns just the MAC list (Port.ts and tests use it). */
  getLearnedMACs(): MACAddress[] { return this.entries.map(e => e.mac); }

  addStaticMAC(mac: MACAddress, vlan = 1): boolean {
    return this.addEntry(mac, vlan, 'static');
  }
  addStickyMAC(mac: MACAddress, vlan = 1): boolean {
    return this.addEntry(mac, vlan, 'sticky');
  }
  removeMAC(mac: MACAddress): boolean {
    const before = this.entries.length;
    this.entries = this.entries.filter(e => !e.mac.equals(mac));
    return this.entries.length < before;
  }
  clearDynamic(): number {
    const before = this.entries.length;
    this.entries = this.entries.filter(e => e.type !== 'dynamic');
    return before - this.entries.length;
  }
  clearSticky(): number {
    const before = this.entries.length;
    this.entries = this.entries.filter(e => e.type !== 'sticky');
    return before - this.entries.length;
  }
  clearAll(): number {
    const n = this.entries.length;
    this.entries = [];
    this.violationCount = 0;
    return n;
  }

  /** Insert (or no-op if already present). Used by sticky-save & static binding. */
  private addEntry(mac: MACAddress, vlan: number, type: LearnedMacType): boolean {
    if (this.entries.some(e => e.mac.equals(mac))) return false;
    const now = Date.now();
    this.entries.push({ mac, vlan, type, learnedAtMs: now, lastSeenMs: now });
    return true;
  }

  // ─── Evaluation ───────────────────────────────────────────────────

  /**
   * Evaluate whether a source MAC can flow through this port.
   *
   * @param srcMAC — source MAC from the incoming frame
   * @param vlan   — ingress VLAN (optional, default 1; used to tag the
   *                  newly-learned entry — does not affect the decision
   *                  beyond bookkeeping).
   */
  evaluate(srcMAC: MACAddress, vlan = 1): SecurityVerdict {
    if (!this.enabled) {
      return { allowed: true, shouldShutdown: false, violation: false };
    }

    // Known entry — refresh lastSeen for inactivity aging.
    const existing = this.entries.find(e => e.mac.equals(srcMAC));
    if (existing) {
      existing.lastSeenMs = Date.now();
      return { allowed: true, shouldShutdown: false, violation: false };
    }

    // Free slot → learn.
    if (this.entries.length < this.maxMACs) {
      const type: LearnedMacType = this.stickyEnabled ? 'sticky' : 'dynamic';
      this.addEntry(srcMAC, vlan, type);
      Logger.debug(this.equipmentId, 'port:security-learn',
        `${this.portName}: learned MAC ${srcMAC} as ${type}`);
      return {
        allowed: true, shouldShutdown: false, violation: false,
        learned: { mac: srcMAC, vlan, type },
      };
    }

    // Violation.
    this.violationCount++;
    Logger.warn(this.equipmentId, 'port:security-violation',
      `${this.portName}: security violation from ${srcMAC} (mode: ${this.violationMode})`);

    switch (this.violationMode) {
      case 'shutdown':
        Logger.warn(this.equipmentId, 'port:security-shutdown',
          `${this.portName}: port shut down due to security violation`);
        return {
          allowed: false, shouldShutdown: true, violation: true,
          reason: `Security violation: ${srcMAC} exceeds max MACs (${this.maxMACs})`,
        };
      case 'restrict':
        return {
          allowed: false, shouldShutdown: false, violation: true,
          reason: `Security violation (restrict): ${srcMAC}`,
        };
      case 'protect':
        return {
          allowed: false, shouldShutdown: false, violation: true,
          reason: `Security violation (protect): ${srcMAC}`,
        };
    }
  }

  // ─── Aging ────────────────────────────────────────────────────────

  /**
   * Drop entries whose aging window has elapsed. Returns the entries
   * that were removed so the caller can publish bus events / refresh
   * the running-config (sticky aging changes NVRAM state).
   *
   * Static entries only age out when `agingStatic` is on (matches
   * `switchport port-security aging static`).
   */
  ageOut(nowMs: number = Date.now()): SecureMacEntry[] {
    if (this.agingTimeMin <= 0) return [];
    const windowMs = this.agingTimeMin * 60_000;
    const expired: SecureMacEntry[] = [];
    this.entries = this.entries.filter(e => {
      if (e.type === 'static' && !this.agingStatic) return true;
      const ref = this.agingType === 'inactivity' ? e.lastSeenMs : e.learnedAtMs;
      if (nowMs - ref >= windowMs) {
        expired.push(e);
        return false;
      }
      return true;
    });
    if (expired.length > 0) {
      Logger.debug(this.equipmentId, 'port:security-aged',
        `${this.portName}: aged out ${expired.length} secure MACs`);
    }
    return expired;
  }
}
