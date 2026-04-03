/**
 * Windows User and Group Manager — simulates Windows local user/group management.
 *
 * Provides realistic Windows security model:
 *   - Local users with SIDs, passwords, enabled/disabled state
 *   - Local groups (Administrators, Users, Guests, etc.)
 *   - Group membership tracking
 *   - Privilege determination based on group membership
 *   - Built-in accounts (Administrator, Guest, DefaultAccount)
 *   - Built-in groups matching real Windows defaults
 */

export interface WindowsUser {
  name: string;
  fullName: string;
  description: string;
  sid: string;
  enabled: boolean;
  password: string;
  passwordRequired: boolean;
  userMayChangePassword: boolean;
  passwordLastSet: Date;
  lastLogon: Date | null;
  builtIn: boolean;
}

export interface WindowsGroup {
  name: string;
  description: string;
  sid: string;
  members: string[];
  builtIn: boolean;
}

/** Well-known Windows SID prefixes and constants */
const MACHINE_SID_PREFIX = 'S-1-5-21-3623811015-3361044348-30300820';

const WELL_KNOWN_SIDS: Record<string, string> = {
  'Administrator': `${MACHINE_SID_PREFIX}-500`,
  'Guest': `${MACHINE_SID_PREFIX}-501`,
  'DefaultAccount': `${MACHINE_SID_PREFIX}-503`,
};

const WELL_KNOWN_GROUP_SIDS: Record<string, string> = {
  'Administrators': 'S-1-5-32-544',
  'Users': 'S-1-5-32-545',
  'Guests': 'S-1-5-32-546',
  'Power Users': 'S-1-5-32-547',
  'Remote Desktop Users': 'S-1-5-32-555',
  'Network Configuration Operators': 'S-1-5-32-556',
  'Event Log Readers': 'S-1-5-32-573',
};

/** Standard user privileges by group membership */
const ADMIN_PRIVILEGES: Array<[string, string, string]> = [
  ['SeIncreaseQuotaPrivilege', 'Adjust memory quotas for a process', 'Disabled'],
  ['SeSecurityPrivilege', 'Manage auditing and security log', 'Disabled'],
  ['SeTakeOwnershipPrivilege', 'Take ownership of files or other objects', 'Disabled'],
  ['SeLoadDriverPrivilege', 'Load and unload device drivers', 'Disabled'],
  ['SeSystemProfilePrivilege', 'Profile system performance', 'Disabled'],
  ['SeSystemtimePrivilege', 'Change the system time', 'Disabled'],
  ['SeProfileSingleProcessPrivilege', 'Profile single process', 'Disabled'],
  ['SeIncreaseBasePriorityPrivilege', 'Increase scheduling priority', 'Disabled'],
  ['SeCreatePagefilePrivilege', 'Create a pagefile', 'Disabled'],
  ['SeBackupPrivilege', 'Back up files and directories', 'Disabled'],
  ['SeRestorePrivilege', 'Restore files and directories', 'Disabled'],
  ['SeShutdownPrivilege', 'Shut down the system', 'Disabled'],
  ['SeDebugPrivilege', 'Debug programs', 'Disabled'],
  ['SeSystemEnvironmentPrivilege', 'Modify firmware environment values', 'Disabled'],
  ['SeChangeNotifyPrivilege', 'Bypass traverse checking', 'Enabled'],
  ['SeRemoteShutdownPrivilege', 'Force shutdown from a remote system', 'Disabled'],
  ['SeUndockPrivilege', 'Remove computer from docking station', 'Disabled'],
  ['SeManageVolumePrivilege', 'Perform volume maintenance tasks', 'Disabled'],
  ['SeImpersonatePrivilege', 'Impersonate a client after authentication', 'Enabled'],
  ['SeCreateGlobalPrivilege', 'Create global objects', 'Enabled'],
  ['SeIncreaseWorkingSetPrivilege', 'Increase a process working set', 'Disabled'],
  ['SeTimeZonePrivilege', 'Change the time zone', 'Disabled'],
  ['SeCreateSymbolicLinkPrivilege', 'Create symbolic links', 'Disabled'],
  ['SeDelegateSessionUserImpersonatePrivilege', 'Obtain an impersonation token', 'Disabled'],
];

const STANDARD_PRIVILEGES: Array<[string, string, string]> = [
  ['SeShutdownPrivilege', 'Shut down the system', 'Disabled'],
  ['SeChangeNotifyPrivilege', 'Bypass traverse checking', 'Enabled'],
  ['SeUndockPrivilege', 'Remove computer from docking station', 'Disabled'],
  ['SeIncreaseWorkingSetPrivilege', 'Increase a process working set', 'Disabled'],
  ['SeTimeZonePrivilege', 'Change the time zone', 'Disabled'],
];

export class WindowsUserManager {
  private users: Map<string, WindowsUser> = new Map();
  private groups: Map<string, WindowsGroup> = new Map();
  private passwords: Map<string, string> = new Map();
  private nextRid = 1001;
  currentUser = 'User';

  constructor() {
    this.initDefaults();
  }

  private initDefaults(): void {
    // Built-in users
    this.addUser({
      name: 'Administrator', fullName: '', description: 'Built-in account for administering the computer/domain',
      sid: WELL_KNOWN_SIDS['Administrator'], enabled: true, password: 'x',
      passwordRequired: true, userMayChangePassword: true,
      passwordLastSet: new Date(), lastLogon: null, builtIn: true,
    });
    this.passwords.set('administrator', 'admin');

    this.addUser({
      name: 'Guest', fullName: '', description: 'Built-in account for guest access to the computer/domain',
      sid: WELL_KNOWN_SIDS['Guest'], enabled: false, password: '',
      passwordRequired: false, userMayChangePassword: false,
      passwordLastSet: new Date(), lastLogon: null, builtIn: true,
    });

    this.addUser({
      name: 'DefaultAccount', fullName: '', description: 'A user account managed by the system.',
      sid: WELL_KNOWN_SIDS['DefaultAccount'], enabled: false, password: '',
      passwordRequired: false, userMayChangePassword: false,
      passwordLastSet: new Date(), lastLogon: null, builtIn: true,
    });

    this.addUser({
      name: 'User', fullName: '', description: '',
      sid: `${MACHINE_SID_PREFIX}-${this.nextRid++}`, enabled: true, password: 'x',
      passwordRequired: true, userMayChangePassword: true,
      passwordLastSet: new Date(), lastLogon: new Date(), builtIn: false,
    });
    this.passwords.set('user', 'user');

    // Built-in groups
    this.addGroup({
      name: 'Administrators', description: 'Administrators have complete and unrestricted access to the computer/domain',
      sid: WELL_KNOWN_GROUP_SIDS['Administrators'], members: ['Administrator'], builtIn: true,
    });
    this.addGroup({
      name: 'Users', description: 'Users are prevented from making accidental or intentional system-wide changes',
      sid: WELL_KNOWN_GROUP_SIDS['Users'], members: ['User'], builtIn: true,
    });
    this.addGroup({
      name: 'Guests', description: 'Guests have the same access as members of the Users group by default',
      sid: WELL_KNOWN_GROUP_SIDS['Guests'], members: ['Guest'], builtIn: true,
    });
    this.addGroup({
      name: 'Power Users', description: 'Power Users are included for backwards compatibility',
      sid: WELL_KNOWN_GROUP_SIDS['Power Users'], members: [], builtIn: true,
    });
    this.addGroup({
      name: 'Remote Desktop Users', description: 'Members are granted the right to logon remotely',
      sid: WELL_KNOWN_GROUP_SIDS['Remote Desktop Users'], members: [], builtIn: true,
    });
    this.addGroup({
      name: 'Network Configuration Operators',
      description: 'Members can have some administrative privileges to manage configuration of networking features',
      sid: WELL_KNOWN_GROUP_SIDS['Network Configuration Operators'], members: [], builtIn: true,
    });
    this.addGroup({
      name: 'Event Log Readers', description: 'Members of this group can read event logs from local machine',
      sid: WELL_KNOWN_GROUP_SIDS['Event Log Readers'], members: [], builtIn: true,
    });
  }

  private addUser(u: WindowsUser): void {
    this.users.set(u.name.toLowerCase(), u);
  }

  private addGroup(g: WindowsGroup): void {
    this.groups.set(g.name.toLowerCase(), g);
  }

  // ─── User Queries ────────────────────────────────────────────────

  getUser(name: string): WindowsUser | undefined {
    return this.users.get(name.toLowerCase());
  }

  getAllUsers(): WindowsUser[] {
    return [...this.users.values()];
  }

  getUserSID(name: string): string | undefined {
    return this.users.get(name.toLowerCase())?.sid;
  }

  // ─── Group Queries ───────────────────────────────────────────────

  getGroup(name: string): WindowsGroup | undefined {
    return this.groups.get(name.toLowerCase());
  }

  getAllGroups(): WindowsGroup[] {
    return [...this.groups.values()];
  }

  getGroupsForUser(username: string): WindowsGroup[] {
    const lower = username.toLowerCase();
    return [...this.groups.values()].filter(g =>
      g.members.some(m => m.toLowerCase() === lower)
    );
  }

  // ─── Privilege Checks ────────────────────────────────────────────

  isAdmin(username?: string): boolean {
    const name = username ?? this.currentUser;
    const adminGroup = this.groups.get('administrators');
    if (!adminGroup) return false;
    return adminGroup.members.some(m => m.toLowerCase() === name.toLowerCase());
  }

  isCurrentUserAdmin(): boolean {
    return this.isAdmin(this.currentUser);
  }

  getPrivileges(username?: string): Array<[string, string, string]> {
    const name = username ?? this.currentUser;
    return this.isAdmin(name) ? ADMIN_PRIVILEGES : STANDARD_PRIVILEGES;
  }

  // ─── User Operations ────────────────────────────────────────────

  createUser(name: string, password: string, opts: {
    fullName?: string; description?: string; noPassword?: boolean;
  } = {}): string {
    if (!this.isCurrentUserAdmin()) return 'Access is denied.';
    if (this.users.has(name.toLowerCase())) {
      return `The account already exists.`;
    }

    const sid = `${MACHINE_SID_PREFIX}-${this.nextRid++}`;
    this.addUser({
      name, fullName: opts.fullName ?? '', description: opts.description ?? '',
      sid, enabled: true, password: opts.noPassword ? '' : 'x',
      passwordRequired: !opts.noPassword, userMayChangePassword: true,
      passwordLastSet: new Date(), lastLogon: null, builtIn: false,
    });
    if (!opts.noPassword) {
      this.passwords.set(name.toLowerCase(), password);
    }
    return '';
  }

  deleteUser(name: string): string {
    if (!this.isCurrentUserAdmin()) return 'Access is denied.';
    const user = this.users.get(name.toLowerCase());
    if (!user) return 'The user name could not be found.';
    if (user.builtIn) return `Cannot delete built-in account '${user.name}'.`;

    // Remove from all groups
    for (const group of this.groups.values()) {
      group.members = group.members.filter(m => m.toLowerCase() !== name.toLowerCase());
    }
    this.users.delete(name.toLowerCase());
    this.passwords.delete(name.toLowerCase());
    return '';
  }

  setUserProperty(name: string, property: string, value: string): string {
    if (!this.isCurrentUserAdmin()) return 'Access is denied.';
    const user = this.users.get(name.toLowerCase());
    if (!user) return 'The user name could not be found.';

    switch (property.toLowerCase()) {
      case 'fullname':
        user.fullName = value;
        break;
      case 'description':
      case 'comment':
        user.description = value;
        break;
      case 'password':
        this.passwords.set(name.toLowerCase(), value);
        user.passwordLastSet = new Date();
        break;
      case 'active':
        user.enabled = value.toLowerCase() === 'yes' || value.toLowerCase() === 'true';
        break;
      default:
        return `Invalid property: ${property}`;
    }
    return '';
  }

  enableUser(name: string): string {
    if (!this.isCurrentUserAdmin()) return 'Access is denied.';
    const user = this.users.get(name.toLowerCase());
    if (!user) return `User '${name}' was not found.`;
    user.enabled = true;
    return '';
  }

  disableUser(name: string): string {
    if (!this.isCurrentUserAdmin()) return 'Access is denied.';
    const user = this.users.get(name.toLowerCase());
    if (!user) return `User '${name}' was not found.`;
    user.enabled = false;
    return '';
  }

  checkPassword(name: string, password: string): boolean {
    return this.passwords.get(name.toLowerCase()) === password;
  }

  // ─── Group Operations ───────────────────────────────────────────

  createGroup(name: string, description = ''): string {
    if (!this.isCurrentUserAdmin()) return 'Access is denied.';
    if (this.groups.has(name.toLowerCase())) {
      return `The specified group already exists.`;
    }
    const sid = `S-1-5-32-${1000 + this.nextRid++}`;
    this.addGroup({ name, description, sid, members: [], builtIn: false });
    return '';
  }

  deleteGroup(name: string): string {
    if (!this.isCurrentUserAdmin()) return 'Access is denied.';
    const group = this.groups.get(name.toLowerCase());
    if (!group) return `The specified group could not be found.`;
    if (group.builtIn) return `Cannot delete built-in group '${group.name}'.`;
    this.groups.delete(name.toLowerCase());
    return '';
  }

  addGroupMember(groupName: string, memberName: string): string {
    if (!this.isCurrentUserAdmin()) return 'Access is denied.';
    const group = this.groups.get(groupName.toLowerCase());
    if (!group) return `Group '${groupName}' was not found.`;
    const user = this.users.get(memberName.toLowerCase());
    if (!user) return `Principal '${memberName}' was not found.`;
    if (group.members.some(m => m.toLowerCase() === memberName.toLowerCase())) {
      return `The specified account name is already a member of the group.`;
    }
    group.members.push(user.name);
    return '';
  }

  removeGroupMember(groupName: string, memberName: string): string {
    if (!this.isCurrentUserAdmin()) return 'Access is denied.';
    const group = this.groups.get(groupName.toLowerCase());
    if (!group) return `Group '${groupName}' was not found.`;
    const idx = group.members.findIndex(m => m.toLowerCase() === memberName.toLowerCase());
    if (idx === -1) return `The specified member was not found.`;
    group.members.splice(idx, 1);
    return '';
  }

  getGroupMembers(groupName: string): { members: string[]; error?: string } {
    const group = this.groups.get(groupName.toLowerCase());
    if (!group) return { members: [], error: `Group '${groupName}' was not found.` };
    return { members: [...group.members] };
  }

  // ─── User switch ────────────────────────────────────────────────

  setCurrentUser(name: string): boolean {
    const user = this.users.get(name.toLowerCase());
    if (!user) return false;
    this.currentUser = user.name;
    return true;
  }
}
