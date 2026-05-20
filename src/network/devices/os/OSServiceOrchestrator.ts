/**
 * OSServiceOrchestrator — cross-OS dependency-aware lifecycle helper.
 *
 * Resolves start/stop order for a service given its `dependsOn` graph,
 * detects cycles, and offers hooks for OS adapters to perform the
 * actual transitions. The orchestrator itself does NOT start/stop
 * services — that stays in the OS-specific managers — it just hands
 * back the ordered list of names.
 *
 * A reactive variant (subscribing to process-exit events to auto-restart
 * a failed service) is built on top of this in the Linux/Windows
 * supervisors; see `linux/supervisor/LinuxServiceSupervisor.ts`.
 */

import type { OSService } from './OSService';

export interface OSServiceOrchestratorOpts {
  services: () => OSService[];
}

export class OSServiceOrchestrator {
  constructor(private readonly opts: OSServiceOrchestratorOpts) {}

  /**
   * Topological order: a service appears after all of its `dependsOn`.
   * Throws on cycles with a path that participates in the cycle.
   */
  resolveStartOrder(name: string): string[] {
    const all = this.byName();
    const result: string[] = [];
    const visiting = new Set<string>();
    const visited = new Set<string>();

    const dfs = (curr: string, path: string[]) => {
      if (visited.has(curr)) return;
      if (visiting.has(curr)) {
        const cycle = [...path.slice(path.indexOf(curr)), curr].join(' -> ');
        throw new Error(`dependency cycle: ${cycle}`);
      }
      visiting.add(curr);
      const svc = all.get(curr);
      if (svc) {
        for (const dep of svc.dependsOn) dfs(dep, [...path, curr]);
      }
      visiting.delete(curr);
      visited.add(curr);
      result.push(curr);
    };

    dfs(name, []);
    return result;
  }

  /**
   * Stop order: reverse of start order, with all transitive dependents
   * of `name` stopped before `name` itself.
   */
  resolveStopOrder(name: string): string[] {
    const all = this.opts.services();
    const dependents = new Map<string, string[]>();
    for (const s of all) {
      for (const dep of s.dependsOn) {
        if (!dependents.has(dep)) dependents.set(dep, []);
        dependents.get(dep)!.push(s.name);
      }
    }

    const result: string[] = [];
    const visited = new Set<string>();
    const collect = (curr: string) => {
      if (visited.has(curr)) return;
      visited.add(curr);
      for (const dep of dependents.get(curr) ?? []) collect(dep);
      result.push(curr);
    };
    collect(name);
    return result;
  }

  /** Whether any transitive dependent of `name` is still active. */
  hasActiveDependents(name: string): boolean {
    const services = this.opts.services();
    const stack = [name];
    const seen = new Set<string>();
    while (stack.length) {
      const curr = stack.pop()!;
      for (const s of services) {
        if (s.name === curr) continue;
        if (s.dependsOn.includes(curr) && !seen.has(s.name)) {
          if (s.isActive()) return true;
          seen.add(s.name);
          stack.push(s.name);
        }
      }
    }
    return false;
  }

  private byName(): Map<string, OSService> {
    const m = new Map<string, OSService>();
    for (const s of this.opts.services()) m.set(s.name, s);
    return m;
  }
}
