export interface HuaweiBgpPeerCfg {
  ip: string;
  asNumber?: number;
  description?: string;
  groupName?: string;
  connectInterface?: string;
  passwordHash?: string;
  rawLines: string[];
}

export interface HuaweiBgpGroupCfg {
  name: string;
  kind?: 'internal' | 'external';
  asNumber?: number;
  rawLines: string[];
}

export interface HuaweiBgpProcess {
  asn: number;
  routerId?: string;
  networks: Array<{ ip: string; mask: string }>;
  aggregates: Array<{ ip: string; mask: string; flags: string[] }>;
  peers: Map<string, HuaweiBgpPeerCfg>;
  groups: Map<string, HuaweiBgpGroupCfg>;
  rawLines: string[];
}

export interface HuaweiIsisProcess {
  processId: number;
  netAddress?: string;
  isLevel?: 'level-1' | 'level-2' | 'level-1-2';
  costStyle?: 'narrow' | 'wide' | 'compatible';
  checkzero?: boolean;
  defaultRouteAdvertise?: boolean;
  importedRoutes: string[];
  gracefulRestart?: boolean;
  rawLines: string[];
}

export class HuaweiRoutingExtras {
  private bgpProcess: HuaweiBgpProcess | null = null;
  private isisProcesses: Map<number, HuaweiIsisProcess> = new Map();

  ensureBgp(asn: number): HuaweiBgpProcess {
    if (!this.bgpProcess) this.bgpProcess = {
      asn, networks: [], aggregates: [], peers: new Map(), groups: new Map(), rawLines: [],
    };
    this.bgpProcess.asn = asn;
    return this.bgpProcess;
  }
  getBgp(): HuaweiBgpProcess | null { return this.bgpProcess; }
  removeBgp(): void { this.bgpProcess = null; }

  ensureIsis(processId: number): HuaweiIsisProcess {
    let p = this.isisProcesses.get(processId);
    if (!p) {
      p = { processId, importedRoutes: [], rawLines: [] };
      this.isisProcesses.set(processId, p);
    }
    return p;
  }
  getIsis(processId: number): HuaweiIsisProcess | undefined { return this.isisProcesses.get(processId); }
  listIsis(): readonly HuaweiIsisProcess[] { return [...this.isisProcesses.values()]; }
  removeIsis(processId: number): void { this.isisProcesses.delete(processId); }

  asRunningConfigLines(): string[] {
    const lines: string[] = [];
    if (this.bgpProcess) {
      lines.push(`bgp ${this.bgpProcess.asn}`);
      if (this.bgpProcess.routerId) lines.push(` router-id ${this.bgpProcess.routerId}`);
      for (const n of this.bgpProcess.networks) lines.push(` network ${n.ip} ${n.mask}`);
      for (const ag of this.bgpProcess.aggregates) lines.push(` aggregate ${ag.ip} ${ag.mask}${ag.flags.length ? ' ' + ag.flags.join(' ') : ''}`);
      for (const [, g] of this.bgpProcess.groups) {
        lines.push(` group ${g.name}${g.kind ? ' ' + g.kind : ''}`);
        for (const line of g.rawLines) lines.push(` ${line}`);
      }
      for (const [, p] of this.bgpProcess.peers) {
        lines.push(` peer ${p.ip}${p.groupName ? ' group ' + p.groupName : ''}${p.asNumber !== undefined ? ' as-number ' + p.asNumber : ''}`);
        for (const line of p.rawLines) lines.push(` ${line}`);
      }
      for (const r of this.bgpProcess.rawLines) lines.push(` ${r}`);
    }
    for (const [, p] of this.isisProcesses) {
      lines.push(`isis ${p.processId}`);
      if (p.netAddress) lines.push(` network-entity ${p.netAddress}`);
      if (p.isLevel) lines.push(` is-level ${p.isLevel}`);
      if (p.costStyle) lines.push(` cost-style ${p.costStyle}`);
      if (p.checkzero === false) lines.push(' undo checkzero');
      else if (p.checkzero) lines.push(' checkzero');
      if (p.defaultRouteAdvertise) lines.push(' default-route-advertise');
      if (p.gracefulRestart) lines.push(' graceful-restart');
      for (const ir of p.importedRoutes) lines.push(` import-route ${ir}`);
      for (const r of p.rawLines) lines.push(` ${r}`);
    }
    return lines;
  }
}
