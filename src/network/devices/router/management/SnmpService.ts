export type SnmpAccess = 'ro' | 'rw';
export type SnmpVersion = '1' | '2c' | '3';
export type SnmpV3Level = 'noauth' | 'auth' | 'priv';

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
  private readonly hosts: SnmpHost[] = [];
  private readonly groups: Map<string, SnmpGroup> = new Map();
  private readonly users: Map<string, SnmpUser> = new Map();
  private readonly views: Map<string, SnmpView[]> = new Map();
  private readonly enabledTraps: Set<string> = new Set();
  private readonly stats: SnmpStats = SnmpService.zeroStats();

  configure(args: string[]): void {
    if (args.length === 0) return;
    const head = args[0].toLowerCase();
    switch (head) {
      case 'community': this.configCommunity(args); break;
      case 'host': this.configHost(args); break;
      case 'group': this.configGroup(args); break;
      case 'user': this.configUser(args); break;
      case 'view': this.configView(args); break;
      case 'enable':
        if (args[1]?.toLowerCase() === 'traps') {
          for (let i = 2; i < args.length; i++) this.enabledTraps.add(args.slice(i).join(' '));
          if (args.length === 2) this.enabledTraps.add('all');
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

  private configHost(args: string[]): void {
    const host = args[1];
    if (!host) return;
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
    if (args[i]?.toLowerCase() === 'version' && args[i + 1]) {
      version = args[i + 1] as SnmpVersion;
      i += 2;
      if (version === '3' && args[i]) { v3Level = args[i].toLowerCase() as SnmpV3Level; i++; }
    }
    if (args[i]?.toLowerCase() === 'udp-port' && args[i + 1]) {
      udpPort = parseInt(args[i + 1], 10);
      i += 2;
    }
    if (args[i]) community = args[i++];
    while (i < args.length) { notifications.push(args[i]); i++; }
    this.hosts.push({ host, version, v3Level, community, notificationType, udpPort, notifications });
    this.enable();
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
          user.privPassword = args[i + 2];
          user.v3Level = 'priv';
          i += 3;
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
    if (!this.views.has(name)) this.views.set(name, []);
    this.views.get(name)!.push({ name, oid, type });
    this.enable();
  }

  enable(): void { this.enabled = true; }
  disable(): void { this.enabled = false; }
  isEnabled(): boolean { return this.enabled; }

  getStats(): SnmpStats { return { ...this.stats }; }
  getCommunities(): readonly SnmpCommunity[] { return [...this.communities.values()]; }
  getHosts(): readonly SnmpHost[] { return [...this.hosts]; }
  getGroups(): readonly SnmpGroup[] { return [...this.groups.values()]; }
  getUsers(): readonly SnmpUser[] { return [...this.users.values()]; }
  getViews(): ReadonlyMap<string, readonly SnmpView[]> { return this.views; }
  getEnabledTraps(): readonly string[] { return [...this.enabledTraps]; }
  getEngineId(): string { return this.engineId; }
  getContact(): string { return this.contact; }
  getLocation(): string { return this.location; }
  getChassisId(): string { return this.chassisId; }
  getTrapSource(): string { return this.trapSourceInterface; }

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
        if (u.privAlgo && u.privPassword) line += ` priv ${u.privAlgo} ${u.privPassword}`;
      }
      if (u.acl) line += ` access ${u.acl}`;
      lines.push(line);
    }
    for (const h of this.hosts) {
      let line = `snmp-server host ${h.host}`;
      if (h.notificationType === 'informs') line += ' informs';
      line += ` version ${h.version}`;
      if (h.v3Level) line += ` ${h.v3Level}`;
      if (h.udpPort) line += ` udp-port ${h.udpPort}`;
      line += ` ${h.community}`;
      if (h.notifications.length) line += ' ' + h.notifications.join(' ');
      lines.push(line);
    }
    for (const t of this.enabledTraps) {
      lines.push(t === 'all' ? 'snmp-server enable traps' : `snmp-server enable traps ${t}`);
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
