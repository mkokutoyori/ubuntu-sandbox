/**
 * RacCacheFusionAgent — the Global Cache Service half of RAC: when a
 * node touches a table another node last wrote, that is (a bounded,
 * table-granularity stand-in for) a Cache Fusion block transfer. Two
 * observable effects, both real Oracle behaviour:
 *   - V$SYSSTAT's `gc cr blocks received`/`gc current blocks received`
 *     increment on EVERY cross-node access (RacClusterRegistry.
 *     recordTableTouch, called unconditionally below);
 *   - a *wait* only becomes visible when the interconnect is degraded
 *     enough that the Global Cache Service round trip is not instant —
 *     `gc cr request`/`gc buffer busy` in V$SYSTEM_EVENT — mirroring how
 *     a fast, healthy interconnect rarely shows up as a wait at all in
 *     real AWR reports, while a lossy/slow one does.
 */

import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import type { HostCapableDevice } from '@/network';
import { IPAddress } from '@/network/core/types';
import type { IEventBus } from '@/events/EventBus';
import { getClusterByDbName, getClusterForDevice, recordTableTouch, type RacCluster, type RacMember } from './RacClusterRegistry';

export const GCS_PORT = 42425;

const attachedClusters = new Set<string>();
const attachedMembers = new Set<string>();

interface GcsHost {
  getBus(): IEventBus;
  sendUdpDatagram(
    destinationIP: IPAddress, destinationPort: number, sourcePort: number,
    payload: unknown, payloadBytes?: number, options?: { iface?: string },
  ): boolean;
}

function gcsHostOf(deviceId: string): GcsHost | null {
  const dev = EquipmentRegistry.getInstance().getById(deviceId) as unknown as GcsHost | null;
  if (!dev || typeof dev.sendUdpDatagram !== 'function') return null;
  return dev;
}

function sendGcsRequest(cluster: RacCluster, requester: RacMember, block: string): void {
  const host = gcsHostOf(requester.deviceId);
  if (!host) return;
  for (const peer of cluster.members.values()) {
    if (peer.deviceId === requester.deviceId || peer.status !== 'ACTIVE') continue;
    host.sendUdpDatagram(
      new IPAddress(peer.interconnectIp), GCS_PORT, GCS_PORT,
      { kind: 'gcs-request', block, from: requester.hostname }, 128,
      { iface: requester.interconnectIface });
  }
}

export function attachRacCacheFusionAgent(dbName: string): void {
  attachedClusters.add(dbName);
  const cluster = getClusterByDbName(dbName);
  if (!cluster) return;

  for (const owner of cluster.members.values()) {
    if (attachedMembers.has(owner.deviceId)) continue;
    const host = gcsHostOf(owner.deviceId);
    if (!host) continue;
    attachedMembers.add(owner.deviceId);
    host.getBus().subscribe('oracle.dml.executed', (e) => {
      onDml(dbName, e.payload as { deviceId: string; sessionId: string; schema: string; table: string });
    });
  }
}

function onDml(
  dbName: string,
  payload: { deviceId: string; sessionId: string; schema: string; table: string },
): void {
  {
    const cluster = getClusterForDevice(payload.deviceId);
    if (!cluster || cluster.dbName !== dbName) return;
    const member = cluster.members.get(payload.deviceId);
    if (!member || member.status !== 'ACTIVE') return;

    const crossed = recordTableTouch(dbName, payload.deviceId, `${payload.schema}.${payload.table}`);
    if (!crossed) return;

    sendGcsRequest(cluster, member, `${payload.schema}.${payload.table}`);

    // A GCS round trip crosses BOTH nodes' interconnect links (requester
    // and block master) — checking every member rather than just the
    // requester means it doesn't matter which side the lab happened to
    // run `tc qdisc` on.
    if (isClusterInterconnectDegraded(cluster)) {
      const sid = parseInt(payload.sessionId, 10) || 0;
      // Recorded on EVERY member, not just the requester: like the
      // gc-blocks-received counters above, this is the same cluster-wide
      // simplification (real Oracle's V$SYSTEM_EVENT is per-instance,
      // GV$SYSTEM_EVENT aggregates) — whichever node a lab happens to
      // query sees the same picture, since a real GCS round trip did
      // genuinely involve both sides.
      for (const m of cluster.members.values()) {
        if (m.status !== 'ACTIVE') continue;
        const engine = m.db.instance.getWaitEngine();
        // Real GCS latency scales with the round trip; 200ms delay + loss
        // (this codebase's own `tc netem` modelling) plausibly costs a
        // few hundred ms per request once retries are folded in.
        engine?.record(sid, 'gc cr request', 8000);
        engine?.record(sid, 'gc buffer busy', 6000);
      }
    }
  }
}

export function _resetRacCacheFusionAgentAttachments(): void {
  attachedClusters.clear();
  attachedMembers.clear();
}

function isMemberInterconnectDegraded(member: RacMember): boolean {
  const dev = EquipmentRegistry.getInstance().getById(member.deviceId) as unknown as HostCapableDevice | null;
  const port = dev?.getPorts().find((p) => p.getName() === member.interconnectIface);
  const cable = port?.getCable();
  if (!cable) return false;
  return cable.getPacketLossRate() > 0 || cable.getArtificialDelayMs() > 0;
}

function isClusterInterconnectDegraded(cluster: RacCluster): boolean {
  for (const member of cluster.members.values()) {
    if (member.status === 'ACTIVE' && isMemberInterconnectDegraded(member)) return true;
  }
  return false;
}
