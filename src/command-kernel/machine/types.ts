/**
 * Façade des méthodes internes de la machine — c'est CE que les commandes
 * appellent réellement. Les commandes ne touchent jamais l'implémentation
 * réelle d'un équipement : elles ne connaissent que cette façade, ce qui
 * la rend testable, mockable et auditable indépendamment du vendeur
 * (Linux, Windows, Cisco IOS, Huawei VRP…).
 */

export interface FileStat {
  readonly path: string;
  readonly size: number;
  readonly isDirectory: boolean;
  readonly ownerUid: number;
  readonly mode: number; // ex: 0o644
  readonly modifiedAt: Date;
}

export interface FileSystemApi {
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string, append?: boolean): Promise<void>;
  list(path: string): Promise<FileStat[]>;
  stat(path: string): Promise<FileStat>;
  remove(path: string, recursive?: boolean): Promise<void>;
  mkdir(path: string): Promise<void>;
  chmod(path: string, mode: number): Promise<void>;
  chown(path: string, uid: number, gid: number): Promise<void>;
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
  create(name: string, groups: string[]): Promise<import("../session/types").User>;
  delete(uid: number): Promise<void>;
}

export interface PowerApi {
  shutdown(delaySeconds: number): Promise<void>;
  reboot(): Promise<void>;
}

/** Point d'entrée UNIQUE vers l'intérieur de la machine. */
export interface MachineApi {
  readonly fs: FileSystemApi;
  readonly proc: ProcessApi;
  readonly net: NetworkApi;
  readonly users: UserManagementApi;
  readonly power: PowerApi;
  readonly hostname: string;
  now(): Date;
}
