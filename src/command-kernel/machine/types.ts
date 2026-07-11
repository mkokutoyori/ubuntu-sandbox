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

/** Entrée de liste de contrôle d'accès (ACL) — modèle NTFS (`icacls`), sans équivalent POSIX générique. */
export interface AclEntry {
  readonly principal: string;
  readonly type: "allow" | "deny";
  readonly permissions: readonly string[];
}

/** Attributs de fichier NTFS (`attrib`) — sans équivalent POSIX générique (mode bits). */
export interface FileAttributes {
  readonly readOnly: boolean;
  readonly archive: boolean;
  readonly hidden: boolean;
  readonly system: boolean;
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
  /** ACL du chemin (`icacls`) — optionnel, vendeurs NTFS uniquement. */
  getAcl?(path: string, actor: FileSystemActor): Promise<readonly AclEntry[]>;
  /** Ajoute/remplace l'ACE d'un principal donné (`icacls /grant`, `/deny`). */
  grantAcl?(path: string, entry: AclEntry, actor: FileSystemActor): Promise<void>;
  /** Retire toutes les ACE d'un principal (`icacls /remove`). */
  removeAcl?(path: string, principal: string, actor: FileSystemActor): Promise<void>;
  /** Attributs de fichier NTFS (`attrib`) — optionnel, vendeurs NTFS uniquement. */
  getAttributes?(path: string, actor: FileSystemActor): Promise<FileAttributes>;
  /** Applique un delta d'attributs (`attrib +r -a`) — seuls les champs présents sont modifiés. */
  setAttributes?(path: string, changes: Partial<FileAttributes>, actor: FileSystemActor): Promise<void>;
}

export interface ProcessInfo {
  readonly pid: number;
  readonly command: string;
  readonly ownerUid: number;
  /** Nom du compte propriétaire déjà résolu (`DOMAINE\user`, `NT AUTHORITY\SYSTEM`...) — optionnel, utile aux vendeurs sans uid POSIX stable (`tasklist`). */
  readonly ownerName?: string;
  /** Session hébergeant le processus (ex: "Services", "Console") — optionnel, concept Windows sans équivalent Linux direct. */
  readonly sessionName?: string;
  readonly sessionNumber?: number;
  readonly memoryKib?: number;
  readonly cpuSeconds?: number;
  readonly status?: string;
  readonly windowTitle?: string;
  /** Services hébergés par ce processus (`svchost.exe`) — optionnel (`tasklist /SVC`). */
  readonly hostedServices?: readonly string[];
  /** Ne peut jamais être terminé, même de force (`csrss`, `lsass`...) — optionnel (`taskkill`). */
  readonly critical?: boolean;
  /** Ne peut être terminé que par un compte administrateur — optionnel (`taskkill`). */
  readonly systemOwned?: boolean;
}

export interface ProcessApi {
  list(): Promise<ProcessInfo[]>;
  kill(pid: number, signal?: string): Promise<void>;
  spawn(command: string, argv: string[]): Promise<ProcessInfo>;
  /** Descendance directe et indirecte d'un PID (`taskkill /T`) — optionnel. */
  descendants?(pid: number): Promise<readonly ProcessInfo[]>;
}

/**
 * Passerelle vers le gestionnaire de services façon SCM Windows (`sc.exe`)
 * — optionnel, concept sans équivalent Linux direct (voir systemd côté
 * `LinuxCommand`). `sc.exe` a ~14 sous-commandes au format de sortie figé et
 * intimement lié au modèle SCM réel (SDDL, actions de reprise sur panne...) ;
 * décomposer chacune en primitives génériques dupliquerait ce formatage
 * sans bénéfice — la commande se contente de transmettre l'argv déjà
 * tokenisé, l'implémentation vendeur reste seule responsable de
 * l'interprétation et du texte produit.
 */
export interface ServiceManagementApi {
  execute(argv: readonly string[], caller: { isAdmin: boolean; userName: string }): Promise<string>;
}

/**
 * Passerelle vers `net.exe` (comptes locaux/domaine, groupes, services,
 * partages SMB, mappages de lecteurs) — optionnel, même raisonnement que
 * `ServiceManagementApi` : ~8 sous-commandes (`user`, `localgroup`,
 * `start`, `stop`, `share`, `session`, `use`, `accounts`) au format figé,
 * chacune couplée à un sous-système vendeur distinct (SAM, SCM, table de
 * partages SMB, table `net use`, politique de compte LSA). Décomposer en
 * primitives génériques réimplémenterait le dispatcher de `net.exe` sans
 * bénéfice pour un autre vendeur.
 */
export interface NetExeApi {
  execute(argv: readonly string[], caller: { isAdmin: boolean; userName: string }): Promise<string>;
}

/**
 * Passerelle vers le planificateur de tâches (`schtasks`) — optionnel,
 * même raisonnement que `NetExeApi` : sous-commandes (`/query`, `/create`,
 * `/delete`, `/run`, `/change`, `/end`) au format figé, couplées à une
 * table de tâches vendeur sans équivalent générique.
 */
export interface SchedulingApi {
  execute(argv: readonly string[]): Promise<string>;
}

/**
 * Passerelle vers la file d'impression (`print`) — optionnel, même
 * raisonnement que `SchedulingApi` : concept vendeur (spouleur
 * d'impression) sans équivalent générique.
 */
export interface PrintApi {
  execute(argv: readonly string[], caller: { userName: string }): Promise<string>;
}

export interface SocketInfo {
  readonly protocol: string;
  readonly localAddress: string;
  readonly localPort: number;
  readonly remoteAddress: string;
  readonly remotePort: number;
  readonly state: string;
  readonly pid?: number;
}

export interface NetworkApi {
  /** `dhcp` optionnel : seuls certains vendeurs (Windows) le suivent par interface. */
  interfaces(): Promise<{ name: string; ip: string; up: boolean; dhcp?: boolean }[]>;
  setInterfaceState(name: string, up: boolean): Promise<void>;
  /** Connexions/sockets actifs (`netstat`) — optionnel. */
  connections?(): Promise<readonly SocketInfo[]>;
}

/** Groupe de sécurité résolu pour un compte (`whoami /groups`) — modèle SID, optionnel (vendeurs sans notion de SID n'ont rien à fournir). */
export interface SecurityGroupMembership {
  readonly displayName: string;
  readonly type: string;
  readonly sid: string;
  readonly attributes: string;
}

/** Privilège de sécurité résolu pour un compte (`whoami /priv`) — optionnel. */
export interface SecurityPrivilege {
  readonly name: string;
  readonly description: string;
  readonly state: string;
}

/** Identité de sécurité complète d'un compte (SID, appartenance, privilèges) — optionnel, modèle Windows/AD sans équivalent POSIX direct. */
export interface SecurityIdentity {
  readonly accountName: string;
  readonly sid: string;
  readonly groups: readonly SecurityGroupMembership[];
  readonly privileges: readonly SecurityPrivilege[];
}

export interface UserManagementApi {
  findByName(name: string): Promise<import("../session/types").User | undefined>;
  findByUid(uid: number): Promise<import("../session/types").User | undefined>;
  create(name: string, groups: string[]): Promise<import("../session/types").User>;
  delete(uid: number): Promise<void>;
  /** Identité de sécurité complète du compte, déjà résolue (SID, domaine actif inclus) — optionnel (`whoami`). */
  securityIdentity?(name: string): Promise<SecurityIdentity | undefined>;
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
  /** Gestionnaire de services façon SCM (`sc`, `net start`/`stop`) — optionnel, pas un concept universel (voir systemd côté `LinuxCommand`). */
  readonly services?: ServiceManagementApi;
  /** Macros de ligne de commande (`doskey`, cmd.exe) — optionnel, pas un concept universel. */
  readonly macros?: MacroApi;
  /** `net.exe` (comptes, groupes, services, partages SMB, lecteurs réseau) — optionnel, pas un concept universel. */
  readonly netExe?: NetExeApi;
  /** Planificateur de tâches (`schtasks`) — optionnel, pas un concept universel. */
  readonly scheduling?: SchedulingApi;
  /** File d'impression (`print`) — optionnel, pas un concept universel. */
  readonly printing?: PrintApi;
  now(): Date;
}

/** Table de macros `doskey` (cmd.exe) — optionnel, sans équivalent universel. */
export interface MacroApi {
  list(): readonly { head: string; body: string }[];
  define(definition: string): void;
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
