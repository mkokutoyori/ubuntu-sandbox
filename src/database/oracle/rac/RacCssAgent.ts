import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import type { HostCapableDevice } from '@/network';
import { IPAddress } from '@/network/core/types';
import { getDefaultScheduler, type IScheduler, type TimerHandle } from '@/events/Scheduler';
import {
  getClusterByDbName, evictMember, type RacCluster, type RacMember,
} from './RacClusterRegistry';

export const CSS_HEARTBEAT_PORT = 42424;
export const CSS_HEARTBEAT_INTERVAL_MS = 1_000;
export const CSS_MISSCOUNT_MS = 30_000;

interface CssHost {
  udpBind(port: number, listener: (delivery: { udp: { payload: unknown } }) => void): boolean;
  sendUdpDatagram(
    destinationIP: IPAddress, destinationPort: number, sourcePort: number,
    payload: unknown, payloadBytes?: number, options?: { iface?: string },
  ): boolean;
}

interface CssBeat {
  readonly kind: 'css-heartbeat';
  readonly hostname: string;
  readonly deviceId: string;
}

const running = new Map<string, ClusterHeartbeat>();

class ClusterHeartbeat {
  private readonly lastHeard = new Map<string, number>();
  private readonly bound = new Set<string>();
  private timer: TimerHandle | null = null;

  constructor(
    private readonly dbName: string,
    private readonly scheduler: IScheduler,
  ) {}

  start(): void {
    if (this.timer !== null) return;
    this.timer = this.scheduler.setInterval(
      () => this.tick(), CSS_HEARTBEAT_INTERVAL_MS);
    this.tick();
  }

  stop(): void {
    if (this.timer !== null) this.scheduler.clear(this.timer);
    this.timer = null;
    this.lastHeard.clear();
    this.bound.clear();
  }

  private cluster(): RacCluster | null {
    return getClusterByDbName(this.dbName);
  }

  private hostOf(deviceId: string): CssHost | null {
    const dev = EquipmentRegistry.getInstance().getById(deviceId);
    const host = dev as unknown as CssHost | null;
    if (!host || typeof host.sendUdpDatagram !== 'function') return null;
    return host;
  }

  private tick(): void {
    const cluster = this.cluster();
    if (!cluster) return;
    const now = this.scheduler.now();

    for (const member of cluster.members.values()) {
      if (member.status !== 'ACTIVE') continue;
      this.bind(member);
      if (!this.lastHeard.has(member.deviceId)) this.lastHeard.set(member.deviceId, now);
    }

    for (const member of cluster.members.values()) {
      if (member.status !== 'ACTIVE') continue;
      this.beat(cluster, member);
    }

    const active = [...cluster.members.values()].filter(m => m.status === 'ACTIVE');
    const stale = active.filter(
      m => now - (this.lastHeard.get(m.deviceId) ?? now) >= CSS_MISSCOUNT_MS);
    if (stale.length === 0) return;

    const survivor = stale.length === active.length
      ? (active.find(m => this.interconnectUsable(m)) ?? active[0])
      : null;

    for (const member of stale) {
      if (survivor && member.deviceId === survivor.deviceId) {
        this.lastHeard.set(member.deviceId, now);
        continue;
      }
      const evicted = evictMember(cluster.dbName, member.deviceId);
      if (evicted) {
        this.lastHeard.delete(member.deviceId);
        writeEvictionLogs(cluster, evicted);
      }
    }
  }

  private interconnectUsable(member: RacMember): boolean {
    const dev = EquipmentRegistry.getInstance().getById(member.deviceId) as unknown as
      { getPorts?: () => Array<{ getName(): string; isAdminDown(): boolean; getCable(): unknown }> } | null;
    const port = dev?.getPorts?.().find(p => p.getName() === member.interconnectIface);
    if (!port) return false;
    return !port.isAdminDown() && port.getCable() !== null;
  }

  private bind(member: RacMember): void {
    if (this.bound.has(member.deviceId)) return;
    const host = this.hostOf(member.deviceId);
    if (!host) return;
    const ok = host.udpBind(CSS_HEARTBEAT_PORT, (delivery) => {
      const beat = delivery.udp?.payload as CssBeat | undefined;
      if (!beat || beat.kind !== 'css-heartbeat') return;
      this.lastHeard.set(beat.deviceId, this.scheduler.now());
    });
    if (ok) this.bound.add(member.deviceId);
  }

  private beat(cluster: RacCluster, member: RacMember): void {
    const host = this.hostOf(member.deviceId);
    if (!host) return;
    const beat: CssBeat = {
      kind: 'css-heartbeat', hostname: member.hostname, deviceId: member.deviceId,
    };
    for (const peer of cluster.members.values()) {
      if (peer.deviceId === member.deviceId || peer.status !== 'ACTIVE') continue;
      host.sendUdpDatagram(
        new IPAddress(peer.interconnectIp), CSS_HEARTBEAT_PORT, CSS_HEARTBEAT_PORT,
        beat, 64, { iface: member.interconnectIface });
    }
  }
}

export function attachRacCssAgent(dbName: string, scheduler?: IScheduler): void {
  let heartbeat = running.get(dbName);
  if (!heartbeat) {
    heartbeat = new ClusterHeartbeat(dbName, scheduler ?? getDefaultScheduler());
    running.set(dbName, heartbeat);
  }
  heartbeat.start();
}

export function _resetRacCssAgentAttachments(): void {
  for (const heartbeat of running.values()) heartbeat.stop();
  running.clear();
}

function writeEvictionLogs(cluster: RacCluster, evicted: RacMember): void {
  const registry = EquipmentRegistry.getInstance();
  const timestamp = new Date().toISOString().replace('T', ' ').slice(0, 19);

  for (const member of cluster.members.values()) {
    if (member.status !== 'ACTIVE' || member.deviceId === evicted.deviceId) continue;
    const dev = registry.getById(member.deviceId) as unknown as HostCapableDevice | null;
    if (!dev) continue;

    const traceDir = `/u01/app/grid/diag/crs/${member.hostname}/crs/trace`;
    const cssLog =
      `${timestamp} [CSSD][1] clssnmPollingThread: node ${evicted.hostname} (${evicted.deviceId}) `
      + `missed(3) checkins, disk/network heartbeat lost, evicting from cluster\n`
      + `${timestamp} [CSSD][1] clssnmDiscHelper: ${evicted.hostname}, node(${evicted.deviceId}) `
      + `connection failed, endp (0xff), probe(0), ninf->endp 0xff\n`
      + `${timestamp} [CSSD][1] clssnmDoSyncUpdate: Terminating node ${evicted.hostname} `
      + `(${evicted.deviceId}) in cluster incarnation, eviction ack not required\n`;
    const crsLog =
      `${timestamp} [CRSD][1] CRSD Reconfiguration started, reason: Membership change `
      + `(node ${evicted.hostname} fenced)\n`
      + `${timestamp} [CRSD][1] Reconfiguration complete\n`;

    appendDeviceFile(dev, `${traceDir}/cssd.log`, cssLog);
    appendDeviceFile(dev, `${traceDir}/crsd.log`, crsLog);
  }
}

function appendDeviceFile(dev: HostCapableDevice, path: string, content: string): void {
  const existing = dev.readFileForEditor?.(path) ?? '';
  dev.writeFileFromEditor?.(path, existing + content);
}
