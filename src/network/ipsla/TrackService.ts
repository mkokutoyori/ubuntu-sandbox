import type { IEventBus } from '@/events/EventBus';
import { ownBusProvider } from '@/events/BusHolder';
import { getDefaultScheduler, type IScheduler, type TimerHandle } from '@/events/Scheduler';
import type { IpSlaEngine } from './IpSlaEngine';

const TICK_INTERVAL_MS = 100;

export type TrackType =
  | 'interface-line'
  | 'interface-routing'
  | 'route-reachability'
  | 'route-metric'
  | 'ipsla-reachability'
  | 'ipsla-state'
  | 'list-boolean'
  | 'list-threshold'
  | 'stub';

export type TrackState = 'up' | 'down';

export interface TrackMember {
  id: number;
  weight?: number;
  negate: boolean;
}

export interface TrackObject {
  id: number;
  type: TrackType;
  iface: string | null;
  prefix: string | null;
  mask: string | null;
  slaId: number | null;
  boolOp: 'and' | 'or';
  members: TrackMember[];
  thresholdUp: number | null;
  thresholdDown: number | null;
  delayUpSeconds: number;
  delayDownSeconds: number;
  state: TrackState;
  changeCount: number;
  lastChangeMs: number | null;
  pendingState: TrackState | null;
  pendingSinceMs: number | null;
  trackedBy: Set<string>;
  initialized: boolean;
}

export interface TrackHost {
  readonly id: string;
  getHostname(): string;
  isInterfaceLineUp(name: string): boolean;
  isInterfaceRoutingUp(name: string): boolean;
  hasRoute(prefix: string, mask: string | null): boolean;
  routeMetric(prefix: string, mask: string | null): number | null;
  epochMs(): number;
  log(severity: 'notifications', mnemonic: string, text: string): void;
}

export function createTrackObject(id: number, type: TrackType): TrackObject {
  return {
    id,
    type,
    iface: null,
    prefix: null,
    mask: null,
    slaId: null,
    boolOp: 'and',
    members: [],
    thresholdUp: null,
    thresholdDown: null,
    delayUpSeconds: 0,
    delayDownSeconds: 0,
    state: 'down',
    changeCount: 0,
    lastChangeMs: null,
    pendingState: null,
    pendingSinceMs: null,
    trackedBy: new Set(),
    initialized: false,
  };
}

export function describeTrack(object: TrackObject): string {
  switch (object.type) {
    case 'interface-line':
      return `Interface ${object.iface} line-protocol`;
    case 'interface-routing':
      return `Interface ${object.iface} ip routing`;
    case 'route-reachability':
      return `IP route ${object.prefix}${object.mask ? ` ${object.mask}` : ''} reachability`;
    case 'route-metric':
      return `IP route ${object.prefix}${object.mask ? ` ${object.mask}` : ''} metric threshold`;
    case 'ipsla-reachability':
      return `IP SLA ${object.slaId} reachability`;
    case 'ipsla-state':
      return `IP SLA ${object.slaId} state`;
    case 'list-boolean':
      return `List boolean ${object.boolOp}`;
    case 'list-threshold':
      return 'List threshold weight';
    default:
      return 'Stub object';
  }
}

export function trackStateNoun(object: TrackObject): string {
  switch (object.type) {
    case 'interface-line':
      return 'Line protocol';
    case 'interface-routing':
      return 'IP routing';
    case 'route-reachability':
    case 'ipsla-reachability':
      return 'Reachability';
    case 'route-metric':
    case 'ipsla-state':
    case 'list-boolean':
    case 'list-threshold':
    default:
      return 'State';
  }
}

function syslogNoun(object: TrackObject): string {
  switch (object.type) {
    case 'interface-line':
      return `interface ${object.iface} line-protocol`;
    case 'interface-routing':
      return `interface ${object.iface} ip routing`;
    case 'route-reachability':
      return `ip route ${object.prefix} reachability`;
    case 'route-metric':
      return `ip route ${object.prefix} metric threshold`;
    case 'ipsla-reachability':
      return `rtr ${object.slaId} reachability`;
    case 'ipsla-state':
      return `rtr ${object.slaId} state`;
    case 'list-boolean':
      return `list boolean ${object.boolOp}`;
    case 'list-threshold':
      return 'list threshold weight';
    default:
      return 'stub-object';
  }
}

export class TrackService {
  private readonly objects = new Map<number, TrackObject>();
  private tickHandle: TimerHandle | null = null;
  private scheduler: IScheduler | null = null;
  private running = false;

  constructor(
    private readonly host: TrackHost,
    private readonly getIpSla: () => IpSlaEngine | null,
    private readonly getBus: () => IEventBus = ownBusProvider(),
    private readonly getScheduler: () => IScheduler = () => getDefaultScheduler(),
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    const scheduler = this.getScheduler();
    this.scheduler = scheduler;
    this.tickHandle = scheduler.setInterval(() => this.evaluateAll(), TICK_INTERVAL_MS);
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    const scheduler = this.scheduler ?? this.getScheduler();
    if (this.tickHandle !== null) {
      scheduler.clear(this.tickHandle);
      this.tickHandle = null;
    }
  }

  ensure(id: number, type: TrackType): TrackObject {
    let object = this.objects.get(id);
    if (!object) {
      object = createTrackObject(id, type);
      this.objects.set(id, object);
    } else if (object.type !== type) {
      object.type = type;
      object.initialized = false;
    }
    return object;
  }

  get(id: number): TrackObject | undefined {
    return this.objects.get(id);
  }

  all(): TrackObject[] {
    return [...this.objects.values()].sort((a, b) => a.id - b.id);
  }

  remove(id: number): void {
    this.objects.delete(id);
  }

  registerConsumer(id: number, consumer: string): void {
    this.objects.get(id)?.trackedBy.add(consumer);
  }

  unregisterConsumer(id: number, consumer: string): void {
    this.objects.get(id)?.trackedBy.delete(consumer);
  }

  state(id: number): TrackState {
    this.evaluateAll();
    return this.objects.get(id)?.state ?? 'down';
  }

  isUp(id: number): boolean {
    return this.state(id) === 'up';
  }

  evaluateAll(): void {
    const now = this.now();
    for (const object of this.objects.values()) {
      const target = this.rawState(object, new Set());
      this.settle(object, target, now);
    }
  }

  private now(): number {
    return (this.scheduler ?? this.getScheduler()).now();
  }

  private settle(object: TrackObject, target: TrackState, nowMs: number): void {
    if (!object.initialized) {
      object.initialized = true;
      object.state = target;
      object.pendingState = null;
      object.pendingSinceMs = null;
      return;
    }
    if (target === object.state) {
      object.pendingState = null;
      object.pendingSinceMs = null;
      return;
    }
    const delaySeconds = target === 'up' ? object.delayUpSeconds : object.delayDownSeconds;
    if (delaySeconds <= 0) {
      this.commit(object, target, nowMs);
      return;
    }
    if (object.pendingState !== target) {
      object.pendingState = target;
      object.pendingSinceMs = nowMs;
      return;
    }
    if (object.pendingSinceMs !== null && nowMs - object.pendingSinceMs >= delaySeconds * 1000) {
      this.commit(object, target, nowMs);
    }
  }

  private commit(object: TrackObject, target: TrackState, nowMs: number): void {
    const oldState = object.state;
    object.state = target;
    object.changeCount++;
    object.lastChangeMs = nowMs;
    object.pendingState = null;
    object.pendingSinceMs = null;

    this.host.log(
      'notifications',
      'TRACKING-5-STATE',
      `${object.id} ${syslogNoun(object)} ${oldState === 'up' ? 'Up' : 'Down'}->${target === 'up' ? 'Up' : 'Down'}`,
    );
    this.getBus().publish({
      topic: 'track.state.changed',
      payload: {
        deviceId: this.host.id,
        hostname: this.host.getHostname(),
        objectId: object.id,
        description: describeTrack(object),
        oldState,
        newState: target,
        changeCount: object.changeCount,
      },
    });
  }

  private rawState(object: TrackObject, seen: Set<number>): TrackState {
    if (seen.has(object.id)) return 'down';
    seen.add(object.id);
    switch (object.type) {
      case 'interface-line':
        return object.iface && this.host.isInterfaceLineUp(object.iface) ? 'up' : 'down';
      case 'interface-routing':
        return object.iface && this.host.isInterfaceRoutingUp(object.iface) ? 'up' : 'down';
      case 'route-reachability':
        return object.prefix && this.host.hasRoute(object.prefix, object.mask) ? 'up' : 'down';
      case 'route-metric': {
        if (!object.prefix) return 'down';
        const metric = this.host.routeMetric(object.prefix, object.mask);
        if (metric === null) return 'down';
        const up = object.thresholdUp ?? 254;
        const down = object.thresholdDown ?? 255;
        if (metric <= up) return 'up';
        if (metric >= down) return 'down';
        return object.state;
      }
      case 'ipsla-reachability': {
        const engine = this.getIpSla();
        return engine && object.slaId !== null && engine.isReachable(object.slaId) ? 'up' : 'down';
      }
      case 'ipsla-state': {
        const engine = this.getIpSla();
        return engine && object.slaId !== null && engine.isWithinThreshold(object.slaId)
          ? 'up' : 'down';
      }
      case 'list-boolean': {
        if (object.members.length === 0) return 'down';
        const states = object.members.map((member) => {
          const child = this.objects.get(member.id);
          const up = child ? this.rawState(child, seen) === 'up' : false;
          return member.negate ? !up : up;
        });
        const combined = object.boolOp === 'or' ? states.some(Boolean) : states.every(Boolean);
        return combined ? 'up' : 'down';
      }
      case 'list-threshold': {
        const weight = object.members.reduce((total, member) => {
          const child = this.objects.get(member.id);
          const up = child ? this.rawState(child, seen) === 'up' : false;
          return total + (up ? (member.weight ?? 10) : 0);
        }, 0);
        const up = object.thresholdUp ?? 1;
        const down = object.thresholdDown ?? 0;
        if (weight >= up) return 'up';
        if (weight <= down) return 'down';
        return object.state;
      }
      default:
        return 'down';
    }
  }

  memberWeight(object: TrackObject): number {
    return object.members.reduce((total, member) => {
      const child = this.objects.get(member.id);
      const up = child ? this.rawState(child, new Set()) === 'up' : false;
      return total + (up ? (member.weight ?? 10) : 0);
    }, 0);
  }

  reset(): void {
    this.objects.clear();
  }
}
