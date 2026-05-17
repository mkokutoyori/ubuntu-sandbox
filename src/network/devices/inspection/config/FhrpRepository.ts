/**
 * FhrpRepository — config-driven HSRP state (Lot C,
 * docs/DESIGN-DEVICE-STATE-INSPECTION.md).
 *
 * `standby …` interface commands mutate REAL group state here; the
 * `show standby` family projects it. State is derived deterministically
 * from real data (a lone simulated speaker owns the group when its
 * interface is up) — no fabricated peers or counters.
 */

export interface HsrpGroup {
  iface: string;
  group: number;
  version: 1 | 2;
  vip: string | null;
  secondary: string[];
  priority: number;            // default 100 (real HSRP default)
  preempt: boolean;
  preemptDelay?: number;
  helloSec: number;            // default 3
  holdSec: number;             // default 10
  authText?: string;
  authMd5?: string;
  name?: string;
  useBia: boolean;
  follow?: string;
  trackDecr: Array<{ target: string; decrement: number }>;
}

function defaults(iface: string, group: number): HsrpGroup {
  return {
    iface, group, version: 1, vip: null, secondary: [],
    priority: 100, preempt: false, helloSec: 3, holdSec: 10,
    useBia: false, trackDecr: [],
  };
}

/** Well-known HSRP virtual MAC (standard formula, not fabricated). */
export function hsrpVirtualMac(group: number, version: 1 | 2): string {
  if (version === 2) {
    return `0000.0c9f.f${group.toString(16).padStart(3, '0')}`;
  }
  return `0000.0c07.ac${group.toString(16).padStart(2, '0')}`;
}

export class FhrpRepository {
  /** key = `${iface}|${group}` */
  private readonly groups = new Map<string, HsrpGroup>();
  /** Per-interface HSRP version (applies to groups without explicit). */
  private readonly ifaceVersion = new Map<string, 1 | 2>();

  private key(iface: string, group: number): string {
    return `${iface}|${group}`;
  }

  ensure(iface: string, group: number): HsrpGroup {
    const k = this.key(iface, group);
    let g = this.groups.get(k);
    if (!g) {
      g = defaults(iface, group);
      g.version = this.ifaceVersion.get(iface) ?? 1;
      this.groups.set(k, g);
    }
    return g;
  }

  setInterfaceVersion(iface: string, version: 1 | 2): void {
    this.ifaceVersion.set(iface, version);
    for (const g of this.groups.values()) {
      if (g.iface === iface) g.version = version;
    }
  }

  remove(iface: string, group: number): void {
    this.groups.delete(this.key(iface, group));
  }

  forInterface(iface: string): HsrpGroup[] {
    return [...this.groups.values()]
      .filter((g) => g.iface === iface)
      .sort((a, b) => a.group - b.group);
  }

  all(): HsrpGroup[] {
    return [...this.groups.values()].sort((a, b) =>
      a.iface === b.iface ? a.group - b.group : a.iface.localeCompare(b.iface));
  }

  reset(): void {
    this.groups.clear();
    this.ifaceVersion.clear();
  }
}
