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
import type { Switch } from '../../Switch';

/**
 * =====================================================================
 *  SwitchMachineApi — façade UNIQUE pour les commandes CLI switch
 * =====================================================================
 *
 *  Toutes les commandes migrées (Cisco IOS switch ou Huawei VRP
 *  switch) lisent et modifient l'état du switch EXCLUSIVEMENT à
 *  travers cette façade — jamais un import direct de `Switch`, `Port`,
 *  `VLANEntry`, `SwitchportConfig`, `MACTableEntry`, ni d'un formateur
 *  legacy (`CiscoSwitchShell`, `HuaweiSwitchShell`).
 *
 *  Différences par rapport à `RouterMachineApi` : sous-façade `switch`
 *  qui expose VLAN, MAC table, switchport config (concepts L2), au lieu
 *  de `router` qui expose routing/ACL/NAT (concepts L3). Le socle CLI
 *  (`cli`) et les capacités universelles (`fs`/`net`/`power`) sont
 *  identiques.
 */
export interface SwitchMachineApiDeps {
  readonly switch: Switch;
  readonly modes: ModeRegistry;
}

/** DTO d'interface switch — inclut mode `access|trunk`, VLAN d'accès,
 *  liste des VLANs autorisés en trunk. `Port`/`SwitchportConfig` ne
 *  fuient jamais aux commandes. */
export type SwitchInterfaceMode = 'access' | 'trunk' | 'hybrid' | 'dot1q-tunnel';

export type SwitchPortViolationMode = 'protect' | 'restrict' | 'shutdown';

/** État port-security exposé aux commandes migrées — DTO stable. */
export interface SwitchPortSecurityInfo {
  readonly enabled: boolean;
  readonly maxMac: number;
  readonly violationMode: SwitchPortViolationMode;
  readonly sticky: boolean;
}

export interface SwitchInterfaceInfo {
  readonly name: string;
  readonly mac: string;
  readonly mtu: number;
  readonly adminUp: boolean;
  readonly linkUp: boolean;
  readonly description: string;
  readonly mode: SwitchInterfaceMode;
  readonly accessVlan: number;
  readonly trunkNativeVlan: number;
  readonly trunkAllowedVlans: readonly number[];
  readonly portSecurity: SwitchPortSecurityInfo;
}

export interface SwitchVlanInfo {
  readonly id: number;
  readonly name: string;
  readonly memberPorts: readonly string[];
}

export interface SwitchMacEntry {
  readonly mac: string;
  readonly vlan: number;
  readonly port: string;
  readonly type: 'static' | 'dynamic';
  readonly ageSeconds: number;
}

/**
 * Sous-façade `switch` : lecture/écriture typée de l'état L2. Aucun
 * `Switch`/`Port`/`ACLEngine` ne fuit — les commandes reçoivent des
 * DTOs et appellent des méthodes explicites pour muter l'état.
 */
export interface SwitchCapabilityApi {
  interfaces(): readonly SwitchInterfaceInfo[];
  interface(name: string): SwitchInterfaceInfo | null;
  setInterfaceAdminUp(name: string, up: boolean): boolean;
  setInterfaceDescription(name: string, description: string): boolean;
  /** Change le mode L2 d'un port (`access` / `trunk` / …). Retourne
   *  `false` si le port n'existe pas ou si le mode est refusé. */
  setInterfaceMode(name: string, mode: SwitchInterfaceMode): boolean;
  /** Assigne l'access-VLAN d'un port. Le VLAN est créé si absent
   *  (comportement standard côté switch). Retourne `false` si le port
   *  n'existe pas ou si l'id est invalide. */
  setInterfaceAccessVlan(name: string, vlanId: number): boolean;
  /** `switchport trunk native vlan <id>` — VLAN natif sur trunk. */
  setInterfaceTrunkNativeVlan(name: string, vlanId: number): boolean;
  /** `switchport trunk allowed vlan {all|none|<list>|add <list>|remove <list>|except <list>}`.
   *  `op` distingue les modes de mise à jour ; `vlans` est la liste
   *  parsée (Set) — la commande a la responsabilité du parse texte
   *  (ex: `10,20-30,50`). */
  setInterfaceTrunkAllowedVlans(
    name: string,
    op: 'set' | 'add' | 'remove' | 'except',
    vlans: ReadonlySet<number>,
  ): boolean;
  /** Réinitialise à `all` (1-4094) — utilisé par `switchport trunk allowed vlan all`. */
  resetInterfaceTrunkAllowedVlans(name: string): boolean;
  /** Active/désactive `switchport port-security` sur un port. */
  setInterfacePortSecurityEnabled(name: string, enabled: boolean): boolean;
  /** `switchport port-security maximum <n>`. */
  setInterfacePortSecurityMaximum(name: string, max: number): boolean;
  /** `switchport port-security violation {protect|restrict|shutdown}`. */
  setInterfacePortSecurityViolation(name: string, mode: SwitchPortViolationMode): boolean;
  /** `switchport port-security mac-address sticky`. */
  setInterfacePortSecuritySticky(name: string, sticky: boolean): boolean;

  vlans(): readonly SwitchVlanInfo[];
  vlan(id: number): SwitchVlanInfo | null;
  /** Crée un VLAN. Retourne `{ ok: false, error }` si l'id est invalide
   *  ou déjà pris. */
  createVlan(id: number, name?: string): { ok: boolean; error?: string };
  /** Supprime un VLAN (interdit sur VLAN 1). */
  deleteVlan(id: number): { ok: boolean; error?: string };
  /** Renomme un VLAN existant. */
  renameVlan(id: number, name: string): { ok: boolean; error?: string };

  macTable(): readonly SwitchMacEntry[];
}

/** Lecture d'état port-security via l'accessor du `Port` — isolé ici
 *  pour que les commandes ne connaissent que le DTO. */
function readPortSecurity(port: import('../../../hardware/Port').Port): SwitchPortSecurityInfo {
  const sec = port.getPortSecurity();
  return {
    enabled: sec.isEnabled(),
    maxMac: sec.getMaxMACAddresses(),
    violationMode: sec.getViolationMode(),
    sticky: sec.isStickyEnabled(),
  };
}

class SwitchCapabilityImpl implements SwitchCapabilityApi {
  constructor(private readonly sw: Switch) {}

  interfaces(): readonly SwitchInterfaceInfo[] {
    return this.sw.getPorts().map((port) => this.buildInterface(port));
  }

  interface(name: string): SwitchInterfaceInfo | null {
    const port = this.sw.getPort(name);
    if (!port) return null;
    return this.buildInterface(port);
  }

  private buildInterface(port: import('../../../hardware/Port').Port): SwitchInterfaceInfo {
    const cfg = this.sw.getSwitchportConfig(port.getName());
    return {
      name: port.getName(),
      mac: port.getMAC().toString(),
      mtu: port.getMTU(),
      adminUp: !port.isAdminDown(),
      linkUp: port.getIsUp() && port.isConnected(),
      description: this.sw.getInterfaceDescription(port.getName()) ?? '',
      mode: cfg?.mode ?? 'access',
      accessVlan: cfg?.accessVlan ?? 1,
      trunkNativeVlan: cfg?.trunkNativeVlan ?? 1,
      trunkAllowedVlans: cfg?.trunkAllowedVlans ? [...cfg.trunkAllowedVlans].sort((a, b) => a - b) : [],
      portSecurity: readPortSecurity(port),
    };
  }

  setInterfaceAdminUp(name: string, up: boolean): boolean {
    const port = this.sw.getPort(name);
    if (!port) return false;
    port.setAdminDown(!up);
    return true;
  }

  setInterfaceDescription(name: string, description: string): boolean {
    const port = this.sw.getPort(name);
    if (!port) return false;
    const map = (this.sw as unknown as { _getInterfaceDescriptions(): Map<string, string> })._getInterfaceDescriptions();
    if (description === '') map.delete(name);
    else map.set(name, description);
    return true;
  }

  setInterfaceMode(name: string, mode: SwitchInterfaceMode): boolean {
    if (!this.sw.getPort(name)) return false;
    return this.sw.setSwitchportMode(name, mode);
  }

  setInterfaceAccessVlan(name: string, vlanId: number): boolean {
    if (!this.sw.getPort(name)) return false;
    if (!Number.isInteger(vlanId) || vlanId < 1 || vlanId > 4094) return false;
    return this.sw.setSwitchportAccessVlan(name, vlanId);
  }

  setInterfaceTrunkNativeVlan(name: string, vlanId: number): boolean {
    if (!this.sw.getPort(name)) return false;
    if (!Number.isInteger(vlanId) || vlanId < 1 || vlanId > 4094) return false;
    return this.sw.setTrunkNativeVlan(name, vlanId);
  }

  setInterfaceTrunkAllowedVlans(
    name: string,
    op: 'set' | 'add' | 'remove' | 'except',
    vlans: ReadonlySet<number>,
  ): boolean {
    if (!this.sw.getPort(name)) return false;
    const cfg = this.sw.getSwitchportConfig(name);
    if (!cfg) return false;
    switch (op) {
      case 'set': {
        return this.sw.setTrunkAllowedVlans(name, new Set(vlans));
      }
      case 'add': {
        const next = new Set(cfg.trunkAllowedVlans);
        for (const v of vlans) next.add(v);
        return this.sw.setTrunkAllowedVlans(name, next);
      }
      case 'remove': {
        const next = new Set(cfg.trunkAllowedVlans);
        for (const v of vlans) next.delete(v);
        return this.sw.setTrunkAllowedVlans(name, next);
      }
      case 'except': {
        const next = new Set<number>();
        for (let i = 1; i <= 4094; i++) if (!vlans.has(i)) next.add(i);
        return this.sw.setTrunkAllowedVlans(name, next);
      }
    }
  }

  resetInterfaceTrunkAllowedVlans(name: string): boolean {
    if (!this.sw.getPort(name)) return false;
    const all = new Set<number>();
    for (let i = 1; i <= 4094; i++) all.add(i);
    return this.sw.setTrunkAllowedVlans(name, all);
  }

  setInterfacePortSecurityEnabled(name: string, enabled: boolean): boolean {
    const port = this.sw.getPort(name);
    if (!port) return false;
    if (enabled) port.getPortSecurity().enable();
    else port.getPortSecurity().disable();
    return true;
  }

  setInterfacePortSecurityMaximum(name: string, max: number): boolean {
    const port = this.sw.getPort(name);
    if (!port) return false;
    if (!Number.isInteger(max) || max < 1) return false;
    try { port.getPortSecurity().setMaxMACAddresses(max); return true; }
    catch { return false; }
  }

  setInterfacePortSecurityViolation(name: string, mode: SwitchPortViolationMode): boolean {
    const port = this.sw.getPort(name);
    if (!port) return false;
    port.getPortSecurity().setViolationMode(mode);
    return true;
  }

  setInterfacePortSecuritySticky(name: string, sticky: boolean): boolean {
    const port = this.sw.getPort(name);
    if (!port) return false;
    if (sticky) port.getPortSecurity().enableSticky();
    else port.getPortSecurity().disableSticky();
    return true;
  }

  createVlan(id: number, name?: string): { ok: boolean; error?: string } {
    if (!Number.isInteger(id) || id < 1 || id > 4094) return { ok: false, error: 'invalid VLAN id' };
    // Idempotent : si le VLAN existe déjà, on renomme (si demandé) et
    // on retourne succès — comportement Cisco standard.
    if (this.sw.getVLANs().has(id)) {
      if (name !== undefined) this.sw.renameVLAN(id, name);
      return { ok: true };
    }
    return this.sw.createVLAN(id, name) ? { ok: true } : { ok: false, error: 'VLAN reserved' };
  }

  deleteVlan(id: number): { ok: boolean; error?: string } {
    if (id === 1) return { ok: false, error: 'cannot delete default VLAN' };
    return this.sw.deleteVLAN(id) ? { ok: true } : { ok: false, error: 'VLAN not found' };
  }

  renameVlan(id: number, name: string): { ok: boolean; error?: string } {
    if (!name) return { ok: false, error: 'name required' };
    return this.sw.renameVLAN(id, name) ? { ok: true } : { ok: false, error: 'VLAN not found' };
  }

  vlans(): readonly SwitchVlanInfo[] {
    return [...this.sw.getVLANs().values()]
      .sort((a, b) => a.id - b.id)
      .map((v) => ({ id: v.id, name: v.name, memberPorts: [...v.ports].sort() }));
  }

  vlan(id: number): SwitchVlanInfo | null {
    const v = this.sw.getVLANs().get(id);
    if (!v) return null;
    return { id: v.id, name: v.name, memberPorts: [...v.ports].sort() };
  }

  macTable(): readonly SwitchMacEntry[] {
    return this.sw.getMACTable().map((e) => ({
      mac: e.mac,
      vlan: e.vlan,
      port: e.port,
      type: e.type,
      ageSeconds: e.age,
    }));
  }
}

// ─── Réseau générique (interfaces / admin state) ────────────────────

class SwitchNetworkApi implements NetworkApi {
  constructor(private readonly sw: Switch) {}

  async interfaces(): Promise<{ name: string; ip: string; up: boolean }[]> {
    return this.sw.getPorts().map((port) => ({
      name: port.getName(),
      ip: port.getIPAddress()?.toString() ?? '',
      up: !port.isAdminDown(),
    }));
  }

  async setInterfaceState(name: string, up: boolean): Promise<void> {
    const port = this.sw.getPort(name);
    if (!port) throw new FileSystemError(name, 'ENOENT', `interface introuvable : ${name}`);
    port.setAdminDown(!up);
  }
}

// ─── Rejets explicites : capacités inapplicables à un switch ────────

const UNSUPPORTED = (path: string): never => {
  throw new FileSystemError(path, 'EACCES', `${path}: not supported on this equipment`);
};

class SwitchFileSystemApi implements FileSystemApi {
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
  async kill(): Promise<void> { /* pas de table de processus sur un switch */ },
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

export class SwitchMachineApi implements MachineApi {
  readonly fs: FileSystemApi = new SwitchFileSystemApi();
  readonly proc = EMPTY_PROC;
  readonly net: NetworkApi;
  readonly users = EMPTY_USERS;
  readonly groups = EMPTY_GROUPS;
  readonly power: PowerApi;
  readonly cli: CliMachineApi;
  readonly switch: SwitchCapabilityApi;

  constructor(private readonly deps: SwitchMachineApiDeps) {
    this.net = new SwitchNetworkApi(deps.switch);
    this.switch = new SwitchCapabilityImpl(deps.switch);
    this.cli = { modes: deps.modes };
    this.power = {
      shutdown: async () => { deps.switch.powerOff(); },
      reboot: async () => { deps.switch.powerOff(); deps.switch.powerOn(); },
    };
  }

  get hostname(): string {
    return this.deps.switch.getHostname();
  }

  setHostname(newName: string): void {
    this.deps.switch.setHostname(newName);
  }

  bootedAt(): Date {
    return new Date(this.deps.switch.getBootedAtMs());
  }

  now(): Date {
    return new Date();
  }
}
