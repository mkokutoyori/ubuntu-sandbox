export type SdwanProtocol = 'ping' | 'http' | 'dns' | 'tcp-echo' | 'udp-echo';

export type SdwanServiceMode = 'auto' | 'manual' | 'priority' | 'sla' | 'load-balance';

export type SdwanLoadBalanceMode =
  | 'source-ip-based'
  | 'weight-based'
  | 'source-dest-ip-based'
  | 'measured-volume-based';

export interface SdwanMember {
  readonly sequence: number;
  readonly iface: string;
  readonly gateway: string;
  readonly priority: number;
  readonly zone: string;
  readonly enabled: boolean;
  readonly weight: number;
  readonly volumeRatio: number;
}

export interface SdwanSlaTarget {
  readonly id: number;
  readonly latencyThresholdMs: number;
  readonly jitterThresholdMs: number;
  readonly packetLossThresholdPercent: number;
}

export interface SdwanHealthCheck {
  readonly name: string;
  readonly servers: readonly string[];
  readonly protocol: SdwanProtocol;
  readonly port: number;
  readonly intervalMs: number;
  readonly probeCount: number;
  readonly failtime: number;
  readonly recoverytime: number;
  readonly members: readonly number[];
  readonly sla: readonly SdwanSlaTarget[];
  readonly updateStaticRoute: boolean;
}

export interface SdwanService {
  readonly id: string;
  readonly name: string;
  readonly mode: SdwanServiceMode;
  readonly sources: readonly string[];
  readonly destinations: readonly string[];
  readonly priorityMembers: readonly number[];
  readonly healthCheck: string;
  readonly slaId: number;
}

export interface SdwanMemberHealth {
  alive: boolean;
  packetLossPercent: number;
  latencyMs: number;
  jitterMs: number;
  consecutiveFailures: number;
  consecutiveSuccesses: number;
}

export type SdwanTieBreak = 'cfg-order' | 'fib-best-match' | 'input-device';

export interface SdwanZone {
  readonly name: string;
  readonly tieBreak: SdwanTieBreak;
}

export interface SdwanConfiguration {
  readonly enabled: boolean;
  readonly loadBalanceMode: SdwanLoadBalanceMode;
  readonly zones: readonly SdwanZone[];
  readonly members: readonly SdwanMember[];
  readonly healthChecks: readonly SdwanHealthCheck[];
  readonly services: readonly SdwanService[];
}

export interface SdwanHealthTransition {
  readonly check: string;
  readonly sequence: number;
  readonly alive: boolean;
}

export const DEAD_LOSS_PERCENT = 100;

export interface SdwanSteeringProbe {
  readonly sourceIP: string;
  readonly destinationIP: string;
  readonly ingressPort?: string;
}

export interface SdwanRouteReach {
  prefixLengthTowards(iface: string, destination: string): number | undefined;
}

export function brokenBy(
  tieBreak: SdwanTieBreak, eligible: readonly SdwanMember[],
  probe: SdwanSteeringProbe, routes?: SdwanRouteReach,
): SdwanMember | undefined {
  if (eligible.length < 2) return eligible[0];

  if (tieBreak === 'input-device') {
    const arrived = probe.ingressPort;
    return eligible.find(member => member.iface === arrived) ?? eligible[0];
  }

  if (tieBreak === 'fib-best-match' && routes) {
    let best: SdwanMember | undefined;
    let longest = -1;
    for (const member of eligible) {
      const length = routes.prefixLengthTowards(member.iface, probe.destinationIP);
      if (length === undefined || length <= longest) continue;
      longest = length;
      best = member;
    }
    return best ?? eligible[0];
  }

  return eligible[0];
}

function flowDigest(text: string): number {
  let digest = 0;
  for (let index = 0; index < text.length; index++) {
    digest = (Math.imul(digest, 31) + text.charCodeAt(index)) >>> 0;
  }
  return avalanche(digest);
}

function avalanche(value: number): number {
  let mixed = value >>> 0;
  mixed ^= mixed >>> 16;
  mixed = Math.imul(mixed, 0x85ebca6b) >>> 0;
  mixed ^= mixed >>> 13;
  mixed = Math.imul(mixed, 0xc2b2ae35) >>> 0;
  mixed ^= mixed >>> 16;
  return mixed >>> 0;
}

function weightOf(mode: SdwanLoadBalanceMode, member: SdwanMember): number {
  return mode === 'measured-volume-based' ? member.volumeRatio : member.weight;
}

export function spreadAcross(
  mode: SdwanLoadBalanceMode, eligible: readonly SdwanMember[],
  probe: SdwanSteeringProbe,
): SdwanMember {
  const key = mode === 'source-ip-based'
    ? probe.sourceIP
    : `${probe.sourceIP}|${probe.destinationIP}`;
  const digest = flowDigest(key);

  if (mode === 'source-ip-based' || mode === 'source-dest-ip-based') {
    return eligible[digest % eligible.length];
  }

  const total = eligible.reduce((sum, member) => sum + weightOf(mode, member), 0);
  if (total <= 0) return eligible[0];

  let remaining = digest % total;
  for (const member of eligible) {
    remaining -= weightOf(mode, member);
    if (remaining < 0) return member;
  }
  return eligible[eligible.length - 1];
}

export class SdwanTable {
  private readonly members = new Map<number, SdwanMember>();
  private readonly checks = new Map<string, SdwanHealthCheck>();
  private readonly services = new Map<string, SdwanService>();
  private readonly zones = new Map<string, SdwanZone>();
  private readonly health = new Map<string, Map<number, SdwanMemberHealth>>();
  private enabled = false;
  private loadBalanceMode: SdwanLoadBalanceMode = 'source-ip-based';

  setStatus(enabled: boolean): void { this.enabled = enabled; }

  setLoadBalanceMode(mode: SdwanLoadBalanceMode): void { this.loadBalanceMode = mode; }

  getLoadBalanceMode(): SdwanLoadBalanceMode { return this.loadBalanceMode; }

  isEnabled(): boolean { return this.enabled; }

  setZone(zone: SdwanZone): void { this.zones.set(zone.name, zone); }

  removeZone(name: string): boolean { return this.zones.delete(name); }

  zoneNames(): readonly string[] { return Object.freeze([...this.zones.keys()]); }

  zone(name: string): SdwanZone | undefined { return this.zones.get(name); }

  setRouteReach(routes: SdwanRouteReach | undefined): void { this.routes = routes; }

  private routes: SdwanRouteReach | undefined;

  setMember(member: SdwanMember): void { this.members.set(member.sequence, member); }

  removeMember(sequence: number): boolean { return this.members.delete(sequence); }

  member(sequence: number): SdwanMember | undefined { return this.members.get(sequence); }

  membersOfZone(zone: string): readonly SdwanMember[] {
    if (zone.length === 0 || !this.zones.has(zone)) return Object.freeze([]);
    return this.allMembers().filter(member => member.zone === zone && member.enabled);
  }

  allMembers(): readonly SdwanMember[] {
    return Object.freeze([...this.members.values()].sort((a, b) => a.sequence - b.sequence));
  }

  setHealthCheck(check: SdwanHealthCheck): void {
    this.checks.set(check.name, check);
    if (!this.health.has(check.name)) this.health.set(check.name, new Map());
  }

  removeHealthCheck(name: string): boolean {
    this.health.delete(name);
    return this.checks.delete(name);
  }

  healthCheck(name: string): SdwanHealthCheck | undefined { return this.checks.get(name); }

  allHealthChecks(): readonly SdwanHealthCheck[] {
    return Object.freeze([...this.checks.values()]);
  }

  setService(service: SdwanService): void { this.services.set(service.id, service); }

  removeService(id: string): boolean { return this.services.delete(id); }

  allServices(): readonly SdwanService[] {
    return Object.freeze([...this.services.values()]);
  }

  recordHealth(check: string, sequence: number, sample: {
    alive: boolean; packetLossPercent: number; latencyMs: number; jitterMs: number;
  }): SdwanHealthTransition | null {
    const perCheck = this.health.get(check) ?? new Map<number, SdwanMemberHealth>();
    this.health.set(check, perCheck);

    const previous = perCheck.get(sequence);
    const failures = sample.alive ? 0 : (previous?.consecutiveFailures ?? 0) + 1;
    const successes = sample.alive ? (previous?.consecutiveSuccesses ?? 0) + 1 : 0;

    const alive = this.declaredState(check, previous, sample.alive, failures, successes);
    perCheck.set(sequence, {
      alive,
      packetLossPercent: sample.packetLossPercent,
      latencyMs: sample.latencyMs,
      jitterMs: sample.jitterMs,
      consecutiveFailures: failures,
      consecutiveSuccesses: successes,
    });

    if (previous !== undefined && previous.alive === alive) return null;
    return { check, sequence, alive };
  }

  private declaredState(
    check: string, previous: SdwanMemberHealth | undefined,
    answered: boolean, failures: number, successes: number,
  ): boolean {
    if (previous === undefined) return answered;

    const declared = this.checks.get(check);
    if (previous.alive) {
      return failures < (declared?.failtime ?? 1);
    }
    return successes >= (declared?.recoverytime ?? 1);
  }

  healthOf(check: string, sequence: number): SdwanMemberHealth | undefined {
    return this.health.get(check)?.get(sequence);
  }

  slaMet(check: string, sequence: number, slaId: number): boolean {
    const declared = this.checks.get(check);
    const measured = this.healthOf(check, sequence);
    if (!declared || !measured || !measured.alive) return false;

    const target = declared.sla.find(entry => entry.id === slaId);
    if (!target) return true;

    return measured.packetLossPercent <= target.packetLossThresholdPercent
      && measured.latencyMs <= target.latencyThresholdMs
      && measured.jitterMs <= target.jitterThresholdMs;
  }

  steer(
    probe: { readonly sourceIP: string; readonly destinationIP: string },
    matchesAddress: (names: readonly string[], candidate: string) => boolean,
  ): { iface: string; gateway: string; ruleId: string } | undefined {
    if (!this.enabled) return undefined;

    for (const rule of this.services.values()) {
      if (rule.sources.length > 0 && !matchesAddress(rule.sources, probe.sourceIP)) continue;
      if (rule.destinations.length > 0
        && !matchesAddress(rule.destinations, probe.destinationIP)) continue;

      const member = this.ruleMember(rule, probe);
      if (member) return { iface: member.iface, gateway: member.gateway, ruleId: rule.id };
    }
    return undefined;
  }

  private ruleMember(
    rule: SdwanService, probe: SdwanSteeringProbe,
  ): SdwanMember | undefined {
    const ordered = rule.priorityMembers
      .map(sequence => this.members.get(sequence))
      .filter((member): member is SdwanMember => member !== undefined && member.enabled);
    const candidates = ordered.length > 0 ? ordered : this.allMembers();

    if (rule.mode === 'sla' && rule.healthCheck.length > 0) {
      const meeting = candidates.filter(
        member => this.slaMet(rule.healthCheck, member.sequence, rule.slaId));
      if (meeting.length > 0) return this.chosenAmong(rule, meeting, probe);
    }

    const alive = candidates.filter(
      member => this.healthOf(rule.healthCheck, member.sequence)?.alive !== false);
    if (alive.length > 0) return this.chosenAmong(rule, alive, probe);
    return candidates[0];
  }

  private chosenAmong(
    rule: SdwanService, eligible: readonly SdwanMember[], probe: SdwanSteeringProbe,
  ): SdwanMember | undefined {
    if (eligible.length < 2) return eligible[0];
    if (rule.mode === 'load-balance') {
      return spreadAcross(this.loadBalanceMode, eligible, probe);
    }
    return brokenBy(this.tieBreakFor(eligible), eligible, probe, this.routes);
  }

  private tieBreakFor(eligible: readonly SdwanMember[]): SdwanTieBreak {
    for (const member of eligible) {
      const declared = this.zones.get(member.zone)?.tieBreak;
      if (declared !== undefined) return declared;
    }
    return 'cfg-order';
  }

  preferredMember(check: string, slaId?: number): SdwanMember | undefined {
    const declared = this.checks.get(check);
    if (!declared) return undefined;

    const candidates = declared.members
      .map(sequence => this.members.get(sequence))
      .filter((member): member is SdwanMember => member !== undefined && member.enabled)
      .sort((a, b) => a.priority - b.priority || a.sequence - b.sequence);

    const meeting = slaId === undefined
      ? candidates.filter(member => this.healthOf(check, member.sequence)?.alive === true)
      : candidates.filter(member => this.slaMet(check, member.sequence, slaId));

    return meeting[0];
  }
}
