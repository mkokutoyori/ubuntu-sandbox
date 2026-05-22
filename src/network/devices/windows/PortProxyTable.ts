/**
 * PortProxyTable — the set of `netsh interface portproxy` rules on one
 * Windows host.
 *
 * The table is the single owner of the device's port-proxy state. Every
 * mutation is announced on the event bus (`windows.portproxy.added` /
 * `windows.portproxy.removed`) so reactive consumers — notably
 * {@link PortProxySocketProjection}, which keeps the kernel socket table
 * coherent — can update their derived views without the table reaching
 * into them directly.
 */

import type { IEventBus } from '@/events/EventBus';
import { PortProxyRule, type PortProxyFamily } from './PortProxyRule';

export class PortProxyTable {
  /** Active rules, keyed by {@link PortProxyRule.key}. */
  private readonly rules = new Map<string, PortProxyRule>();
  private bus: IEventBus | null = null;
  private deviceId = '';

  /**
   * Attach the device's event bus so subsequent mutations are published.
   * Existing rules are (re-)announced so a freshly-attached projection
   * can reconcile its view.
   */
  attachBus(bus: IEventBus, deviceId: string): void {
    this.bus = bus;
    this.deviceId = deviceId;
    for (const rule of this.rules.values()) this.publish('added', rule);
  }

  /**
   * Install (or replace) a rule. Returns the rule it displaced, if any,
   * so callers can report `netsh`'s "updated" vs "added" semantics.
   */
  add(rule: PortProxyRule): PortProxyRule | null {
    const previous = this.rules.get(rule.key) ?? null;
    if (previous) this.publish('removed', previous);
    this.rules.set(rule.key, rule);
    this.publish('added', rule);
    return previous;
  }

  /** Remove the rule matching the family + listen endpoint. */
  remove(family: PortProxyFamily, listenAddress: string, listenPort: number): boolean {
    const key = `${family}|${listenAddress}|${listenPort}`;
    const rule = this.rules.get(key);
    if (!rule) return false;
    this.rules.delete(key);
    this.publish('removed', rule);
    return true;
  }

  /** Drop every rule (`netsh interface portproxy reset`). */
  reset(): void {
    for (const rule of this.rules.values()) this.publish('removed', rule);
    this.rules.clear();
  }

  /** Every rule, in insertion order. */
  list(): PortProxyRule[] {
    return [...this.rules.values()];
  }

  /** Rules of a single address family — backs `show v4tov4` etc. */
  byFamily(family: PortProxyFamily): PortProxyRule[] {
    return this.list().filter(r => r.family === family);
  }

  get size(): number {
    return this.rules.size;
  }

  // ─── internal ──────────────────────────────────────────────────────

  private publish(kind: 'added' | 'removed', rule: PortProxyRule): void {
    this.bus?.publish({
      topic: kind === 'added' ? 'windows.portproxy.added' : 'windows.portproxy.removed',
      payload: {
        deviceId: this.deviceId,
        protocol: rule.family,
        listenAddress: rule.listenAddress,
        listenPort: rule.listenPort,
        connectAddress: rule.connectAddress,
        connectPort: rule.connectPort,
      },
    });
  }
}
