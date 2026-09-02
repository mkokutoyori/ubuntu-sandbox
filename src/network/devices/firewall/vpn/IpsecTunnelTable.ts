export type IkeVersion = 1 | 2;

export type Phase1Type = 'static' | 'dynamic' | 'ddns';

export type DpdMode = 'disable' | 'on-idle' | 'on-demand';

export type NatTraversalMode = 'enable' | 'disable' | 'forced';

export type TunnelStatus = 'down' | 'up';

export interface IpsecProposal {
  readonly cipher: string;
  readonly integrity: string;
}

export interface Phase1Tunnel {
  readonly name: string;
  readonly boundInterface: string;
  readonly ikeVersion: IkeVersion;
  readonly type: Phase1Type;
  readonly remoteGateway: string;
  readonly proposals: readonly IpsecProposal[];
  readonly dhGroups: readonly number[];
  readonly presharedKey: string;
  readonly keyLifeSeconds: number;
  readonly authMethod: 'psk' | 'signature';
  readonly certificate: string;
  readonly dpd: DpdMode;
  readonly dpdRetryIntervalSeconds: number;
  readonly dpdRetryCount: number;
  readonly natTraversal: NatTraversalMode;
  readonly policyBased: boolean;
  readonly modeCfg?: boolean;
  readonly authUserGroup?: string;
  readonly poolStart?: string;
  readonly poolEnd?: string;
  readonly poolNetmask?: string;
  readonly splitInclude?: string;
  readonly xauthType?: string;
  readonly authUser?: string;
  readonly authPassword?: string;
  readonly dnsServers?: readonly string[];
  readonly comments?: string;
}

export interface ReceivedConfiguration {
  readonly address: string;
  readonly netmask: string;
  readonly splitInclude: readonly string[];
  readonly dnsServers: readonly string[];
}

export interface ModeCfgAssignment {
  readonly address: string;
  readonly netmask: string;
  readonly user?: string;
  readonly splitInclude?: string;
  readonly dnsServers: readonly string[];
}

export interface Phase2Tunnel {
  readonly name: string;
  readonly phase1Name: string;
  readonly proposals: readonly IpsecProposal[];
  readonly sourceSubnet: string;
  readonly sourceMask: string;
  readonly destinationSubnet: string;
  readonly destinationMask: string;
  readonly pfs: boolean;
  readonly dhGroups: readonly number[];
  readonly keyLifeSeconds: number;
  readonly autoNegotiate: boolean;
}

export interface TunnelCounters {
  receivedPackets: number;
  sentPackets: number;
  receivedBytes: number;
  sentBytes: number;
}

export interface TunnelState {
  readonly serial: number;
  status: TunnelStatus;
  gatewayUp: boolean;
  establishedAt: number | null;
  lastInboundAt: number | null;
  lastOutboundAt: number | null;
  failure: string | null;
  natTraversalUsed: boolean;
  readonly counters: TunnelCounters;
}

export interface IpsecTunnelTableDeps {
  readonly now?: () => number;
  readonly onInterfaceCreated?: (name: string, boundTo: string) => void;
  readonly onInterfaceRemoved?: (name: string) => void;
}

export class IpsecTunnelTable {
  private readonly phase1 = new Map<string, Phase1Tunnel>();
  private readonly phase2 = new Map<string, Phase2Tunnel>();
  private readonly states = new Map<string, TunnelState>();
  private readonly received = new Map<string, ReceivedConfiguration>();
  private readonly now: () => number;
  private nextSerial = 1;

  constructor(private readonly deps: IpsecTunnelTableDeps = {}) {
    this.now = deps.now ?? (() => Date.now());
  }

  setPhase1(tunnel: Phase1Tunnel): void {
    const existed = this.phase1.has(tunnel.name);
    this.phase1.set(tunnel.name, tunnel);
    if (!this.states.has(tunnel.name)) this.states.set(tunnel.name, this.freshState());
    if (!existed && !tunnel.policyBased) {
      this.deps.onInterfaceCreated?.(tunnel.name, tunnel.boundInterface);
    }
  }

  getPhase1(name: string): Phase1Tunnel | undefined { return this.phase1.get(name); }

  removePhase1(name: string): boolean {
    for (const [key, entry] of [...this.phase2]) {
      if (entry.phase1Name === name) this.phase2.delete(key);
    }
    this.states.delete(name);
    this.deps.onInterfaceRemoved?.(name);
    return this.phase1.delete(name);
  }

  phase1Names(): readonly string[] { return Object.freeze([...this.phase1.keys()]); }

  setPhase2(tunnel: Phase2Tunnel): void { this.phase2.set(tunnel.name, tunnel); }

  getPhase2(name: string): Phase2Tunnel | undefined { return this.phase2.get(name); }

  removePhase2(name: string): boolean { return this.phase2.delete(name); }

  phase2Names(): readonly string[] { return Object.freeze([...this.phase2.keys()]); }

  selectorsOf(phase1Name: string): readonly Phase2Tunnel[] {
    return Object.freeze(
      [...this.phase2.values()].filter(entry => entry.phase1Name === phase1Name));
  }

  stateOf(name: string): TunnelState | undefined { return this.states.get(name); }

  phase1NameFor(token: string): string | undefined {
    if (this.phase1.has(token)) return token;

    const phase2 = this.phase2.get(token);
    if (phase2 && this.phase1.has(phase2.phase1Name)) return phase2.phase1Name;

    const serial = Number.parseInt(token, 10);
    if (!Number.isInteger(serial) || String(serial) !== token) return undefined;
    for (const [name, state] of this.states) {
      if (state.serial === serial) return name;
    }
    return undefined;
  }

  recordAssignment(name: string, assignment: {
    address: string; netmask: string;
    splitInclude?: readonly string[]; dnsServers?: readonly string[];
  }): void {
    this.received.set(name, Object.freeze({
      address: assignment.address,
      netmask: assignment.netmask,
      splitInclude: Object.freeze([...(assignment.splitInclude ?? [])]),
      dnsServers: Object.freeze([...(assignment.dnsServers ?? [])]),
    }));
  }

  receivedAssignment(name: string): ReceivedConfiguration | undefined {
    return this.received.get(name);
  }

  markGateway(name: string, up: boolean): void {
    const state = this.states.get(name);
    if (state) state.gatewayUp = up;
  }

  markUp(name: string, natTraversalUsed = false): void {
    const state = this.states.get(name);
    if (!state) return;
    state.status = 'up';
    state.gatewayUp = true;
    state.establishedAt = this.now();
    state.failure = null;
    state.natTraversalUsed = natTraversalUsed;
  }

  markDown(name: string, failure: string | null = null): void {
    const state = this.states.get(name);
    if (!state) return;
    state.status = 'down';
    state.establishedAt = null;
    state.failure = failure;
  }

  recordTraffic(name: string, direction: 'in' | 'out', bytes: number): void {
    const state = this.states.get(name);
    if (!state) return;

    if (direction === 'in') {
      state.counters.receivedPackets += 1;
      state.counters.receivedBytes += bytes;
      state.lastInboundAt = this.now();
      return;
    }
    state.counters.sentPackets += 1;
    state.counters.sentBytes += bytes;
    state.lastOutboundAt = this.now();
  }

  tunnelForInterface(iface: string): Phase1Tunnel | undefined {
    return this.phase1.get(iface);
  }

  isTunnelInterface(iface: string): boolean {
    const declared = this.phase1.get(iface);
    return declared !== undefined && !declared.policyBased;
  }

  all(): readonly Phase1Tunnel[] { return Object.freeze([...this.phase1.values()]); }

  private freshState(): TunnelState {
    return {
      serial: this.nextSerial++,
      status: 'down',
      gatewayUp: false,
      establishedAt: null,
      lastInboundAt: null,
      lastOutboundAt: null,
      failure: null,
      natTraversalUsed: false,
      counters: {
        receivedPackets: 0, sentPackets: 0, receivedBytes: 0, sentBytes: 0,
      },
    };
  }
}
