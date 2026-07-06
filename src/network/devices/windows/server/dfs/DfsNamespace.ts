/**
 * DfsNamespace — DFS Namespaces (PRD-Windows-Server-Advanced.md §5 P16,
 * §2.1.15, MS-DFSNM). `New-DfsnRoot`/`New-DfsnFolder` build a logical
 * path (`\\domain\namespace\folder`) that redirects to one or more real
 * `smbShares` targets, already delivered at P3 — purely a metadata
 * registry, resolution is a local lookup (no new wire protocol; the
 * client dials the resolved target's real SMB share exactly as it would
 * any other UNC path).
 */

export interface DfsOpResult { ok: boolean; message: string }

export interface DfsTarget {
  readonly serverAddress: string;
  readonly shareName: string;
}

export interface DfsFolderInfo {
  readonly namespacePath: string;
  readonly folderName: string;
  readonly targets: readonly DfsTarget[];
}

interface FolderState {
  folderName: string;
  targets: DfsTarget[];
}

interface RootState {
  namespacePath: string;
  folders: Map<string, FolderState>;
}

/** Splits a full DFSN path (`\\domain\namespace\folder`) into its root (`\\domain\namespace`) and folder-name parts. Only flat, one-level folders are supported (matches this phase's minimal scope). */
export function parseNamespacePath(fullPath: string): { namespacePath: string; folderName: string } | null {
  const segments = fullPath.split('\\').filter(s => s.length > 0);
  if (segments.length < 3) return null;
  return { namespacePath: `\\\\${segments[0]}\\${segments[1]}`, folderName: segments[2] };
}

/** Parses a UNC target path (`\\serverAddress\shareName`) into a `DfsTarget`. */
export function parseUncTarget(uncPath: string): DfsTarget | null {
  const segments = uncPath.split('\\').filter(s => s.length > 0);
  if (segments.length < 2) return null;
  return { serverAddress: segments[0], shareName: segments[1] };
}

export class DfsNamespaceRegistry {
  private readonly roots = new Map<string, RootState>();

  private normalize(path: string): string {
    return path.toLowerCase();
  }

  /** `New-DfsnRoot -Path <namespacePath>` — e.g. `\\lab.local\Public`. */
  newRoot(namespacePath: string): DfsOpResult {
    const key = this.normalize(namespacePath);
    if (this.roots.has(key)) return { ok: false, message: `New-DfsnRoot : The namespace "${namespacePath}" already exists.` };
    this.roots.set(key, { namespacePath, folders: new Map() });
    return { ok: true, message: '' };
  }

  listRoots(): string[] {
    return [...this.roots.values()].map(r => r.namespacePath);
  }

  /** `New-DfsnFolder -Path <namespacePath>\<folderName> -TargetPath <\\server\share>` (one or more targets). */
  newFolder(namespacePath: string, folderName: string, targets: DfsTarget[]): DfsOpResult {
    const root = this.roots.get(this.normalize(namespacePath));
    if (!root) return { ok: false, message: `New-DfsnFolder : The namespace "${namespacePath}" does not exist.` };
    const folderKey = folderName.toLowerCase();
    if (root.folders.has(folderKey)) return { ok: false, message: `New-DfsnFolder : The folder "${folderName}" already exists.` };
    if (targets.length === 0) return { ok: false, message: 'New-DfsnFolder : At least one target is required.' };
    root.folders.set(folderKey, { folderName, targets: [...targets] });
    return { ok: true, message: '' };
  }

  /** `New-DfsnFolderTarget` — adds another target to an existing folder (multi-target load-balanced/failover namespace). */
  addFolderTarget(namespacePath: string, folderName: string, target: DfsTarget): DfsOpResult {
    const root = this.roots.get(this.normalize(namespacePath));
    if (!root) return { ok: false, message: `New-DfsnFolderTarget : The namespace "${namespacePath}" does not exist.` };
    const folder = root.folders.get(folderName.toLowerCase());
    if (!folder) return { ok: false, message: `New-DfsnFolderTarget : The folder "${folderName}" does not exist.` };
    folder.targets.push(target);
    return { ok: true, message: '' };
  }

  getFolder(namespacePath: string, folderName: string): DfsFolderInfo | null {
    const root = this.roots.get(this.normalize(namespacePath));
    const folder = root?.folders.get(folderName.toLowerCase());
    return folder ? { namespacePath, folderName: folder.folderName, targets: folder.targets } : null;
  }

  listFolders(namespacePath: string): DfsFolderInfo[] {
    const root = this.roots.get(this.normalize(namespacePath));
    if (!root) return [];
    return [...root.folders.values()].map(f => ({ namespacePath, folderName: f.folderName, targets: f.targets }));
  }

  /** The client-facing resolution step — every real target this logical folder currently redirects to. */
  resolve(namespacePath: string, folderName: string): readonly DfsTarget[] | null {
    return this.getFolder(namespacePath, folderName)?.targets ?? null;
  }
}
