/**
 * PortBindingPolicy — the rule governing *who* may bind *which* port.
 *
 * On a POSIX host, binding a port below 1024 requires either uid 0 or the
 * `CAP_NET_BIND_SERVICE` capability; the boundary itself is tunable through
 * the `net.ipv4.ip_unprivileged_port_start` sysctl. Windows imposes no such
 * restriction. This class models all of that so a service that tries to
 * bind a privileged port as an unprivileged user fails exactly as it would
 * on real equipment.
 *
 * Modelled as a class because the boundary is mutable state a `sysctl`
 * write genuinely changes — it is not a constant.
 */

import { PortNumber } from './PortNumber';

/** The OS family a binding attempt runs on — they have different rules. */
export type BindingPlatform = 'linux' | 'windows';

/** The privilege context of whoever is attempting the bind. */
export interface BindActor {
  /** Effective uid (POSIX). 0 is root. Ignored on Windows. */
  uid: number;
  /** True when the process holds `CAP_NET_BIND_SERVICE`. */
  hasNetBindCapability?: boolean;
}

/** The verdict of a binding-permission check. */
export interface BindVerdict {
  /** True when the bind is permitted. */
  allowed: boolean;
  /** The faithful diagnostic when denied (empty when allowed). */
  reason: string;
}

export interface PortBindingPolicyInit {
  platform?: BindingPlatform;
  /**
   * `net.ipv4.ip_unprivileged_port_start` — the lowest port an
   * unprivileged process may bind. Ports below it need privilege.
   */
  unprivilegedPortStart?: number;
}

export class PortBindingPolicy {
  /** The OS family whose rules apply. */
  readonly platform: BindingPlatform;
  /** Lowest port an unprivileged process may bind (POSIX sysctl). */
  unprivilegedPortStart: number;

  constructor(init: PortBindingPolicyInit = {}) {
    this.platform = init.platform ?? 'linux';
    this.unprivilegedPortStart = init.unprivilegedPortStart ?? 1024;
  }

  /** Stock POSIX binding policy (privileged ports below 1024). */
  static linux(): PortBindingPolicy {
    return new PortBindingPolicy({ platform: 'linux' });
  }

  /** Windows binding policy — no privileged-port restriction. */
  static windows(): PortBindingPolicy {
    return new PortBindingPolicy({ platform: 'windows', unprivilegedPortStart: 0 });
  }

  /** True when binding `port` needs elevated privilege under this policy. */
  requiresPrivilege(port: number | PortNumber): boolean {
    const value = port instanceof PortNumber ? port.value : port;
    if (this.platform === 'windows') return false;
    return value < this.unprivilegedPortStart;
  }

  /**
   * Decide whether `actor` may bind `port`. The faithful POSIX rule:
   * a privileged port is permitted only for uid 0 or a process that
   * carries `CAP_NET_BIND_SERVICE`.
   */
  evaluate(port: number | PortNumber, actor: BindActor): BindVerdict {
    const value = port instanceof PortNumber ? port.value : port;

    if (!PortNumber.isValid(value)) {
      return { allowed: false, reason: `invalid port number ${value}` };
    }
    if (!this.requiresPrivilege(value)) {
      return { allowed: true, reason: '' };
    }
    if (actor.uid === 0 || actor.hasNetBindCapability) {
      return { allowed: true, reason: '' };
    }
    return {
      allowed: false,
      reason:
        `Permission denied: binding port ${value} requires root ` +
        `or CAP_NET_BIND_SERVICE (ports below ${this.unprivilegedPortStart} are privileged)`,
    };
  }

  /** Convenience predicate over {@link evaluate}. */
  permits(port: number | PortNumber, actor: BindActor): boolean {
    return this.evaluate(port, actor).allowed;
  }
}
