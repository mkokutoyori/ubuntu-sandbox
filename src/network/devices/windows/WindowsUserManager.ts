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

import type { IEventBus } from '@/events/EventBus';
import type { WindowsAccountChange } from './events';
import type { WindowsAccountsPolicy } from './security/WindowsAccountsPolicy';

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
  /** Previous passwords, most-recent-first — checked against /uniquepw. */
  passwordHistory: string[];
  /** Consecutive failed logons since the last success or unlock. */
  failedLogonCount: number;
  /** Set once failedLogonCount reaches the lockout threshold; cleared when it elapses. */
  lockedUntil: Date | null;
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
  /** `runas /savecred` vault (PRD-Nslookup-Dig-Rndc-Runas.md §2.1.6/P12) — mirrors real Windows Credential Manager's per-user saved-credential behavior at a simplified level. */
  private savedCredentials: Map<string, string> = new Map();
  private nextRid = 1001;
  currentUser = 'User';
  /** Reactive sink — null until the device attaches its bus. */
  private bus: IEventBus | null = null;
  private deviceId = '';
  /** LSA account policy (net accounts) — null until the device attaches it. */
  private policy: WindowsAccountsPolicy | null = null;

  constructor() {
    this.initDefaults();
  }

  /**
   * Attach the device event bus so account, group and logon operations are
   * published. The reactive WindowsSecurityAuditProjection subscribes and
   * writes the faithful Security event-log entries.
   */
  attachBus(bus: IEventBus, deviceId: string): void {
    this.bus = bus;
    this.deviceId = deviceId;
  }

  /** Attach the machine's `net accounts` policy so it is actually enforced. */
  attachPolicy(policy: WindowsAccountsPolicy): void {
    this.policy = policy;
  }

  /** Publish an account-change event on the central bus. */
  private publishAccount(account: string, change: WindowsAccountChange): void {
    this.bus?.publish({
      topic: 'windows.account.changed',
      payload: { deviceId: this.deviceId, account, change },
    });
  }

  /** Publish a group-membership-change event on the central bus. */
  private publishMembership(group: string, member: string, added: boolean): void {
    this.bus?.publish({
      topic: 'windows.group.membership-changed',
      payload: { deviceId: this.deviceId, group, member, added },
    });
  }

  private initDefaults(): void {
    // Built-in users
    this.addUser({
      name: 'Administrator', fullName: '', description: 'Built-in account for administering the computer/domain',
      sid: WELL_KNOWN_SIDS['Administrator'], enabled: true, password: 'x',
      passwordRequired: true, userMayChangePassword: true,
      passwordLastSet: new Date(), lastLogon: null, builtIn: true,
      passwordHistory: [], failedLogonCount: 0, lockedUntil: null,
    });
    this.passwords.set('administrator', 'admin');

    this.addUser({
      name: 'Guest', fullName: '', description: 'Built-in account for guest access to the computer/domain',
      sid: WELL_KNOWN_SIDS['Guest'], enabled: false, password: '',
      passwordRequired: false, userMayChangePassword: false,
      passwordLastSet: new Date(), lastLogon: null, builtIn: true,
      passwordHistory: [], failedLogonCount: 0, lockedUntil: null,
    });

    this.addUser({
      name: 'DefaultAccount', fullName: '', description: 'A user account managed by the system.',
      sid: WELL_KNOWN_SIDS['DefaultAccount'], enabled: false, password: '',
      passwordRequired: false, userMayChangePassword: false,
      passwordLastSet: new Date(), lastLogon: null, builtIn: true,
      passwordHistory: [], failedLogonCount: 0, lockedUntil: null,
    });

    this.addUser({
      name: 'User', fullName: '', description: '',
      sid: `${MACHINE_SID_PREFIX}-${this.nextRid++}`, enabled: true, password: 'x',
      passwordRequired: true, userMayChangePassword: true,
      passwordLastSet: new Date(), lastLogon: new Date(), builtIn: false,
      passwordHistory: [], failedLogonCount: 0, lockedUntil: null,
    });
    this.passwords.set('user', 'user');

    // Standard cast — password equals the username — so cross-equipment
    // SSH tests don't need per-pairing setup.
    for (const u of ['alice', 'bob', 'carl', 'dave']) {
      this.addUser({
        name: u, fullName: '', description: '',
        sid: `${MACHINE_SID_PREFIX}-${this.nextRid++}`, enabled: true, password: 'x',
        passwordRequired: true, userMayChangePassword: true,
        passwordLastSet: new Date(), lastLogon: null, builtIn: false,
        passwordHistory: [], failedLogonCount: 0, lockedUntil: null,
      });
      this.passwords.set(u.toLowerCase(), u);
    }

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

  /**
   * Renders a plain-text account roster (name / password / groups) for
   * `C:\users.txt` — the single source of truth is this manager, so the
   * file always matches whatever accounts actually exist on this device
   * (built-ins plus the standard alice/bob/carl/dave cast), instead of a
   * second, hand-maintained copy of the same data living in
   * `WindowsFileSystem.ts`.
   */
  renderUsersDoc(): string {
    const lines = ['# Windows local users (name / password / groups)', ''];
    for (const u of this.getAllUsers()) {
      const password = this.getPlaintextPassword(u.name) ?? '(none)';
      const groups = this.getGroupsForUser(u.name).map(g => g.name);
      const groupsText = groups.length > 0 ? groups.join(', ') : '(none)';
      lines.push(`${u.name} / ${password || '(none)'} / ${groupsText}`);
    }
    return lines.join('\n') + '\n';
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
    if (!opts.noPassword && password) {
      const pwErr = this.validatePasswordComplexity(password);
      if (pwErr) return pwErr;
    }

    const sid = `${MACHINE_SID_PREFIX}-${this.nextRid++}`;
    this.addUser({
      name, fullName: opts.fullName ?? '', description: opts.description ?? '',
      sid, enabled: true, password: opts.noPassword ? '' : 'x',
      passwordRequired: !opts.noPassword, userMayChangePassword: true,
      passwordLastSet: new Date(), lastLogon: null, builtIn: false,
      passwordHistory: [], failedLogonCount: 0, lockedUntil: null,
    });
    if (!opts.noPassword) {
      this.passwords.set(name.toLowerCase(), password);
    }
    this.publishAccount(name, 'created');
    return '';
  }

  /**
   * Enforce the LSA account policy (`net accounts`) the same way the real
   * SAM does when a password is set: minimum length and reuse against the
   * account's password history. Both violations share the one generic
   * Windows error string — real `net user` doesn't distinguish them either.
   */
  private validatePasswordComplexity(password: string, previousPasswords: readonly string[] = []): string {
    const policy = this.policy?.snapshot();
    const minLength = policy?.minPasswordLength ?? 0;
    const historyLength = policy?.passwordHistoryLength ?? 0;
    const reused = historyLength > 0 && previousPasswords.slice(0, historyLength).includes(password);
    if (password.length < minLength || reused) {
      return 'The password does not meet the password policy requirements. Check the minimum password length, password complexity, and password history requirements.';
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
    this.publishAccount(user.name, 'deleted');
    return '';
  }

  setUserProperty(name: string, property: string, value: string): string {
    if (!this.isCurrentUserAdmin()) return 'Access is denied.';
    const user = this.users.get(name.toLowerCase());
    if (!user) return 'The user name could not be found.';

    switch (property.toLowerCase()) {
      case 'fullname':
        user.fullName = value;
        this.publishAccount(user.name, 'modified');
        break;
      case 'description':
      case 'comment':
        user.description = value;
        this.publishAccount(user.name, 'modified');
        break;
      case 'password': {
        const current = this.passwords.get(name.toLowerCase()) ?? '';
        const pwErr = this.validatePasswordComplexity(value, [current, ...user.passwordHistory]);
        if (pwErr) return pwErr;
        const historyLength = this.policy?.snapshot().passwordHistoryLength ?? 0;
        if (current) {
          user.passwordHistory = [current, ...user.passwordHistory].slice(0, historyLength);
        }
        this.passwords.set(name.toLowerCase(), value);
        user.passwordLastSet = new Date();
        this.publishAccount(user.name, 'password-reset');
        break;
      }
      case 'active': {
        const enabled = value.toLowerCase() === 'yes' || value.toLowerCase() === 'true';
        user.enabled = enabled;
        if (enabled) {
          user.lockedUntil = null;
          user.failedLogonCount = 0;
          this.publishAccount(user.name, 'enabled');
        } else {
          this.publishAccount(user.name, 'disabled');
        }
        break;
      }
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
    this.publishAccount(user.name, 'enabled');
    return '';
  }

  disableUser(name: string): string {
    if (!this.isCurrentUserAdmin()) return 'Access is denied.';
    const user = this.users.get(name.toLowerCase());
    if (!user) return `User '${name}' was not found.`;
    user.enabled = false;
    this.publishAccount(user.name, 'disabled');
    return '';
  }

  /** Whether the account is currently locked out (auto-clears once the observation window elapses). */
  isLockedOut(name: string): boolean {
    const user = this.users.get(name.toLowerCase());
    if (!user?.lockedUntil) return false;
    if (user.lockedUntil.getTime() > Date.now()) return true;
    user.lockedUntil = null;
    user.failedLogonCount = 0;
    return false;
  }

  /** The instant this account's password stops being valid, or null if `net accounts /maxpwage` is Never/unset. */
  passwordExpiresAt(name: string): number | null {
    const user = this.users.get(name.toLowerCase());
    if (!user) return null;
    const maxAge = this.policy?.snapshot().maxPasswordAge ?? -1;
    if (maxAge < 0) return null;
    return user.passwordLastSet.getTime() + maxAge * 86_400_000;
  }

  /** Whether the account's password is past `net accounts /maxpwage`. */
  isPasswordExpired(name: string): boolean {
    const expiresAt = this.passwordExpiresAt(name);
    return expiresAt !== null && expiresAt < Date.now();
  }

  /**
   * Verify a password. Publishes a logon event so the security-audit
   * projection journals a 4624 (success) or 4625 (failure) Security entry.
   * Enforces the LSA lockout policy (`net accounts /lockoutthreshold`):
   * once a user's consecutive failures reach the threshold, further
   * attempts are rejected until the lockout duration elapses, exactly the
   * way `accountLockedOut` (Security 4740) is meant to be triggered. Also
   * enforces `/maxpwage` — real Windows refuses logon with an expired
   * password until it's changed (no self-service change-at-logon flow
   * here, so it's a straightforward denial, same as Cisco/Huawei's
   * `passwordExpireAt` gate).
   */
  /** Plaintext password for `name`, or null if the account doesn't exist — used by the NPS/RADIUS role (PRD-Windows-Server.md §5 P9), which needs the raw secret for CHAP/MSCHAPv2/EAP-MD5 crypto, not just a match check like `checkPassword`. */
  getPlaintextPassword(name: string): string | null {
    if (!this.users.has(name.toLowerCase())) return null;
    return this.passwords.get(name.toLowerCase()) ?? null;
  }

  /**
   * `logonType` defaults to 2 (Interactive) — the console/`runas` case —
   * but every caller that authenticates over a specific protocol
   * (SSH → 10 RemoteInteractive, RDP → 10, a future unlock-workstation
   * flow → 7 Unlock) must pass its own real value. `checkPassword` used
   * to hardcode 2 unconditionally, which made every non-interactive
   * caller either silently mislabel its own `windows.account.logon`
   * publish or (SSH) publish a second, correctly-typed one on top of
   * this one — PRD-Winlogon.md §1.2 point 1.
   */
  checkPassword(name: string, password: string, logonType = 2): boolean {
    const user = this.users.get(name.toLowerCase());
    if (user && (this.isLockedOut(name) || this.isPasswordExpired(name))) {
      this.bus?.publish({
        topic: 'windows.account.logon',
        payload: { deviceId: this.deviceId, account: name, success: false, logonType },
      });
      return false;
    }

    const ok = this.passwords.get(name.toLowerCase()) === password;
    if (user) {
      if (ok) {
        user.failedLogonCount = 0;
      } else {
        user.failedLogonCount++;
        const threshold = this.policy?.snapshot().lockoutThreshold ?? 0;
        if (threshold > 0 && user.failedLogonCount >= threshold) {
          const durationMinutes = this.policy?.snapshot().lockoutDurationMinutes ?? 30;
          user.lockedUntil = new Date(Date.now() + durationMinutes * 60_000);
          this.publishAccount(user.name, 'locked-out');
        }
      }
    }

    this.bus?.publish({
      topic: 'windows.account.logon',
      payload: { deviceId: this.deviceId, account: name, success: ok, logonType },
    });
    return ok;
  }

  // ─── `runas /savecred` vault (PRD-Nslookup-Dig-Rndc-Runas.md P12) ──

  saveCredential(name: string, password: string): void {
    this.savedCredentials.set(name.toLowerCase(), password);
  }

  getSavedCredential(name: string): string | null {
    return this.savedCredentials.get(name.toLowerCase()) ?? null;
  }

  clearSavedCredential(name: string): void {
    this.savedCredentials.delete(name.toLowerCase());
  }

  // ─── Group Operations ───────────────────────────────────────────

  createGroup(name: string, description = ''): string {
    if (!this.isCurrentUserAdmin()) return 'Access is denied.';
    if (this.groups.has(name.toLowerCase())) {
      return `The specified group already exists.`;
    }
    const sid = `S-1-5-32-${1000 + this.nextRid++}`;
    this.addGroup({ name, description, sid, members: [], builtIn: false });
    this.bus?.publish({ topic: 'windows.group.created', payload: { deviceId: this.deviceId, group: name } });
    return '';
  }

  deleteGroup(name: string): string {
    if (!this.isCurrentUserAdmin()) return 'Access is denied.';
    const group = this.groups.get(name.toLowerCase());
    if (!group) return `The specified group could not be found.`;
    if (group.builtIn) return `Cannot delete built-in group '${group.name}'.`;
    this.groups.delete(name.toLowerCase());
    this.bus?.publish({ topic: 'windows.group.deleted', payload: { deviceId: this.deviceId, group: group.name } });
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
    this.publishMembership(group.name, user.name, true);
    return '';
  }

  removeGroupMember(groupName: string, memberName: string): string {
    if (!this.isCurrentUserAdmin()) return 'Access is denied.';
    const group = this.groups.get(groupName.toLowerCase());
    if (!group) return `Group '${groupName}' was not found.`;
    const idx = group.members.findIndex(m => m.toLowerCase() === memberName.toLowerCase());
    if (idx === -1) return `The specified member was not found.`;
    const removed = group.members[idx];
    group.members.splice(idx, 1);
    this.publishMembership(group.name, removed, false);
    return '';
  }

  getGroupMembers(groupName: string): { members: string[]; error?: string } {
    const group = this.groups.get(groupName.toLowerCase());
    if (!group) return { members: [], error: `Group '${groupName}' was not found.` };
    return { members: [...group.members] };
  }

  // ─── Rename operations ──────────────────────────────────────────

  renameUser(name: string, newName: string): string {
    if (!this.isCurrentUserAdmin()) return 'Access is denied.';
    const user = this.users.get(name.toLowerCase());
    if (!user) return `User '${name}' was not found.`;
    if (this.users.has(newName.toLowerCase())) return `User '${newName}' already exists.`;
    this.users.delete(name.toLowerCase());
    user.name = newName;
    this.users.set(newName.toLowerCase(), user);
    // Update group membership references
    for (const group of this.groups.values()) {
      const idx = group.members.findIndex(m => m.toLowerCase() === name.toLowerCase());
      if (idx !== -1) group.members[idx] = newName;
    }
    if (this.currentUser.toLowerCase() === name.toLowerCase()) this.currentUser = newName;
    return '';
  }

  renameGroup(name: string, newName: string): string {
    if (!this.isCurrentUserAdmin()) return 'Access is denied.';
    const group = this.groups.get(name.toLowerCase());
    if (!group) return `Group '${name}' was not found.`;
    if (this.groups.has(newName.toLowerCase())) return `Group '${newName}' already exists.`;
    this.groups.delete(name.toLowerCase());
    group.name = newName;
    this.groups.set(newName.toLowerCase(), group);
    return '';
  }

  // ─── User switch ────────────────────────────────────────────────

  setCurrentUser(name: string): boolean {
    let user = this.users.get(name.toLowerCase());
    if (!user) {
      // Auto-create as a non-admin standard user for testing context switching
      const rid = this.nextRid++;
      user = {
        name,
        fullName: '',
        description: '',
        sid: `${MACHINE_SID_PREFIX}-${rid}`,
        enabled: true,
        password: '',
        passwordRequired: false,
        userMayChangePassword: true,
        passwordLastSet: new Date(),
        lastLogon: null,
        builtIn: false,
        passwordHistory: [],
        failedLogonCount: 0,
        lockedUntil: null,
      };
      this.users.set(name.toLowerCase(), user);
      const usersGroup = this.groups.get('users');
      if (usersGroup && !usersGroup.members.some(m => m.toLowerCase() === name.toLowerCase())) {
        usersGroup.members.push(name);
      }
    }
    this.currentUser = user.name;
    return true;
  }
}
