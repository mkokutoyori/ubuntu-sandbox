/**
 * RacCssAgent — models the real Grid Infrastructure CSSD/CRSD daemons
 * that monitor the private cluster interconnect heartbeat and evict a
 * node once it goes silent.
 *
 * Real CSS uses a misscount-based timer (30s default) before declaring a
 * node dead; there is no network jitter in this simulator for that timer
 * to protect against, so eviction here fires the instant the
 * interconnect NIC itself loses carrier (`port.link.down`) — the same
 * signal a real interconnect switch failure or unplugged cable produces,
 * and the literal trigger every RAC test in this codebase uses
 * (`ip link set eth1 down`).
 */

import { getDefaultEventBus } from '@/events/EventBus';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import type { HostCapableDevice } from '@/network';
import { getClusterForDevice, evictMember, type RacCluster, type RacMember } from './RacClusterRegistry';

const attachedClusters = new Set<string>();

/**
 * Idempotent per dbName — a cluster forms once per test topology, and
 * `getOracleDatabase` calls this on every member's boot, so guard against
 * subscribing more than once for the same cluster (the bus itself is
 * also reset between tests via setupGlobalState.ts, so a later call
 * after a reset correctly rebinds to the current bus).
 */
export function attachRacCssAgent(dbName: string): void {
  if (attachedClusters.has(dbName)) return;
  attachedClusters.add(dbName);

  getDefaultEventBus().subscribe('port.link.down', (e) => {
    const { deviceId, portName } = e.payload as { deviceId: string; portName: string };
    const cluster = getClusterForDevice(deviceId);
    if (!cluster || cluster.dbName !== dbName) return;
    const member = cluster.members.get(deviceId);
    if (!member || member.status !== 'ACTIVE' || member.interconnectIface !== portName) return;

    const evicted = evictMember(cluster.dbName, deviceId);
    if (evicted) writeEvictionLogs(cluster, evicted);
  });
}

/** Test-only: drop the idempotency guard so a fresh test's cluster gets its own subscription. */
export function _resetRacCssAgentAttachments(): void {
  attachedClusters.clear();
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
