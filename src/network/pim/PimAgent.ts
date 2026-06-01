import type { IEventBus } from '@/events/EventBus';
import { getDefaultScheduler, type IScheduler, type TimerHandle } from '@/events/Scheduler';
import {
  type PimConfig, type PimInterfaceRuntime, type PimNeighborEntry,
  type PimMode, type PimPacket, type PimHelloOption,
  createDefaultPimConfig, defaultInterfaceRuntime, makeNeighborKey,
  compareDrCandidate, getOption,
  IP_PROTO_PIM, PIM_ALL_ROUTERS, PIM_ALL_ROUTERS_MAC,
} from './types';
import {
  MACAddress, IPAddress,
  type EthernetFrame, type IPv4Packet,
  ETHERTYPE_IPV4, nextIPv4Id, computeIPv4Checksum,
} from '../core/types';
import { Logger } from '../core/Logger';

export interface PimHost {
  readonly id: string;
  readonly name: string;
  getHostname(): string;
  getPort(name: string): import('../hardware/Port').Port | undefined;
  getPorts(): import('../hardware/Port').Port[];
  sendFrame(portName: string, frame: EthernetFrame): void;
}

export class PimAgent {
  private config: PimConfig = createDefaultPimConfig();
  private helloTimer: TimerHandle | null = null;
  private expiryTimer: TimerHandle | null = null;
  private scheduler: IScheduler | null = null;
  private unsubscribers: Array<() => void> = [];
  private running = false;

  constructor(
    private readonly host: PimHost,
    private readonly getBus: () => IEventBus,
    private readonly getScheduler: () => IScheduler = () => getDefaultScheduler(),
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.installSubscribers();
    if (this.config.enabled) this.startTimers();
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    for (const u of this.unsubscribers) u();
    this.unsubscribers = [];
    this.stopTimers();
  }

  getConfig(): Readonly<PimConfig> { return this.config; }

  enableInterface(iface: string, mode: PimMode = 'sparse'): void {
    const rt = this.ensureIface(iface);
    rt.enabled = true;
    rt.mode = mode;
    this.transmitHello(rt);
    this.recomputeDr(rt);
  }

  disableInterface(iface: string): void {
    const rt = this.config.interfaces.get(iface);
    if (!rt) return;
    rt.enabled = false;
    for (const [k, n] of this.config.neighbors) {
      if (n.iface === iface) {
        this.config.neighbors.delete(k);
        this.emitNeighborLost(n, 'config');
      }
    }
    rt.designatedRouterIp = null;
  }

  setDrPriority(iface: string, priority: number): void {
    const rt = this.ensureIface(iface);
    rt.drPriority = priority;
    if (rt.enabled) {
      this.transmitHello(rt);
      this.recomputeDr(rt);
    }
  }

  setHelloInterval(iface: string, seconds: number): void {
    const rt = this.ensureIface(iface);
    rt.helloIntervalSec = seconds;
    rt.helloHoldSec = Math.max(seconds * 3 + seconds / 2, 105);
  }

  getInterfaceRuntime(iface: string): PimInterfaceRuntime | undefined {
    return this.config.interfaces.get(iface);
  }

  listNeighbors(iface?: string): PimNeighborEntry[] {
    const all = Array.from(this.config.neighbors.values());
    const filtered = iface ? all.filter(n => n.iface === iface) : all;
    return filtered.sort((a, b) =>
      a.iface === b.iface ? a.neighborIp.localeCompare(b.neighborIp) : a.iface.localeCompare(b.iface));
  }

  handleIp(inPort: string, srcIp: IPAddress, ipPkt: IPv4Packet): void {
    if (!this.config.enabled) return;
    if (ipPkt.protocol !== IP_PROTO_PIM) return;
    const payload = ipPkt.payload as PimPacket | undefined;
    if (!payload || payload.type !== 'pim') return;
    const rt = this.config.interfaces.get(inPort);
    if (!rt || !rt.enabled) return;
    const senderIp = srcIp.toString();

    this.getBus().publish({
      topic: 'pim.packet.received',
      payload: {
        deviceId: this.host.id, hostname: this.host.getHostname(),
        iface: inPort, messageType: payload.messageType, fromIp: senderIp,
      },
    });

    if (payload.messageType !== 'hello') return;

    const holdtime = (getOption<number>(payload.options, 'holdtime') ?? rt.helloHoldSec);
    const drPriOpt = payload.options.find(o => o.type === 'dr-priority');
    const drPriority = (drPriOpt?.value as number | undefined) ?? 1;
    const generationId = (getOption<number>(payload.options, 'generation-id') ?? 0);
    const addressList = (getOption<string[]>(payload.options, 'address-list') ?? []);

    const k = makeNeighborKey(inPort, senderIp);
    const existing = this.config.neighbors.get(k);
    if (existing && existing.generationId !== generationId && existing.generationId !== 0) {
      this.config.neighbors.delete(k);
      this.emitNeighborLost(existing, 'gen-id-changed');
    }
    const had = this.config.neighbors.has(k);
    const entry: PimNeighborEntry = {
      iface: inPort, neighborIp: senderIp,
      helloHoldSec: holdtime,
      drPriority,
      generationId,
      hasDrPriorityOption: !!drPriOpt,
      lastHeardMs: Date.now(),
      upSinceMs: existing?.upSinceMs ?? Date.now(),
      addressList,
    };
    this.config.neighbors.set(k, entry);
    if (!had) {
      this.getBus().publish({
        topic: 'pim.neighbor.added',
        payload: {
          deviceId: this.host.id, hostname: this.host.getHostname(),
          iface: inPort, neighborIp: senderIp,
          drPriority, generationId,
        },
      });
      Logger.info(this.host.id, 'pim:neighbor',
        `${this.host.name}: ${inPort} new PIM neighbor ${senderIp}`);
      this.transmitHello(rt);
    }
    this.recomputeDr(rt);
  }

  private recomputeDr(rt: PimInterfaceRuntime): void {
    const port = this.host.getPort(rt.iface);
    const myIp = port?.getIPAddress()?.toString();
    if (!myIp) return;
    const candidates: Array<{ drPriority: number; hasDrPriority: boolean; ip: string }> = [
      { drPriority: rt.drPriority, hasDrPriority: true, ip: myIp },
    ];
    for (const n of this.config.neighbors.values()) {
      if (n.iface !== rt.iface) continue;
      candidates.push({ drPriority: n.drPriority, hasDrPriority: n.hasDrPriorityOption, ip: n.neighborIp });
    }
    let best = candidates[0];
    for (const c of candidates.slice(1)) {
      if (compareDrCandidate(c, best) < 0) best = c;
    }
    const oldDr = rt.designatedRouterIp;
    if (oldDr !== best.ip) {
      rt.designatedRouterIp = best.ip;
      this.getBus().publish({
        topic: 'pim.dr.changed',
        payload: {
          deviceId: this.host.id, hostname: this.host.getHostname(),
          iface: rt.iface, oldDrIp: oldDr, newDrIp: best.ip,
        },
      });
      Logger.info(this.host.id, 'pim:dr',
        `${this.host.name}: ${rt.iface} DR ${oldDr ?? '(none)'} → ${best.ip}`);
    }
  }

  private emitNeighborLost(n: PimNeighborEntry, reason: 'timeout' | 'link' | 'gen-id-changed' | 'config'): void {
    this.getBus().publish({
      topic: 'pim.neighbor.lost',
      payload: {
        deviceId: this.host.id, hostname: this.host.getHostname(),
        iface: n.iface, neighborIp: n.neighborIp, reason,
      },
    });
  }

  private transmitHello(rt: PimInterfaceRuntime): void {
    if (!rt.enabled) return;
    const port = this.host.getPort(rt.iface);
    if (!port || !port.getIsUp() || !port.isConnected()) return;
    const srcIp = port.getIPAddress();
    if (!srcIp) return;
    const opts: PimHelloOption[] = [
      { type: 'holdtime', value: rt.helloHoldSec },
      { type: 'dr-priority', value: rt.drPriority },
      { type: 'generation-id', value: rt.generationId },
      { type: 'lan-prune-delay', value: 500 },
    ];
    const payload: PimPacket = {
      type: 'pim', version: 2, messageType: 'hello',
      reserved: 0, checksum: 0,
      options: opts,
      senderIp: srcIp.toString(),
    };
    const ipPkt: IPv4Packet = {
      type: 'ipv4', version: 4, ihl: 5, tos: 0xc0,
      totalLength: 20 + 8 + opts.length * 8,
      identification: nextIPv4Id(), flags: 0, fragmentOffset: 0,
      ttl: 1, protocol: IP_PROTO_PIM, headerChecksum: 0,
      sourceIP: srcIp, destinationIP: new IPAddress(PIM_ALL_ROUTERS),
      payload,
    };
    ipPkt.headerChecksum = computeIPv4Checksum(ipPkt);
    const eth: EthernetFrame = {
      srcMAC: port.getMAC(),
      dstMAC: new MACAddress(PIM_ALL_ROUTERS_MAC),
      etherType: ETHERTYPE_IPV4,
      payload: ipPkt,
    };
    this.host.sendFrame(rt.iface, eth);
    rt.lastHelloSentMs = Date.now();
    this.getBus().publish({
      topic: 'pim.packet.sent',
      payload: {
        deviceId: this.host.id, hostname: this.host.getHostname(),
        iface: rt.iface, messageType: 'hello',
        destinationIp: PIM_ALL_ROUTERS,
      },
    });
  }

  private ensureIface(iface: string): PimInterfaceRuntime {
    let rt = this.config.interfaces.get(iface);
    if (!rt) {
      rt = defaultInterfaceRuntime(iface);
      this.config.interfaces.set(iface, rt);
    }
    return rt;
  }

  private startTimers(): void {
    const s = this.getScheduler();
    this.scheduler = s;
    if (this.helloTimer === null) {
      this.helloTimer = s.setInterval(() => {
        const now = Date.now();
        for (const rt of this.config.interfaces.values()) {
          if (!rt.enabled) continue;
          if (now - rt.lastHelloSentMs >= rt.helloIntervalSec * 1000) {
            this.transmitHello(rt);
          }
        }
      }, 1000);
    }
    if (this.expiryTimer === null) {
      this.expiryTimer = s.setInterval(() => this.expireDue(), 1000);
    }
  }

  private stopTimers(): void {
    const s = this.scheduler ?? this.getScheduler();
    if (this.helloTimer !== null) { s.clear(this.helloTimer); this.helloTimer = null; }
    if (this.expiryTimer !== null) { s.clear(this.expiryTimer); this.expiryTimer = null; }
  }

  private expireDue(): void {
    const now = Date.now();
    const touched = new Set<string>();
    for (const [k, n] of this.config.neighbors) {
      if (now - n.lastHeardMs > n.helloHoldSec * 1000) {
        this.config.neighbors.delete(k);
        this.emitNeighborLost(n, 'timeout');
        touched.add(n.iface);
      }
    }
    for (const iface of touched) {
      const rt = this.config.interfaces.get(iface);
      if (rt) this.recomputeDr(rt);
    }
  }

  private installSubscribers(): void {
    const bus = this.getBus();
    this.unsubscribers.push(bus.subscribeWhere(
      'port.link.down',
      (p) => p.deviceId === this.host.id,
      (e) => this.onLinkDown(e.payload.portName),
    ));
    this.unsubscribers.push(bus.subscribeWhere(
      'port.link.up',
      (p) => p.deviceId === this.host.id,
      (e) => this.onLinkUp(e.payload.portName),
    ));
  }

  private onLinkDown(portName: string): void {
    const rt = this.config.interfaces.get(portName);
    if (!rt) return;
    for (const [k, n] of this.config.neighbors) {
      if (n.iface === portName) {
        this.config.neighbors.delete(k);
        this.emitNeighborLost(n, 'link');
      }
    }
    rt.designatedRouterIp = null;
  }

  private onLinkUp(portName: string): void {
    const rt = this.config.interfaces.get(portName);
    if (!rt || !rt.enabled) return;
    this.transmitHello(rt);
  }
}
