/**
 * DfsReplicationGroup — DFSR (PRD-Windows-Server-Advanced.md §5 P16,
 * §2.1.15, MS-FRS2). Same pattern as AD replication (§5 P4's USN/
 * high-watermark pull cycle — `ReplicationSession.ts`), applied here to
 * file metadata (name, size, content hash, timestamp) instead of
 * directory objects: **same replication patron, second use case**, not a
 * second independent design.
 *
 * Wire payload: a JSON PDU over a real TCP connection on port 5722 —
 * DFSR's actual real-world default RPC endpoint — the same convention
 * `ReplicationSession.ts`/`SmbServerHandler`/`WinRmServerHandler` use for
 * their own JSON-over-TCP protocols rather than a byte-exact MS-FRS2
 * encoding.
 */
import type { TcpStack, TcpSocket } from '@/network/tcp/TcpStack';
import type { WindowsFileSystem } from '@/network/devices/windows/WindowsFileSystem';
import type { EndHost } from '@/network/devices/EndHost';
import { type IEventBus } from '@/events/EventBus';
import { detachedBus } from '@/events/BusHolder';

export const DFSR_PORT = 5722;

export interface DfsFileMeta {
  readonly size: number;
  readonly hash: string;
  readonly mtime: number;
  /** Per-file version — this simulator's stand-in for a real USN, bumped whenever the tracked content hash changes. */
  readonly version: number;
}

/** fileName -> version, this replicated folder's outbound vector (mirrors `HighWatermarkVector`'s DC-> USN shape). */
export type DfsFileVector = Record<string, number>;

function fnv1aHash(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/**
 * One folder replicated as part of a DFS Replication Group — tracks each
 * file's version by rescanning its physical path (a minimal stand-in for
 * a real filesystem change journal / USN journal watcher).
 */
export class DfsReplicatedFolder {
  private readonly versions = new Map<string, DfsFileMeta>();
  private nextVersion = 1;

  constructor(private readonly fs: WindowsFileSystem, readonly physicalPath: string) {
    this.fs.mkdirp(physicalPath);
    this.rescan();
  }

  /** Picks up local edits since the last scan, bumping the version for any file whose content hash changed. */
  rescan(): void {
    for (const { name, entry } of this.fs.listDirectory(this.physicalPath)) {
      if (entry.type !== 'file') continue;
      const hash = fnv1aHash(entry.content ?? '');
      const existing = this.versions.get(name);
      if (!existing || existing.hash !== hash) {
        this.versions.set(name, { size: entry.size, hash, mtime: entry.mtime.getTime(), version: this.nextVersion++ });
      }
    }
  }

  getOutboundVector(): DfsFileVector {
    this.rescan();
    const vector: DfsFileVector = {};
    for (const [name, meta] of this.versions) vector[name] = meta.version;
    return vector;
  }

  /** Every file this folder holds a strictly newer version of than `requesterVector` claims to have. */
  changesSince(requesterVector: DfsFileVector): { fileName: string; content: string; meta: DfsFileMeta }[] {
    this.rescan();
    const changes: { fileName: string; content: string; meta: DfsFileMeta }[] = [];
    for (const [fileName, meta] of this.versions) {
      if ((requesterVector[fileName] ?? 0) >= meta.version) continue;
      const file = this.fs.readFile(`${this.physicalPath}\\${fileName}`);
      if (file.ok) changes.push({ fileName, content: file.content ?? '', meta });
    }
    return changes;
  }

  /** Applies one replicated file — adopts the partner's version number directly, matching `DirectoryStore.applyReplicatedEntry`'s own stamp-adoption. */
  applyReplicatedFile(fileName: string, content: string, meta: DfsFileMeta): void {
    this.fs.createFile(`${this.physicalPath}\\${fileName}`, content);
    this.versions.set(fileName, meta);
  }

  listFiles(): { name: string; meta: DfsFileMeta }[] {
    this.rescan();
    return [...this.versions.entries()].map(([name, meta]) => ({ name, meta }));
  }
}

interface DfsrPullRequest {
  kind: 'pullRequest';
  groupName: string;
  requesterVector: DfsFileVector;
}
interface DfsrChangedFile { fileName: string; content: string; meta: DfsFileMeta }
interface DfsrPullResponse {
  kind: 'pullResponse';
  changes: DfsrChangedFile[];
}

/** Server side of a DFSR pull cycle — serves whichever replication group the requester names. */
export class DfsrServerHandler {
  constructor(private readonly groups: ReadonlyMap<string, DfsReplicatedFolder>) {}

  register(socket: TcpSocket): void {
    socket.onData((data) => {
      if (!(data instanceof Uint8Array)) return;
      let msg: DfsrPullRequest;
      try { msg = JSON.parse(new TextDecoder().decode(data)) as DfsrPullRequest; } catch { return; }
      if (msg.kind !== 'pullRequest') return;

      const folder = this.groups.get(msg.groupName);
      const changes: DfsrChangedFile[] = folder ? folder.changesSince(msg.requesterVector) : [];
      const response: DfsrPullResponse = { kind: 'pullResponse', changes };
      socket.send(new TextEncoder().encode(JSON.stringify(response)));
    });
  }
}

export interface DfsrPullResult {
  ok: boolean;
  error?: string;
  applied: number;
}

/** One DFSR replication cycle: dial `partnerIp`'s TCP/5722, send our vector for `groupName`, and apply whatever the partner has that we don't. */
export function pullDfsReplication(
  tcpStack: TcpStack, partnerIp: string, groupName: string, folder: DfsReplicatedFolder,
): DfsrPullResult {
  const socket = tcpStack.connect(partnerIp, DFSR_PORT);
  if (!socket || socket.state !== 'established') {
    return { ok: false, error: "A local error occurred (Can't contact the replication partner)", applied: 0 };
  }

  let response: DfsrPullResponse | null = null;
  const unsubscribe = socket.onData((data) => {
    if (!(data instanceof Uint8Array)) return;
    try { response = JSON.parse(new TextDecoder().decode(data)) as DfsrPullResponse; } catch { /* ignore malformed */ }
  });
  const request: DfsrPullRequest = { kind: 'pullRequest', groupName, requesterVector: folder.getOutboundVector() };
  socket.send(new TextEncoder().encode(JSON.stringify(request)));
  unsubscribe();

  if (!response || (response as DfsrPullResponse).kind !== 'pullResponse') {
    return { ok: false, error: 'no reply from replication partner', applied: 0 };
  }
  for (const change of (response as DfsrPullResponse).changes) folder.applyReplicatedFile(change.fileName, change.content, change.meta);
  return { ok: true, applied: (response as DfsrPullResponse).changes.length };
}

export interface DfsOpResult { ok: boolean; message: string }

/**
 * WindowsDfsrRole — the "DFS Replication" (FS-DFS-Replication) role,
 * `DFSR` service (PRD-Windows-Server-Advanced.md §5 P16): owns this
 * server's own membership in each replication group it's part of.
 */
/** One replication group's admin-side topology — real DFSR management (`New-DfsReplicationGroup`/`Add-DfsrMember`/`New-DfsReplicatedFolder`/`Add-DfsrConnection`/`Set-DfsrMembership`) is directory-driven: an admin defines membership/topology centrally (normally in AD) before any member ever touches a content path — distinct from `newGroup()`/`sync()` above, which model a single server's own local participation once that topology already exists. Since every test/caller in this simulator manages a group's topology from one admin session, tracking it here (on whichever server that session is connected to) is equivalent to a real directory-backed store without needing one. */
interface DfsrAdminGroupState {
  readonly name: string;
  description: string;
  readonly members: Set<string>;
  readonly memberDisplay: Map<string, string>;
  readonly folders: Set<string>;
  readonly folderDisplay: Map<string, string>;
  readonly connections: Array<{ source: string; destination: string }>;
  /** Keyed by `folderNameLower|computerNameLower`. */
  readonly memberships: Map<string, { contentPath: string; primaryMember: boolean }>;
}

export interface DfsrGroupInfo { readonly name: string; readonly description: string }
export interface DfsrMembershipInfo {
  readonly computerName: string; readonly folderName: string;
  readonly contentPath: string; readonly primaryMember: boolean;
}

export class WindowsDfsrRole {
  private readonly groups = new Map<string, DfsReplicatedFolder>();
  private readonly adminGroups = new Map<string, DfsrAdminGroupState>();

  constructor(
    private readonly host: EndHost,
    private readonly fs: WindowsFileSystem,
    private readonly bus: IEventBus = detachedBus(),
    private readonly deviceId: string = '',
  ) {}

  getGroups(): ReadonlyMap<string, DfsReplicatedFolder> { return this.groups; }

  /** `New-DfsReplicationGroup -GroupName <name> -ContentPath <localPath>` — run identically on every member server. */
  newGroup(groupName: string, contentPath: string): DfsOpResult {
    const key = groupName.toLowerCase();
    if (this.groups.has(key)) return { ok: false, message: `New-DfsReplicationGroup : A replication group named "${groupName}" already exists.` };
    this.groups.set(key, new DfsReplicatedFolder(this.fs, contentPath));
    return { ok: true, message: '' };
  }

  /** `New-DfsReplicationGroup -GroupName <name> [-Description <text>]` — the real cmdlet signature (no `-ContentPath`): defines the group's admin topology, populated afterwards by `Add-DfsrMember`/`New-DfsReplicatedFolder`/`Set-DfsrMembership`. */
  registerAdminGroup(groupName: string, description: string): DfsOpResult {
    const key = groupName.toLowerCase();
    if (this.adminGroups.has(key)) return { ok: false, message: `New-DfsReplicationGroup : A replication group named "${groupName}" already exists.` };
    this.adminGroups.set(key, {
      name: groupName, description, members: new Set(), memberDisplay: new Map(),
      folders: new Set(), folderDisplay: new Map(), connections: [], memberships: new Map(),
    });
    return { ok: true, message: '' };
  }

  getAdminGroup(groupName: string): DfsrGroupInfo | null {
    const g = this.adminGroups.get(groupName.toLowerCase());
    return g ? { name: g.name, description: g.description } : null;
  }

  /** `Add-DfsrMember -GroupName <name> -ComputerName <name[]>`. */
  addMembers(groupName: string, computerNames: string[]): DfsOpResult {
    const g = this.adminGroups.get(groupName.toLowerCase());
    if (!g) return { ok: false, message: `Add-DfsrMember : A replication group named "${groupName}" does not exist.` };
    for (const c of computerNames) g.memberDisplay.set(c.toLowerCase(), c);
    for (const c of computerNames) g.members.add(c.toLowerCase());
    return { ok: true, message: '' };
  }

  listMembers(groupName: string): string[] {
    const g = this.adminGroups.get(groupName.toLowerCase());
    return g ? [...g.memberDisplay.values()] : [];
  }

  /** `New-DfsReplicatedFolder -GroupName <name> -FolderName <name>` — the real cmdlet, distinct from the single implicit folder `newGroup()`'s `-ContentPath` models. */
  newReplicatedFolder(groupName: string, folderName: string): DfsOpResult {
    const g = this.adminGroups.get(groupName.toLowerCase());
    if (!g) return { ok: false, message: `New-DfsReplicatedFolder : A replication group named "${groupName}" does not exist.` };
    const key = folderName.toLowerCase();
    if (g.folders.has(key)) return { ok: false, message: `New-DfsReplicatedFolder : A replicated folder named "${folderName}" already exists in group "${groupName}".` };
    g.folders.add(key);
    g.folderDisplay.set(key, folderName);
    return { ok: true, message: '' };
  }

  /** `Add-DfsrConnection -GroupName <name> -SourceComputerName <a> -DestinationComputerName <b>`. */
  addConnection(groupName: string, source: string, destination: string): DfsOpResult {
    const g = this.adminGroups.get(groupName.toLowerCase());
    if (!g) return { ok: false, message: `Add-DfsrConnection : A replication group named "${groupName}" does not exist.` };
    if (!g.members.has(source.toLowerCase())) return { ok: false, message: `Add-DfsrConnection : "${source}" is not a member of replication group "${groupName}".` };
    if (!g.members.has(destination.toLowerCase())) return { ok: false, message: `Add-DfsrConnection : "${destination}" is not a member of replication group "${groupName}".` };
    g.connections.push({ source, destination });
    return { ok: true, message: '' };
  }

  /** `Set-DfsrMembership -GroupName <name> -FolderName <name> -ComputerName <name> -ContentPath <path> -PrimaryMember <bool>`. */
  setMembership(
    groupName: string, folderName: string, computerName: string, contentPath: string, primaryMember: boolean,
  ): DfsOpResult {
    const g = this.adminGroups.get(groupName.toLowerCase());
    if (!g) return { ok: false, message: `Set-DfsrMembership : A replication group named "${groupName}" does not exist.` };
    if (!g.folders.has(folderName.toLowerCase())) return { ok: false, message: `Set-DfsrMembership : A replicated folder named "${folderName}" does not exist in group "${groupName}".` };
    if (!g.members.has(computerName.toLowerCase())) return { ok: false, message: `Set-DfsrMembership : "${computerName}" is not a member of replication group "${groupName}".` };
    g.memberships.set(`${folderName.toLowerCase()}|${computerName.toLowerCase()}`, { contentPath, primaryMember });
    return { ok: true, message: '' };
  }

  listMemberships(groupName: string, folderName: string): DfsrMembershipInfo[] {
    const g = this.adminGroups.get(groupName.toLowerCase());
    if (!g) return [];
    const out: DfsrMembershipInfo[] = [];
    const folderKey = folderName.toLowerCase();
    for (const [key, state] of g.memberships) {
      const [fk, ck] = key.split('|');
      if (fk !== folderKey) continue;
      out.push({
        computerName: g.memberDisplay.get(ck) ?? ck, folderName: g.folderDisplay.get(fk) ?? fk,
        contentPath: state.contentPath, primaryMember: state.primaryMember,
      });
    }
    return out;
  }

  /** `Sync-DfsReplicationGroup -GroupName <name> -PartnerServer <address>` — one manually-triggered DFSR pull cycle (no scheduled/automatic replication modeled, per PRD §2.2 scope, mirroring `replicateFrom`'s own AD replication convention). */
  sync(groupName: string, partnerAddress: string): DfsrPullResult {
    const key = groupName.toLowerCase();
    const folder = this.groups.get(key);
    if (!folder) {
      const error = `Sync-DfsReplicationGroup : A replication group named "${groupName}" does not exist.`;
      this.bus.publish({ topic: 'dfs.replication.failed', payload: { deviceId: this.deviceId, groupName, error } });
      return { ok: false, error, applied: 0 };
    }
    const result = pullDfsReplication(this.host.getTcpStack(), partnerAddress, key, folder);
    if (result.ok) {
      this.bus.publish({ topic: 'dfs.replication.synced', payload: { deviceId: this.deviceId, groupName, filesApplied: result.applied } });
    } else {
      this.bus.publish({ topic: 'dfs.replication.failed', payload: { deviceId: this.deviceId, groupName, error: result.error ?? 'unknown error' } });
    }
    return result;
  }
}
