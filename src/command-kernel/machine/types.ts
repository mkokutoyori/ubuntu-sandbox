/**
 * Façade des méthodes internes de la machine — c'est CE que les commandes
 * appellent réellement. Les commandes ne touchent jamais l'implémentation
 * réelle d'un équipement : elles ne connaissent que cette façade, ce qui
 * la rend testable, mockable et auditable indépendamment du vendeur
 * (Linux, Windows, Cisco IOS, Huawei VRP…).
 */

export type FileNodeType = "file" | "directory" | "symlink" | "fifo" | "chardev";

/**
 * Identité de l'appelant pour les opérations sensibles aux permissions.
 * Portée explicitement à chaque appel (jamais mémorisée sur l'implémentation
 * de `FileSystemApi`, partagée entre toutes les sessions) : le contrôle
 * d'accès dépend de QUI appelle, pas de QUELLE machine répond.
 */
export interface FileSystemActor {
  readonly uid: number;
  readonly gid: number;
  readonly gids?: readonly number[];
}

export interface FileStat {
  readonly path: string;
  readonly type: FileNodeType;
  readonly size: number;
  readonly ownerUid: number;
  readonly ownerGid: number;
  readonly mode: number; // ex: 0o644
  readonly linkCount: number;
  readonly inode: number;
  readonly modifiedAt: Date;
  readonly symlinkTarget?: string;
}

export interface FileSystemApi {
  readFile(path: string, actor: FileSystemActor): Promise<string>;
  writeFile(path: string, content: string, actor: FileSystemActor, append?: boolean): Promise<void>;
  list(path: string, actor: FileSystemActor): Promise<FileStat[]>;
  stat(path: string, actor: FileSystemActor): Promise<FileStat>;
  lstat(path: string, actor: FileSystemActor): Promise<FileStat>;
  exists(path: string, actor: FileSystemActor): Promise<boolean>;
  remove(path: string, actor: FileSystemActor, recursive?: boolean): Promise<void>;
  mkdir(path: string, actor: FileSystemActor, parents?: boolean): Promise<void>;
  chmod(path: string, mode: number, actor: FileSystemActor): Promise<void>;
  chown(path: string, uid: number, gid: number, actor: FileSystemActor): Promise<void>;
  copy(source: string, destination: string, actor: FileSystemActor): Promise<void>;
  rename(source: string, destination: string, actor: FileSystemActor): Promise<void>;
  symlink(target: string, path: string, actor: FileSystemActor): Promise<void>;
  readlink(path: string, actor: FileSystemActor): Promise<string>;
  resolve(cwd: string, path: string): string; // résolution relative/absolue
}

export interface ProcessInfo {
  readonly pid: number;
  readonly command: string;
  readonly ownerUid: number;
}

export interface ProcessApi {
  list(): Promise<ProcessInfo[]>;
  kill(pid: number, signal?: string): Promise<void>;
  spawn(command: string, argv: string[]): Promise<ProcessInfo>;
}

export interface NetworkApi {
  interfaces(): Promise<{ name: string; ip: string; up: boolean }[]>;
  setInterfaceState(name: string, up: boolean): Promise<void>;
}

export interface UserManagementApi {
  findByName(name: string): Promise<import("../session/types").User | undefined>;
  findByUid(uid: number): Promise<import("../session/types").User | undefined>;
  create(name: string, groups: string[]): Promise<import("../session/types").User>;
  delete(uid: number): Promise<void>;
}

export interface PowerApi {
  shutdown(delaySeconds: number): Promise<void>;
  reboot(): Promise<void>;
}

export interface GroupInfo {
  readonly gid: number;
  readonly name: string;
}

export interface GroupManagementApi {
  findByGid(gid: number): Promise<GroupInfo | undefined>;
  findByName(name: string): Promise<GroupInfo | undefined>;
}

/** Point d'entrée UNIQUE vers l'intérieur de la machine. */
export interface MachineApi {
  readonly fs: FileSystemApi;
  readonly proc: ProcessApi;
  readonly net: NetworkApi;
  readonly users: UserManagementApi;
  readonly groups: GroupManagementApi;
  readonly power: PowerApi;
  readonly hostname: string;
  now(): Date;
}

/** Dérive l'acteur `FileSystemApi` d'un `User` de session — point unique, partagé par l'Executor et par les commandes. */
export function toFileSystemActor(user: import("../session/types").User): FileSystemActor {
  return { uid: user.uid, gid: user.gid, gids: user.supplementaryGids ?? [] };
}
