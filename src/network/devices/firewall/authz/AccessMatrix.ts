import { addressObjectMatches, subnetAddress } from '../model/AddressObject';

export type AccessGroup =
  | 'sysgrp' | 'netgrp' | 'fwgrp' | 'utmgrp' | 'vpngrp'
  | 'loggrp' | 'authgrp' | 'secfabgrp' | 'ftviewgrp';

export const ACCESS_GROUPS: readonly AccessGroup[] = Object.freeze([
  'sysgrp', 'netgrp', 'fwgrp', 'utmgrp', 'vpngrp',
  'loggrp', 'authgrp', 'secfabgrp', 'ftviewgrp',
]);

export type AccessRight = 'none' | 'read' | 'read-write';

export const ACCESS_RIGHTS: readonly AccessRight[] = Object.freeze([
  'none', 'read', 'read-write',
]);

export type AccessIntent = 'read' | 'write';

export type AccessVerdict = 'run' | 'read-only' | 'absent';

export interface AccessProfile {
  readonly name: string;
  readonly rights: Readonly<Record<AccessGroup, AccessRight>>;
  readonly comments?: string;
}

export const SUPER_ADMIN = 'super_admin';
export const PROF_ADMIN = 'prof_admin';
export const NO_ACCESS = 'no_access';

function uniform(right: AccessRight): Record<AccessGroup, AccessRight> {
  const out = {} as Record<AccessGroup, AccessRight>;
  for (const group of ACCESS_GROUPS) out[group] = right;
  return out;
}

export function emptyRights(): Record<AccessGroup, AccessRight> {
  return uniform('none');
}

export const PREDEFINED_PROFILES: readonly AccessProfile[] = Object.freeze([
  Object.freeze({ name: SUPER_ADMIN, rights: Object.freeze(uniform('read-write')) }),
  Object.freeze({ name: PROF_ADMIN, rights: Object.freeze(uniform('read-write')) }),
]);

export interface AdminAccount {
  readonly name: string;
  readonly profile: string;
  readonly vdoms: readonly string[];
  readonly trustHosts: readonly TrustHost[];
  readonly remoteAuth: boolean;
  readonly remoteGroup?: string;
  readonly comments?: string;
}

export interface TrustHost {
  readonly index: number;
  readonly address: string;
  readonly mask: string;
}

export const ANY_HOST: TrustHost = Object.freeze({
  index: 0, address: '0.0.0.0', mask: '0.0.0.0',
});

export class AccessMatrix {
  private readonly profiles = new Map<string, AccessProfile>();
  private readonly admins = new Map<string, AdminAccount>();

  constructor() {
    for (const profile of PREDEFINED_PROFILES) this.profiles.set(profile.name, profile);
  }

  setProfile(profile: AccessProfile): void {
    this.profiles.set(profile.name, profile);
  }

  getProfile(name: string): AccessProfile | undefined {
    return this.profiles.get(name);
  }

  removeProfile(name: string): boolean {
    if (this.isPredefined(name)) return false;
    return this.profiles.delete(name);
  }

  isPredefined(name: string): boolean {
    return PREDEFINED_PROFILES.some(profile => profile.name === name);
  }

  profileNames(): readonly string[] {
    return Object.freeze([...this.profiles.keys()]);
  }

  setAdmin(admin: AdminAccount): void {
    this.admins.set(admin.name, admin);
  }

  getAdmin(name: string): AdminAccount | undefined {
    return this.admins.get(name);
  }

  removeAdmin(name: string): boolean {
    return this.admins.delete(name);
  }

  adminNames(): readonly string[] {
    return Object.freeze([...this.admins.keys()]);
  }

  rightOf(profileName: string, group: AccessGroup): AccessRight {
    if (profileName === NO_ACCESS) return 'none';
    return this.profiles.get(profileName)?.rights[group] ?? 'none';
  }

  authorize(profileName: string, group: AccessGroup, intent: AccessIntent): AccessVerdict {
    const right = this.rightOf(profileName, group);
    if (right === 'none') return 'absent';
    if (right === 'read-write') return 'run';
    return intent === 'read' ? 'run' : 'read-only';
  }
}

export function trustHostAllows(
  hosts: readonly TrustHost[], source: string,
): boolean {
  const declared = hosts.filter(host => !isAnyHost(host));
  if (declared.length === 0) return true;
  return declared.some(host => withinMask(source, host.address, host.mask));
}

export function isAnyHost(host: TrustHost): boolean {
  return host.address === '0.0.0.0' && host.mask === '0.0.0.0';
}

function withinMask(candidate: string, network: string, mask: string): boolean {
  return addressObjectMatches(
    subnetAddress('trusthost', network, mask), candidate, {});
}
