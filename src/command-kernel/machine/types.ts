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
  /**
   * Résout `path` en suivant tous les liens symboliques rencontrés
   * (`readlink -f`, `realpath`) — optionnel, vendeurs avec liens
   * symboliques uniquement. `requireFinal`: la dernière composante
   * doit elle aussi exister (`-e`) ; `null` si une composante requise
   * n'existe pas.
   */
  realpath?(path: string, actor: FileSystemActor, requireFinal: boolean): Promise<string | null>;
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
 * Entrée de la table des processus façon POSIX (`ps`/`pgrep`/`kill`) —
 * champs riches d'un noyau Unix, sans équivalent dans le `ProcessInfo`
 * générique (orienté Windows). Sert les commandes de la famille processus.
 */
export interface ProcessEntry {
  readonly pid: number;
  readonly ppid: number;
  readonly pgid: number;
  readonly uid: number;
  readonly user: string;
  /** Nom court (`comm`, basename de argv[0]). */
  readonly comm: string;
  /** Ligne de commande complète. */
  readonly command: string;
  /** État façon `ps` (`R`, `S`, `Z`...). */
  readonly state: string;
  readonly tty: string;
  /** Gentillesse (`nice`/`renice`). */
  readonly nice: number;
  /** Politique d'ordonnancement (`chrt` : `SCHED_OTHER`/`SCHED_FIFO`...). */
  readonly schedPolicy?: string;
  /** Priorité temps réel (`chrt`). */
  readonly rtPriority?: number;
  /** Classe d'ordonnancement d'E/S (`ionice` : `best-effort`, `idle`...). */
  readonly ioClass?: string;
  /** Niveau au sein de la classe d'E/S (`ionice -n`). */
  readonly ioClassData?: number;
  /** Affinité CPU (`taskset`). */
  readonly cpuAffinity?: readonly number[];
}

/**
 * Contrôle des processus POSIX (`pidof`/`pgrep`/`pkill`/`kill`/`killall`) —
 * optionnel, propre aux équipements de type Unix. Fournit l'instantané de
 * la table des processus et l'envoi de signaux ; les commandes portent
 * elles-mêmes leur logique de sélection.
 */
export interface ProcessControlApi {
  /** Instantané de la table des processus. */
  list(): readonly ProcessEntry[];
  /** Un processus par PID, ou `null` s'il n'existe pas. */
  get(pid: number): ProcessEntry | null;
  /** Envoie `signal` au PID ; `false` si le PID n'existe pas. */
  signal(pid: number, signal: string): boolean;
  /** Change la gentillesse (`renice`) ; `false` si le PID n'existe pas. */
  renice(pid: number, nice: number): boolean;
  /** Change la politique d'ordonnancement temps réel (`chrt`) ; `false` si absent. */
  setSchedPolicy(pid: number, policy: string, rtPriority: number): boolean;
  /** Change la classe d'ordonnancement d'E/S (`ionice`) ; `false` si absent. */
  setIoClass(pid: number, ioClass: string, ioClassData: number): boolean;
  /** Change l'affinité CPU (`taskset`) ; `false` si absent. */
  setCpuAffinity(pid: number, cpus: readonly number[]): boolean;
}

export interface ServiceOpResult {
  readonly ok: boolean;
  readonly error?: string;
}

export interface ServiceControlResult {
  readonly ok: boolean;
  readonly error?: string;
  /** Bloc de statut déjà formaté (état PENDING transitoire inclus) — présent seulement si `ok`. */
  readonly formattedStatus?: string;
}

export interface ServiceFailureConfig {
  readonly resetPeriodSec: number;
  readonly actions: readonly { type: 'restart' | 'run' | 'reboot' | 'none'; delayMs: number }[];
  readonly command?: string;
}

/**
 * Gestionnaire de services façon SCM Windows (`sc.exe`, `net start`/`stop`)
 * — optionnel, concept sans équivalent Linux direct (voir systemd côté
 * `LinuxCommand`). Chaque méthode correspond à UNE opération SCM réelle ;
 * le dispatch de sous-commandes, l'analyse des arguments et le texte
 * d'erreur `[SC] ... FAILED nnnn` restent la responsabilité de la
 * commande — seul le texte déjà formaté d'un bloc de statut individuel
 * (`formatQuery`/`formatQc`/...) vient du vendeur, parce que ce format
 * (codes STATE/TYPE hexadécimaux, alignement figé) est une réalité SCM
 * qu'aucun autre vendeur ne partage, pas une décision de présentation.
 */
export interface ServiceManagementApi {
  exists(name: string): boolean;
  displayNameFor(name: string): string | undefined;
  /** Résout un nom de service réel OU son nom d'affichage (`net start "DHCP Client"`) vers le nom réel. */
  resolveName(nameOrDisplayName: string): string | undefined;
  isRunning(name: string): boolean;
  runningServiceNames(): readonly string[];
  allServiceNames(): readonly string[];
  pidFor(name: string): number;

  formatQuery(name: string): string | undefined;
  formatQueryAllRunning(): readonly string[];
  formatQueryAll(): readonly string[];
  formatQueryEx(name: string): string | undefined;
  formatQueryExAllRunning(): readonly string[];
  formatQueryExAll(): readonly string[];
  formatQc(name: string): string | undefined;
  formatDescription(name: string): string | undefined;
  formatQfailure(name: string): string | undefined;

  start(name: string, isAdmin: boolean): ServiceControlResult;
  stop(name: string, isAdmin: boolean): ServiceControlResult;
  pause(name: string, isAdmin: boolean): ServiceControlResult;
  resume(name: string, isAdmin: boolean): ServiceControlResult;

  setStartType(name: string, startType: 'Automatic' | 'Manual' | 'Disabled', isAdmin: boolean): ServiceOpResult;
  setDependencies(name: string, dependencies: readonly string[], isAdmin: boolean): ServiceOpResult;
  setAccount(name: string, account: string, isAdmin: boolean, changedBy: string): ServiceOpResult;
  setDescription(name: string, description: string, isAdmin: boolean): ServiceOpResult;
  setFailureConfig(name: string, config: ServiceFailureConfig, isAdmin: boolean): ServiceOpResult;

  create(
    name: string,
    opts: { binaryPath: string; displayName?: string; startType?: 'Automatic' | 'Manual' | 'Disabled'; dependencies?: readonly string[] },
    isAdmin: boolean,
    installedBy: string,
  ): ServiceOpResult;
  delete(name: string, isAdmin: boolean): ServiceOpResult;
}

/**
 * Passerelle vers `net.exe` (comptes locaux/domaine, groupes, services,
 * partages SMB, mappages de lecteurs) — optionnel, même raisonnement que
 * `ServiceManagementApi` : ~8 sous-commandes (`user`, `localgroup`,
 * `start`, `stop`, `share`, `session`, `use`, `accounts`) au format figé,
 * chacune couplée à un sous-système vendeur distinct (SAM, SCM, table de
 * partages SMB, table `net use`, politique de compte LSA). `user`/
 * `localgroup` passent par `UserManagementApi`/`GroupManagementApi`,
 * `start`/`stop` par `ServiceManagementApi` — les capacités ci-dessous
 * couvrent le reste (`share`, `session`, `use`, `accounts`).
 */

export interface SmbShareInfo {
  readonly name: string;
  readonly path: string;
  readonly description: string;
}

/** Table de partages SMB serveur (`net share`) — optionnel, pas un concept universel. */
export interface SmbShareApi {
  isServerRunning(): boolean;
  list(): readonly SmbShareInfo[];
  add(name: string, resource: string, description: string): AccountMutationResult;
  remove(name: string): AccountMutationResult;
}

export interface SmbSessionInfo {
  readonly clientComputerName: string;
  readonly clientIp: string;
  readonly user: string;
  readonly numOpens: number;
}

/** Sessions SMB entrantes (`net session`) — optionnel, pas un concept universel. */
export interface SmbSessionApi {
  list(): readonly SmbSessionInfo[];
  /** Ferme les sessions correspondant à `target` (`\\\\ordinateur`), ou toutes si omis. */
  closeMatching(target?: string): void;
}

export interface NetUseMappingInfo {
  readonly local: string;
  readonly remote: string;
  readonly status: string;
}

/** Mappages de lecteurs réseau SMB côté client (`net use`) — optionnel, pas un concept universel. */
export interface NetUseApi {
  isWorkstationRunning(): boolean;
  list(): readonly NetUseMappingInfo[];
  connect(drive: string, uncPath: string, username: string, password: string): Promise<AccountMutationResult>;
  disconnect(drive: string): boolean;
  disconnectAll(): number;
}

/** Politique de compte LSA (`net accounts`) — optionnel, pas un concept universel. */
export interface AccountsPolicyApi {
  /** Rendu canonique de la politique courante — même raisonnement que `ServiceManagementApi.formatQuery` (format `net accounts` figé, sans équivalent générique). */
  render(): string;
  /** Applique un seul indicateur (`/minpwlen`, `/lockoutthreshold`...) ; retourne un message d'erreur, ou `undefined` en cas de succès. */
  apply(flag: string, value: string): string | undefined;
}

export interface ScheduledTaskInfo {
  readonly name: string;
  readonly runAt: Date | null;
  readonly state: string;
}

/**
 * Planificateur de tâches (`schtasks`) — optionnel, concept sans
 * équivalent Linux direct (voir `cron`/`CronEngine` côté `LinuxCommand`).
 * Primitives d'état brutes ; le dispatch de sous-commandes (`/query`,
 * `/create`, `/delete`, `/run`, `/change`, `/end`) et le format
 * d'affichage restent la responsabilité de la commande.
 */
export interface SchedulingApi {
  isServiceRunning(): boolean;
  list(nameFilter?: string): readonly ScheduledTaskInfo[];
  create(name: string, opts: { schedule?: string; startTime?: string; intervalCount?: number; command?: string }): void;
  delete(name: string): boolean;
  run(name: string): boolean;
}

/**
 * File d'impression (`print`) — optionnel, concept vendeur (spouleur)
 * sans équivalent générique. Primitives d'état brutes ; le dispatch
 * d'options (`/D:device`) et le format d'affichage restent la
 * responsabilité de la commande.
 */
export interface PrintApi {
  isSpoolerRunning(): boolean;
  submit(document: string, printer: string, owner: string): void;
}

export interface AuditSubcategorySetting {
  readonly success: boolean;
  readonly failure: boolean;
}

/**
 * Politique d'audit de sécurité (`auditpol`) — optionnel, concept sans
 * équivalent Linux direct (voir `auditctl` côté `LinuxCommand`, un système
 * distinct). Primitives d'état brutes ; le dispatch de sous-commandes et
 * le format d'affichage restent la responsabilité de la commande.
 */
export interface AuditPolicyApi {
  get(subcategory: string): AuditSubcategorySetting | undefined;
  set(subcategory: string, changes: { success?: boolean; failure?: boolean }): void;
}

export interface WinRmListenerInfo {
  readonly transport: 'HTTP' | 'HTTPS';
  readonly port: number;
}

/**
 * Configuration WinRM (`winrm`) — optionnel, pas un concept universel.
 * Primitives d'état brutes (écouteurs HTTP/HTTPS actifs, service activé) ;
 * le dispatch de sous-commandes et le format d'affichage restent la
 * responsabilité de la commande.
 */
export interface WinRmApi {
  isEnabled(): boolean;
  listeners(): readonly WinRmListenerInfo[];
  enable(): void;
}

/** Entrée structurée d'un journal d'évènements Windows (`wevtutil qe`) — modèle Windows. */
export interface WindowsEventLogEntry {
  readonly source: string;
  readonly eventId: number;
  readonly message: string;
}

/** Bannière d'ouverture de session appliquée par GPO (`gpresult /r`) — modèle Windows/AD. */
export interface WindowsGpLogonBanner { readonly title: string; readonly text: string; }

/** Instantané du jeu de stratégies résultant (`gpresult /r`) — modèle Windows/AD. */
export interface WindowsGpResult {
  readonly netbiosName: string;
  readonly dcAddress: string;
  readonly currentUser: string;
  readonly hostname: string;
  readonly lastAppliedAt: Date | null;
  readonly appliedGpoNames: readonly string[];
  readonly logonBanner: WindowsGpLogonBanner | null;
  readonly startupScript: string;
}

/** Résultat de `nltest /dsgetdc:<domaine>` — localisation d'un DC (modèle Windows/AD). */
export type DomainControllerLocation =
  | { readonly ok: true; readonly dnsName: string; readonly dcAddress: string; readonly siteName: string }
  | { readonly ok: false; readonly reason: 'no-such-domain' | 'unreachable' };

/** Instantané de santé d'un contrôleur de domaine (`dcdiag`) — `isDc: false` hors DC. */
export interface DomainControllerDiagnostics {
  readonly isDc: boolean;
  readonly hostname: string;
  readonly dnsName: string;
  readonly siteName: string;
  readonly servicesRunning: { readonly ntds: boolean; readonly netlogon: boolean; readonly kdc: boolean };
  readonly sysvolShareExists: boolean;
}

/** Sens d'une relation d'approbation inter-domaines (`netdom trust /Direction:`). */
export type DomainTrustDirection = 'Inbound' | 'Outbound' | 'Bidirectional';

/** Un enregistrement de zone DNS tel que listé par `dnscmd /ZonePrint`. */
export interface DnsServerZoneRecord {
  readonly name: string;
  readonly ttl: number;
  readonly type: string;
  readonly text: string;
}

/** Données d'un enregistrement SRV (`dnscmd /RecordAdd … SRV`). */
export interface DnsSrvRecordData {
  readonly priority: number;
  readonly weight: number;
  readonly port: number;
  readonly target: string;
}

/**
 * Administration du serveur DNS (`dnscmd`) — optionnel, exposé uniquement
 * quand le rôle DNS Server est installé (donc jamais sur un simple poste :
 * `dnscmd` y reste « not recognized »). Miroir cmd de la surface du module
 * PowerShell `DnsServer`.
 */
export interface DnsServerAdminApi {
  addPrimaryZone(zone: string): { ok: boolean; message: string };
  addARecord(zone: string, node: string, ipv4: string): { ok: boolean; message: string };
  addAaaaRecord(zone: string, node: string, ipv6: string): { ok: boolean; message: string };
  addCnameRecord(zone: string, node: string, target: string): { ok: boolean; message: string };
  addPtrRecord(zone: string, node: string, ptrDomain: string): { ok: boolean; message: string };
  addMxRecord(zone: string, node: string, preference: number, mailExchange: string): { ok: boolean; message: string };
  addSrvRecord(zone: string, node: string, data: DnsSrvRecordData): { ok: boolean; message: string };
  removeRecord(zone: string, node: string, type: string): { ok: boolean; message: string };
  getRecords(zone: string): readonly DnsServerZoneRecord[] | null;
  listZones(): readonly { readonly name: string }[];
  setForwarders(addresses: readonly string[]): { ok: boolean; message: string };
}

/** Un ticket Kerberos en cache (`klist`) — modèle Windows/AD. */
export interface KerberosCachedTicket {
  readonly clientPrincipal: string;
  readonly serverPrincipal: string;
  readonly flagsHex: string;
  readonly flagNames: readonly string[];
  readonly startTime: number;
  readonly endTime: number;
  readonly renewTill: number | null;
}

/**
 * Appartenance à un domaine AD et diagnostics associés (`gpupdate`,
 * `gpresult`, `nltest`, `dcdiag`, `klist`) — optionnel, concept sans
 * équivalent universel. La plupart des opérations échouent proprement
 * (« not joined to a domain », `isDc: false`, cache de tickets vide) hors
 * domaine : aucune fonctionnalité serveur n'est exposée sur un poste non
 * joint.
 */
export interface DomainApi {
  /** Force l'application des stratégies de groupe (`gpupdate /force`) — mutation réelle (pull LDAP + application). `message` non vide = échec (ex. hors domaine). */
  gpupdateForce(): { ok: boolean; message: string };
  /** Instantané RSoP typé (`gpresult /r`) — `null` si la machine n'est pas jointe à un domaine. */
  groupPolicyResult(): WindowsGpResult | null;
  /** `nltest /dsgetdc:<domaine>` — localisation d'un DC via une vraie sonde réseau (TCP/389). */
  locateDomainController(domain: string): DomainControllerLocation;
  /** `dcdiag` — instantané de santé du DC ; `isDc: false` sur une machine non promue. */
  dcDiagnostics(): DomainControllerDiagnostics;
  /** `klist` — instantané typé du cache de tickets Kerberos (vide sans logon domaine). */
  kerberosTickets(): readonly KerberosCachedTicket[];
  /** `netdom join` — jointure de domaine (vraie négociation LDAP). `ok:false` = échec (mauvais mot de passe, déjà joint...). */
  joinDomain(domain: string, dcAddress: string, user: string, password: string): { ok: boolean; message: string };
  /** Résout un nom de domaine en adresse de DC via DNS synchrone — `null` si irrésolu (pour `netdom join` sans `/Server:`). */
  resolveDcAddress(domain: string): string | null;
  /** `netdom trust` — établit une approbation inter-domaines ; `null` si la machine n'est pas un contrôleur de domaine (fonctionnalité serveur). */
  establishTrust(remoteRealm: string, dcAddress: string, direction: DomainTrustDirection, transitive: boolean, user: string, password: string): { ok: boolean; message: string } | null;
}

/**
 * Journal d'évènements Windows (`wevtutil`) — optionnel, concept sans
 * équivalent universel (Linux : syslog/journald). Expose les journaux
 * structurés plus le journal d'évènements DHCP-Client dédié.
 */
export interface EventLogApi {
  /** Entrées structurées d'un journal nommé (`System`/`Security`/...) — `null` si le journal n'existe pas. */
  entries(logName: string): readonly WindowsEventLogEntry[] | null;
  /** Journal d'évènements du client DHCP (synchronisé à l'appel) — lignes brutes horodatées. */
  dhcpEventLog(): readonly string[];
  /** Amorce le journal DHCP avec un évènement `INIT` s'il est vide (première interrogation `wevtutil qe System ...dhcp`). */
  ensureDhcpInitEvent(): void;
}

/**
 * Registre système façon Windows (clés hiérarchiques, valeurs typées) —
 * optionnel, concept sans équivalent Linux direct. Surface déjà réduite
 * au strict nécessaire (`reg.exe`, et côté PowerShell le provider
 * `Registry::`), pas une passerelle opaque : chaque méthode est une
 * primitive générique réutilisable par un futur vendeur avec un registre
 * similaire.
 */
export interface RegistryApi {
  testPath(key: string): boolean;
  newItem(key: string, force: boolean): unknown;
  setItemProperty(key: string, name: string, value: string | number): void;
  removeItemProperty(key: string, name: string): void;
  removeItem(key: string, recurse: boolean): void;
  getItemPropertyValues(key: string): Record<string, unknown> | null | undefined;
  listSubkeyNames(key: string): string[];
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

/** Adaptateur réseau tel que vu par `arp`/`route`/`getmac`/`ipconfig` — optionnel, modèle Windows (nom d'interface + MAC + IP + état physique/admin distincts). */
export interface WindowsAdapterInfo {
  readonly name: string;
  /** Forme canonique deux-points minuscule (ex: `aa:bb:cc:dd:ee:ff`) — chaque commande applique son propre formatage d'affichage (tirets, majuscules...). */
  readonly mac: string;
  readonly ip: string | undefined;
  readonly mask: string | undefined;
  readonly globalIPv6: string | undefined;
  readonly linkLocalIPv6: string | undefined;
  readonly isUp: boolean;
  readonly isConnected: boolean;
  readonly isAdminDown: boolean;
  /** Suffixe DNS spécifique à la connexion (`ipconfig`) — `''` si aucun. */
  readonly connectionDnsSuffix: string;
  /** Adresse obtenue par DHCP plutôt que statique (`ipconfig /all`). */
  readonly isDhcp: boolean;
  /** Mode de résolution DNS de l'interface (`netsh interface ip show dns`). */
  readonly dnsMode: 'static' | 'dhcp';
  /** Interface administrativement activée (`netsh interface show interface`) — distinct de `isAdminDown`, qui reflète l'état lien physique. */
  readonly adminEnabled: boolean;
  /** Adresses IPv4 secondaires (`netsh interface ip add/delete address`, IP alias). */
  readonly secondaryIps: readonly { readonly ip: string; readonly mask: string }[];
  /** Adresses IPv6 complètes de l'interface (link-local + globales + toutes origines) — `netsh interface ipv6 show addresses`. */
  readonly ipv6Addresses: readonly WindowsIPv6AddressEntry[];
}

/** Une adresse IPv6 assignée à une interface, avec sa longueur de préfixe et son origine — `netsh interface ipv6`. */
export interface WindowsIPv6AddressEntry {
  readonly address: string;
  readonly prefixLength: number;
  readonly origin: 'link-local' | 'static' | 'slaac' | 'dhcpv6';
}

/** Route IPv6 statique déclarée via `netsh interface ipv6 add route` — optionnel, modèle Windows. */
export interface WindowsIPv6RouteEntry {
  readonly prefix: string;
  readonly prefixLen: number;
  readonly iface: string;
  readonly nexthop: string;
  readonly metric: number;
  readonly published: boolean;
}

/** Une règle `netsh interface portproxy` — optionnel, modèle Windows. */
export interface WindowsPortProxyRule {
  readonly family: 'v4tov4' | 'v4tov6' | 'v6tov4' | 'v6tov6';
  readonly listenAddress: string;
  readonly listenPort: number;
  readonly connectAddress: string;
  readonly connectPort: number;
}

/** Bail DHCPv4 actif sur une interface (`ipconfig /all`) — optionnel, modèle Windows. */
export interface WindowsDhcpLease {
  readonly ipAddress: string;
  readonly serverIdentifier: string;
  readonly leaseStartMs: number;
  readonly expirationMs: number;
  readonly dnsServers: readonly string[];
}

/** Entrée du cache résolveur DNS (`ipconfig /displaydns`) — optionnel, modèle Windows. */
export interface WindowsDnsCacheEntry {
  readonly name: string;
  readonly type: string;
  readonly value: string;
  readonly ttlRemainingSec: number;
}

/** Entrée de la table ARP (`arp -a`) — optionnel, modèle Windows. */
export interface WindowsArpEntry {
  readonly ip: string;
  readonly mac: string;
  readonly iface: string;
  readonly type: 'dynamic' | 'static' | 'failed';
}

/** Entrée de la table de routage (`route print`) — optionnel, modèle Windows. */
export interface WindowsRouteEntry {
  readonly network: string;
  readonly mask: string;
  readonly nextHop: string | null;
  readonly iface: string;
  readonly metric: number;
  readonly type: 'connected' | 'static' | 'default';
}

/**
 * Configuration réseau bas niveau façon Windows (adaptateurs, ARP, table de
 * routage) — optionnel, sans équivalent universel unique (Linux a `ip`/`ss`
 * couverts ailleurs). Chaque méthode correspond à UNE opération vendeur
 * réelle : aucun `execute(argv)` opaque — `arp`/`route`/`getmac` portent
 * eux-mêmes l'analyse d'arguments et le formatage de sortie.
 */
export interface WindowsNetConfigApi {
  adapters(): readonly WindowsAdapterInfo[];

  arpEntries(): readonly WindowsArpEntry[];
  addStaticArp(ip: string, mac: string, iface: string): { ok: boolean; error?: string };
  deleteArp(ip: string): void;
  clearArp(): void;

  routes(): readonly WindowsRouteEntry[];
  /** `false` si la passerelle suivante n'est pas joignable par une interface locale (échec réel, pas une erreur de syntaxe). */
  addRoute(network: string, mask: string, nextHop: string, metric: number): boolean;
  removeRoute(network: string, mask: string): boolean;
  setDefaultGateway(gw: string): void;
  clearDefaultGateway(): void;

  /** Résolution DNS/hosts réelle (passe par le réseau simulé) — `null` si introuvable (`ping`/`tracert`). */
  resolveHostname(name: string): Promise<string | null>;
  /** Séquence d'échos ICMP réels vers `targetIp` — tableau vide = pas de route ou pas de réponse ARP (`ping`/`tracert`). */
  pingSequence(targetIp: string, count: number, timeoutMs?: number, ttl?: number): Promise<readonly WindowsPingReply[]>;
  /** Traceroute réel vers `targetIp` — tableau vide = pas de route (`tracert`). */
  traceroute(targetIp: string, maxHops?: number, timeoutMs?: number): Promise<readonly WindowsTracerouteHop[]>;
  /** Résolution inverse (IP → nom d'hôte via le fichier hosts) — optionnel, `null` si absent (`tracert`). */
  reverseLookup(ip: string): string | null;
  /** Résolution VIA LE SEUL fichier hosts statique (pas de DNS) — distinct de `resolveHostname` (`nslookup` court-circuite le DNS sur un hit hosts). */
  resolveViaHostsFile(name: string): string | null;
  /** Premier serveur DNS configuré, toutes interfaces confondues — `''` si aucun (`nslookup`). */
  firstConfiguredDnsServer(): string;
  /**
   * Requête DNS réelle vers `server` — `null` sur timeout/erreur. Type
   * `DnsMessage` du moteur protocolaire `@/network/dns` réutilisé tel quel
   * (pas une réinvention Windows) : DNS est un protocole, pas une réalité
   * vendeur, et `executeNslookup` (moteur cross-vendor déjà partagé par
   * Linux et Windows) attend exactement cette forme.
   */
  queryDnsServer(
    server: string, name: string, qtype: string, timeoutMs?: number,
  ): Promise<import("@/network/dns/wire/DnsMessage").DnsMessage | null>;

  /** Passerelle par défaut IPv4/IPv6 — `null` si aucune (`ipconfig`). */
  defaultGateway(): string | null;
  defaultGateway6(): string | null;
  /** Suffixe DNS principal de la machine (`ipconfig /all`). */
  primaryDnsSuffix(): string;
  /** Serveurs DNS statiques configurés sur une interface (hors bail DHCP) — `ipconfig` (mode non-DHCP). */
  staticDnsServers(ifName: string): readonly string[];
  /** Bail DHCPv4 actif sur l'interface, s'il y en a un — `ipconfig /all`, `/release`, `/renew`. */
  dhcpLease(ifName: string): WindowsDhcpLease | null;
  /** Libère le bail DHCPv4 de l'interface, journalise l'évènement DHCP et réinitialise l'état du client à `INIT` (`ipconfig /release`). */
  releaseLease(ifName: string): void;
  /** Redemande un bail DHCPv4 sur l'interface, synchrone côté simulation (`ipconfig /renew`). */
  requestLease(ifName: string): void;
  /** Relance la découverte des serveurs DHCP joignables avant un `/renew` (topologie déjà câblée). */
  autoDiscoverDhcpServers(): void;
  /** Libère les adresses IPv6 dynamiques (SLAAC/DHCPv6) d'une interface — renvoie les adresses effectivement libérées (`ipconfig /release6`) ; journalise l'évènement DHCP en interne. */
  releaseDynamicIPv6(ifName: string): readonly string[];
  /** Resollicite un routeur IPv6 sur l'interface pour un nouveau préfixe SLAAC (`ipconfig /renew6`). */
  sendRouterSolicitation(ifName: string): void;
  /** Vendor Class ID DHCP (option 60) affiché/positionné — `isV6` distingue `/showclassid[6]`/`/setclassid[6]`. */
  classId(ifName: string, isV6: boolean): string | null;
  setClassId(ifName: string, isV6: boolean, classId: string | null): void;
  /** Vide le cache résolveur DNS (`ipconfig /flushdns`). */
  flushDnsCache(): void;
  /** Entrées actives du cache résolveur DNS, déjà purgées des entrées expirées (`ipconfig /displaydns`). */
  dnsCacheEntries(): readonly WindowsDnsCacheEntry[];

  /**
   * Résout un nom d'interface façon `netsh` (nom réel `eth0`, nom
   * d'affichage `Ethernet 0`, ou variantes `Local Area Connection`) vers
   * le nom réel de port — `null` si aucune interface ne correspond.
   */
  resolveAdapterName(name: string): string | null;
  /** Configure l'adresse IPv4 primaire d'une interface (`netsh interface ip set address ... static`). */
  configureAddress(ifName: string, ip: string, mask: string): { ok: boolean; error?: string };
  /** Bascule l'interface en configuration IPv4 par DHCP (`netsh interface ip set address ... dhcp`). */
  setAddressDhcp(ifName: string): void;
  /** Efface l'adresse IPv4 (et la route connectée associée) d'une interface (`netsh interface ip delete address` sans IP explicite). */
  clearInterfaceIP(ifName: string): void;
  /** Ajoute une adresse IPv4 secondaire (IP alias) — `netsh interface ip add address` quand l'interface a déjà une IP primaire. */
  addSecondaryIp(ifName: string, ip: string, mask: string): { ok: boolean; error?: string };
  /** Retire une adresse IPv4 secondaire (`netsh interface ip delete address` avec IP explicite ≠ primaire). */
  removeSecondaryIp(ifName: string, ip: string): void;
  /** Définit la liste des serveurs DNS statiques d'une interface (`netsh interface ip set/add/delete dns`). */
  setDnsServers(ifName: string, servers: readonly string[]): void;
  /** Bascule le mode de résolution DNS d'une interface (`netsh interface ip set dns ... dhcp`). */
  setDnsMode(ifName: string, mode: 'static' | 'dhcp'): void;

  /** État admin de l'interface (`netsh interface set interface admin=`). */
  setInterfaceAdmin(ifName: string, enabled: boolean): void;
  /** Renomme une interface — `false` si l'interface source n'existe pas ou si le nouveau nom est déjà pris (`netsh interface set interface newname=`). */
  renameInterface(oldName: string, newName: string): boolean;
  /** Réinitialise complètement la pile TCP/IP (adresses, routes, ARP, DNS) — `netsh interface ip reset` / `netsh int ip reset`. */
  resetTcpIpStack(): void;
  /** Journalise la réinitialisation du catalogue Winsock — aucun état modélisé à réinitialiser (`netsh winsock reset`). */
  resetWinsockCatalog(): void;

  /** Ajoute une adresse IPv6 à une interface (`netsh interface ipv6 add address`). */
  addIPv6Address(ifName: string, address: string, prefixLength: number): { ok: boolean; error?: string };
  /** Retire une adresse IPv6 d'une interface — `false` si elle n'existait pas (`netsh interface ipv6 delete address`). */
  removeIPv6Address(ifName: string, address: string): boolean;
  /** Routes IPv6 statiques déclarées sur cet équipement (`netsh interface ipv6 show route`). */
  ipv6Routes(): readonly WindowsIPv6RouteEntry[];
  /** Déclare une route IPv6 statique (`netsh interface ipv6 add route`) — pas de validation de joignabilité réelle, à l'identique du `netsh` d'origine. */
  addIPv6Route(entry: WindowsIPv6RouteEntry): void;

  /** Règles de redirection de port (`netsh interface portproxy show`), filtrées par famille si fournie. */
  portProxyRules(family?: string): readonly WindowsPortProxyRule[];
  addPortProxyRule(rule: WindowsPortProxyRule): void;
  removePortProxyRule(family: string, listenAddress: string, listenPort: number): boolean;
  resetPortProxy(): void;

  /** Proxy WinHTTP global de la machine (`netsh winhttp` / `Set-WinHttpProxy`) — état partagé avec les cmdlets PowerShell équivalentes. */
  winhttpProxy(): string;
  setWinhttpProxy(proxy: string): void;

  /** Suffixe DNS principal — positionné par `netsh dnsclient set global dnssuffix=` (lecture via `primaryDnsSuffix`). */
  setPrimaryDnsSuffix(suffix: string): void;
  /** Le service DHCP Client (`dhcp`) tourne-t-il (`netsh dhcpclient show state`) — distinct de l'état d'installation, qui est un booléen de configuration `netsh`. */
  isDhcpClientRunning(): boolean;
  /** Le service DNS Client (`dnscache`) tourne-t-il (`netsh dnsclient show state`). */
  isDnsClientRunning(): boolean;

  /** État de configuration `netsh dhcpclient` (service installé, traçage) — par-instance, sans équivalent universel. */
  dhcpClientConfig(): WindowsDhcpClientConfig;
  setDhcpClientInstalled(installed: boolean): void;
  setDhcpClientTracing(enabled: boolean, output?: string): void;
  setDhcpClientTraceEnabled(enabled: boolean): void;
  /** Marque/démarque une interface comme ayant un bail libéré (`netsh dhcpclient release`/`renew`) — n'affecte que l'affichage `show parameters`. */
  setInterfaceReleased(ifName: string, released: boolean): void;
  isInterfaceReleased(ifName: string): boolean;

  /** Magasin de politiques IPsec (`netsh ipsec`) — par-instance. */
  readonly ipsec: WindowsIpsecStore;
  /** Profils filaires (`netsh lan`) — par-instance. */
  readonly lan: WindowsLanStore;
  /** Profils sans-fil (`netsh wlan`) — par-instance. */
  readonly wlan: WindowsWlanStore;
  /** Configuration HTTP.sys (`netsh http`) — par-instance. */
  readonly http: WindowsHttpStore;
  /** Ponts réseau (`netsh bridge`) — par-instance. */
  readonly bridge: WindowsBridgeStore;
  /** Politiques NRPT (`netsh namespace`) — par-instance. */
  readonly nrpt: WindowsNrptStore;
  /** Pare-feu Windows (`netsh advfirewall`) — état partagé plan de données/PowerShell. */
  readonly firewall: WindowsFirewallApi;
  /** Rôle Serveur DHCP (`netsh dhcp server`) — `null` sur un poste client. */
  readonly dhcpServer: WindowsDhcpServerApi | null;
  /** Rôle NPS/RADIUS (`netsh nps`) — `null` sur un poste client. */
  readonly nps: WindowsNpsApi | null;
}

/** État de configuration du contexte `netsh dhcpclient` — par-instance, modèle Windows. */
export interface WindowsDhcpClientConfig {
  readonly installed: boolean;
  readonly tracingEnabled: boolean;
  readonly tracingOutput: string;
  readonly traceEnabled: boolean;
}

/** Politique IPsec statique (`netsh ipsec static`) — par-instance, modèle Windows. */
export interface WindowsIpsecPolicy {
  readonly name: string;
  readonly description: string;
  readonly assigned: boolean;
}
export interface WindowsIpsecFilter {
  readonly srcAddr: string;
  readonly dstAddr: string;
  readonly protocol: string;
  readonly srcPort: string;
  readonly dstPort: string;
  readonly mirrored: boolean;
  readonly description: string;
}
export interface WindowsIpsecFilterList {
  readonly name: string;
  readonly filters: readonly WindowsIpsecFilter[];
}
export interface WindowsIpsecFilterAction {
  readonly name: string;
  readonly action: 'permit' | 'block' | 'negotiate';
  readonly description: string;
}
export interface WindowsIpsecRule {
  readonly name: string;
  readonly policy: string;
  readonly filterlist: string;
  readonly filteraction: string;
}
export interface WindowsIpsecDynamicSettings {
  readonly mmSecMethods: string;
  readonly qmSecMethods: string;
  readonly ikeLogging: number;
  readonly config: Readonly<Record<string, string>>;
}

/**
 * Magasin de politiques IPsec `netsh ipsec` — état de configuration
 * par-instance, sans connexion au moteur IPsec réel (pur registre de
 * politiques façon Windows XP/2003). CRUD granulaire ; `NetshCommand`
 * porte tout le parsing, le dispatch de sous-objet et les messages
 * (« already exists »/« not found »).
 */
export interface WindowsIpsecStore {
  policies(): readonly WindowsIpsecPolicy[];
  addPolicy(policy: WindowsIpsecPolicy): void;
  /** `true` si une politique portait ce nom (supprimée), `false` sinon. */
  deletePolicy(name: string): boolean;
  deleteAllPolicies(): void;
  /** `true` si la politique existait et a été modifiée. */
  setPolicy(name: string, changes: { assigned?: boolean; description?: string }): boolean;

  filterLists(): readonly WindowsIpsecFilterList[];
  addFilterList(name: string): void;
  deleteFilterList(name: string): boolean;
  deleteAllFilterLists(): void;
  /** Ajoute un filtre à une liste — `false` si la liste n'existe pas. */
  addFilter(filterListName: string, filter: WindowsIpsecFilter): boolean;
  /** Une liste de filtres est-elle référencée par une règle (blocage de suppression) ? */
  filterListInUse(name: string): boolean;

  filterActions(): readonly WindowsIpsecFilterAction[];
  addFilterAction(action: WindowsIpsecFilterAction): void;
  deleteFilterAction(name: string): boolean;
  deleteAllFilterActions(): void;

  rules(): readonly WindowsIpsecRule[];
  addRule(rule: WindowsIpsecRule): void;
  /** Supprime une règle par nom (et politique optionnelle) — `false` si absente. */
  deleteRule(name: string, policy?: string): boolean;

  dynamic(): WindowsIpsecDynamicSettings;
  setDynamicMainMode(mmSecMethods: string): void;
  setDynamicQm(qmSecMethods: string): void;
  setDynamicConfig(key: string, value: string): void;
}

/** Profil filaire `netsh lan` — par-instance, modèle Windows. */
export interface WindowsLanProfile { readonly name: string; readonly interface: string; }
export interface WindowsLanStore {
  profiles(): readonly WindowsLanProfile[];
  addProfile(profile: WindowsLanProfile): void;
  deleteProfile(name: string): boolean;
  deleteAllProfiles(): void;
  tracingEnabled(): boolean;
  setTracing(enabled: boolean): void;
  autoconnect(ifName: string): boolean | undefined;
  setAutoconnect(ifName: string, enabled: boolean): void;
}

/** Profil sans-fil `netsh wlan` — par-instance, modèle Windows. */
export interface WindowsWlanProfile { readonly name: string; readonly ssid: string; }
export interface WindowsWlanStore {
  profiles(): readonly WindowsWlanProfile[];
  addProfile(profile: WindowsWlanProfile): void;
  deleteProfile(name: string): boolean;
}

/** Binding certificat SSL `netsh http` — par-instance, modèle Windows. */
export interface WindowsHttpSslCert { readonly ipport: string; readonly certhash: string; readonly appid: string; }
export interface WindowsHttpStore {
  ipListen(): readonly string[];
  addIpListen(ip: string): void;
  removeIpListen(ip: string): boolean;
  sslCerts(): readonly WindowsHttpSslCert[];
  addSslCert(cert: WindowsHttpSslCert): void;
}

/** Pont réseau `netsh bridge` — par-instance, modèle Windows. */
export interface WindowsBridge { readonly name: string; readonly members: readonly string[]; }
export interface WindowsBridgeStore {
  bridges(): readonly WindowsBridge[];
  /** `false` si un pont de ce nom existe déjà. */
  create(name: string): boolean;
  /** Ajoute un adaptateur à un pont — `false` si le pont n'existe pas. */
  addMember(bridgeName: string, adapter: string): boolean;
  delete(name: string): void;
}

/** Politique NRPT `netsh namespace` — par-instance, modèle Windows. */
export interface WindowsNrptPolicy { readonly name: string; readonly namespace: string; readonly dnsservers: string; }
export interface WindowsNrptStore {
  policies(): readonly WindowsNrptPolicy[];
  add(policy: WindowsNrptPolicy): void;
}

/** Règle de pare-feu Windows (`netsh advfirewall firewall` / `New-NetFirewallRule`) — modèle Windows. */
export interface WindowsFirewallRule {
  readonly name: string;
  readonly displayName: string;
  readonly enabled: boolean;
  readonly action: string;
  readonly direction: string;
  readonly protocol: string;
  readonly localPort: string;
  readonly remotePort: string;
  readonly description: string;
}

/**
 * Pare-feu Windows (`netsh advfirewall firewall`) — état PARTAGÉ avec le
 * plan de données (`WindowsPC.firewallFilter`) et les cmdlets PowerShell
 * (`Get/New-NetFirewallRule`) : une règle ajoutée ici est honorée par le
 * filtrage réel des paquets. Optionnel, modèle Windows.
 */
export interface WindowsFirewallApi {
  rules(): readonly WindowsFirewallRule[];
  /** Une règle porte-t-elle ce nom (clé normalisée casse/espaces) ? */
  hasRule(name: string): boolean;
  addRule(rule: WindowsFirewallRule): void;
  /** Supprime toutes les règles au nom donné (ou toutes si absent) — renvoie le nombre supprimé. */
  deleteRules(name?: string): number;
  clearRules(): void;
}

/** Résultat d'une opération de rôle serveur (`netsh dhcp server`/`nps`) — `message` est le texte d'erreur vendeur déjà formaté. */
export interface WindowsServerOpResult { readonly ok: boolean; readonly message: string; }

/** Étendue DHCP (`netsh dhcp server show scope`) — modèle Windows Server. */
export interface WindowsDhcpScope { readonly name: string; readonly startRange: string; readonly subnetMask: string; }

/**
 * Rôle Serveur DHCP (`netsh dhcp server`) — présent UNIQUEMENT sur un
 * `WindowsServer` avec la fonctionnalité DHCP installée. Adosse le vrai
 * moteur DHCP (les baux qu'il distribue sont réels). `null` sur un poste
 * client.
 */
export interface WindowsDhcpServerApi {
  addScope(name: string, startRange: string, endRange: string, subnetMask: string): WindowsServerOpResult;
  scopes(): readonly WindowsDhcpScope[];
  addExclusionRange(startRange: string, endRange: string): WindowsServerOpResult;
  addReservation(scopeName: string, ipAddress: string, clientMac: string): WindowsServerOpResult;
  /** Résout l'étendue par nom OU par adresse réseau (`ScopeAddress`) — `null` si absente. */
  findScope(scopeAddressOrName: string): WindowsDhcpScope | null;
}

/** Client RADIUS/NAS (`netsh nps show clients`) — modèle Windows Server. */
export interface WindowsNasClient { readonly name: string; readonly ipAddress: string; }

/**
 * Rôle NPS/RADIUS (`netsh nps`) — présent UNIQUEMENT sur un
 * `WindowsServer` avec la fonctionnalité NPAS installée. `null` sur un
 * poste client.
 */
export interface WindowsNpsApi {
  addNasClient(name: string, address: string, secret: string): WindowsServerOpResult;
  nasClients(): readonly WindowsNasClient[];
}

/** Un écho ICMP individuel (`ping`) — optionnel, modèle Windows. */
export interface WindowsPingReply {
  readonly success: boolean;
  readonly fromIP?: string;
  readonly ttl: number;
  readonly rttMs: number;
  readonly error?: string;
}

/** Une sonde individuelle au sein d'un saut de traceroute — optionnel, modèle Windows. */
export interface WindowsTracerouteProbe {
  readonly responded: boolean;
  readonly rttMs?: number;
  readonly ip?: string;
  readonly unreachable?: boolean;
  readonly icmpCode?: number;
}

/** Un saut de traceroute (`tracert`) — optionnel, modèle Windows. */
export interface WindowsTracerouteHop {
  readonly hop: number;
  readonly ip?: string;
  readonly rttMs?: number;
  readonly timeout: boolean;
  readonly unreachable?: boolean;
  readonly icmpCode?: number;
  readonly probes: readonly WindowsTracerouteProbe[];
}

export interface NetworkApi {
  /** `dhcp` optionnel : seuls certains vendeurs (Windows) le suivent par interface. */
  interfaces(): Promise<{ name: string; ip: string; up: boolean; dhcp?: boolean }[]>;
  setInterfaceState(name: string, up: boolean): Promise<void>;
  /** Connexions/sockets actifs (`netstat`) — optionnel. */
  connections?(): Promise<readonly SocketInfo[]>;
}

/** Réponse à un écho ICMP réel émis à travers la topologie simulée. */
export interface IcmpEchoReply {
  readonly success: boolean;
  readonly rttMs: number;
  readonly ttl: number;
  readonly seq: number;
  readonly bytes: number;
  readonly fromIP: string;
  readonly error?: string;
}

/**
 * Sondes réseau bas niveau (`ping`/`traceroute`/`arping`) — optionnel.
 * Chaque méthode émet de VRAIES trames à travers Equipment/Port/Cable ;
 * la commande porte elle-même l'analyse d'arguments et le formatage.
 */
export interface NetProbeApi {
  /** Résolution DNS/hosts réelle — `null` si introuvable. */
  resolveHostname(name: string): Promise<string | null>;
  /** `false` si aucune route locale ne couvre la destination. */
  hasRoute(ip: string): boolean;
  /** Séquence d'échos ICMP réels — tableau vide = pas de réponse ARP/route. */
  echoSequence(targetIp: string, count: number, timeoutMs?: number, ttl?: number): Promise<readonly IcmpEchoReply[]>;
  /** Variante ICMPv6 — `null` si `target6` n'est pas une adresse IPv6 valide ;
   *  `target` est la forme canonique (compressée) de l'adresse. */
  echo6Sequence(target6: string, count: number, timeoutMs?: number): Promise<{ readonly target: string; readonly replies: readonly IcmpEchoReply[] } | null>;
  /** État physique des interfaces (MTU inclus) — la vue `ip addr` complète reste ailleurs. */
  interfaceDetails(): readonly { name: string; up: boolean; mtu: number }[];
  /** MTU de chaque port de toute la topologie (découverte PMTU de `ping -M do`). */
  topologyMtus(): readonly number[];
  /** MAC connue du voisin — `null` si absent de la table (`arping`). */
  neighborMac(ip: string): string | null;
  /** Sondes TTL croissant réelles à travers la topologie (`traceroute`). */
  traceroute(targetIp: string, maxHops?: number, probesPerHop?: number, firstTtl?: number, timeoutMs?: number): Promise<readonly TracerouteHopInfo[]>;
  /** Émet un datagramme UDP local (mode UDP de `traceroute`) — `false` si non émis. */
  sendUdpProbe(targetIp: string, destinationPort: number, sourcePort: number): boolean;
  /** Passerelle par défaut IPv4 — `null` si aucune. */
  defaultGateway(): string | null;
  /** Résolution inverse IP → nom (fichier hosts) — `null` si absent. */
  reverseLookup(ip: string): string | null;
  /** Vraie si un équipement de la topologie refuse (ACL deny) l'UDP sur toute la plage donnée. */
  udpRangeDeniedByTopology(startPort: number, endPort: number): boolean;
  /** Toutes les IP des ports de l'équipement possédant `ip` (alias multi-interfaces d'un saut). */
  deviceIpsSharing(ip: string): readonly string[];
}

/** Détail d'une sonde individuelle d'un saut de `traceroute`. */
export interface TracerouteProbeInfo {
  readonly responded: boolean;
  readonly rttMs?: number;
  readonly ip?: string;
  readonly unreachable?: boolean;
  readonly icmpCode?: number;
}

/** Un saut de `traceroute` (une valeur de TTL). */
export interface TracerouteHopInfo {
  readonly hop: number;
  readonly ip?: string;
  readonly rttMs?: number;
  readonly timeout: boolean;
  readonly unreachable?: boolean;
  readonly icmpCode?: number;
  readonly probes: readonly TracerouteProbeInfo[];
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

/** Détail complet d'un compte local (`net user <name>`) — optionnel, modèle Windows/SAM sans équivalent POSIX direct. */
export interface AccountDetail {
  readonly name: string;
  readonly fullName: string;
  readonly description: string;
  readonly enabled: boolean;
  readonly passwordLastSet: Date;
  readonly passwordRequired: boolean;
  readonly userMayChangePassword: boolean;
  readonly lastLogon: Date | null;
  readonly localGroups: readonly string[];
}

export interface AccountMutationResult {
  readonly ok: boolean;
  readonly error?: string;
}

export interface UserManagementApi {
  findByName(name: string): Promise<import("../session/types").User | undefined>;
  findByUid(uid: number): Promise<import("../session/types").User | undefined>;
  create(name: string, groups: string[]): Promise<import("../session/types").User>;
  delete(uid: number): Promise<void>;
  /** Identité de sécurité complète du compte, déjà résolue (SID, domaine actif inclus) — optionnel (`whoami`). */
  securityIdentity?(name: string): Promise<SecurityIdentity | undefined>;
  /** Comptes locaux connus, par nom — optionnel (`net user`). */
  listAccountNames?(): readonly string[];
  /** Détail complet d'un compte local, déjà résolu — optionnel (`net user <name>`). */
  getAccountDetail?(name: string): AccountDetail | undefined;
  /** Crée un compte local avec mot de passe — optionnel (`net user <name> <mdp> /add`). */
  createAccount?(name: string, password: string): AccountMutationResult;
  /** Supprime un compte local — optionnel (`net user <name> /delete`). */
  deleteAccount?(name: string): AccountMutationResult;
  /** Modifie une propriété d'un compte local (`active`/`fullname`/`comment`/`password`) — optionnel. */
  setAccountProperty?(name: string, property: 'active' | 'fullname' | 'comment' | 'password', value: string): AccountMutationResult;
  /** L'appelant courant a-t-il des droits d'administration locale — optionnel, gate de mutation pour `net user`/`net localgroup`. */
  callerIsAdmin?(): boolean;
  /** Noms des comptes de domaine (`net user /domain`) — optionnel, `undefined` si l'équipement n'est pas un contrôleur de domaine promu. */
  domainAccountNames?(): readonly string[] | undefined;
  /** Détail d'un compte de domaine, déjà résolu — optionnel (`net user <name> /domain`). Champ réduit par rapport à `AccountDetail` : AD ne suit pas les mêmes attributs de mot de passe qu'un compte SAM local. */
  getDomainAccountDetail?(sam: string): { readonly sam: string; readonly fullName: string; readonly enabled: boolean; readonly globalGroups: readonly string[] } | undefined;
}

export interface PowerApi {
  shutdown(delaySeconds: number): Promise<void>;
  reboot(): Promise<void>;
}

/** Une session Bureau à distance (`query session`/`qwinsta`) — modèle Windows. */
export interface RdpSessionInfo {
  readonly sessionId: number;
  readonly userName: string;
  readonly state: string;
}

/**
 * Sessions Bureau à distance (`query session`/`qwinsta`, `logoff`/`rwinsta`)
 * — optionnel, pas un concept universel. Introspection et fermeture de la
 * table de sessions RDP (aucun contenu graphique).
 */
export interface RdpSessionsApi {
  /** `query session` / `qwinsta` — sessions RDP établies. */
  list(): readonly RdpSessionInfo[];
  /** `logoff` / `rwinsta` — ferme une session ; `false` si l'ID n'existe pas. */
  logoff(sessionId: number): boolean;
}

/** Résultat d'une demande de certificat (`certreq -submit`) — modèle Windows/AD CS. */
export interface CertificateIssuance {
  readonly ok: boolean;
  readonly message: string;
  readonly serialNumber?: string;
  readonly subject?: string;
  readonly issuer?: string;
}

/**
 * Services de certificats côté client (`certreq`/`certutil -submit`) —
 * optionnel, présent uniquement quand le rôle AD CS est installé (donc
 * jamais sur un simple poste : `certreq` y répond « RPC server is
 * unavailable »). Soumet une demande à l'autorité de certification et
 * stocke le certificat émis dans le magasin local.
 */
export interface CertificateServicesApi {
  /** `certreq -submit -template <modèle> -subject <sujet>` — émet un certificat signé par l'AC. */
  submitRequest(subject: string, template: string, eku: string | undefined): CertificateIssuance;
}

/**
 * Client d'impression réseau (`lpr`) — optionnel, pas un concept universel.
 * Soumet un travail à une file LPD distante via un vrai échange RFC 1179 ;
 * le nom du propriétaire et l'hôte d'origine sont fournis par l'équipement.
 */
export interface PrintClientApi {
  /** `lpr -S <serveur> -P <file> <fichier>` — soumet `content` à la file LPD distante. `ok:false` = échec (file inexistante, injoignable...). */
  submitLpdJob(server: string, queue: string, jobName: string, content: Uint8Array): { ok: boolean; error?: string };
}

/**
 * État d'activation/licence de la machine (`slmgr`) — optionnel, pas un
 * concept universel. `installProductKey`/`activate` mutent l'état ;
 * `productKey`/`state` le lisent. Aucune vérification cryptographique
 * (une clé au format `XXXXX-XXXXX-XXXXX-XXXXX-XXXXX` suffit).
 */
export interface LicensingApi {
  /** `slmgr /ipk <clé>` — validation de forme uniquement. */
  installProductKey(key: string): { ok: boolean; message: string };
  /** `slmgr /ato` — active contre la clé installée. */
  activate(): { ok: boolean; message: string };
  /** Clé de produit installée (`null` si aucune). */
  productKey(): string | null;
  /** État de licence courant (`Notification`, `Licensed`, ...). */
  state(): string;
}

/**
 * Élévation/changement d'identité (`runas`) — optionnel, pas un concept
 * universel. Le changement d'identité et la ré-entrée récursive du shell
 * (le programme s'exécute dans une logon session distincte) sont des
 * primitives de l'équipement ; le parsing/la validation/le formatage
 * restent côté commande. `getUser` a la forme d'une `RunasUserSource` pour
 * réutiliser le validateur partagé.
 */
export interface RunAsApi {
  /** Compte local (nom + état d'activation) — `undefined` si inconnu (validation `runas`). */
  getUser(name: string): { readonly name: string; readonly enabled: boolean } | undefined;
  /** Nom du compte appelant courant (`runas /netonly` = « exécuter en tant que l'appelant »). */
  currentUser(): string;
  /** Exécute `command` sous l'identité `userName`, puis restaure l'appelant — vraie ré-entrée du shell. */
  runCommandAs(userName: string, command: string): Promise<string>;
}

export interface GroupInfo {
  readonly gid: number;
  readonly name: string;
}

/** Détail complet d'un groupe local (`net localgroup <name>`) — optionnel. */
export interface GroupDetail {
  readonly name: string;
  readonly description: string;
  readonly members: readonly string[];
}

export interface GroupManagementApi {
  findByGid(gid: number): Promise<GroupInfo | undefined>;
  findByName(name: string): Promise<GroupInfo | undefined>;
  /** Groupes locaux connus, par nom — optionnel (`net localgroup`). */
  listGroupNames?(): readonly string[];
  /** Détail complet d'un groupe local (description, membres), déjà résolu — optionnel. */
  getGroupDetail?(name: string): GroupDetail | undefined;
  /** Crée un groupe local — optionnel (`net localgroup <name> /add`). */
  createGroup?(name: string, description: string): AccountMutationResult;
  /** Supprime un groupe local — optionnel (`net localgroup <name> /delete`). */
  deleteGroup?(name: string): AccountMutationResult;
  /** Ajoute un membre à un groupe local — optionnel. */
  addGroupMember?(groupName: string, memberName: string): AccountMutationResult;
  /** Retire un membre d'un groupe local — optionnel. */
  removeGroupMember?(groupName: string, memberName: string): AccountMutationResult;
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

/** Résultat d'une écriture syslog (`logger`) : `ok` faux si le spec
 * `facility.priority` est invalide ; `line` est la ligne syslog formatée
 * (rendue par `logger -s`). */
export interface SyslogWriteResult {
  readonly ok: boolean;
  readonly line: string;
}

/** Un message du ring buffer noyau (`dmesg`) : décalage en secondes depuis
 * le démarrage, niveau syslog (0-7), texte. */
export interface KernelMessage {
  readonly offsetSec: number;
  readonly level: number;
  readonly message: string;
}

/** Un enregistrement du journal système (`journalctl`). */
export interface JournalRecord {
  readonly timestampMs: number;
  readonly priority: number;
  readonly facility: number;
  readonly unit: string;
  readonly tag: string;
  readonly message: string;
  readonly pid: number;
  readonly displayPid?: boolean;
  readonly hostname: string;
}

/**
 * Capacité optionnelle : journalisation système (syslog/journald/kernel
 * ring buffer) pour les équipements qui en tiennent une. Absente des
 * profils sans démon de log — les commandes l'appellent via
 * `ctx.machine.logging?.` . Expose des primitives (écrire un
 * enregistrement, lire le journal / le ring buffer noyau) ; le parsing et
 * le formatage propres à chaque commande (`logger`/`journalctl`/`dmesg`)
 * restent dans la commande.
 */
export interface LoggingApi {
  writeSyslog(facilityPrioritySpec: string, tag: string, message: string, displayPid: boolean): SyslogWriteResult;
  /** Instantané du ring buffer noyau (`dmesg`). */
  kernelBuffer(): readonly KernelMessage[];
  /** Vide le ring buffer noyau (`dmesg -c`/`-C`). */
  clearKernelBuffer(): void;
  /** Horodatage du démarrage, pour les timestamps humains (`dmesg -T`). */
  bootTime(): Date;
  /** `journald` est-il actif (sinon `journalctl` ne trouve pas de journal). */
  journalActive(): boolean;
  /** Instantané du journal système, ordre chronologique (`journalctl`). */
  journalEntries(): readonly JournalRecord[];
  /** Identifiant de boot courant (`journalctl --list-boots`, format `verbose`). */
  bootId(): string;
}

/**
 * Masque de permissions par défaut appliqué à la création de fichiers/
 * répertoires (`umask` POSIX) — optionnel, pas un concept universel : un
 * équipement sans notion de masque de création à la Unix (Windows/ACL,
 * Cisco/Huawei…) ne l'implémente pas.
 */
export interface PermissionsApi {
  getUmask(): Promise<number>;
  setUmask(mask: number): Promise<void>;
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
  /** Contrôle des processus POSIX (`pidof`, `pgrep`, `pkill`, `kill`, `killall`) — optionnel, propre aux équipements Unix. */
  readonly processControl?: ProcessControlApi;
  readonly net: NetworkApi;
  /** Sondes réseau réelles (`ping`/`traceroute`/`arping`) — optionnel. */
  readonly netProbe?: NetProbeApi;
  readonly users: UserManagementApi;
  readonly groups: GroupManagementApi;
  readonly power: PowerApi;
  readonly hostname: string;
  readonly audit?: AuditApi;
  /** Journalisation système (`logger`, `journalctl`, `dmesg`) — optionnel, propre aux équipements Unix avec syslog/journald. */
  readonly logging?: LoggingApi;
  readonly os?: OsIdentity;
  readonly hardware?: HardwareProfile;
  /** Horodatage de démarrage, si l'équipement suit un cycle de vie power-on/off (`systeminfo`'s System Boot Time). */
  bootedAt?(): Date | null;
  /** Gestionnaire de services façon SCM (`sc`, `net start`/`stop`) — optionnel, pas un concept universel (voir systemd côté `LinuxCommand`). */
  readonly services?: ServiceManagementApi;
  /** Macros de ligne de commande (`doskey`, cmd.exe) — optionnel, pas un concept universel. */
  readonly macros?: MacroApi;
  /** Partages SMB serveur (`net share`) — optionnel, pas un concept universel. */
  readonly smbShares?: SmbShareApi;
  /** Sessions SMB entrantes (`net session`) — optionnel, pas un concept universel. */
  readonly smbSessions?: SmbSessionApi;
  /** Mappages de lecteurs réseau SMB (`net use`) — optionnel, pas un concept universel. */
  readonly netUse?: NetUseApi;
  /** Politique de compte LSA (`net accounts`) — optionnel, pas un concept universel. */
  readonly accountsPolicy?: AccountsPolicyApi;
  /** Planificateur de tâches (`schtasks`) — optionnel, pas un concept universel. */
  readonly scheduling?: SchedulingApi;
  /** File d'impression (`print`) — optionnel, pas un concept universel. */
  readonly printing?: PrintApi;
  /** Registre système (`reg`, `Registry::`) — optionnel, pas un concept universel. */
  readonly registry?: RegistryApi;
  /** Politique d'audit (`auditpol`) — optionnel, pas un concept universel. */
  readonly auditPolicy?: AuditPolicyApi;
  /** Configuration WinRM (`winrm`) — optionnel, pas un concept universel. */
  readonly winRm?: WinRmApi;
  /** Adaptateurs/ARP/table de routage bas niveau (`arp`, `route`, `getmac`) — optionnel, pas un concept universel. */
  readonly netConfig?: WindowsNetConfigApi;
  /** Journal d'évènements Windows (`wevtutil`) — optionnel, pas un concept universel (Linux a syslog/journald). */
  readonly eventLog?: EventLogApi;
  /** Appartenance à un domaine AD (`gpupdate`, `gpresult`) — optionnel, pas un concept universel. */
  readonly domain?: DomainApi;
  /** Administration du serveur DNS (`dnscmd`) — optionnel, présent seulement quand le rôle DNS Server est installé. */
  readonly dnsServer?: DnsServerAdminApi;
  /** Élévation/changement d'identité (`runas`) — optionnel, pas un concept universel. */
  readonly runAs?: RunAsApi;
  /** État d'activation/licence (`slmgr`) — optionnel, pas un concept universel. */
  readonly licensing?: LicensingApi;
  /** Client d'impression réseau (`lpr`) — optionnel, pas un concept universel. */
  readonly printClient?: PrintClientApi;
  /** Services de certificats (`certreq`/`certutil`) — optionnel, présent seulement quand le rôle AD CS est installé. */
  readonly certificateServices?: CertificateServicesApi;
  /** Sessions Bureau à distance (`query session`, `logoff`) — optionnel, pas un concept universel. */
  readonly rdpSessions?: RdpSessionsApi;
  /** Masque de permissions par défaut (`umask`) — optionnel, pas un concept universel. */
  readonly permissions?: PermissionsApi;
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
