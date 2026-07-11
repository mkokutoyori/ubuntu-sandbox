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
  readonly name?: string;
  readonly groupNames?: readonly string[];
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
  /** Crée un fichier vide s'il n'existe pas, ou ne fait que rafraîchir sa
   *  date de modification s'il existe déjà (sans réécrire son contenu). */
  touch(path: string, actor: FileSystemActor): Promise<void>;
  list(path: string, actor: FileSystemActor): Promise<FileStat[]>;
  stat(path: string, actor: FileSystemActor): Promise<FileStat>;
  lstat(path: string, actor: FileSystemActor): Promise<FileStat>;
  exists(path: string, actor: FileSystemActor): Promise<boolean>;
  remove(path: string, actor: FileSystemActor, recursive?: boolean): Promise<void>;
  mkdir(path: string, actor: FileSystemActor, parents?: boolean): Promise<void>;
  /** Supprime un répertoire — échoue (ENOTEMPTY) s'il n'est pas vide, contrairement à `remove(path, actor, true)`. */
  rmdir(path: string, actor: FileSystemActor): Promise<void>;
  chmod(path: string, mode: number, actor: FileSystemActor): Promise<void>;
  chown(path: string, uid: number, gid: number, actor: FileSystemActor): Promise<void>;
  copy(source: string, destination: string, actor: FileSystemActor): Promise<void>;
  rename(source: string, destination: string, actor: FileSystemActor): Promise<void>;
  symlink(target: string, path: string, actor: FileSystemActor): Promise<void>;
  readlink(path: string, actor: FileSystemActor): Promise<string>;
  /** Lien physique : `path` désigne désormais le même inode que `targetPath` (partage de contenu, `linkCount` incrémenté). */
  link(targetPath: string, path: string, actor: FileSystemActor): Promise<void>;
  /**
   * Info du volume/disque contenant `path` (numéro de série, octets
   * libres/totaux) — optionnel : tous les vendeurs ne modélisent pas de
   * volumes distincts (ex: `dir`/`vol` sous Windows). `undefined` si le
   * vendeur ne l'implémente pas OU si `path` ne désigne aucun volume connu.
   */
  volumeInfo?(path: string): Promise<{ serial: string; freeBytes: number; totalBytes: number } | undefined>;
  /** Optionnel : lettres de lecteur montées (`wmic logicaldisk`, `Get-PSDrive`) — vendeurs sans notion de volumes distincts n'ont rien à implémenter. */
  listDrives?(): Promise<string[]>;
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
  /**
   * Échappatoire vendeur : l'objet process-manager réel derrière cette
   * API (ex: le `WindowsProcessManager` complet), pour les commandes dont
   * la richesse (session, mémoire détaillée, services hébergés, titre de
   * fenêtre...) est trop spécifique à un vendeur pour justifier une
   * extension générique de `ProcessInfo` (`tasklist /SVC`, `/V`...).
   * Typé `unknown` ici — chaque commande fait le cast vers le type
   * concret qu'elle attend, jamais l'inverse (le générique ne doit rien
   * savoir du type réel).
   */
  native?: unknown;
}

export interface NetworkApi {
  /** `dhcp` optionnel : seuls certains vendeurs (Windows) le suivent par interface. */
  interfaces(): Promise<{ name: string; ip: string; up: boolean; dhcp?: boolean }[]>;
  setInterfaceState(name: string, up: boolean): Promise<void>;
  /** Échappatoire vendeur — voir `ProcessApi.native` pour le principe (ex: la `SocketTable` réelle pour `netstat`). */
  native?: unknown;
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

/**
 * Capacité optionnelle : trace d'audit (syscalls simulés) pour les
 * équipements qui en tiennent une (auditd Linux...). Absente pour les
 * profils qui n'en ont pas besoin — les commandes doivent l'appeler avec
 * `ctx.machine.audit?.` .
 */
export interface AuditApi {
  fsAccess(path: string, perm: "r" | "w" | "x" | "a", syscall?: string): void;
  syscall(name: string, path?: string): void;
}

/**
 * Identité OS réelle de l'équipement (nom de distribution/édition, version
 * de noyau) — optionnelle : sert aux commandes qui affichent la version du
 * système (`ver`, `systeminfo`...) et doivent refléter le VRAI profil de
 * l'équipement (ex: Windows 10 vs Windows Server), jamais une chaîne figée.
 */
export interface OsIdentity {
  readonly name: string;
  readonly prettyName: string;
  readonly version: string;
  readonly kernelRelease: string;
}

/**
 * Profil matériel réel de l'équipement (`systeminfo`, `wmic cpu/memorychip`,
 * `Get-CimInstance Win32_*`) — optionnel, un switch/routeur n'a pas ce
 * niveau de détail PC. Vient de `HardwareProfile.defaultFor()`, DÉJÀ
 * différencié par type d'équipement (station de travail vs serveur), pas
 * une valeur figée par ce pont.
 */
export interface HardwareProfile {
  readonly manufacturer: string;
  readonly productName: string;
  readonly cpu: { sockets: number; cpuFamily: number; model: number; stepping: number; vendor: string; clockMhz: number };
  readonly memory: { totalKib: number; availableKib: number; swapTotalKib: number };
  readonly firmware: { vendor: string; version: string; releaseDate: string };
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
  readonly audit?: AuditApi;
  readonly os?: OsIdentity;
  readonly hardware?: HardwareProfile;
  /** Horodatage de démarrage, si l'équipement suit un cycle de vie power-on/off (`systeminfo`'s System Boot Time). */
  bootedAt?(): Date | null;
  /** Échappatoire vendeur pour un sous-système sans équivalent générique (ex: le gestionnaire de services Windows pour `sc`/`net start`/`net stop`). Voir `ProcessApi.native`. */
  servicesNative?: unknown;
  now(): Date;
}

/** Dérive l'acteur `FileSystemApi` d'un `User` de session — point unique, partagé par l'Executor et par les commandes. */
export function toFileSystemActor(user: import("../session/types").User): FileSystemActor {
  return {
    uid: user.uid,
    gid: user.gid,
    gids: user.supplementaryGids ?? [],
    name: user.name,
    groupNames: [...user.groups],
  };
}
