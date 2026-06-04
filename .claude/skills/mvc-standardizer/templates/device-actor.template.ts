/**
 * TEMPLATE — Equipment Actor (a new device family), the standard way.
 *
 * Copy to `src/network/devices/<Device>.ts`. Worked example: a Firewall
 * (the `firewall-*` DeviceType values already exist in core/types.ts but no
 * class implements them yet). Modelled on `Equipment` + `EndHost` + the
 * `devices/host/observables.ts` read-model.
 *
 * KEY RULE (O6): a new device = a subclass of Equipment that owns its state,
 * publishes events, and projects a read-model. You do NOT edit Equipment,
 * Router, or Switch to add it.
 *
 * The VM types / projections / SignalStore live in a co-located
 * `devices/firewall/observables.ts` — see templates/observables.template.ts.
 */

import { Equipment } from '@/network/equipment/Equipment';
import type { EthernetFrame, DeviceType } from '@/network/core/types';
import { Port } from '@/network/hardware/Port';
import { RealTimeScheduler, type IScheduler } from '@/events/Scheduler';
import {
  FirewallSignalStore,
  makeReadonlyFirewallObservables,
  projectFirewallRules,
  projectFirewallStats,
  type FirewallObservables,
  type FirewallRule,
} from './firewall/observables';

export class Firewall extends Equipment {
  // ── Mutable domain state (private) ──────────────────────────────────────
  private readonly rules: FirewallRule[] = [];
  private hitCount = 0;
  private dropCount = 0;

  // ── Reactive surface ────────────────────────────────────────────────────
  private readonly signalStore = new FirewallSignalStore();
  readonly observables: FirewallObservables = makeReadonlyFirewallObservables(this.signalStore);

  // ── Bus actor + scheduler ────────────────────────────────────────────────
  private refreshActor: FirewallSignalRefreshActor | null = null;
  private readonly scheduler: IScheduler;

  constructor(
    deviceType: DeviceType, // e.g. 'firewall-cisco'
    name: string,
    x = 0,
    y = 0,
    scheduler: IScheduler = new RealTimeScheduler(),
  ) {
    super(deviceType, name, x, y);
    this.scheduler = scheduler;
    // Two interfaces by default (inside / outside).
    this.addPort(new Port('GigabitEthernet0/0', 'ethernet'));
    this.addPort(new Port('GigabitEthernet0/1', 'ethernet'));
    this.refreshActor = new FirewallSignalRefreshActor(this);
    this.refreshAll();
  }

  /** Equipment requires this. Frame filtering lives here. */
  protected handleFrame(portName: string, frame: EthernetFrame): void {
    const verdict = this.evaluate(portName, frame); // pure-ish decision
    if (verdict === 'allow') {
      this.hitCount++;
      // forward out the other interface (simplified)
      const out = portName.endsWith('0/0') ? 'GigabitEthernet0/1' : 'GigabitEthernet0/0';
      this.sendFrame(out, frame);
      this.getBus().publish({ topic: 'firewall.rule.matched' as never, payload: { id: this.getId(), verdict } as never });
    } else {
      this.dropCount++;
      this.getBus().publish({ topic: 'firewall.frame.dropped' as never, payload: { id: this.getId() } as never });
    }
    // The refresh actor reacts to the published topics; counters → stats VM.
    this._refreshStatsSignal();
  }

  // ── Domain commands (mutate, then the read-model follows) ────────────────
  addRule(rule: FirewallRule): void {
    this.rules.push(rule);
    this._refreshRulesSignal();
  }

  private evaluate(_portName: string, _frame: EthernetFrame): 'allow' | 'deny' {
    // Real matching logic against this.rules goes here.
    return this.rules.length === 0 ? 'allow' : 'deny';
  }

  // ── Read-model refresh — thin wrappers over PURE projections ─────────────
  _refreshRulesSignal(): void {
    this.signalStore.rules.set(projectFirewallRules(this.rules));
  }

  _refreshStatsSignal(): void {
    this.signalStore.stats.set(
      projectFirewallStats({ ruleCount: this.rules.length, hitCount: this.hitCount, dropCount: this.dropCount }),
    );
  }

  private refreshAll(): void {
    this._refreshRulesSignal();
    this._refreshStatsSignal();
  }
}

/**
 * Refresh Actor — subscribes to the bus and republishes the firewall's signals
 * after relevant mutations (keeps subscription wiring out of the device).
 */
export class FirewallSignalRefreshActor {
  constructor(device: Firewall) {
    const bus = (device as unknown as { getBus(): { subscribe(t: string, h: () => void): () => void } }).getBus();
    bus.subscribe('firewall.rule.matched', () => device._refreshStatsSignal());
    bus.subscribe('firewall.frame.dropped', () => device._refreshStatsSignal());
  }
}
