/**
 * OSFeatureGate — cross-OS feature-availability checker.
 *
 * Many features only make sense when a backing daemon is running:
 *   - `ipconfig /renew` requires the Dhcp service
 *   - `ssh user@host` requires the remote's sshd process
 *   - `wevtutil` requires the EventLog service
 *
 * Rather than scattering ad-hoc `if (svc.state !== 'active') return err`
 * checks across every command, callers express their requirement as a
 * declarative spec and let the gate explain refusals uniformly.
 *
 * Usage:
 *   const gate = new OSFeatureGate({
 *     services: () => serviceMgr.list(),
 *     processes: () => processMgr.list(),
 *     ports: () => socketTable.listeners(),
 *   });
 *   const r = gate.require({ services: ['Dhcp'] });
 *   if (!r.ok) return r.error;
 */

import type { OSProcess } from './OSProcess';
import type { OSService } from './OSService';

export interface OSFeatureSpec {
  /** Service names that must be in the `active` (running) state. */
  services?: string[];
  /** Process comms that must be alive in the process table. */
  processes?: string[];
  /** TCP/UDP ports that must have a listener bound. */
  listenPorts?: number[];
  /** Custom predicates evaluated last; reason returned on false. */
  custom?: { predicate: () => boolean; reason: string }[];
}

export interface OSGateResult {
  ok: boolean;
  reasons: string[];
  /** First reason, formatted as an error line. Empty when ok. */
  error: string;
}

export interface OSFeatureGateOpts {
  services: () => OSService[];
  processes: () => OSProcess[];
  /** Optional: ports currently bound to a listener. */
  ports?: () => number[];
  /** Optional: prefix prepended to every refusal line ("sc.exe", etc.). */
  errorPrefix?: string;
}

export class OSFeatureGate {
  constructor(private readonly opts: OSFeatureGateOpts) {}

  /** Check a spec, returning ok + all refusal reasons. */
  require(spec: OSFeatureSpec): OSGateResult {
    const reasons: string[] = [];
    const services = this.opts.services();
    const processes = this.opts.processes();
    const ports = this.opts.ports?.() ?? [];

    for (const name of spec.services ?? []) {
      const svc = services.find(s => s.name === name);
      if (!svc) {
        reasons.push(`service '${name}' does not exist`);
      } else if (!svc.isActive()) {
        reasons.push(`service '${name}' is not running (state: ${svc.state})`);
      }
    }

    for (const comm of spec.processes ?? []) {
      const p = processes.find(pr => pr.matches(comm) && pr.isAlive());
      if (!p) reasons.push(`process '${comm}' is not running`);
    }

    for (const port of spec.listenPorts ?? []) {
      if (!ports.includes(port)) reasons.push(`no listener on port ${port}`);
    }

    for (const { predicate, reason } of spec.custom ?? []) {
      if (!predicate()) reasons.push(reason);
    }

    const prefix = this.opts.errorPrefix ? `${this.opts.errorPrefix}: ` : '';
    return {
      ok: reasons.length === 0,
      reasons,
      error: reasons.length === 0 ? '' : prefix + reasons[0],
    };
  }

  /** Convenience: throw on refusal — for code paths that prefer it. */
  requireOrThrow(spec: OSFeatureSpec): void {
    const r = this.require(spec);
    if (!r.ok) throw new Error(r.error);
  }
}
