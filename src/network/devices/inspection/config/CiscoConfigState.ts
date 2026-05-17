/**
 * CiscoConfigState — Repository for config-driven global device state
 * (Lot C of docs/DESIGN-DEVICE-STATE-INSPECTION.md).
 *
 * The CLI mutates this real state instead of swallowing toggles as
 * silent no-ops; `show` commands and running-config project it. Only
 * values that differ from the IOS default are surfaced, matching real
 * `show running-config` behaviour.
 *
 * This is intentionally a small, owned aggregate (composition) rather
 * than flags scattered across the shell — single responsibility, easy
 * to test and to extend with further config-driven subsystems.
 */

/** Global on/off features with their real IOS defaults. */
interface FeatureDefaults {
  readonly [flag: string]: boolean;
}

const DEFAULTS: FeatureDefaults = {
  // CDP is enabled by default on Cisco; LLDP is disabled by default.
  'cdp': true,
  'lldp': false,
  // Routers route by default; CEF on; HTTP server off on modern IOS.
  'ip routing': true,
  'ipv6 unicast-routing': false,
  'ip cef': true,
  'ip http server': false,
  'ip http secure-server': false,
  // Legacy source-routing historically defaulted on.
  'ip source-route': true,
  'ip domain-lookup': true,
};

export class CiscoConfigState {
  /** Sparse overrides; absence ⇒ the IOS default in DEFAULTS. */
  private readonly flags = new Map<string, boolean>();

  /** True if `feature` is currently effectively enabled. */
  isEnabled(feature: string): boolean {
    const f = feature.toLowerCase();
    if (this.flags.has(f)) return this.flags.get(f)!;
    return DEFAULTS[f] ?? false;
  }

  /** Apply `feature` / `no feature`. Returns true if `feature` known. */
  set(feature: string, enabled: boolean): boolean {
    const f = feature.toLowerCase();
    if (!(f in DEFAULTS)) return false;
    this.flags.set(f, enabled);
    return true;
  }

  /** Lines for `show running-config` (only non-default, real intent). */
  runningConfigLines(): string[] {
    const out: string[] = [];
    for (const key of Object.keys(DEFAULTS)) {
      const cur = this.isEnabled(key);
      if (cur === DEFAULTS[key]) continue;
      // CDP/LLDP use the `<proto> run` spelling.
      const stanza = key === 'cdp' || key === 'lldp' ? `${key} run` : key;
      out.push(cur ? stanza : `no ${stanza}`);
    }
    return out;
  }

  reset(): void {
    this.flags.clear();
  }
}
