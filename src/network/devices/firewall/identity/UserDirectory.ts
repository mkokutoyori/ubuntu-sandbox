import { NetworkOsAccount } from '../../router/aaa/NetworkOsAccount';
import { NetworkOsCredentialStore } from '../../router/aaa/NetworkOsCredentialStore';
import type { IdentitySource } from './IdentityTable';

export type LocalUserType = 'password' | 'radius' | 'tacacs+' | 'ldap';

export type RemoteServerKind = 'radius' | 'tacacs+' | 'ldap';

export interface LocalUser {
  readonly name: string;
  readonly type: LocalUserType;
  readonly server?: string;
  readonly enabled: boolean;
  readonly emailTo?: string;
}

export type UserGroupType = 'firewall' | 'guest';

export interface GroupMatch {
  readonly id: string;
  readonly serverName: string;
  readonly groupName: string;
}

export interface UserGroup {
  readonly name: string;
  readonly numericId: number;
  readonly groupType: UserGroupType;
  readonly members: readonly string[];
  readonly matches: readonly GroupMatch[];
  readonly authTimeoutMin: number;
}

export interface RemoteServer {
  readonly name: string;
  readonly kind: RemoteServerKind;
  readonly address: string;
  readonly secret: string;
  readonly port?: number;
  readonly authType?: string;
  readonly baseDn?: string;
  readonly cnid?: string;
  readonly bindType?: string;
  readonly username?: string;
}

export interface UserDirectoryDeps {
  readonly credentials: NetworkOsCredentialStore;
  readonly now?: () => number;
}

export class UserDirectory {
  private readonly users = new Map<string, LocalUser>();
  private readonly groups = new Map<string, UserGroup>();
  private readonly servers = new Map<string, RemoteServer>();
  private readonly credentials: NetworkOsCredentialStore;
  private readonly now: () => number;
  private nextGroupId = 1;

  constructor(deps: UserDirectoryDeps) {
    this.credentials = deps.credentials;
    this.now = deps.now ?? (() => Date.now());
  }

  setUser(user: LocalUser, password?: string): void {
    this.users.set(user.name, user);
    if (user.type !== 'password') return;

    const existing = this.credentials.get(user.name);
    const secret = password ?? existing?.secret ?? '';
    this.credentials.upsert(NetworkOsAccount.create({
      name: user.name,
      secret,
      privilege: 1,
      disabled: !user.enabled,
      now: this.now(),
    }));
  }

  getUser(name: string): LocalUser | undefined { return this.users.get(name); }
  removeUser(name: string): boolean {
    this.credentials.remove(name);
    return this.users.delete(name);
  }

  userNames(): readonly string[] { return Object.freeze([...this.users.keys()]); }

  setGroup(draft: Omit<UserGroup, 'numericId'>): UserGroup {
    const existing = this.groups.get(draft.name);
    const group: UserGroup = {
      ...draft,
      numericId: existing?.numericId ?? this.nextGroupId++,
    };
    this.groups.set(group.name, group);
    return group;
  }

  getGroup(name: string): UserGroup | undefined { return this.groups.get(name); }
  removeGroup(name: string): boolean { return this.groups.delete(name); }
  groupNames(): readonly string[] { return Object.freeze([...this.groups.keys()]); }

  setServer(server: RemoteServer): void { this.servers.set(server.name, server); }
  getServer(name: string): RemoteServer | undefined { return this.servers.get(name); }
  removeServer(name: string): boolean { return this.servers.delete(name); }
  serverNames(): readonly string[] { return Object.freeze([...this.servers.keys()]); }

  groupsOf(user: string): readonly string[] {
    const out: string[] = [];
    for (const group of this.groups.values()) {
      if (group.members.includes(user)) out.push(group.name);
    }
    return Object.freeze(out);
  }

  groupIdsOf(names: readonly string[]): readonly number[] {
    return Object.freeze(names
      .map(name => this.groups.get(name)?.numericId)
      .filter((id): id is number => id !== undefined));
  }

  serverBackedGroups(server: string): readonly string[] {
    const out: string[] = [];
    for (const group of this.groups.values()) {
      if (group.members.includes(server)) out.push(group.name);
      else if (group.matches.some(match => match.serverName === server)) out.push(group.name);
    }
    return Object.freeze(out);
  }

  authenticationRouteOf(user: string): { source: IdentitySource; server?: string } | undefined {
    const declared = this.users.get(user);
    if (declared) {
      if (!declared.enabled) return undefined;
      if (declared.type === 'password') return { source: 'local' };
      return { source: declared.type, server: declared.server };
    }
    return undefined;
  }

  authenticateLocal(user: string, password: string): boolean {
    const declared = this.users.get(user);
    if (!declared || !declared.enabled || declared.type !== 'password') return false;
    return this.credentials.authenticate(user, password);
  }

  authTimeoutSecondsFor(groups: readonly string[], fallbackSec: number): number {
    const declared = groups
      .map(name => this.groups.get(name)?.authTimeoutMin ?? 0)
      .filter(minutes => minutes > 0);
    if (declared.length === 0) return fallbackSec;
    return Math.min(...declared) * 60;
  }
}
