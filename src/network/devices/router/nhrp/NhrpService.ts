export interface NhrpInterfaceConfig {
  ifName: string;
  networkId?: number;
  authentication?: string;
  holdtimeSec?: number;
  shortcut?: boolean;
  redirect?: boolean;
  registrationNoUnique?: boolean;
}

export interface NhrpMapping {
  ifName: string;
  targetAddress: string;
  nbmaAddress: string;
  static: boolean;
  multicast: boolean;
  registeredAtMs: number;
  expiresAtMs?: number;
}

export interface NhrpHubServer {
  ifName: string;
  address: string;
  registered: boolean;
}

export interface NhrpCacheEntry {
  ifName: string;
  targetAddress: string;
  targetPrefixLen: number;
  nbmaAddress: string;
  type: 'static' | 'dynamic' | 'incomplete';
  flags: string[];
  registeredAtMs: number;
  expiresAtMs?: number;
}

export class NhrpService {
  private readonly perInterface: Map<string, NhrpInterfaceConfig> = new Map();
  private readonly mappings: NhrpMapping[] = [];
  private readonly nhsServers: NhrpHubServer[] = [];
  private readonly cache: NhrpCacheEntry[] = [];

  configure(ifName: string, kv: Partial<NhrpInterfaceConfig>): void {
    const existing = this.perInterface.get(ifName) ?? { ifName };
    Object.assign(existing, kv);
    this.perInterface.set(ifName, existing);
  }

  addMapping(ifName: string, target: string, nbma: string, opts?: { multicast?: boolean; static?: boolean }): NhrpMapping {
    const m: NhrpMapping = {
      ifName,
      targetAddress: target,
      nbmaAddress: nbma,
      static: opts?.static ?? true,
      multicast: opts?.multicast ?? false,
      registeredAtMs: Date.now(),
    };
    this.mappings.push(m);
    this.cache.push({
      ifName,
      targetAddress: target,
      targetPrefixLen: 32,
      nbmaAddress: nbma,
      type: 'static',
      flags: opts?.multicast ? ['M'] : ['S'],
      registeredAtMs: m.registeredAtMs,
    });
    return m;
  }

  addNhsServer(ifName: string, address: string): void {
    if (!this.nhsServers.find(n => n.ifName === ifName && n.address === address)) {
      this.nhsServers.push({ ifName, address, registered: false });
    }
  }

  removeInterface(ifName: string): void {
    this.perInterface.delete(ifName);
    for (let i = this.mappings.length - 1; i >= 0; i--) {
      if (this.mappings[i].ifName === ifName) this.mappings.splice(i, 1);
    }
    for (let i = this.cache.length - 1; i >= 0; i--) {
      if (this.cache[i].ifName === ifName) this.cache.splice(i, 1);
    }
    for (let i = this.nhsServers.length - 1; i >= 0; i--) {
      if (this.nhsServers[i].ifName === ifName) this.nhsServers.splice(i, 1);
    }
  }

  getInterface(ifName: string): NhrpInterfaceConfig | undefined { return this.perInterface.get(ifName); }
  listInterfaces(): readonly NhrpInterfaceConfig[] { return [...this.perInterface.values()]; }
  listMappings(ifName?: string): readonly NhrpMapping[] {
    return ifName ? this.mappings.filter(m => m.ifName === ifName) : [...this.mappings];
  }
  listNhsServers(ifName?: string): readonly NhrpHubServer[] {
    return ifName ? this.nhsServers.filter(n => n.ifName === ifName) : [...this.nhsServers];
  }
  listCache(): readonly NhrpCacheEntry[] { return [...this.cache]; }

  formatCache(): string {
    if (this.cache.length === 0) return 'IP-NHRP table contains no entries';
    const lines: string[] = ['IP NHRP cache:'];
    for (const e of this.cache) {
      const ageSec = Math.max(0, Math.floor((Date.now() - e.registeredAtMs) / 1000));
      const exp = e.expiresAtMs ? Math.max(0, Math.floor((e.expiresAtMs - Date.now()) / 1000)) : null;
      lines.push(`${e.targetAddress}/${e.targetPrefixLen} via ${e.nbmaAddress}, ${e.ifName} created ${ageSec}s ago${exp !== null ? ', expire ' + exp + 's' : ''}`);
      lines.push(`  Type: ${e.type}, Flags: ${e.flags.join(' ')}`);
      lines.push(`  NBMA address: ${e.nbmaAddress}`);
    }
    return lines.join('\n');
  }

  formatCacheBrief(): string {
    if (this.cache.length === 0) return 'IP-NHRP table contains no entries';
    const lines = ['Target            Via                NBMA Address        Interface'];
    for (const e of this.cache) {
      lines.push(`${`${e.targetAddress}/${e.targetPrefixLen}`.padEnd(18)}${e.targetAddress.padEnd(19)}${e.nbmaAddress.padEnd(20)}${e.ifName}`);
    }
    return lines.join('\n');
  }

  formatSummary(): string {
    const total = this.cache.length;
    const statics = this.cache.filter(e => e.type === 'static').length;
    const dynamics = this.cache.filter(e => e.type === 'dynamic').length;
    return [
      'IP NHRP cache summary:',
      `  Total entries: ${total}`,
      `  Static: ${statics}`,
      `  Dynamic: ${dynamics}`,
      `  Incomplete: ${total - statics - dynamics}`,
    ].join('\n');
  }

  asRunningConfigInterface(ifName: string): string[] {
    const cfg = this.perInterface.get(ifName);
    const lines: string[] = [];
    if (cfg?.networkId !== undefined) lines.push(` ip nhrp network-id ${cfg.networkId}`);
    if (cfg?.authentication) lines.push(` ip nhrp authentication ${cfg.authentication}`);
    if (cfg?.holdtimeSec !== undefined) lines.push(` ip nhrp holdtime ${cfg.holdtimeSec}`);
    if (cfg?.shortcut) lines.push(` ip nhrp shortcut`);
    if (cfg?.redirect) lines.push(` ip nhrp redirect`);
    for (const m of this.mappings.filter(x => x.ifName === ifName)) {
      lines.push(` ip nhrp map ${m.multicast ? 'multicast ' : ''}${m.targetAddress} ${m.nbmaAddress}`);
    }
    for (const n of this.nhsServers.filter(x => x.ifName === ifName)) {
      lines.push(` ip nhrp nhs ${n.address}`);
    }
    return lines;
  }
}
