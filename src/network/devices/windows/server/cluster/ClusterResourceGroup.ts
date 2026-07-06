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
 */
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

  constructor(private readonly cluster: ClusterService) {}

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

  private describe(entry: GroupEntry): ClusterResourceGroupInfo {
    const owner = entry.preferredOwners.find((n) => this.cluster.isNodeUp(n)) ?? entry.preferredOwners[0];
    return { name: entry.name, ownerNode: owner, resourceType: entry.resourceType };
  }
}
