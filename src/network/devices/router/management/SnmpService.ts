import type { IEventBus } from '@/events/EventBus';
import { MAX_PORT, MIN_PORT } from '@/network/core/ports/PortNumber';

export type SnmpAccess = 'ro' | 'rw';

export const SNMP_VERSIONS = ['1', '2c', '3'] as const;
export const SNMP_V3_LEVELS = ['noauth', 'auth', 'priv'] as const;

export type SnmpVersion = typeof SNMP_VERSIONS[number];
export type SnmpV3Level = typeof SNMP_V3_LEVELS[number];

export function isSnmpVersion(token: string | undefined): token is SnmpVersion {
  return token !== undefined
    && (SNMP_VERSIONS as readonly string[]).includes(token.toLowerCase());
}

export function isSnmpV3Level(token: string | undefined): token is SnmpV3Level {
  return token !== undefined
    && (SNMP_V3_LEVELS as readonly string[]).includes(token.toLowerCase());
}

function isUdpPort(token: string | undefined): boolean {
  if (token === undefined || !/^\d+$/.test(token)) return false;
  const value = Number(token);
  return value >= MIN_PORT && value <= MAX_PORT;
}

export interface SnmpCommunity {
  name: string;
  access: SnmpAccess;
  aclName?: string;
  view?: string;
}

export interface SnmpHost {
  host: string;
  version: SnmpVersion;
  v3Level?: SnmpV3Level;
  community: string;
  notificationType?: 'traps' | 'informs';
  udpPort?: number;
  notifications: string[];
}

export interface SnmpGroup {
  name: string;
  version: SnmpVersion;
  v3Level?: SnmpV3Level;
  readView?: string;
  writeView?: string;
  notifyView?: string;
  acl?: string;
}

export interface SnmpUser {
  name: string;
  group: string;
  version: SnmpVersion;
  v3Level?: SnmpV3Level;
  authAlgo?: 'md5' | 'sha';
  authPassword?: string;
  privAlgo?: 'des' | '3des' | 'aes';
  /**
   * La longueur de clé d'AES (`priv aes 256 <mot de passe>`).
   *
   * Elle n'existait pas, et son absence ne coûtait pas qu'un affichage :
   * l'analyseur lisait le mot suivant `aes` comme l'algorithme et le
   * SUIVANT comme le mot de passe, donc `256` DEVENAIT le mot de passe
   * et le vrai secret était jeté. La machine chiffrait avec une clé que
   * personne n'avait saisie, et la configuration relue la reproduisait.
   */
  privKeyBits?: 128 | 192 | 256;
  privPassword?: string;
  acl?: string;
}

export interface SnmpView {
  name: string;
  oid: string;
  type: 'included' | 'excluded';
}

export interface SnmpStats {
  pktsIn: number;
  pktsOut: number;
  badVersions: number;
  badCommunityNames: number;
  badCommunityUses: number;
  asn1ParseErrors: number;
  silentDrops: number;
  proxyDrops: number;
  getRequests: number;
  getNextRequests: number;
  setRequests: number;
  getResponses: number;
  trapsSent: number;
  informsSent: number;
}

export class SnmpService {
  private enabled = false;
  private contact = '';
  private location = '';
  private sysName = '';
  private chassisId = '';
  private trapSourceInterface = '';
  private engineId: string = SnmpService.generateEngineId();
  private readonly communities: Map<string, SnmpCommunity> = new Map();
  private versions: SnmpVersion[] = [];
  private readonly hosts: SnmpHost[] = [];
  private readonly groups: Map<string, SnmpGroup> = new Map();
  private readonly users: Map<string, SnmpUser> = new Map();
  private readonly views: Map<string, SnmpView[]> = new Map();
  /**
   * `snmp-server enable traps [type [option ...]]` — a TYPE and its
   * options.
   *
   * This was a `Set<string>` filled by a loop that added every suffix of
   * the line, so one typed command rendered as three, two of which
   * nobody wrote. That matters beyond display: the rendered
   * configuration is REPLAYED when a topology is imported.
   */
  private readonly enabledTraps: Map<string, Set<string>> = new Map();
  private readonly stats: SnmpStats = SnmpService.zeroStats();

  configure(args: string[]): string | null {
    if (args.length === 0) return null;
    const head = args[0].toLowerCase();
    switch (head) {
      case 'community': this.configCommunity(args); break;
      case 'host': return this.configHost(args);
      case 'group': this.configGroup(args); break;
      case 'user': this.configUser(args); break;
      case 'view': this.configView(args); break;
      case 'enable':
        if (args[1]?.toLowerCase() === 'traps') {
          if (args.length === 2) {
            // Bare `snmp-server enable traps`: every notification the
            // platform can emit.
            this.enabledTraps.set('all', new Set());
          } else {
            const type = args[2].toLowerCase();
            const options = this.enabledTraps.get(type) ?? new Set<string>();
            // A second command on the same type ADDS its options, as on
            // real IOS where the two lines merge into one.
            for (let i = 3; i < args.length; i++) options.add(args[i].toLowerCase());
            this.enabledTraps.set(type, options);
          }
          this.enable();
        }
        break;
      case 'contact': this.contact = args.slice(1).join(' '); this.enable(); break;
      case 'location': this.location = args.slice(1).join(' '); this.enable(); break;
      case 'chassis-id': this.chassisId = args.slice(1).join(' '); this.enable(); break;
      case 'trap-source':
      case 'trap-timeout':
        if (head === 'trap-source' && args[1]) this.trapSourceInterface = args[1];
        this.enable();
        break;
      case 'engineid':
      case 'engineID':
        if (args[1]?.toLowerCase() === 'local' && args[2]) {
          this.engineId = args[2];
          this.enable();
        }
        break;
    }
    return null;
  }

  unconfigure(args: string[]): void {
    if (args.length === 0) { this.disable(); return; }
    const head = args[0].toLowerCase();
    switch (head) {
      case 'community': if (args[1]) this.communities.delete(args[1]); break;
      case 'host': if (args[1]) this.removeTrapHost(args[1]); break;
      case 'group': if (args[1]) this.groups.delete(args[1]); break;
      case 'user': if (args[1]) this.users.delete(args[1]); break;
      case 'view': if (args[1]) this.removeMibView(args[1]); break;
      case 'enable':
        if (args[1]?.toLowerCase() === 'traps') {
          if (args.length === 2) this.enabledTraps.clear();
          else this.enabledTraps.delete(args[2].toLowerCase());
        }
        break;
      case 'contact': this.contact = ''; break;
      case 'location': this.location = ''; break;
      case 'chassis-id': this.chassisId = ''; break;
      case 'trap-source': this.trapSourceInterface = ''; break;
      case 'engineid':
        if (args[1]?.toLowerCase() === 'local') this.setEngineId('');
        break;
    }
  }

  private configCommunity(args: string[]): void {
    const name = args[1];
    if (!name) return;
    let access: SnmpAccess = 'ro';
    let view: string | undefined;
    let aclName: string | undefined;
    for (let i = 2; i < args.length; i++) {
      const a = args[i].toLowerCase();
      if (a === 'rw' || a === 'ro') access = a;
      else if (a === 'view' && args[i + 1]) { view = args[i + 1]; i++; }
      else if (/^[0-9]+$/.test(args[i])) aclName = args[i];
      else aclName = args[i];
    }
    this.communities.set(name, { name, access, aclName, view });
    this.enable();
  }

  private configHost(args: string[]): string | null {
    const host = args[1];
    if (!host) return null;
    let version: SnmpVersion = '1';
    let v3Level: SnmpV3Level | undefined;
    let community = '';
    let udpPort: number | undefined;
    let notificationType: 'traps' | 'informs' = 'traps';
    const notifications: string[] = [];
    let i = 2;
    if (args[i]?.toLowerCase() === 'traps' || args[i]?.toLowerCase() === 'informs') {
      notificationType = args[i].toLowerCase() as 'traps' | 'informs';
      i++;
    }
    if (args[i]?.toLowerCase() === 'version') {
      const declaree = args[i + 1];
      if (!isSnmpVersion(declaree)) return declaree ?? 'version';
      version = declaree.toLowerCase() as SnmpVersion;
      i += 2;
      if (version === '3' && isSnmpV3Level(args[i])) {
        v3Level = args[i].toLowerCase() as SnmpV3Level;
        i++;
      }
    }
    const lireUdpPort = (): string | null => {
      if (args[i]?.toLowerCase() !== 'udp-port') return null;
      const declare = args[i + 1];
      if (!isUdpPort(declare)) return declare ?? 'udp-port';
      udpPort = Number(declare);
      i += 2;
      return null;
    };
    const avant = lireUdpPort();
    if (avant !== null) return avant;
    if (args[i]) community = args[i++];
    const apres = lireUdpPort();
    if (apres !== null) return apres;
    while (i < args.length) { notifications.push(args[i]); i++; }
    this.hosts.push({ host, version, v3Level, community, notificationType, udpPort, notifications });
    this.enable();
    return null;
  }

  private configGroup(args: string[]): void {
    const name = args[1];
    if (!name || args[2]?.toLowerCase() !== 'v3' && args[2]?.toLowerCase() !== 'v1' && args[2]?.toLowerCase() !== 'v2c') return;
    const version = (args[2].toLowerCase().replace('v', '') as SnmpVersion);
    const group: SnmpGroup = { name, version };
    let i = 3;
    if (version === '3' && args[i]) { group.v3Level = args[i].toLowerCase() as SnmpV3Level; i++; }
    while (i < args.length) {
      if (args[i] === 'read' && args[i + 1]) { group.readView = args[i + 1]; i += 2; }
      else if (args[i] === 'write' && args[i + 1]) { group.writeView = args[i + 1]; i += 2; }
      else if (args[i] === 'notify' && args[i + 1]) { group.notifyView = args[i + 1]; i += 2; }
      else if (args[i] === 'access' && args[i + 1]) { group.acl = args[i + 1]; i += 2; }
      else i++;
    }
    this.groups.set(name, group);
    this.enable();
  }

  private configUser(args: string[]): void {
    const name = args[1];
    const groupName = args[2];
    if (!name || !groupName) return;
    const user: SnmpUser = { name, group: groupName, version: '1' };
    let i = 3;
    if (args[i]?.toLowerCase() === 'v3' || args[i]?.toLowerCase() === 'v2c' || args[i]?.toLowerCase() === 'v1') {
      user.version = args[i].toLowerCase().replace('v', '') as SnmpVersion;
      i++;
    }
    while (i < args.length) {
      const tok = args[i].toLowerCase();
      if (tok === 'auth' && args[i + 1] && args[i + 2]) {
        user.authAlgo = args[i + 1].toLowerCase() as 'md5' | 'sha';
        user.authPassword = args[i + 2];
        i += 3;
        if (args[i]?.toLowerCase() === 'priv' && args[i + 1] && args[i + 2]) {
          user.privAlgo = args[i + 1].toLowerCase() as 'des' | '3des' | 'aes';
          i += 2;
          // `aes` prend une longueur de clé AVANT le mot de passe. Sans
          // ce pas, `256` était lu comme le secret.
          if (user.privAlgo === 'aes' && /^(128|192|256)$/.test(args[i] ?? '')) {
            user.privKeyBits = Number(args[i]) as 128 | 192 | 256;
            i++;
          }
          user.privPassword = args[i];
          user.v3Level = 'priv';
          i++;
        } else {
          user.v3Level = 'auth';
        }
      } else if (tok === 'access' && args[i + 1]) {
        user.acl = args[i + 1];
        i += 2;
      } else if (tok === 'noauth') {
        user.v3Level = 'noauth';
        i++;
      } else {
        i++;
      }
    }
    this.users.set(name, user);
    this.enable();
  }

  private configView(args: string[]): void {
    const name = args[1];
    const oid = args[2];
    const type = (args[3]?.toLowerCase() === 'excluded' ? 'excluded' : 'included') as 'included' | 'excluded';
    if (!name || !oid) return;
    this.setMibViewEntry(name, oid, type);
  }

  /**
   * Rejouer la commande sur le MEME sous-arbre remplace l'entree ; sur
   * un autre, les deux coexistent. C'est ce que VRP documente, et la
   * pile precedente accumulait les doublons — une meme ligne tapee deux
   * fois faisait deux entrees que la regle du sous-arbre le plus long
   * departageait par hasard.
   */
  setMibViewEntry(name: string, oid: string, type: 'included' | 'excluded'): void {
    const entries = this.views.get(name) ?? [];
    const at = entries.findIndex((e) => e.oid === oid);
    if (at >= 0) entries[at] = { name, oid, type };
    else entries.push({ name, oid, type });
    this.views.set(name, entries);
    this.enable();
  }

  removeMibView(name: string): boolean { return this.views.delete(name); }

  enable(): void { this.enabled = true; }
  disable(): void { this.enabled = false; }
  isEnabled(): boolean { return this.enabled; }

  getStats(): SnmpStats { return { ...this.stats }; }

  attachToBus(bus: IEventBus, deviceId: string): () => void {
    const isOurs = (p: { deviceId?: string }) => p.deviceId === deviceId;
    const unsubs = [
      bus.subscribeWhere('snmp.packet.received', isOurs, () => { this.stats.pktsIn++; }),
      bus.subscribeWhere('snmp.packet.sent', isOurs, () => { this.stats.pktsOut++; }),
      bus.subscribeWhere('snmp.request.served', isOurs, (e) => {
        const p = e.payload;
        if (p.pduType === 'get-request') this.stats.getRequests += p.oidCount;
        else if (p.pduType === 'get-next-request') this.stats.getNextRequests += p.oidCount;
        else if (p.pduType === 'set-request') this.stats.setRequests += p.oidCount;
        this.stats.getResponses++;
        if (p.errorStatus !== 'no-error') this.stats.silentDrops++;
      }),
      bus.subscribeWhere('snmp.auth.rejected', isOurs, (e) => {
        if (e.payload.reason === 'unknown-community') this.stats.badCommunityNames++;
        else this.stats.badCommunityUses++;
      }),
      bus.subscribeWhere('snmp.trap.sent', isOurs, () => { this.stats.trapsSent++; }),
    ];
    return () => { for (const u of unsubs) u(); };
  }
  getCommunities(): readonly SnmpCommunity[] { return [...this.communities.values()]; }
  getHosts(): readonly SnmpHost[] { return [...this.hosts]; }
  getGroups(): readonly SnmpGroup[] { return [...this.groups.values()]; }
  getUsers(): readonly SnmpUser[] { return [...this.users.values()]; }
  getViews(): ReadonlyMap<string, readonly SnmpView[]> { return this.views; }
  getEnabledTraps(): readonly string[] {
    return [...this.enabledTraps].map(([type, options]) =>
      options.size > 0 ? `${type} ${[...options].join(' ')}` : type);
  }

  /**
   * Is this notification armed?
   *
   * Bare `enable traps` arms everything; `enable traps snmp` arms the
   * whole type; `enable traps snmp linkdown` arms only that one. Nobody
   * asked this question before — `enabledTraps` was read only by the
   * configuration renderer, so no trap was ever emitted.
   */
  isTrapEnabled(type: string, option?: string): boolean {
    if (this.enabledTraps.has('all')) return true;
    const options = this.enabledTraps.get(type.toLowerCase());
    if (!options) return false;
    if (!option || options.size === 0) return true;
    return options.has(option.toLowerCase());
  }
  getEngineId(): string { return this.engineId; }
  getContact(): string { return this.contact; }
  getLocation(): string { return this.location; }
  getChassisId(): string { return this.chassisId; }
  getTrapSource(): string { return this.trapSourceInterface; }
  getVersions(): readonly SnmpVersion[] { return [...this.versions]; }

  private readonly vrpLines: string[] = [];

  getVrpLines(): readonly string[] { return [...this.vrpLines]; }

  recordVrpLine(line: string): void {
    if (!this.vrpLines.includes(line)) this.vrpLines.push(line);
    this.enable();
  }

  forgetVrpLine(line: string): void {
    const index = this.vrpLines.indexOf(line);
    if (index >= 0) this.vrpLines.splice(index, 1);
  }

  private engineIdConfigured = false;

  hasConfiguredEngineId(): boolean { return this.engineIdConfigured; }

  setEngineId(id: string): void {
    this.engineIdConfigured = id !== '';
    this.engineId = id || SnmpService.generateEngineId();
    this.enable();
  }

  enableTrap(feature?: string): void {
    this.enabledTraps.set(feature ?? 'all', new Set());
    this.enable();
  }

  disableTrap(feature?: string): void {
    this.enabledTraps.delete(feature ?? 'all');
  }

  setCommunity(community: SnmpCommunity): void {
    this.communities.set(community.name, { ...community });
    this.enable();
  }

  removeCommunity(name: string): void {
    this.communities.delete(name);
  }

  setContact(contact: string): void { this.contact = contact; this.enable(); }
  setLocation(location: string): void { this.location = location; this.enable(); }
  setTrapSourceInterface(iface: string): void { this.trapSourceInterface = iface; this.enable(); }
  setVersions(versions: readonly SnmpVersion[]): void { this.versions = [...versions]; this.enable(); }

  setTrapHost(host: string, community: string, version: SnmpVersion, udpPort?: number): void {
    const index = this.hosts.findIndex((h) => h.host === host);
    const entry: SnmpHost = {
      host, version, community, notificationType: 'traps', udpPort, notifications: [],
    };
    if (index >= 0) this.hosts[index] = entry; else this.hosts.push(entry);
    this.enable();
  }

  removeTrapHost(host: string): void {
    const index = this.hosts.findIndex((h) => h.host === host);
    if (index >= 0) this.hosts.splice(index, 1);
  }

  asRunningConfigLines(): string[] {
    if (!this.enabled && this.communities.size === 0 && this.users.size === 0 && this.hosts.length === 0) return [];
    const lines: string[] = [];
    for (const c of this.communities.values()) {
      let line = `snmp-server community ${c.name} ${c.access.toUpperCase()}`;
      if (c.view) line += ` VIEW ${c.view}`;
      if (c.aclName) line += ` ${c.aclName}`;
      lines.push(line);
    }
    if (this.contact) lines.push(`snmp-server contact ${this.contact}`);
    if (this.location) lines.push(`snmp-server location ${this.location}`);
    if (this.chassisId) lines.push(`snmp-server chassis-id ${this.chassisId}`);
    if (this.trapSourceInterface) lines.push(`snmp-server trap-source ${this.trapSourceInterface}`);
    for (const v of this.views.values()) for (const e of v) {
      lines.push(`snmp-server view ${e.name} ${e.oid} ${e.type}`);
    }
    for (const g of this.groups.values()) {
      let line = `snmp-server group ${g.name} v${g.version}`;
      if (g.v3Level) line += ` ${g.v3Level}`;
      if (g.readView) line += ` read ${g.readView}`;
      if (g.writeView) line += ` write ${g.writeView}`;
      if (g.notifyView) line += ` notify ${g.notifyView}`;
      if (g.acl) line += ` access ${g.acl}`;
      lines.push(line);
    }
    for (const u of this.users.values()) {
      let line = `snmp-server user ${u.name} ${u.group} v${u.version}`;
      if (u.authAlgo && u.authPassword) {
        line += ` auth ${u.authAlgo} ${u.authPassword}`;
        if (u.privAlgo && u.privPassword) {
          line += ` priv ${u.privAlgo}`
            + (u.privKeyBits ? ` ${u.privKeyBits}` : '')
            + ` ${u.privPassword}`;
        }
      }
      if (u.acl) line += ` access ${u.acl}`;
      lines.push(line);
    }
    for (const h of this.hosts) {
      let line = `snmp-server host ${h.host}`;
      if (h.notificationType === 'informs') line += ' informs';
      line += ` version ${h.version}`;
      if (h.v3Level) line += ` ${h.v3Level}`;
      line += ` ${h.community}`;
      if (h.udpPort !== undefined) line += ` udp-port ${h.udpPort}`;
      if (h.notifications.length) line += ' ' + h.notifications.join(' ');
      lines.push(line);
    }
    for (const ligne of this.getEnabledTraps()) {
      lines.push(ligne === 'all' ? 'snmp-server enable traps' : `snmp-server enable traps ${ligne}`);
    }
    return lines;
  }

  private static generateEngineId(): string {
    return '8000000903' + Math.floor(Math.random() * 0xFFFFFFFF).toString(16).padStart(8, '0').toUpperCase();
  }

  private static zeroStats(): SnmpStats {
    return {
      pktsIn: 0, pktsOut: 0, badVersions: 0,
      badCommunityNames: 0, badCommunityUses: 0,
      asn1ParseErrors: 0, silentDrops: 0, proxyDrops: 0,
      getRequests: 0, getNextRequests: 0, setRequests: 0,
      getResponses: 0, trapsSent: 0, informsSent: 0,
    };
  }
}
