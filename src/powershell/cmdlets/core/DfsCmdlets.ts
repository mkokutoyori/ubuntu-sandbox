/**
 * DfsCmdlets — DFS Namespaces + DFSR (PRD-Windows-Server-Advanced.md §5
 * P16, §2.1.15): `New-DfsnRoot`/`New-DfsnFolder`/`New-DfsnFolderTarget`/
 * `Get-DfsnFolder` build a logical namespace redirecting to real
 * `smbShares` targets; `New-DfsReplicationGroup`/`Sync-DfsReplicationGroup`
 * reuse the same USN/high-watermark replication patron as AD replication
 * (§5 P4), applied to file metadata instead of directory objects.
 */

import type { ICmdlet } from '../ICmdlet';
import type { CmdletContext } from '../CmdletContext';
import { PSRuntimeError } from '@/powershell/runtime/PSRuntime';
import type { PSValue } from '@/powershell/runtime/PSEnvironment';
import type { IDfsProvider, DfsFolderInfo } from '@/powershell/providers/PSProviders';
import { psValueToString } from '@/powershell/runtime/PSExpansion';
import { parseNamespacePath, parseUncTarget } from '@/network/devices/windows/server/dfs/DfsNamespace';

function requireDfs(ctx: CmdletContext, cmdletName: string): IDfsProvider {
  if (!ctx.providers.dfs) {
    throw new PSRuntimeError(`${cmdletName} is not recognized as the name of a cmdlet, function, script file, or operable program`);
  }
  return ctx.providers.dfs;
}

function pathOf(ctx: CmdletContext): string {
  return psValueToString(ctx.named['path'] ?? ctx.positional[0] ?? '');
}

function folderToPSObject(f: DfsFolderInfo): Record<string, PSValue> {
  return {
    Path: `${f.namespacePath}\\${f.folderName}`,
    TargetPaths: f.targets.map(t => `\\\\${t.serverAddress}\\${t.shareName}`),
  };
}

// ── New-DfsnRoot ─────────────────────────────────────────────────────────

export class NewDfsnRootCmdlet implements ICmdlet {
  readonly name = 'new-dfsnroot';
  readonly aliases = [] as const;
  readonly parameters = ['Path'] as const;

  execute(ctx: CmdletContext): PSValue {
    const dfs = requireDfs(ctx, 'New-DfsnRoot');
    const path = pathOf(ctx);
    if (!path) {
      ctx.emitError('New-DfsnRoot : Cannot process command because of one or more missing mandatory parameters: Path.');
      return null;
    }
    const res = dfs.newDfsnRoot(path);
    if (!res.ok) { ctx.emitError(res.message); return null; }
    return null;
  }
}

// ── New-DfsnFolder ───────────────────────────────────────────────────────

export class NewDfsnFolderCmdlet implements ICmdlet {
  readonly name = 'new-dfsnfolder';
  readonly aliases = [] as const;
  readonly parameters = ['Path', 'TargetPath'] as const;

  execute(ctx: CmdletContext): PSValue {
    const dfs = requireDfs(ctx, 'New-DfsnFolder');
    const path = pathOf(ctx);
    const targetPath = psValueToString(ctx.named['targetpath'] ?? '');
    const parsed = parseNamespacePath(path);
    const target = parseUncTarget(targetPath);
    if (!parsed || !target) {
      ctx.emitError('New-DfsnFolder : Cannot process command because of one or more missing mandatory parameters: Path TargetPath.');
      return null;
    }
    const res = dfs.newDfsnFolder(parsed.namespacePath, parsed.folderName, target);
    if (!res.ok) { ctx.emitError(res.message); return null; }
    const folder = dfs.getDfsnFolder(parsed.namespacePath, parsed.folderName);
    return folder ? folderToPSObject(folder) : null;
  }
}

// ── New-DfsnFolderTarget ─────────────────────────────────────────────────

export class NewDfsnFolderTargetCmdlet implements ICmdlet {
  readonly name = 'new-dfsnfoldertarget';
  readonly aliases = [] as const;
  readonly parameters = ['Path', 'TargetPath'] as const;

  execute(ctx: CmdletContext): PSValue {
    const dfs = requireDfs(ctx, 'New-DfsnFolderTarget');
    const path = pathOf(ctx);
    const targetPath = psValueToString(ctx.named['targetpath'] ?? '');
    const parsed = parseNamespacePath(path);
    const target = parseUncTarget(targetPath);
    if (!parsed || !target) {
      ctx.emitError('New-DfsnFolderTarget : Cannot process command because of one or more missing mandatory parameters: Path TargetPath.');
      return null;
    }
    const res = dfs.addDfsnFolderTarget(parsed.namespacePath, parsed.folderName, target);
    if (!res.ok) { ctx.emitError(res.message); return null; }
    const folder = dfs.getDfsnFolder(parsed.namespacePath, parsed.folderName);
    return folder ? folderToPSObject(folder) : null;
  }
}

// ── Get-DfsnFolder ───────────────────────────────────────────────────────

export class GetDfsnFolderCmdlet implements ICmdlet {
  readonly name = 'get-dfsnfolder';
  readonly aliases = [] as const;
  readonly parameters = ['Path'] as const;

  execute(ctx: CmdletContext): PSValue {
    const dfs = requireDfs(ctx, 'Get-DfsnFolder');
    const path = pathOf(ctx);
    const parsed = parseNamespacePath(path);
    if (!parsed) {
      ctx.emitError('Get-DfsnFolder : Cannot process command because of one or more missing mandatory parameters: Path.');
      return null;
    }
    const folder = dfs.getDfsnFolder(parsed.namespacePath, parsed.folderName);
    if (!folder) { ctx.emitError(`Get-DfsnFolder : No DFSN folder found for "${path}".`); return null; }
    return folderToPSObject(folder);
  }
}

// ── New-DfsReplicationGroup ──────────────────────────────────────────────

export class NewDfsReplicationGroupCmdlet implements ICmdlet {
  readonly name = 'new-dfsreplicationgroup';
  readonly aliases = [] as const;
  readonly parameters = ['GroupName', 'ContentPath'] as const;

  execute(ctx: CmdletContext): PSValue {
    const dfs = requireDfs(ctx, 'New-DfsReplicationGroup');
    const groupName = psValueToString(ctx.named['groupname'] ?? ctx.positional[0] ?? '');
    const contentPath = psValueToString(ctx.named['contentpath'] ?? '');
    if (!groupName || !contentPath) {
      ctx.emitError('New-DfsReplicationGroup : Cannot process command because of one or more missing mandatory parameters: GroupName ContentPath.');
      return null;
    }
    const res = dfs.newDfsReplicationGroup(groupName, contentPath);
    if (!res.ok) { ctx.emitError(res.message); return null; }
    return null;
  }
}

// ── Sync-DfsReplicationGroup ─────────────────────────────────────────────

export class SyncDfsReplicationGroupCmdlet implements ICmdlet {
  readonly name = 'sync-dfsreplicationgroup';
  readonly aliases = [] as const;
  readonly parameters = ['GroupName', 'PartnerServer'] as const;

  execute(ctx: CmdletContext): PSValue {
    const dfs = requireDfs(ctx, 'Sync-DfsReplicationGroup');
    const groupName = psValueToString(ctx.named['groupname'] ?? ctx.positional[0] ?? '');
    const partnerServer = psValueToString(ctx.named['partnerserver'] ?? '');
    if (!groupName || !partnerServer) {
      ctx.emitError('Sync-DfsReplicationGroup : Cannot process command because of one or more missing mandatory parameters: GroupName PartnerServer.');
      return null;
    }
    const res = dfs.syncDfsReplicationGroup(groupName, partnerServer);
    if (!res.ok) { ctx.emitError(`Sync-DfsReplicationGroup : ${res.error}`); return null; }
    return { FilesApplied: res.applied } as Record<string, PSValue>;
  }
}
