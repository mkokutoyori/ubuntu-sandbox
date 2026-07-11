import { FileSystemError } from "../errors";
import {
  FileNodeType,
  FileStat,
  FileSystemActor,
  FileSystemApi,
  GroupInfo,
  GroupManagementApi,
  MachineApi,
  NetworkApi,
  PowerApi,
  ProcessApi,
  ProcessInfo,
  UserManagementApi,
} from "../machine/types";
import { SimpleUser, User } from "../session/types";

function normalize(path: string): string {
  const isAbsolute = path.startsWith("/");
  const parts = path.split("/").filter((p) => p.length > 0 && p !== ".");
  const stack: string[] = [];
  for (const part of parts) {
    if (part === "..") stack.pop();
    else stack.push(part);
  }
  const joined = stack.join("/");
  return isAbsolute ? `/${joined}` : joined || ".";
}

interface InMemoryNode {
  id: number;
  type: FileNodeType;
  content: string;
  mode: number;
  uid: number;
  gid: number;
  symlinkTarget?: string;
  modifiedAt: Date;
}

/**
 * Système de fichiers en mémoire — implémentation de référence de
 * FileSystemApi, avec de vrais contrôles de permission POSIX (owner/group/
 * other). Utilisée pour les tests du command-kernel et comme squelette
 * d'implémentation pour brancher un futur équipement dessus.
 */
class InMemoryFileSystem implements FileSystemApi {
  private readonly nodes = new Map<string, InMemoryNode>();
  private nextInode = 1;

  constructor() {
    this.nodes.set("/", { id: this.nextInode++, type: "directory", content: "", mode: 0o755, uid: 0, gid: 0, modifiedAt: new Date() });
  }

  private checkAccess(node: InMemoryNode, mode: "r" | "w" | "x", actor: FileSystemActor): boolean {
    if (actor.uid === 0) return true;
    const bit = mode === "r" ? 4 : mode === "w" ? 2 : 1;
    const perms = node.mode & 0o777;
    if (node.uid === actor.uid) return ((perms >> 6) & bit) !== 0;
    if (node.gid === actor.gid || (actor.gids ?? []).includes(node.gid)) return ((perms >> 3) & bit) !== 0;
    return (perms & bit) !== 0;
  }

  private requireNode(path: string): InMemoryNode {
    const node = this.nodes.get(path);
    if (!node) throw new FileSystemError(path, "ENOENT", `${path}: No such file or directory`);
    return node;
  }

  private parentOf(path: string): { parentPath: string; parent: InMemoryNode; basename: string } {
    const slash = path.lastIndexOf("/");
    const parentPath = slash <= 0 ? "/" : path.slice(0, slash);
    const basename = path.slice(slash + 1);
    const parent = this.requireNode(parentPath);
    if (parent.type !== "directory") {
      throw new FileSystemError(parentPath, "ENOTDIR", `${parentPath}: Not a directory`);
    }
    return { parentPath, parent, basename };
  }

  private toStat(path: string, node: InMemoryNode): FileStat {
    return {
      path,
      type: node.type,
      size: node.content.length,
      ownerUid: node.uid,
      ownerGid: node.gid,
      mode: node.mode,
      linkCount: node.type === "directory" ? 2 : 1,
      inode: node.id,
      modifiedAt: node.modifiedAt,
      symlinkTarget: node.symlinkTarget,
    };
  }

  async readFile(path: string, actor: FileSystemActor): Promise<string> {
    const node = this.requireNode(path);
    if (node.type === "directory") {
      throw new FileSystemError(path, "EISDIR", `${path}: Is a directory`);
    }
    if (!this.checkAccess(node, "r", actor)) {
      throw new FileSystemError(path, "EACCES", `${path}: Permission denied`);
    }
    return node.content;
  }

  async writeFile(path: string, content: string, actor: FileSystemActor, append = false): Promise<void> {
    const existing = this.nodes.get(path);
    if (existing) {
      if (existing.type === "directory") {
        throw new FileSystemError(path, "EISDIR", `${path}: Is a directory`);
      }
      if (!this.checkAccess(existing, "w", actor)) {
        throw new FileSystemError(path, "EACCES", `${path}: Permission denied`);
      }
      existing.content = append ? existing.content + content : content;
      existing.modifiedAt = new Date();
      return;
    }
    const slash = path.lastIndexOf("/");
    const parentPath = slash <= 0 ? "/" : path.slice(0, slash);
    if (!this.nodes.has(parentPath)) await this.mkdir(parentPath, actor, true);
    const { parent } = this.parentOf(path);
    if (!this.checkAccess(parent, "w", actor)) {
      throw new FileSystemError(parentPath, "EACCES", `${parentPath}: Permission denied`);
    }
    this.nodes.set(path, {
      id: this.nextInode++,
      type: "file",
      content,
      mode: 0o644,
      uid: actor.uid,
      gid: actor.gid,
      modifiedAt: new Date(),
    });
  }

  async touch(path: string, actor: FileSystemActor): Promise<void> {
    const existing = this.nodes.get(path);
    if (existing) {
      if (!this.checkAccess(existing, "w", actor)) {
        throw new FileSystemError(path, "EACCES", `${path}: Permission denied`);
      }
      existing.modifiedAt = new Date();
      return;
    }
    await this.writeFile(path, "", actor, false);
  }

  async list(path: string, actor: FileSystemActor): Promise<FileStat[]> {
    const node = this.requireNode(path);
    if (node.type !== "directory") {
      throw new FileSystemError(path, "ENOTDIR", `${path}: Not a directory`);
    }
    if (!this.checkAccess(node, "r", actor)) {
      throw new FileSystemError(path, "EACCES", `${path}: Permission denied`);
    }
    const prefix = path === "/" ? "/" : `${path}/`;
    const stats: FileStat[] = [];
    for (const [candidate, candidateNode] of this.nodes) {
      if (candidate !== path && candidate.startsWith(prefix) && !candidate.slice(prefix.length).includes("/")) {
        stats.push(this.toStat(candidate, candidateNode));
      }
    }
    return stats;
  }

  async stat(path: string, _actor: FileSystemActor): Promise<FileStat> {
    return this.toStat(path, this.requireNode(path));
  }

  async lstat(path: string, actor: FileSystemActor): Promise<FileStat> {
    return this.stat(path, actor);
  }

  async exists(path: string, _actor: FileSystemActor): Promise<boolean> {
    return this.nodes.has(path);
  }

  async remove(path: string, actor: FileSystemActor, recursive = false): Promise<void> {
    const node = this.requireNode(path);
    const { parent, parentPath } = this.parentOf(path);
    if (!this.checkAccess(parent, "w", actor)) {
      throw new FileSystemError(parentPath, "EACCES", `${parentPath}: Permission denied`);
    }
    if (node.type === "directory") {
      const prefix = `${path === "/" ? "" : path}/`;
      const children = [...this.nodes.keys()].filter((p) => p.startsWith(prefix));
      if (children.length > 0 && !recursive) {
        throw new FileSystemError(path, "ENOTEMPTY", `${path}: Directory not empty`);
      }
      for (const child of children) this.nodes.delete(child);
    }
    this.nodes.delete(path);
  }

  async mkdir(path: string, actor: FileSystemActor, parents = false): Promise<void> {
    if (this.nodes.has(path)) {
      if (parents) return;
      throw new FileSystemError(path, "EEXIST", `${path}: File exists`);
    }
    if (parents) {
      const segments = path.split("/").filter(Boolean);
      let current = "";
      for (const segment of segments) {
        current += `/${segment}`;
        if (!this.nodes.has(current)) await this.mkdir(current, actor, false);
      }
      return;
    }
    const { parent, parentPath } = this.parentOf(path);
    if (!this.checkAccess(parent, "w", actor)) {
      throw new FileSystemError(parentPath, "EACCES", `${parentPath}: Permission denied`);
    }
    this.nodes.set(path, { id: this.nextInode++, type: "directory", content: "", mode: 0o755, uid: actor.uid, gid: actor.gid, modifiedAt: new Date() });
  }

  async chmod(path: string, mode: number, actor: FileSystemActor): Promise<void> {
    const node = this.requireNode(path);
    if (actor.uid !== 0 && actor.uid !== node.uid) {
      throw new FileSystemError(path, "EACCES", `${path}: Operation not permitted`);
    }
    node.mode = mode;
  }

  async chown(path: string, uid: number, gid: number, actor: FileSystemActor): Promise<void> {
    const node = this.requireNode(path);
    if (actor.uid !== 0) {
      throw new FileSystemError(path, "EACCES", `${path}: Operation not permitted`);
    }
    node.uid = uid;
    node.gid = gid;
  }

  async copy(source: string, destination: string, actor: FileSystemActor): Promise<void> {
    const content = await this.readFile(source, actor);
    await this.writeFile(destination, content, actor, false);
  }

  async rename(source: string, destination: string, actor: FileSystemActor): Promise<void> {
    const node = this.requireNode(source);
    const { parent: srcParent, parentPath: srcParentPath } = this.parentOf(source);
    if (!this.checkAccess(srcParent, "w", actor)) {
      throw new FileSystemError(srcParentPath, "EACCES", `${srcParentPath}: Permission denied`);
    }
    this.nodes.delete(source);
    this.nodes.set(destination, node);
  }

  async symlink(target: string, path: string, actor: FileSystemActor): Promise<void> {
    if (this.nodes.has(path)) {
      throw new FileSystemError(path, "EEXIST", `${path}: File exists`);
    }
    this.nodes.set(path, {
      id: this.nextInode++,
      type: "symlink",
      content: "",
      mode: 0o777,
      uid: actor.uid,
      gid: actor.gid,
      symlinkTarget: target,
      modifiedAt: new Date(),
    });
  }

  async readlink(path: string, _actor: FileSystemActor): Promise<string> {
    const node = this.requireNode(path);
    if (node.type !== "symlink" || node.symlinkTarget === undefined) {
      throw new FileSystemError(path, "EACCES", `${path}: Invalid argument`);
    }
    return node.symlinkTarget;
  }

  resolve(cwd: string, path: string): string {
    if (path.startsWith("/")) return normalize(path);
    return normalize(`${cwd}/${path}`);
  }
}

class InMemoryProcessApi implements ProcessApi {
  private readonly processes = new Map<number, ProcessInfo>();
  private nextPid = 1;

  async list(): Promise<ProcessInfo[]> {
    return [...this.processes.values()];
  }

  async kill(pid: number): Promise<void> {
    if (!this.processes.delete(pid)) {
      throw new Error(`processus introuvable : ${pid}`);
    }
  }

  async spawn(command: string): Promise<ProcessInfo> {
    const info: ProcessInfo = { pid: this.nextPid++, command, ownerUid: 0 };
    this.processes.set(info.pid, info);
    return info;
  }
}

class InMemoryNetworkApi implements NetworkApi {
  private readonly ifaces = new Map<string, { name: string; ip: string; up: boolean }>([
    ["eth0", { name: "eth0", ip: "0.0.0.0", up: true }],
  ]);

  async interfaces(): Promise<{ name: string; ip: string; up: boolean }[]> {
    return [...this.ifaces.values()];
  }

  async setInterfaceState(name: string, up: boolean): Promise<void> {
    const iface = this.ifaces.get(name);
    if (!iface) throw new Error(`interface introuvable : ${name}`);
    iface.up = up;
  }
}

class InMemoryUserManagementApi implements UserManagementApi {
  constructor(private readonly users: Map<string, User>) {}

  async findByName(name: string): Promise<User | undefined> {
    return this.users.get(name);
  }

  async findByUid(uid: number): Promise<User | undefined> {
    return [...this.users.values()].find((u) => u.uid === uid);
  }

  async create(name: string, groups: string[]): Promise<User> {
    const uid = this.users.size + 1000;
    const user = new SimpleUser(uid, uid, name, new Set(groups));
    this.users.set(name, user);
    return user;
  }

  async delete(uid: number): Promise<void> {
    for (const [name, user] of this.users) {
      if (user.uid === uid) this.users.delete(name);
    }
  }
}

class InMemoryGroupManagementApi implements GroupManagementApi {
  constructor(private readonly users: Map<string, User>) {}

  async findByGid(gid: number): Promise<GroupInfo | undefined> {
    const user = [...this.users.values()].find((u) => u.gid === gid);
    return user ? { gid, name: user.name } : undefined;
  }

  async findByName(name: string): Promise<GroupInfo | undefined> {
    const user = this.users.get(name);
    return user ? { gid: user.gid, name: user.name } : undefined;
  }
}

class InMemoryPowerApi implements PowerApi {
  shutdownCalls: number[] = [];
  rebootCalls = 0;

  async shutdown(delaySeconds: number): Promise<void> {
    this.shutdownCalls.push(delaySeconds);
  }

  async reboot(): Promise<void> {
    this.rebootCalls++;
  }
}

/**
 * Machine de référence entièrement en mémoire — utilisée par les tests
 * du command-kernel et comme squelette d'implémentation pour brancher
 * un futur équipement (LinuxPC, CiscoRouter…) sur cette architecture.
 */
export class InMemoryMachine implements MachineApi {
  readonly fs = new InMemoryFileSystem();
  readonly proc = new InMemoryProcessApi();
  readonly net = new InMemoryNetworkApi();
  readonly power = new InMemoryPowerApi();
  readonly users: InMemoryUserManagementApi;
  readonly groups: GroupManagementApi;

  constructor(
    readonly hostname: string = "sandbox",
    seedUsers: Map<string, User> = new Map(),
  ) {
    this.users = new InMemoryUserManagementApi(seedUsers);
    this.groups = new InMemoryGroupManagementApi(seedUsers);
  }

  now(): Date {
    return new Date();
  }
}
