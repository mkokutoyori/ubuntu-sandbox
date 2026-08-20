/**
 * ClusterResourceGroup — a WSFC resource group's ownership/failover model
 * (PRD-Windows-Server-Advanced.md §5 P18, §2.1.17). Only the File Server
 * role type is covered, per the PRD's own `ClusterResourceGroup` sketch
 * (§4.7). Ownership is a **pure function** of (`preferredOwners` order,
 * each node's current `Up`/`Down` state from the owning `ClusterService`)
 * — not a message that must be propagated between nodes — so every
 * surviving node's local view converges to the same owner without a
 * cluster-database replication protocol, matching how DFSR/AD replication
 * groups are created identically (not pushed) on every member server.
 *
 * `cluster.group.moved` (PRD-Windows-Server-Advanced.md §5 P23) fires
 * whenever a group's *computed* owner changes — both a manual
 * `Move-ClusterGroup` and an automatic failover detected on the next
 * `ClusterService` heartbeat tick converge on the same
 * publish-if-changed check, so neither path can double-publish.
 */
import type { IEventBus } from '@/events/EventBus';
import type { ClusterService } from './ClusterService';

export type ClusterResourceType = 'FileServer';

export interface ClusterResourceGroupInfo {
  readonly name: string;
  readonly ownerNode: string;
  readonly resourceType: ClusterResourceType;
}

export interface ClusterOpResult { ok: boolean; message: string }

interface GroupEntry {
  name: string;
  preferredOwners: string[];
  resourceType: ClusterResourceType;
}

/** Owned by one node's `ClusterService` — the resource groups that node knows about within its cluster. */
export class ClusterGroupRegistry {
  private readonly groups = new Map<string, GroupEntry>();
  /** Last owner this instance published for each group — lets both the manual and periodic-tick paths share one publish-if-changed check. */
  private readonly lastKnownOwners = new Map<string, string>();

  constructor(
    private readonly cluster: ClusterService,
    private readonly bus: IEventBus,
    private readonly deviceId: string,
  ) {}

  /** `Add-ClusterFileServerRole -Name <name> -Node <preferredOwner1,...>` — run identically on every member server, so every node starts with the same preference order. */
  addFileServerRole(name: string, preferredOwners: readonly string[]): ClusterOpResult {
    const key = name.toLowerCase();
    if (this.groups.has(key)) {
      return { ok: false, message: `Add-ClusterFileServerRole : A resource group named "${name}" already exists.` };
    }
    if (preferredOwners.length === 0) {
      return { ok: false, message: 'Add-ClusterFileServerRole : At least one preferred owner node is required.' };
    }
    this.groups.set(key, { name, preferredOwners: [...preferredOwners], resourceType: 'FileServer' });
    this.publishIfChanged(key);
    return { ok: true, message: '' };
  }

  /** `Move-ClusterGroup -Name <name> -Node <target>` — makes `target` the preferred (and, once its heartbeat is current, actual) owner. */
  moveGroup(name: string, targetNode: string): ClusterOpResult {
    const key = name.toLowerCase();
    const entry = this.groups.get(key);
    if (!entry) return { ok: false, message: `Move-ClusterGroup : Cluster group "${name}" does not exist.` };
    if (!this.cluster.isNodeUp(targetNode)) {
      return { ok: false, message: `Move-ClusterGroup : Node "${targetNode}" is not a member of the cluster or is not up.` };
    }
    entry.preferredOwners = [targetNode, ...entry.preferredOwners.filter((n) => n !== targetNode)];
    this.publishIfChanged(key);
    return { ok: true, message: '' };
  }

  /** `Get-ClusterGroup` — current owner is the highest-preference node that is currently `Up`; falls back to the last preferred name if every owner is down (mirrors a real group going `Offline` while keeping its last-known owner). */
  listGroups(): ClusterResourceGroupInfo[] {
    return [...this.groups.values()].map((entry) => this.describe(entry));
  }

  getGroup(name: string): ClusterResourceGroupInfo | null {
    const entry = this.groups.get(name.toLowerCase());
    return entry ? this.describe(entry) : null;
  }

  /** Called by `ClusterService` on every heartbeat tick — detects automatic failover (no `Move-ClusterGroup` involved) for every group this node knows about. */
  refreshOwnersAndPublish(): void {
    for (const key of this.groups.keys()) this.publishIfChanged(key);
  }

  private publishIfChanged(key: string): void {
    const entry = this.groups.get(key);
    if (!entry) return;
    const info = this.describe(entry);
    const previous = this.lastKnownOwners.get(key) ?? null;
    if (previous === info.ownerNode) return;
    this.lastKnownOwners.set(key, info.ownerNode);
    this.bus.publish({
      topic: 'cluster.group.moved',
      payload: { deviceId: this.deviceId, clusterName: this.cluster.clusterName, groupName: entry.name, fromNode: previous, toNode: info.ownerNode },
    });
  }

  private describe(entry: GroupEntry): ClusterResourceGroupInfo {
    const owner = entry.preferredOwners.find((n) => this.cluster.isNodeUp(n)) ?? entry.preferredOwners[0];
    return { name: entry.name, ownerNode: owner, resourceType: entry.resourceType };
  }
}
