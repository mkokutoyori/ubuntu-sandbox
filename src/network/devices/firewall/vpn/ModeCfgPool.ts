import type { ModeCfgAssignment, Phase1Tunnel } from './IpsecTunnelTable';

function toNumber(address: string): number {
  const parts = address.split('.').map(part => Number.parseInt(part, 10));
  if (parts.length !== 4 || parts.some(value => Number.isNaN(value))) return NaN;
  return ((parts[0] << 24) >>> 0) + (parts[1] << 16) + (parts[2] << 8) + parts[3];
}

function toAddress(value: number): string {
  return [value >>> 24, (value >>> 16) & 255, (value >>> 8) & 255, value & 255].join('.');
}

export class ModeCfgPool {
  private readonly assigned = new Map<string, ModeCfgAssignment>();

  configuredFor(tunnel: Phase1Tunnel): boolean {
    return tunnel.modeCfg === true
      && (tunnel.poolStart ?? '').length > 0
      && (tunnel.poolEnd ?? '').length > 0;
  }

  assignmentOf(tunnel: string, peer: string): ModeCfgAssignment | undefined {
    return this.assigned.get(`${tunnel}|${peer}`);
  }

  assignmentsOf(tunnel: string): readonly ModeCfgAssignment[] {
    const out: ModeCfgAssignment[] = [];
    for (const [key, assignment] of this.assigned) {
      if (key.startsWith(`${tunnel}|`)) out.push(assignment);
    }
    return Object.freeze(out);
  }

  release(tunnel: string, peer: string): boolean {
    return this.assigned.delete(`${tunnel}|${peer}`);
  }

  releaseTunnel(tunnel: string): void {
    for (const key of [...this.assigned.keys()]) {
      if (key.startsWith(`${tunnel}|`)) this.assigned.delete(key);
    }
  }

  assign(
    tunnel: Phase1Tunnel, peer: string, user?: string,
  ): ModeCfgAssignment | 'exhausted' | undefined {
    if (!this.configuredFor(tunnel)) return undefined;

    const held = this.assigned.get(`${tunnel.name}|${peer}`);
    if (held) return held;

    const first = toNumber(tunnel.poolStart!);
    const last = toNumber(tunnel.poolEnd!);
    if (Number.isNaN(first) || Number.isNaN(last) || last < first) return 'exhausted';

    const taken = new Set(this.assignmentsOf(tunnel.name).map(entry => entry.address));
    for (let candidate = first; candidate <= last; candidate++) {
      const address = toAddress(candidate);
      if (taken.has(address)) continue;

      const assignment: ModeCfgAssignment = {
        address,
        netmask: tunnel.poolNetmask ?? '255.255.255.255',
        user,
        splitInclude: tunnel.splitInclude,
        dnsServers: Object.freeze([...(tunnel.dnsServers ?? [])]),
      };
      this.assigned.set(`${tunnel.name}|${peer}`, assignment);
      return assignment;
    }
    return 'exhausted';
  }
}
