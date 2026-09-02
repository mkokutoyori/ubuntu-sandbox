import type { Firewall } from '../../../Firewall';
import {
  ACCESS_GROUPS, emptyRights, type AccessGroup, type AccessRight,
} from '../../../authz/AccessMatrix';
import type { FortiCommitDevice } from '../schema/types';

type IdentityHandlers = Pick<FortiCommitDevice,
  | 'applyLocalUser' | 'removeLocalUser'
  | 'applyUserGroup' | 'removeUserGroup'
  | 'applyRemoteAuthServer' | 'applyLdapServer' | 'removeRemoteAuthServer'
  | 'applyAuthSetting'
  | 'applyAccessProfile' | 'removeAccessProfile'
  | 'applyAdminAccount' | 'removeAdminAccount'>;

export function identityCommitHandlers(fw: Firewall): IdentityHandlers {
  return {
  applyLocalUser(user) {
    fw.getUserDirectory().setUser({
      name: user.name,
      type: user.type === 'radius' || user.type === 'tacacs+' ? user.type : 'password',
      server: user.server,
      enabled: user.enabled,
      emailTo: user.emailTo,
    }, user.password);
  },
  removeLocalUser(name) {
    fw.getUserDirectory().removeUser(name);
    fw.getIdentityTable().releaseUser(name);
  },
  applyUserGroup(group) {
    fw.getUserDirectory().setGroup({
      name: group.name,
      groupType: group.groupType === 'guest' ? 'guest' : 'firewall',
      members: [...group.members],
      matches: group.matches.map(match => ({
        id: match.id, serverName: match.serverName, groupName: match.groupName,
      })),
      authTimeoutMin: group.authTimeoutMin,
    });
  },
  removeUserGroup(name) {
    fw.getUserDirectory().removeGroup(name);
  },
  applyRemoteAuthServer(server) {
    fw.getUserDirectory().setServer({
      name: server.name,
      kind: server.kind,
      address: server.address,
      secret: server.secret,
      port: server.port,
      authType: server.authType,
    });
  },
  applyLdapServer(server) {
    fw.getUserDirectory().setServer({
      name: server.name,
      kind: 'ldap',
      address: server.address,
      secret: server.password ?? '',
      port: server.port,
      baseDn: server.baseDn,
      cnid: server.cnid,
      bindType: server.bindType,
      username: server.username,
    });
  },
  removeRemoteAuthServer(name) {
    fw.getUserDirectory().removeServer(name);
  },
  applyAuthSetting(setting) {
    const seconds = setting.timeoutMinutes * 60;
    fw.getAuthPortal().setTimeoutSeconds(seconds);
    fw.getIdentityTable().setTimeoutPolicy(
      setting.timeoutType === 'hard-timeout' || setting.timeoutType === 'new-session'
        ? setting.timeoutType
        : 'idle-timeout',
      seconds);
    fw.setAuthPortalSecureHttp(setting.secureHttp === true);
  },
  applyAccessProfile(profile) {
    fw.getAccessMatrix().setProfile({
      name: profile.name,
      rights: accessRights(profile.rights),
      comments: profile.comments,
    });
  },
  removeAccessProfile(name) {
    fw.getAccessMatrix().removeProfile(name);
  },
  applyAdminAccount(admin) {
    fw.applyAdminAccount(admin);
  },
  removeAdminAccount(name) {
    fw.getAccessMatrix().removeAdmin(name);
  },
  };
}

export function accessRights(
  declared: Readonly<Record<string, string>>,
): Record<AccessGroup, AccessRight> {
  const out = emptyRights();
  for (const group of ACCESS_GROUPS) {
    const value = declared[group];
    out[group] = value === 'read' || value === 'read-write' ? value : 'none';
  }
  return out;
}
