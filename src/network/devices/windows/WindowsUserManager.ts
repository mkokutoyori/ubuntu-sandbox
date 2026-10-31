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

import { simulationNowMs } from '@/network/core/SystemClock';

import type { IEventBus } from '@/events/EventBus';
import { parseAccountExpiry } from './WindowsAccountExpiry';
import { dateOrderOf, DEFAULT_REGIONAL_FORMATS, type RegionalFormats } from './WindowsRegionalSettings';
import { logonHoursAllow, parseLogonHours, type LogonHours } from './WindowsLogonHours';
import type { WindowsAccountChange, WindowsLogonDetails, WindowsLogonFailureCause } from './events';
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
  /** `net user /expires` / `Set-LocalUser -AccountExpires`; null means Never. */
  accountExpires: Date | null;
  logonHours?: LogonHours;
  workstations?: readonly string[];
  passwordNeverExpires?: boolean;
  homeDirectory?: string;
  profilePath?: string;
  scriptPath?: string;
  userComment?: string;
  countryCode?: number;
}

export interface WindowsUserMachine {
  nowMs(): number;
  hostname(): string;
  timezone(): string | undefined;
  directoryExists(path: string): boolean;
  regionalFormats(): RegionalFormats;
}

export type WindowsLogonRefusal = 'disabled' | 'expired' | 'locked' | 'logon-hours' | 'workstation';

const MAX_WORKSTATIONS = 8;
const MAX_USER_NAME_LENGTH = 20;
const MAX_COMMENT_LENGTH = 48;
const FORBIDDEN_NAME_CHARACTERS = /["/\\[\]:;|=,+*?<>]/;
const SYNTAX_INVALID = 'The command syntax is invalid.';

function yesNo(value: string): boolean | null {
  const lower = value.toLowerCase();
  if (lower === 'yes') return true;
  if (lower === 'no') return false;
  return null;
}

function isAbsolutePath(path: string): boolean {
  return /^([a-z]:|[\\/])/i.test(path);
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

const COUNTRY_CODES: ReadonlyMap<number, string> = new Map([
  [1, 'United States'], [7, 'Russia'], [20, 'Egypt'], [27, 'South Africa'], [30, 'Greece'],
  [31, 'Netherlands'], [32, 'Belgium'], [33, 'France'], [34, 'Spain'], [36, 'Hungary'],
  [39, 'Italy'], [40, 'Romania'], [41, 'Switzerland'], [43, 'Austria'], [44, 'United Kingdom'],
  [45, 'Denmark'], [46, 'Sweden'], [47, 'Norway'], [48, 'Poland'], [49, 'Germany'],
  [52, 'Mexico'], [55, 'Brazil'], [61, 'Australia'], [64, 'New Zealand'], [81, 'Japan'],
  [82, 'Korea'], [86, "People's Republic of China"], [90, 'Turkey'], [91, 'India'], [351, 'Portugal'],
  [353, 'Ireland'], [358, 'Finland'], [972, 'Israel'], [966, 'Saudi Arabia'], [971, 'United Arab Emirates'],
]);

export function describeCountryCode(code: number): string {
  const label = code === 0 ? 'System Default' : COUNTRY_CODES.get(code) ?? 'Unknown';
  return `${String(code).padStart(3, '0')} (${label})`;
}

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
  private machine: WindowsUserMachine | null = null;

  constructor() {
    this.initDefaults();
  }

  private nowMs(): number {
    return this.machine === null ? simulationNowMs() : this.machine.nowMs();
  }

  private nowDate(): Date {
    return new Date(this.nowMs());
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

  attachMachine(machine: WindowsUserMachine): void {
    this.machine = machine;
  }

  /** Attach the machine's `net accounts` policy so it is actually enforced. */
  attachPolicy(policy: WindowsAccountsPolicy): void {
    this.policy = policy;
  }

  /** Publish an account-change event on the central bus. */
  private publishAccount(
    account: string, change: WindowsAccountChange, changed?: Record<string, string>,
  ): void {
    const actor = change === 'locked-out' ? 'SYSTEM' : this.currentUser;
    this.bus?.publish({
      topic: 'windows.account.changed',
      payload: { deviceId: this.deviceId, account, change, actor, ...(changed === undefined ? {} : { changed }) },
    });
  }

  /** Publish a group-membership-change event on the central bus. */
  private publishMembership(group: string, member: string, added: boolean): void {
    this.bus?.publish({
      topic: 'windows.group.membership-changed',
      payload: { deviceId: this.deviceId, group, member, added, actor: this.currentUser },
    });
  }

  private initDefaults(): void {
    // Built-in users
    this.addUser({
      name: 'Administrator', fullName: '', description: 'Built-in account for administering the computer/domain',
      sid: WELL_KNOWN_SIDS['Administrator'], enabled: true, password: 'x',
      passwordRequired: true, userMayChangePassword: true,
      passwordLastSet: this.nowDate(), lastLogon: null, builtIn: true,
      passwordHistory: [], failedLogonCount: 0, lockedUntil: null, accountExpires: null,
    });
    this.passwords.set('administrator', 'admin');

    this.addUser({
      name: 'Guest', fullName: '', description: 'Built-in account for guest access to the computer/domain',
      sid: WELL_KNOWN_SIDS['Guest'], enabled: false, password: '',
      passwordRequired: false, userMayChangePassword: false,
      passwordLastSet: this.nowDate(), lastLogon: null, builtIn: true,
      passwordHistory: [], failedLogonCount: 0, lockedUntil: null, accountExpires: null,
    });

    this.addUser({
      name: 'DefaultAccount', fullName: '', description: 'A user account managed by the system.',
      sid: WELL_KNOWN_SIDS['DefaultAccount'], enabled: false, password: '',
      passwordRequired: false, userMayChangePassword: false,
      passwordLastSet: this.nowDate(), lastLogon: null, builtIn: true,
      passwordHistory: [], failedLogonCount: 0, lockedUntil: null, accountExpires: null,
    });

    this.addUser({
      name: 'User', fullName: '', description: '',
      sid: `${MACHINE_SID_PREFIX}-${this.nextRid++}`, enabled: true, password: 'x',
      passwordRequired: true, userMayChangePassword: true,
      passwordLastSet: this.nowDate(), lastLogon: this.nowDate(), builtIn: false,
      passwordHistory: [], failedLogonCount: 0, lockedUntil: null, accountExpires: null,
    });
    this.passwords.set('user', 'user');

    // Standard cast — password equals the username — so cross-equipment
    // SSH tests don't need per-pairing setup.
    for (const u of ['alice', 'bob', 'carl', 'dave']) {
      this.addUser({
        name: u, fullName: '', description: '',
        sid: `${MACHINE_SID_PREFIX}-${this.nextRid++}`, enabled: true, password: 'x',
        passwordRequired: true, userMayChangePassword: true,
        passwordLastSet: this.nowDate(), lastLogon: null, builtIn: false,
        passwordHistory: [], failedLogonCount: 0, lockedUntil: null, accountExpires: null,
      });
      this.passwords.set(u.toLowerCase(), u);
    }

    for (const builtIn of ['guest', 'defaultaccount']) this.users.get(builtIn)!.passwordNeverExpires = true;

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

  /**
   * Put back accounts and groups exactly as they were — used when a saved
   * topology is reopened.
   *
   * Deliberately not `createUser`/`net user /add`: that path mints a fresh
   * SID, resets the password through the complexity policy and clears the
   * lockout counters, so a restored machine would look right in
   * `net user` while every ACL naming the old SID pointed at nobody and
   * the lab's own password no longer worked. Restoring is not creating.
   *
   * Existing entries are overwritten rather than skipped: the machine
   * boots with its built-in accounts, and the saved copy of `Administrator`
   * (renamed, disabled, whatever the lab did to it) is the one that must
   * win.
   */
  restoreAccounts(
    users: readonly WindowsUser[],
    groups: readonly WindowsGroup[],
    removed: { users?: readonly string[]; groups?: readonly string[] } = {},
    passwords: Readonly<Record<string, string>> = {},
  ): void {
    for (const name of removed.users ?? []) {
      this.users.delete(name.toLowerCase());
      this.passwords.delete(name.toLowerCase());
    }
    for (const [name, secret] of Object.entries(passwords)) this.passwords.set(name.toLowerCase(), secret);
    for (const name of removed.groups ?? []) this.groups.delete(name.toLowerCase());
    for (const u of users) this.addUser(u);
    for (const g of groups) this.addGroup(g);
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
    if (name.length === 0 || name.length > MAX_USER_NAME_LENGTH || FORBIDDEN_NAME_CHARACTERS.test(name)) {
      return 'The user name or group name parameter is invalid.';
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
      passwordLastSet: this.nowDate(), lastLogon: null, builtIn: false,
      passwordHistory: [], failedLogonCount: 0, lockedUntil: null, accountExpires: null,
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

  private storePassword(user: WindowsUser, value: string): string {
    const current = this.passwords.get(user.name.toLowerCase()) ?? '';
    const blankAllowed = value === '' && !user.passwordRequired;
    const failure = blankAllowed ? '' : this.validatePasswordComplexity(value, [current, ...user.passwordHistory]);
    if (failure) return failure;
    const historyLength = this.policy?.snapshot().passwordHistoryLength ?? 0;
    if (current) {
      user.passwordHistory = [current, ...user.passwordHistory].slice(0, historyLength);
    }
    this.passwords.set(user.name.toLowerCase(), value);
    user.passwordLastSet = this.nowDate();
    return '';
  }

  changePassword(name: string, oldPassword: string, newPassword: string): string {
    const user = this.users.get(name.toLowerCase());
    if (!user) return 'The user name could not be found.';
    if (this.passwords.get(name.toLowerCase()) !== oldPassword) {
      return 'The specified network password is not correct.';
    }
    if (!user.userMayChangePassword) return 'The password of this user cannot be changed.';
    const changeableAt = user.passwordLastSet.getTime() + (this.policy?.snapshot().minPasswordAge ?? 0) * 86_400_000;
    if (changeableAt > this.nowMs()) return 'The password of this user is too recent to change.';
    const failure = this.storePassword(user, newPassword);
    if (failure) return failure;
    this.publishAccount(user.name, 'password-changed');
    return '';
  }

  validateUserOption(property: string, value: string): string {
    switch (property.toLowerCase()) {
      case 'times': return parseLogonHours(value).ok ? '' : SYNTAX_INVALID;
      case 'expires': return parseAccountExpiry(value, this.nowMs(), this.dateOrder()) === undefined ? SYNTAX_INVALID : '';
      case 'workstations': {
        const names = value.split(',').map((entry) => entry.trim()).filter((entry) => entry !== '');
        return names.length > MAX_WORKSTATIONS && !names.includes('*') ? SYNTAX_INVALID : '';
      }
      case 'passwordchg':
      case 'passwordreq':
      case 'passwordneverexpires':
      case 'active':
        return yesNo(value) === null ? SYNTAX_INVALID : '';
      case 'homedir':
        return value !== '' && !value.startsWith('\\\\') && this.machine !== null && !this.machine.directoryExists(value)
          ? 'The system cannot find the path specified.' : '';
      case 'scriptpath': return isAbsolutePath(value) ? SYNTAX_INVALID : '';
      case 'comment':
      case 'usercomment':
        return value.length > MAX_COMMENT_LENGTH ? SYNTAX_INVALID : '';
      case 'countrycode': {
        const code = Number(value);
        return /^\d{1,3}$/.test(value) && (code === 0 || COUNTRY_CODES.has(code)) ? '' : SYNTAX_INVALID;
      }
      default: return '';
    }
  }

  setUserProperty(name: string, property: string, value: string): string {
    if (!this.isCurrentUserAdmin()) return 'Access is denied.';
    const user = this.users.get(name.toLowerCase());
    if (!user) return 'The user name could not be found.';

    switch (property.toLowerCase()) {
      case 'fullname':
        user.fullName = value;
        this.publishAccount(user.name, 'modified', { DisplayName: value });
        break;
      case 'description':
      case 'comment':
        if (value.length > MAX_COMMENT_LENGTH) return SYNTAX_INVALID;
        user.description = value;
        this.publishAccount(user.name, 'modified');
        break;
      case 'password': {
        const failure = this.storePassword(user, value);
        if (failure) return failure;
        this.publishAccount(user.name, 'password-reset');
        break;
      }
      case 'active': {
        const enabled = yesNo(value);
        if (enabled === null) return SYNTAX_INVALID;
        user.enabled = enabled;
        if (enabled) {
          const wasLocked = this.isLockedOut(user.name);
          user.lockedUntil = null;
          user.failedLogonCount = 0;
          if (wasLocked) this.publishAccount(user.name, 'unlocked');
          this.publishAccount(user.name, 'enabled');
        } else {
          this.publishAccount(user.name, 'disabled');
        }
        break;
      }
      case 'expires': {
        const parsed = parseAccountExpiry(value, this.nowMs(), this.dateOrder());
        if (parsed === undefined) return SYNTAX_INVALID;
        user.accountExpires = parsed;
        this.publishAccount(user.name, 'modified', {
          AccountExpires: parsed === null ? '%%1794' : `${parsed.getUTCMonth() + 1}/${parsed.getUTCDate()}/${parsed.getUTCFullYear()}`,
        });
        break;
      }
      case 'times': {
        const parsed = parseLogonHours(value);
        if (!parsed.ok) return SYNTAX_INVALID;
        user.logonHours = parsed.hours ?? undefined;
        this.publishAccount(user.name, 'modified');
        break;
      }
      case 'workstations': {
        const names = value.split(',').map((entry) => entry.trim()).filter((entry) => entry !== '');
        if (names.includes('*') || names.length === 0) {
          user.workstations = undefined;
        } else {
          if (names.length > MAX_WORKSTATIONS) return SYNTAX_INVALID;
          user.workstations = names;
        }
        this.publishAccount(user.name, 'modified');
        break;
      }
      case 'passwordchg': {
        const allowed = yesNo(value);
        if (allowed === null) return SYNTAX_INVALID;
        user.userMayChangePassword = allowed;
        this.publishAccount(user.name, 'modified');
        break;
      }
      case 'passwordreq': {
        const required = yesNo(value);
        if (required === null) return SYNTAX_INVALID;
        if (required && (this.passwords.get(user.name.toLowerCase()) ?? '') === '') {
          return this.validatePasswordComplexity('');
        }
        user.passwordRequired = required;
        this.publishAccount(user.name, 'modified');
        break;
      }
      case 'passwordneverexpires': {
        const never = yesNo(value);
        if (never === null) return SYNTAX_INVALID;
        user.passwordNeverExpires = never;
        this.publishAccount(user.name, 'modified');
        break;
      }
      case 'homedir': {
        if (value !== '' && !value.startsWith('\\\\') && this.machine !== null && !this.machine.directoryExists(value)) {
          return 'The system cannot find the path specified.';
        }
        user.homeDirectory = value;
        this.publishAccount(user.name, 'modified', { HomeDirectory: value === '' ? '%%1793' : value });
        break;
      }
      case 'profilepath':
        user.profilePath = value;
        this.publishAccount(user.name, 'modified', { ProfilePath: value === '' ? '%%1793' : value });
        break;
      case 'scriptpath':
        if (isAbsolutePath(value)) return SYNTAX_INVALID;
        user.scriptPath = value;
        this.publishAccount(user.name, 'modified', { ScriptPath: value === '' ? '%%1793' : value });
        break;
      case 'usercomment':
        if (value.length > MAX_COMMENT_LENGTH) return SYNTAX_INVALID;
        user.userComment = value;
        this.publishAccount(user.name, 'modified');
        break;
      case 'countrycode': {
        const code = Number(value);
        if (!/^\d{1,3}$/.test(value) || (code !== 0 && !COUNTRY_CODES.has(code))) return SYNTAX_INVALID;
        user.countryCode = code;
        this.publishAccount(user.name, 'modified');
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
    if (user.lockedUntil.getTime() > this.nowMs()) return true;
    user.lockedUntil = null;
    user.failedLogonCount = 0;
    return false;
  }

  isAccountExpired(name: string): boolean {
    const expires = this.users.get(name.toLowerCase())?.accountExpires;
    return expires != null && expires.getTime() <= this.nowMs();
  }

  /**
   * Why a logon that needs no password (the S4U logon Win32-OpenSSH performs
   * for public-key authentication, win32_usertoken_utils.c) is refused for
   * this account, or null when it may proceed. A password that is merely
   * expired does not appear here: S4U never presents one.
   */
  logonRefusal(name: string, workstation?: string): WindowsLogonRefusal | null {
    const user = this.users.get(name.toLowerCase());
    if (!user) return null;
    if (!user.enabled) return 'disabled';
    if (this.isAccountExpired(name)) return 'expired';
    if (this.isLockedOut(name)) return 'locked';
    if (!logonHoursAllow(user.logonHours, this.nowMs(), this.machine?.timezone())) return 'logon-hours';
    if (user.workstations !== undefined) {
      const origin = (workstation ?? this.machine?.hostname() ?? '').toLowerCase();
      if (!user.workstations.some((entry) => entry.toLowerCase() === origin)) return 'workstation';
    }
    return null;
  }

  regionalFormats(): RegionalFormats {
    return this.machine?.regionalFormats() ?? DEFAULT_REGIONAL_FORMATS;
  }

  private dateOrder() {
    return dateOrderOf(this.regionalFormats().shortDate);
  }

  passwordMinimumAgeDays(): number {
    return this.policy?.snapshot().minPasswordAge ?? 0;
  }

  /** The instant this account's password stops being valid, or null if `net accounts /maxpwage` is Never/unset. */
  passwordExpiresAt(name: string): number | null {
    const user = this.users.get(name.toLowerCase());
    if (!user || user.passwordNeverExpires === true) return null;
    const maxAge = this.policy?.snapshot().maxPasswordAge ?? -1;
    if (maxAge < 0) return null;
    return user.passwordLastSet.getTime() + maxAge * 86_400_000;
  }

  /** Whether the account's password is past `net accounts /maxpwage`. */
  isPasswordExpired(name: string): boolean {
    const expiresAt = this.passwordExpiresAt(name);
    return expiresAt !== null && expiresAt < this.nowMs();
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
   * (SSH → 10 RemoteInteractive, RDP → 10, workstation unlock → 7
   * Unlock) must pass its own real value. `checkPassword` used to
   * hardcode 2 unconditionally, which made every non-interactive caller
   * either silently mislabel its own `windows.account.logon` publish or
   * (SSH) publish a second, correctly-typed one on top of this one —
   * PRD-Winlogon.md §1.2 point 1.
   *
   * `publishOnSuccess` defaults to true. A successful workstation unlock
   * (PRD-Winlogon.md §2.1 P2) passes false: real Windows does not open
   * a fresh logon session (4624) to resume an already-open one that was
   * merely locked — only 4801 (workstation unlocked) fires — but a
   * *failed* unlock attempt is exactly as real a failed authentication
   * as any other, so the failure branches published `false` by default.
   *
   * `publishOnFailure` (default true) exists for the RDP case
   * (PRD-Winlogon.md §2.1 P4): `RdpServerHandler` is the single
   * publisher for *both* outcomes there (it must be, since a
   * domain-authenticated RDP logon never reaches this method at all —
   * `tryDomainAuth` publishes nothing on its own), so the local-account
   * path passes `publishOnSuccess=false, publishOnFailure=false` to stay
   * out of the way entirely rather than double-publishing the failure
   * half like the success half would.
   */
  checkPassword(
    name: string, password: string, logonType = 2, publishOnSuccess = true, publishOnFailure = true,
    details?: WindowsLogonDetails,
  ): boolean {
    const user = this.users.get(name.toLowerCase());
    const refusal = user === undefined ? null : this.logonRefusal(name, details?.workstation);
    const blocked: WindowsLogonFailureCause | null =
      refusal !== null ? refusal
        : user !== undefined && this.isPasswordExpired(name) ? 'password-expired' : null;
    if (blocked !== null) {
      if (publishOnFailure) {
        this.bus?.publish({
          topic: 'windows.account.logon',
          payload: { deviceId: this.deviceId, account: name, success: false, logonType, failure: blocked, details },
        });
      }
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
          user.lockedUntil = new Date(this.nowMs() + durationMinutes * 60_000);
          this.publishAccount(user.name, 'locked-out');
        }
      }
    }

    if (ok && !publishOnSuccess) return true;
    if (!ok && !publishOnFailure) return false;
    this.bus?.publish({
      topic: 'windows.account.logon',
      payload: {
        deviceId: this.deviceId, account: name, success: ok, logonType, details,
        ...(ok ? {} : { failure: user === undefined ? 'unknown-user' as const : 'bad-password' as const }),
      },
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

  /**
   * The logon secret this machine holds for an account, as Windows holds
   * one to authenticate the signed-in user outbound without re-prompting.
   * A real client proves knowledge of it by challenge-response; this
   * simulator's SMB session-setup verifies the secret itself, so the
   * caller hands it over and the SERVER still decides.
   */
  getLogonSecret(name: string): string | null {
    return this.passwords.get(name.toLowerCase()) ?? null;
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
    this.bus?.publish({ topic: 'windows.group.created', payload: { deviceId: this.deviceId, group: name, actor: this.currentUser } });
    return '';
  }

  deleteGroup(name: string): string {
    if (!this.isCurrentUserAdmin()) return 'Access is denied.';
    const group = this.groups.get(name.toLowerCase());
    if (!group) return `The specified group could not be found.`;
    if (group.builtIn) return `Cannot delete built-in group '${group.name}'.`;
    this.groups.delete(name.toLowerCase());
    this.bus?.publish({ topic: 'windows.group.deleted', payload: { deviceId: this.deviceId, group: group.name, actor: this.currentUser } });
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
        passwordLastSet: this.nowDate(),
        lastLogon: null,
        builtIn: false,
        passwordHistory: [],
        failedLogonCount: 0,
        lockedUntil: null, accountExpires: null,
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
