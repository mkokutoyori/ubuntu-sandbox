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
import { IPAddress, MACAddress, SubnetMask } from '@/network/core/types';
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
/** Encapsulation L2 posée sur une sous-interface routeur.
 *  `type` reste texte pour rester ouvert aux futurs types (`isl`,
 *  `ppp`…) — dot1Q est le seul migré pour l'instant. */
export interface RouterInterfaceEncapsulation {
  readonly type: string;
  readonly vlan?: number;
  readonly native: boolean;
}

export interface RouterInterfaceInfo {
  readonly name: string;
  readonly ip: string;
  readonly mask: string;
  readonly mac: string;
  readonly mtu: number;
  readonly adminUp: boolean;
  readonly linkUp: boolean;
  readonly description: string;
  /** Sous-interface : nom de l'interface parent (`Gi0/0` si le nom est
   *  `Gi0/0.10`). `null` pour une interface principale. */
  readonly parent: string | null;
  /** Sous-interface : encapsulation configurée (`dot1Q <vid>`). */
  readonly encapsulation: RouterInterfaceEncapsulation | null;
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

/** Entrée ARP exposée aux commandes — DTO stable. `ageSeconds` mesuré
 *  depuis le timestamp du plan de données. `iface` peut être vide pour
 *  les entrées statiques posées sans interface d'ancrage. */
export interface RouterArpEntry {
  readonly ip: string;
  readonly mac: string;
  readonly iface: string;
  readonly type: 'dynamic' | 'static';
  readonly ageSeconds: number;
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
  /** Table ARP courante sous forme de DTOs stables. Ordre d'insertion
   *  préservé — les commandes trient/filtrent elles-mêmes. */
  arpEntries(): readonly RouterArpEntry[];
  /** Pose une entrée ARP statique (`arp static <ip> <mac>`). Retourne
   *  `{ ok: false, error }` si l'IP ou la MAC sont invalides. */
  addStaticArp(ip: string, mac: string): { ok: boolean; error?: string };
  /** Retire une entrée ARP par IP (`undo arp <ip>` / `undo arp static
   *  <ip>`). Retourne `false` si l'entrée n'existe pas. */
  removeArp(ip: string): boolean;
  /** Ajuste le MTU d'une interface (`mtu <bytes>`). Retourne `false`
   *  si l'interface est absente ou la valeur invalide (68..9216). */
  setInterfaceMtu(name: string, bytes: number): boolean;
  /** Ajoute une route statique (`ip route <net> <mask> <nexthop>`).
   *  Retourne `{ ok: false, error }` sans exception si les valeurs
   *  sont invalides ou la limite RIB atteinte. */
  addStaticRoute(network: string, mask: string, nextHop: string): { ok: boolean; error?: string };
  /** Retire une route statique. `nextHop` optionnel : si absent,
   *  retire toutes les routes statiques correspondant au (net, mask). */
  removeStaticRoute(network: string, mask: string, nextHop?: string): { ok: boolean; error?: string };
  /** Crée à la volée une sous-interface `<parent>.<id>` (pattern
   *  Cisco). Le parent doit exister. La sous-interface créée est
   *  virtuelle (`up`) et sans encapsulation par défaut. Retourne le
   *  nom canonique de la sous-interface (`Gi0/0.10`). */
  createSubInterface(parent: string, subId: number): { ok: boolean; error?: string; name?: string };
  /** Configure l'encapsulation d'une sous-interface (`encapsulation
   *  dot1Q <vid> [native]`). Refuse si l'interface n'est pas une
   *  sous-interface. */
  setInterfaceEncapsulation(name: string, type: string, vlan: number | undefined, native: boolean): { ok: boolean; error?: string };
}

/** Nom parent d'une sous-interface Cisco (`Gi0/0.10` → `Gi0/0`). */
function parentOf(name: string): string | null {
  const dot = name.indexOf('.');
  return dot > 0 ? name.slice(0, dot) : null;
}

/** Lecture non-typée du champ `encapsulation` posé sur le `Port` par
 *  le setter — la seule dépendance à la structure vendeur est isolée
 *  ici, jamais dans une commande. */
function readEncapsulation(port: import('../../../hardware/Port').Port): RouterInterfaceEncapsulation | null {
  const enc = (port as unknown as { encapsulation?: { type?: string; vlan?: number; native?: boolean } }).encapsulation;
  if (!enc || !enc.type) return null;
  return { type: enc.type, vlan: enc.vlan, native: enc.native ?? false };
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
      parent: parentOf(port.getName()),
      encapsulation: readEncapsulation(port),
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
      parent: parentOf(name),
      encapsulation: readEncapsulation(port),
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

  addStaticRoute(network: string, mask: string, nextHop: string): { ok: boolean; error?: string } {
    let n: IPAddress, m: SubnetMask, nh: IPAddress;
    try { n = new IPAddress(network); } catch { return { ok: false, error: `invalid network: ${network}` }; }
    try { m = new SubnetMask(mask); } catch { return { ok: false, error: `invalid mask: ${mask}` }; }
    try { nh = new IPAddress(nextHop); } catch { return { ok: false, error: `invalid next-hop: ${nextHop}` }; }
    const ok = this.router.addStaticRoute(n, m, nh);
    return ok ? { ok: true } : { ok: false, error: 'routing table full' };
  }

  removeStaticRoute(network: string, mask: string, nextHop?: string): { ok: boolean; error?: string } {
    let n: IPAddress, m: SubnetMask, nh: IPAddress | undefined;
    try { n = new IPAddress(network); } catch { return { ok: false, error: `invalid network: ${network}` }; }
    try { m = new SubnetMask(mask); } catch { return { ok: false, error: `invalid mask: ${mask}` }; }
    if (nextHop !== undefined) {
      try { nh = new IPAddress(nextHop); } catch { return { ok: false, error: `invalid next-hop: ${nextHop}` }; }
    }
    const ok = this.router.removeStaticRoute(n, m, nh);
    return ok ? { ok: true } : { ok: false, error: 'route not found' };
  }

  createSubInterface(parent: string, subId: number): { ok: boolean; error?: string; name?: string } {
    if (!this.router.getPort(parent)) return { ok: false, error: `unknown parent interface: ${parent}` };
    if (!Number.isInteger(subId) || subId < 0) return { ok: false, error: `invalid sub-id: ${subId}` };
    const name = `${parent}.${subId}`;
    const already = this.router.getPort(name);
    if (already) return { ok: true, name };
    const created = (this.router as unknown as { _createVirtualInterface(name: string): boolean })._createVirtualInterface(name);
    if (!created) return { ok: false, error: `failed to create ${name}` };
    return { ok: true, name };
  }

  setInterfaceEncapsulation(name: string, type: string, vlan: number | undefined, native: boolean): { ok: boolean; error?: string } {
    const port = this.router.getPort(name);
    if (!port) return { ok: false, error: `unknown interface: ${name}` };
    if (parentOf(name) === null) return { ok: false, error: `encapsulation only valid on sub-interfaces` };
    const kind = type.toLowerCase();
    if (kind !== 'dot1q') return { ok: false, error: `unsupported encapsulation type: ${type}` };
    if (vlan === undefined || !Number.isInteger(vlan) || vlan < 1 || vlan > 4094) {
      return { ok: false, error: `invalid VLAN id` };
    }
    (port as unknown as { encapsulation?: { type: string; vlan?: number; native?: boolean } }).encapsulation = {
      type: kind, vlan, native,
    };
    return { ok: true };
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

  arpEntries(): readonly RouterArpEntry[] {
    const table = (this.router as unknown as { _getArpTableInternal(): Map<string, { mac: { toString(): string }; iface: string; timestamp: number; type: 'dynamic' | 'static' }> })._getArpTableInternal();
    const now = Date.now();
    const out: RouterArpEntry[] = [];
    for (const [ip, entry] of table) {
      out.push({
        ip,
        mac: entry.mac.toString(),
        iface: entry.iface,
        type: entry.type,
        ageSeconds: entry.type === 'static' ? 0 : Math.max(0, Math.floor((now - entry.timestamp) / 1000)),
      });
    }
    return out;
  }

  addStaticArp(ip: string, mac: string): { ok: boolean; error?: string } {
    let parsedIp: IPAddress, parsedMac: MACAddress;
    try { parsedIp = new IPAddress(ip); } catch { return { ok: false, error: `invalid IP: ${ip}` }; }
    // Accepte les 3 formats vendeurs courants : colon (`aa:bb:cc:dd:ee:ff`),
    // Cisco dotted (`aabb.ccdd.eeff`), Huawei dashed (`aabb-ccdd-eeff`).
    // Le parser MACAddress connaît les 2 premiers ; on normalise le
    // 3e en dotted avant de le passer.
    const normalized = /^[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}$/.test(mac)
      ? mac.replace(/-/g, '.')
      : mac;
    try { parsedMac = new MACAddress(normalized); } catch { return { ok: false, error: `invalid MAC: ${mac}` }; }
    (this.router as unknown as { _addStaticARP(ip: IPAddress, mac: MACAddress, iface: string): void })._addStaticARP(parsedIp, parsedMac, '');
    return { ok: true };
  }

  removeArp(ip: string): boolean {
    let parsedIp: IPAddress;
    try { parsedIp = new IPAddress(ip); } catch { return false; }
    return (this.router as unknown as { _deleteARP(ip: IPAddress): boolean })._deleteARP(parsedIp);
  }

  setInterfaceMtu(name: string, bytes: number): boolean {
    const port = this.router.getPort(name);
    if (!port) return false;
    if (!Number.isInteger(bytes) || bytes < 68 || bytes > 9216) return false;
    port.setMTU(bytes);
    return true;
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

  /** `dhcp enable` — active le service DHCP global. */
  enableDhcp(): void {
    (this.deps.router as unknown as { _getDHCPServerInternal(): { enable(): void } })._getDHCPServerInternal().enable();
  }

  /** `undo dhcp enable` — désactive le service DHCP global. */
  disableDhcp(): void {
    (this.deps.router as unknown as { _getDHCPServerInternal(): { disable(): void } })._getDHCPServerInternal().disable();
  }

  isDhcpEnabled(): boolean {
    return (this.deps.router as unknown as { _getDHCPServerInternal(): { isEnabled(): boolean } })._getDHCPServerInternal().isEnabled();
  }

  /** `mtu <bytes>` (interface-view) — délègue au sous-capability `router`. */
  setInterfaceMtu(name: string, bytes: number): boolean {
    return this.router.setInterfaceMtu(name, bytes);
  }

  /** Liste des noms de pools DHCP existants — utilisé par `display ip pool`
   *  et la synthèse `display current-configuration`. */
  dhcpPoolNames(): readonly string[] {
    const server = (this.deps.router as unknown as { _getDHCPServerInternal(): { getAllPools(): Map<string, unknown> } })._getDHCPServerInternal();
    return [...server.getAllPools().keys()];
  }

  /** Crée un pool DHCP s'il n'existe pas (push `ip pool <name>` VRP). */
  ensureDhcpPool(name: string): void {
    const server = (this.deps.router as unknown as { _getDHCPServerInternal(): { getPool(n: string): unknown; createPool(n: string): unknown } })._getDHCPServerInternal();
    if (!server.getPool(name)) server.createPool(name);
  }

  /** Supprime un pool DHCP (`undo ip pool <name>`). */
  removeDhcpPool(name: string): boolean {
    const server = (this.deps.router as unknown as { _getDHCPServerInternal(): { deletePool(n: string): boolean } })._getDHCPServerInternal();
    return server.deletePool(name);
  }
}
