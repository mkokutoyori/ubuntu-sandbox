import {
  FileStat,
  FileSystemApi,
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

/**
 * Système de fichiers en mémoire — implémentation de référence de
 * FileSystemApi, utilisée pour les tests du command-kernel et comme
 * point de départ pour les futurs adaptateurs vers le vrai filesystem
 * simulé du projet (src/terminal/filesystem.ts).
 */
class InMemoryFileSystem implements FileSystemApi {
  private readonly files = new Map<string, string>();
  private readonly directories = new Set<string>(["/"]);
  private readonly modes = new Map<string, number>();
  private readonly owners = new Map<string, number>();

  async readFile(path: string): Promise<string> {
    const content = this.files.get(path);
    if (content === undefined) throw new Error(`fichier introuvable : ${path}`);
    return content;
  }

  async writeFile(path: string, content: string, append = false): Promise<void> {
    const existing = append ? (this.files.get(path) ?? "") : "";
    this.files.set(path, existing + content);
    if (!this.modes.has(path)) this.modes.set(path, 0o644);
    if (!this.owners.has(path)) this.owners.set(path, 0);
  }

  async list(path: string): Promise<FileStat[]> {
    const prefix = path === "/" ? "/" : `${path}/`;
    const stats: FileStat[] = [];
    for (const filePath of this.files.keys()) {
      if (filePath.startsWith(prefix) && !filePath.slice(prefix.length).includes("/")) {
        stats.push(await this.stat(filePath));
      }
    }
    for (const dirPath of this.directories) {
      if (dirPath !== path && dirPath.startsWith(prefix) && !dirPath.slice(prefix.length).includes("/")) {
        stats.push(await this.stat(dirPath));
      }
    }
    return stats;
  }

  async stat(path: string): Promise<FileStat> {
    if (this.directories.has(path)) {
      return {
        path,
        size: 0,
        isDirectory: true,
        ownerUid: this.owners.get(path) ?? 0,
        mode: this.modes.get(path) ?? 0o755,
        modifiedAt: new Date(),
      };
    }
    const content = this.files.get(path);
    if (content === undefined) throw new Error(`fichier introuvable : ${path}`);
    return {
      path,
      size: content.length,
      isDirectory: false,
      ownerUid: this.owners.get(path) ?? 0,
      mode: this.modes.get(path) ?? 0o644,
      modifiedAt: new Date(),
    };
  }

  async remove(path: string, recursive = false): Promise<void> {
    if (this.directories.has(path)) {
      if (!recursive) {
        const hasChildren = [...this.files.keys(), ...this.directories].some(
          (p) => p !== path && p.startsWith(`${path}/`),
        );
        if (hasChildren) throw new Error(`répertoire non vide : ${path}`);
      }
      this.directories.delete(path);
      for (const filePath of [...this.files.keys()]) {
        if (filePath.startsWith(`${path}/`)) this.files.delete(filePath);
      }
      return;
    }
    this.files.delete(path);
  }

  async mkdir(path: string): Promise<void> {
    this.directories.add(path);
  }

  async chmod(path: string, mode: number): Promise<void> {
    this.modes.set(path, mode);
  }

  async chown(path: string, uid: number): Promise<void> {
    this.owners.set(path, uid);
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

  constructor(
    readonly hostname: string = "sandbox",
    seedUsers: Map<string, User> = new Map(),
  ) {
    this.users = new InMemoryUserManagementApi(seedUsers);
  }

  now(): Date {
    return new Date();
  }
}
