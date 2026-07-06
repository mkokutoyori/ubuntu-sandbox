/**
 * ClusterService — Windows Failover Clustering (WSFC) minimal
 * (PRD-Windows-Server-Advanced.md §5 P18, §2.1.17, MS-CMRP). `New-Cluster`
 * is run identically on every participating node (same convention as
 * DFSR's `New-DfsReplicationGroup` — §5 P16): each `WindowsServer` owns its
 * own independent `ClusterService` instance, learning peer liveness purely
 * from real periodic UDP heartbeat traffic on port 3343 (`ClusSvc`'s real
 * default port) — no shared in-memory cluster object, no central mediator.
 *
 * Quorum is a simple majority of currently-reachable nodes (self included),
 * **no witness disk/file share** (PRD §5 objective 17 explicitly excludes
 * one) — this is why a 2-node cluster loses quorum the moment either node
 * goes silent, matching real WSFC's own node-majority behaviour without a
 * witness.
 */
import type { EndHost, UdpDelivery } from '@/network/devices/EndHost';
import { IPAddress } from '@/network/core/types';
import type { IScheduler, TimerHandle } from '@/events/Scheduler';
import { getDefaultScheduler } from '@/events/Scheduler';
import { ClusterGroupRegistry } from './ClusterResourceGroup';

export const CLUSTER_HEARTBEAT_PORT = 3343;
/** Heartbeat cadence — real WSFC defaults to ~1s intra-subnet. */
export const HEARTBEAT_INTERVAL_MS = 1000;
/** A node missing ~3.5 beats is considered `Down` (avoids flapping on a single dropped datagram). */
export const MISSED_THRESHOLD_MS = 3500;

export type ClusterNodeState = 'Up' | 'Down';

export interface ClusterNode {
  readonly name: string;
  readonly state: ClusterNodeState;
  readonly lastHeartbeatAt: number;
}

export interface ClusterPeerConfig {
  readonly name: string;
  readonly ip: string;
}

interface ClusterHeartbeatPdu {
  readonly kind: 'heartbeat';
  readonly clusterName: string;
  readonly nodeName: string;
}

/** One node's view of a cluster it belongs to — membership, heartbeat, quorum, and (via `.groups`) resource-group failover. */
export class ClusterService {
  private readonly peerState = new Map<string, { ip: string; lastHeartbeatAt: number }>();
  private heartbeatTimer: TimerHandle | null = null;
  private bound = false;
  readonly groups: ClusterGroupRegistry;

  constructor(
    private readonly host: EndHost,
    readonly clusterName: string,
    readonly selfNodeName: string,
    peers: readonly ClusterPeerConfig[],
    private readonly getScheduler: () => IScheduler = () => getDefaultScheduler(),
  ) {
    const now = this.getScheduler().now();
    for (const p of peers) this.peerState.set(p.name, { ip: p.ip, lastHeartbeatAt: now });
    this.groups = new ClusterGroupRegistry(this);
  }

  start(): void {
    if (this.bound) return;
    this.bound = true;
    this.host.udpBind(CLUSTER_HEARTBEAT_PORT, (dgram) => this.onHeartbeat(dgram));
    this.heartbeatTimer = this.getScheduler().setInterval(() => this.sendHeartbeats(), HEARTBEAT_INTERVAL_MS);
    this.sendHeartbeats();
  }

  stop(): void {
    if (!this.bound) return;
    this.bound = false;
    this.host.udpClose(CLUSTER_HEARTBEAT_PORT);
    if (this.heartbeatTimer !== null) { this.getScheduler().clear(this.heartbeatTimer); this.heartbeatTimer = null; }
  }

  private onHeartbeat(dgram: UdpDelivery): void {
    const pdu = dgram.udp.payload as ClusterHeartbeatPdu;
    if (!pdu || pdu.kind !== 'heartbeat' || pdu.clusterName !== this.clusterName) return;
    const peer = this.peerState.get(pdu.nodeName);
    if (!peer) return;
    peer.lastHeartbeatAt = this.getScheduler().now();
  }

  private sendHeartbeats(): void {
    const pdu: ClusterHeartbeatPdu = { kind: 'heartbeat', clusterName: this.clusterName, nodeName: this.selfNodeName };
    for (const peer of this.peerState.values()) {
      this.host.sendUdpDatagram(new IPAddress(peer.ip), CLUSTER_HEARTBEAT_PORT, CLUSTER_HEARTBEAT_PORT, pdu);
    }
  }

  /** Total membership (self + configured peers) — the denominator for majority quorum. */
  totalNodes(): number { return 1 + this.peerState.size; }

  /** Every node's current view — self is always `Up`; a peer is `Down` once it has missed `MISSED_THRESHOLD_MS` of heartbeats. */
  listNodes(): ClusterNode[] {
    const now = this.getScheduler().now();
    const nodes: ClusterNode[] = [{ name: this.selfNodeName, state: 'Up', lastHeartbeatAt: now }];
    for (const [name, peer] of this.peerState) {
      nodes.push({
        name,
        state: now - peer.lastHeartbeatAt <= MISSED_THRESHOLD_MS ? 'Up' : 'Down',
        lastHeartbeatAt: peer.lastHeartbeatAt,
      });
    }
    return nodes;
  }

  isNodeUp(name: string): boolean {
    return this.listNodes().find((n) => n.name === name)?.state === 'Up';
  }

  /** Simple majority of live nodes — no witness disk/share (PRD §5 objective 17). */
  hasQuorum(): boolean {
    const alive = this.listNodes().filter((n) => n.state === 'Up').length;
    return alive > this.totalNodes() / 2;
  }
}
