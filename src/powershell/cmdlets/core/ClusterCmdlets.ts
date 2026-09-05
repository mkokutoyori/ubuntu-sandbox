/**
 * ClusterCmdlets — Failover Clustering / WSFC minimal (PRD-Windows-
 * Server-Advanced.md §5 P18, §2.1.17, MS-CMRP): `New-Cluster` forms a
 * cluster identically on every member node; `Get-ClusterNode`/`Get-Cluster`
 * expose membership/quorum; `Add-ClusterFileServerRole`/`Get-ClusterGroup`/
 * `Move-ClusterGroup` manage the File Server resource group's failover.
 *
 * Simplification (documented per PRD §2.2): real WSFC resolves `-Node`
 * computer names via DNS. This simulator instead takes each peer's IP
 * directly via `-NodeAddress`, mirroring DFSR's own `-PartnerServer
 * <address>` convention (§5 P16) rather than adding a DNS round-trip to a
 * cmdlet execution model that is otherwise synchronous.
 */

import type { ICmdlet } from '../ICmdlet';
import type { CmdletContext } from '../CmdletContext';
import { PSRuntimeError } from '@/powershell/runtime/PSRuntime';
import type { PSValue } from '@/powershell/runtime/PSEnvironment';
import type { IClusterProvider, ClusterNodeInfo, ClusterGroupInfo } from '@/powershell/providers/PSProviders';
import { psValueToString } from '@/powershell/runtime/PSExpansion';
import { commandNotFoundMessage } from '@/powershell/commandNotFound';

function requireCluster(ctx: CmdletContext, cmdletName: string): IClusterProvider {
  if (!ctx.providers.cluster) {
    throw new PSRuntimeError(commandNotFoundMessage(cmdletName));
  }
  return ctx.providers.cluster;
}

function stringListOf(raw: PSValue | undefined): string[] {
  if (raw === undefined) return [];
  return Array.isArray(raw) ? raw.map(psValueToString) : [psValueToString(raw)];
}

function nodeToPSObject(n: ClusterNodeInfo): Record<string, PSValue> {
  return { NodeName: n.name, State: n.state };
}

function groupToPSObject(g: ClusterGroupInfo): Record<string, PSValue> {
  return { Name: g.name, OwnerNode: g.ownerNode, GroupType: g.resourceType };
}

// ── New-Cluster ──────────────────────────────────────────────────────────

export class NewClusterCmdlet implements ICmdlet {
  readonly name = 'new-cluster';
  readonly aliases = [] as const;
  readonly parameters = ['Name', 'Node', 'NodeAddress'] as const;
  readonly displayName = 'New-Cluster';

  execute(ctx: CmdletContext): PSValue {
    const cluster = requireCluster(ctx, 'New-Cluster');
    const clusterName = psValueToString(ctx.named['name'] ?? ctx.positional[0] ?? '');
    const nodeNames = stringListOf(ctx.named['node']);
    const nodeAddresses = stringListOf(ctx.named['nodeaddress']);
    if (!clusterName || nodeNames.length === 0 || nodeNames.length !== nodeAddresses.length) {
      ctx.emitError('New-Cluster : Cannot process command because of one or more missing mandatory parameters: Name Node NodeAddress.');
      return null;
    }
    const [selfNodeName, ...peerNames] = nodeNames;
    const peers = peerNames.map((peerName, i) => ({ name: peerName, ip: nodeAddresses[i + 1] }));
    const res = cluster.newCluster(clusterName, selfNodeName, peers);
    if (!res.ok) { ctx.emitError(res.message); return null; }
    return null;
  }
}

// ── Get-ClusterNode ──────────────────────────────────────────────────────

export class GetClusterNodeCmdlet implements ICmdlet {
  readonly name = 'get-clusternode';
  readonly aliases = [] as const;
  readonly parameters = [] as const;
  readonly displayName = 'Get-ClusterNode';

  execute(ctx: CmdletContext): PSValue {
    const cluster = requireCluster(ctx, 'Get-ClusterNode');
    return cluster.getClusterNodes().map(nodeToPSObject);
  }
}

// ── Get-Cluster ──────────────────────────────────────────────────────────

export class GetClusterCmdlet implements ICmdlet {
  readonly name = 'get-cluster';
  readonly aliases = [] as const;
  readonly parameters = [] as const;
  readonly displayName = 'Get-Cluster';

  execute(ctx: CmdletContext): PSValue {
    const cluster = requireCluster(ctx, 'Get-Cluster');
    return { HasQuorum: cluster.hasClusterQuorum() } as Record<string, PSValue>;
  }
}

// ── Add-ClusterFileServerRole ────────────────────────────────────────────

export class AddClusterFileServerRoleCmdlet implements ICmdlet {
  readonly name = 'add-clusterfileserverrole';
  readonly aliases = [] as const;
  readonly parameters = ['Name', 'Node'] as const;
  readonly displayName = 'Add-ClusterFileServerRole';

  execute(ctx: CmdletContext): PSValue {
    const cluster = requireCluster(ctx, 'Add-ClusterFileServerRole');
    const name = psValueToString(ctx.named['name'] ?? ctx.positional[0] ?? '');
    const preferredOwners = stringListOf(ctx.named['node']);
    if (!name || preferredOwners.length === 0) {
      ctx.emitError('Add-ClusterFileServerRole : Cannot process command because of one or more missing mandatory parameters: Name Node.');
      return null;
    }
    const res = cluster.addClusterFileServerRole(name, preferredOwners);
    if (!res.ok) { ctx.emitError(res.message); return null; }
    return null;
  }
}

// ── Get-ClusterGroup ─────────────────────────────────────────────────────

export class GetClusterGroupCmdlet implements ICmdlet {
  readonly name = 'get-clustergroup';
  readonly aliases = [] as const;
  readonly parameters = ['Name'] as const;
  readonly displayName = 'Get-ClusterGroup';

  execute(ctx: CmdletContext): PSValue {
    const cluster = requireCluster(ctx, 'Get-ClusterGroup');
    const name = psValueToString(ctx.named['name'] ?? ctx.positional[0] ?? '');
    const groups = cluster.getClusterGroups();
    if (!name) return groups.map(groupToPSObject);
    const found = groups.find((g) => g.name.toLowerCase() === name.toLowerCase());
    if (!found) { ctx.emitError(`Get-ClusterGroup : The group identifier "${name}" was not found.`); return null; }
    return groupToPSObject(found);
  }
}

// ── Move-ClusterGroup ────────────────────────────────────────────────────

export class MoveClusterGroupCmdlet implements ICmdlet {
  readonly name = 'move-clustergroup';
  readonly aliases = [] as const;
  readonly parameters = ['Name', 'Node'] as const;
  readonly displayName = 'Move-ClusterGroup';

  execute(ctx: CmdletContext): PSValue {
    const cluster = requireCluster(ctx, 'Move-ClusterGroup');
    const name = psValueToString(ctx.named['name'] ?? ctx.positional[0] ?? '');
    const targetNode = psValueToString(ctx.named['node'] ?? '');
    if (!name || !targetNode) {
      ctx.emitError('Move-ClusterGroup : Cannot process command because of one or more missing mandatory parameters: Name Node.');
      return null;
    }
    const res = cluster.moveClusterGroup(name, targetNode);
    if (!res.ok) { ctx.emitError(res.message); return null; }
    return null;
  }
}
