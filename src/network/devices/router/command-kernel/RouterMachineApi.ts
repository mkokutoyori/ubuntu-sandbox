import {
  FileStat,
  FileSystemApi,
  GroupInfo,
  GroupManagementApi,
  MachineApi,
  NetworkApi,
  PowerApi,
  ProcessApi,
  ProcessInfo,
  UserManagementApi,
} from '@/command-kernel/machine/types';
import type { User } from '@/command-kernel/session/types';
import type { CliMachineApi, ModeRegistry } from '@/command-kernel/cli';
import { FileSystemError } from '@/command-kernel/errors';
import { IPAddress, SubnetMask } from '@/network/core/types';
import type { Router } from '../../Router';

/**
 * =====================================================================
 *  RouterMachineApi — façade UNIQUE pour les commandes CLI vendeur
 * =====================================================================
 *
 *  Toutes les commandes migrées (Cisco IOS ou Huawei VRP) lisent ET
 *  modifient l'état du routeur EXCLUSIVEMENT à travers cette façade —
 *  jamais un import direct de `Router`, `Port`, `ACLEngine`, `NATEngine`,
 *  ni d'un formateur legacy (`CiscoShowCommands`, `HuaweiDisplayCommands`).
 *
 *  Structure suivant `MachineApi` (fs/proc/net/users/…) + capacités
 *  additionnelles propres à l'équipement routeur :
 *   - `cli` : socle CLI (modes, prompt) pour `enable`/`configure`/`exit`
 *   - `router` (à venir) : ports/routing table/ACL/NAT en lecture typée
 *
 *  Pour les capacités qui n'ont aucun sens sur un routeur (fs POSIX,
 *  processus, users locaux au sens Linux), on renvoie des erreurs
 *  explicites plutôt que des stubs silencieux — signal clair pour les
 *  commandes portées à tort sur ce socle.
 */
export interface RouterMachineApiDeps {
  readonly router: Router;
  readonly modes: ModeRegistry;
}

/** Info d'interface exposée aux commandes — DTO stable, pas l'objet
 *  `Port` réel (les commandes n'ont pas à connaître la classe). */
export interface RouterInterfaceInfo {
  readonly name: string;
  readonly ip: string;
  readonly mask: string;
  readonly mac: string;
  readonly mtu: number;
  readonly adminUp: boolean;
  readonly linkUp: boolean;
  readonly description: string;
}

/** DTO de route exposé aux commandes — évite de fuiter `RouteEntry`
 *  (qui référence des instances `IPAddress`/`SubnetMask`). Sous forme
 *  texte + entier prêts à formater. */
export type RouterRouteType = 'connected' | 'static' | 'default' | 'rip' | 'ospf' | 'eigrp' | 'bgp';

export interface RouterRouteInfo {
  readonly network: string;
  readonly mask: string;
  readonly cidr: number;
  readonly nextHop: string | null;
  readonly iface: string;
  readonly type: RouterRouteType;
  readonly ad: number;
  readonly metric: number;
}

/** Sous-façade `router` : lecture/écriture typée de l'état routeur.
 *  Aucun `Port`/`Router`/`ACLEngine` ne fuit ; les commandes reçoivent
 *  des DTOs et appellent des méthodes explicites pour muter l'état. */
export interface RouterCapabilityApi {
  interfaces(): readonly RouterInterfaceInfo[];
  interface(name: string): RouterInterfaceInfo | null;
  /** Description libre d'une interface (`interface X`/`description Y`).
   *  Retourne `false` si l'interface n'existe pas. */
  setInterfaceDescription(name: string, description: string): boolean;
  /** État admin (`no shutdown`/`shutdown`). Retourne `false` si absente. */
  setInterfaceAdminUp(name: string, up: boolean): boolean;
  /** Configure l'IP primaire (`ip address A.B.C.D M.M.M.M`). Retourne
   *  `{ ok: false, error }` si l'interface est absente ou les valeurs
   *  invalides — sans exception. Les commandes reçoivent des chaînes
   *  ; la façade parse (jamais l'inverse). */
  setInterfaceIp(name: string, ip: string, mask: string): { ok: boolean; error?: string };
  /** Retire toute IP primaire (`no ip address`). */
  clearInterfaceIp(name: string): boolean;
  /** Table de routage IPv4 (RIB) sous forme de DTOs stables. Ordre
   *  d'insertion préservé — les commandes trient elles-mêmes. */
  routes(): readonly RouterRouteInfo[];
}

class RouterCapabilityImpl implements RouterCapabilityApi {
  constructor(private readonly router: Router) {}

  interfaces(): readonly RouterInterfaceInfo[] {
    return this.router.getPorts().map((port) => ({
      name: port.getName(),
      ip: port.getIPAddress()?.toString() ?? '',
      mask: port.getSubnetMask()?.toString() ?? '',
      mac: port.getMAC().toString(),
      mtu: port.getMTU(),
      adminUp: !port.isAdminDown(),
      linkUp: port.getIsUp() && port.isConnected(),
      description: this.router.getInterfaceDescription(port.getName()) ?? '',
    }));
  }

  interface(name: string): RouterInterfaceInfo | null {
    const port = this.router.getPort(name);
    if (!port) return null;
    return {
      name: port.getName(),
      ip: port.getIPAddress()?.toString() ?? '',
      mask: port.getSubnetMask()?.toString() ?? '',
      mac: port.getMAC().toString(),
      mtu: port.getMTU(),
      adminUp: !port.isAdminDown(),
      linkUp: port.getIsUp() && port.isConnected(),
      description: this.router.getInterfaceDescription(name) ?? '',
    };
  }

  setInterfaceDescription(name: string, description: string): boolean {
    const port = this.router.getPort(name);
    if (!port) return false;
    const map = (this.router as unknown as { _getInterfaceDescriptions(): Map<string, string> })._getInterfaceDescriptions();
    if (description === '') map.delete(name);
    else map.set(name, description);
    return true;
  }

  setInterfaceAdminUp(name: string, up: boolean): boolean {
    const port = this.router.getPort(name);
    if (!port) return false;
    port.setAdminDown(!up);
    return true;
  }

  setInterfaceIp(name: string, ip: string, mask: string): { ok: boolean; error?: string } {
    const port = this.router.getPort(name);
    if (!port) return { ok: false, error: `unknown interface: ${name}` };
    let parsedIp: IPAddress;
    let parsedMask: SubnetMask;
    try { parsedIp = new IPAddress(ip); } catch { return { ok: false, error: `invalid IP: ${ip}` }; }
    try { parsedMask = new SubnetMask(mask); } catch { return { ok: false, error: `invalid mask: ${mask}` }; }
    this.router.configureInterface(name, parsedIp, parsedMask, false);
    return { ok: true };
  }

  clearInterfaceIp(name: string): boolean {
    const port = this.router.getPort(name);
    if (!port) return false;
    this.router.unconfigureInterface(name);
    return true;
  }

  routes(): readonly RouterRouteInfo[] {
    return this.router.getRoutingTable().map((r) => ({
      network: r.network.toString(),
      mask: r.mask.toString(),
      cidr: r.mask.toCIDR(),
      nextHop: r.nextHop ? r.nextHop.toString() : null,
      iface: r.iface,
      type: r.type as RouterRouteType,
      ad: r.ad,
      metric: r.metric,
    }));
  }
}

class RouterNetworkApi implements NetworkApi {
  constructor(private readonly router: Router) {}

  async interfaces(): Promise<{ name: string; ip: string; up: boolean }[]> {
    return this.router.getPorts().map((port) => ({
      name: port.getName(),
      ip: port.getIPAddress()?.toString() ?? '',
      up: !port.isAdminDown(),
    }));
  }

  async setInterfaceState(name: string, up: boolean): Promise<void> {
    const port = this.router.getPort(name);
    if (!port) throw new FileSystemError(name, 'ENOENT', `interface introuvable : ${name}`);
    port.setAdminDown(!up);
  }
}

// ─── Rejets explicites : capacités inapplicables à un routeur ──────

const UNSUPPORTED = (path: string): never => {
  throw new FileSystemError(path, 'EACCES', `${path}: not supported on this equipment`);
};

class RouterFileSystemApi implements FileSystemApi {
  async readFile(path: string): Promise<string> { return UNSUPPORTED(path); }
  async writeFile(path: string): Promise<void> { UNSUPPORTED(path); }
  async touch(path: string): Promise<void> { UNSUPPORTED(path); }
  async list(path: string): Promise<FileStat[]> { return UNSUPPORTED(path); }
  async stat(path: string): Promise<FileStat> { return UNSUPPORTED(path); }
  async lstat(path: string): Promise<FileStat> { return UNSUPPORTED(path); }
  async exists(): Promise<boolean> { return false; }
  async remove(path: string): Promise<void> { UNSUPPORTED(path); }
  async mkdir(path: string): Promise<void> { UNSUPPORTED(path); }
  async rmdir(path: string): Promise<void> { UNSUPPORTED(path); }
  async chmod(path: string): Promise<void> { UNSUPPORTED(path); }
  async chown(path: string): Promise<void> { UNSUPPORTED(path); }
  async copy(source: string): Promise<void> { UNSUPPORTED(source); }
  async rename(source: string): Promise<void> { UNSUPPORTED(source); }
  async symlink(_target: string, path: string): Promise<void> { UNSUPPORTED(path); }
  async readlink(path: string): Promise<string> { return UNSUPPORTED(path); }
  async link(_target: string, path: string): Promise<void> { UNSUPPORTED(path); }
  resolve(_cwd: string, path: string): string { return path; }
}

const EMPTY_PROC: ProcessApi = {
  async list(): Promise<ProcessInfo[]> { return []; },
  async kill(): Promise<void> { /* pas de table de processus sur un routeur */ },
  async spawn(): Promise<ProcessInfo> {
    throw new FileSystemError('', 'EACCES', 'spawn: not supported on this equipment');
  },
};

const EMPTY_USERS: UserManagementApi = {
  async findByName(): Promise<User | undefined> { return undefined; },
  async findByUid(): Promise<User | undefined> { return undefined; },
  async create(): Promise<User> {
    throw new FileSystemError('', 'EACCES', 'useradd: not supported on this equipment');
  },
  async delete(): Promise<void> { /* pas de compte AAA local géré ici */ },
};

const EMPTY_GROUPS: GroupManagementApi = {
  async findByGid(): Promise<GroupInfo | undefined> { return undefined; },
  async findByName(): Promise<GroupInfo | undefined> { return undefined; },
};

// ─── Assemblage ─────────────────────────────────────────────────────

export class RouterMachineApi implements MachineApi {
  readonly fs: FileSystemApi = new RouterFileSystemApi();
  readonly proc = EMPTY_PROC;
  readonly net: NetworkApi;
  readonly users = EMPTY_USERS;
  readonly groups = EMPTY_GROUPS;
  readonly power: PowerApi;
  readonly cli: CliMachineApi;
  readonly router: RouterCapabilityApi;

  constructor(private readonly deps: RouterMachineApiDeps) {
    this.net = new RouterNetworkApi(deps.router);
    this.router = new RouterCapabilityImpl(deps.router);
    this.cli = { modes: deps.modes };
    this.power = {
      shutdown: async () => { deps.router.powerOff(); },
      reboot: async () => { deps.router.powerOff(); deps.router.powerOn(); },
    };
  }

  get hostname(): string {
    return this.deps.router.getHostname();
  }

  setHostname(newName: string): void {
    this.deps.router.setHostname(newName);
  }

  bootedAt(): Date {
    return new Date(this.deps.router.getBootedAtMs());
  }

  now(): Date {
    return new Date();
  }
}
