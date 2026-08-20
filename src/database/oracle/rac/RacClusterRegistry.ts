/**
 * RacClusterRegistry — Oracle RAC (Real Application Clusters) membership
 * bookkeeping and automatic cluster-formation detection.
 *
 * This simulator models one `OracleInstance` per device; genuine RAC is
 * N instances sharing ONE physical database on shared storage. The
 * shared-storage half is implemented at the `OracleDatabase` layer (see
 * its constructor's `shared` param) — a joining node's `OracleDatabase`
 * is constructed with the founding node's `OracleStorage`/`OracleCatalog`
 * injected instead of fresh ones, so DML/DDL from either node is
 * immediately visible to the other with zero data duplication, exactly
 * like real shared storage. This module owns the OTHER half: cluster
 * *membership* — which devices belong to which cluster, their identity
 * (hostname, interconnect NIC), and their ACTIVE/EVICTED status — kept
 * separately because each node still has genuinely distinct per-instance
 * state (its own SGA, sessions, wait events) that a fully-shared object
 * would blur.
 *
 * Detection is fully automatic, matching how these tests build a
 * topology (no `srvctl add database`/`crsctl` provisioning step exists
 * in this codebase — clusterware installation is out of scope). A device
 * is a RAC candidate when BOTH real-world RAC requirements are present:
 *   1. Hostname follows Oracle's own long-standing lab/tutorial
 *      convention of prefixing cluster nodes with "rac" (racnode1,
 *      racnode2, rac1, rac2, ...) — the convention Oracle's official
 *      2-node RAC tutorials use.
 *   2. A SECOND, non-public NIC is configured — the dedicated private
 *      cluster interconnect Grid Infrastructure always requires (never
 *      the client-facing NIC) — whose subnet is shared with another
 *      already-booted `rac*` instance.
 * Requiring BOTH keeps this from ever firing on the hundreds of other
 * multi-server Oracle topologies elsewhere in this test suite (Data
 * Guard, RMAN duplicate targets, dblink scenarios, …): none of them use
 * this hostname prefix or wire a second private NIC between two Oracle
 * hosts, so ordinary standalone-instance behaviour is completely
 * unaffected.
 */

import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import type { HostCapableDevice } from '@/network';
import type { OracleDatabase } from '../OracleDatabase';

export interface RacMember {
  readonly deviceId: string;
  readonly hostname: string;
  readonly interconnectIp: string;
  readonly interconnectIface: string;
  /** This member's own OracleDatabase (own OracleInstance/wait engine —
   *  only storage/catalog are shared, see the module doc comment). Lets
   *  RacCacheFusionAgent record real gc wait events on the right node. */
  readonly db: OracleDatabase;
  status: 'ACTIVE' | 'EVICTED';
  evictedAt: Date | null;
}

export interface RacCluster {
  readonly dbName: string;
  readonly members: Map<string, RacMember>;
  /** Device whose OracleStorage/OracleCatalog every member shares. */
  readonly primaryDeviceId: string;
  /** SCHEMA.TABLE -> deviceId of the instance that last wrote it — the
   *  bounded, table-granularity stand-in for real per-block Cache Fusion
   *  ownership tracking (see RacCacheFusionAgent). */
  readonly lastTouchedTable: Map<string, string>;
  /** Cluster-wide Cache Fusion block-transfer counters. Real Oracle
   *  tracks these per-instance (GV$SYSSTAT aggregates across instances);
   *  modelling true per-instance attribution would need to know which
   *  instance currently masters each block, which this simulator does
   *  not track at block granularity. Exposing one cluster-wide counter
   *  to every member's V$SYSSTAT is the bounded, honestly-simplified
   *  stand-in — sufficient to observe "cross-node access generates GC
   *  traffic", not a faithful per-instance breakdown. */
  gcCrBlocksReceived: number;
  gcCurrentBlocksReceived: number;
}

const clusters = new Map<string, RacCluster>();

export function resetRacClusterRegistry(): void {
  clusters.clear();
}

/** Oracle's own 2-node RAC tutorials (and a great many real production
 *  deployments) prefix cluster-member hostnames with "rac". */
function isRacHostname(hostname: string): boolean {
  return /^rac/i.test(hostname);
}

export interface RacCandidate {
  readonly hostname: string;
  readonly interconnectIp: string;
  readonly interconnectIface: string;
  /** Another already-booted rac* device sharing the interconnect subnet, or null if this is the founding node. */
  readonly peerDeviceId: string | null;
}

/**
 * Detects RAC candidacy for `deviceId` per the two-part rule documented
 * above. `isBooted` lets the caller (which owns the Oracle-instance
 * cache) report which other devices already have a live instance,
 * without this module depending on that cache directly.
 */
export function resolveRacMembership(
  deviceId: string,
  isBooted: (otherDeviceId: string) => boolean,
): RacCandidate | null {
  const registry = EquipmentRegistry.getInstance();
  const dev = registry.getById(deviceId) as unknown as HostCapableDevice | null;
  if (!dev) return null;
  const hostname = dev.getHostname?.() ?? '';
  if (!isRacHostname(hostname)) return null;

  // The interconnect is never the first-configured (public/client-facing)
  // NIC — real Grid Infrastructure always dedicates a separate private
  // NIC to it.
  const candidatePorts = dev.getPorts().slice(1).filter((p) => p.getIPAddress() !== null);
  if (candidatePorts.length === 0) return null;
  const myPort = candidatePorts[0];
  const myIp = myPort.getIPAddress()!;
  const myMask = myPort.getSubnetMask();

  let peerDeviceId: string | null = null;
  if (myMask) {
    for (const other of registry.getAll()) {
      if (other.getId() === deviceId) continue;
      if (!isBooted(other.getId())) continue;
      const otherHostname = (other as unknown as HostCapableDevice).getHostname?.() ?? '';
      if (!isRacHostname(otherHostname)) continue;
      const otherPorts = other.getPorts().slice(1).filter((p) => p.getIPAddress() !== null);
      for (const op of otherPorts) {
        const oip = op.getIPAddress();
        if (oip && myIp.isInSameSubnet(oip, myMask)) { peerDeviceId = other.getId(); break; }
      }
      if (peerDeviceId) break;
    }
  }

  return { hostname, interconnectIp: myIp.toString(), interconnectIface: myPort.getName(), peerDeviceId };
}

export function joinOrCreateCluster(
  dbName: string,
  primaryDeviceId: string,
  member: { deviceId: string; hostname: string; interconnectIp: string; interconnectIface: string; db: OracleDatabase },
): RacCluster {
  let cluster = clusters.get(dbName);
  if (!cluster) {
    cluster = {
      dbName, members: new Map(), primaryDeviceId,
      lastTouchedTable: new Map(), gcCrBlocksReceived: 0, gcCurrentBlocksReceived: 0,
    };
    clusters.set(dbName, cluster);
  }
  cluster.members.set(member.deviceId, { ...member, status: 'ACTIVE', evictedAt: null });
  return cluster;
}

export function getClusterForDevice(deviceId: string): RacCluster | null {
  for (const cluster of clusters.values()) {
    if (cluster.members.has(deviceId)) return cluster;
  }
  return null;
}

export function getClusterByDbName(dbName: string): RacCluster | null {
  return clusters.get(dbName) ?? null;
}

export function evictMember(dbName: string, deviceId: string): RacMember | null {
  const cluster = clusters.get(dbName);
  const member = cluster?.members.get(deviceId);
  if (!cluster || !member || member.status === 'EVICTED') return null;
  member.status = 'EVICTED';
  member.evictedAt = new Date();
  return member;
}

/** Record a cross-node table access for Cache Fusion GC stats — see
 *  `RacCluster.lastTouchedTable`'s doc comment for the granularity
 *  caveat. Returns true when this access actually crossed instances
 *  (i.e. genuinely generated simulated Cache Fusion traffic). */
export function recordTableTouch(dbName: string, deviceId: string, schemaTable: string): boolean {
  const cluster = clusters.get(dbName);
  if (!cluster) return false;
  const key = schemaTable.toUpperCase();
  const last = cluster.lastTouchedTable.get(key);
  cluster.lastTouchedTable.set(key, deviceId);
  if (last && last !== deviceId) {
    cluster.gcCrBlocksReceived++;
    cluster.gcCurrentBlocksReceived++;
    return true;
  }
  return false;
}
