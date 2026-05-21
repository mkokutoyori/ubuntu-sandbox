/**
 * User and group management for Linux simulation.
 *
 * Owns the in-VM IAM state — accounts (`LinuxUserAccount`) and groups
 * (`LinuxGroup`) — and projects it onto `/etc/passwd`, `/etc/shadow` and
 * `/etc/group`.
 *
 * Reactive layer: once a device calls `attachBus()`, every mutation
 * (`useradd`, `usermod`, `passwd`, `groupadd`, …) also publishes a
 * deviceId-scoped domain event on the central `EventBus`. The legacy
 * return-string API is unchanged, so existing callers keep working while
 * new consumers (audit panels, toasts, supervisors) subscribe to the bus.
 */

import { VirtualFileSystem } from './VirtualFileSystem';
import { uptimeHeader } from './system/SystemInfo';
import type { IEventBus } from '@/events/EventBus';
import { GecosInfo } from './iam/GecosInfo';
import {
  LinuxUserAccount,
  daysSinceEpoch as daysSinceEpochOf,
  type UserEntry,
} from './iam/LinuxUserAccount';
import { LinuxGroup, type GroupEntry } from './iam/LinuxGroup';
import type { LinuxIamDomainEvent } from './iam/events';
import { LoginDefs } from './iam/fs/LoginDefs';
import { UseraddDefaults } from './iam/fs/UseraddDefaults';
import { IamFilesystem } from './iam/fs/IamFilesystem';

// Re-export the structural contracts so existing importers keep working.
export type { UserEntry } from './iam/LinuxUserAccount';
export type { GroupEntry } from './iam/LinuxGroup';

/** Default primary GID used by `useradd -N` (no user-private group). */
const DEFAULT_USER_GID = 100;

/**
 * Options accepted by {@link LinuxUserManager.useradd}.
 *
 * The original six fields (`m s G d g c`) are preserved verbatim for
 * backward compatibility; the remainder expose the real `useradd` surface
 * (uid override, system accounts, pre-hashed password, account aging).
 */
export interface UseraddOptions {
  /** `-m` create the home directory. */
  m?: boolean;
  /** `-M` never create the home directory (wins over `-m`). */
  M?: boolean;
  /** `-s` login shell. */
  s?: string;
  /** `-G` supplementary groups, comma-separated. */
  G?: string;
  /** `-d` home directory path. */
  d?: string;
  /** `-g` primary group, by name or numeric id. */
  g?: string;
  /** `-c` GECOS comment. */
  c?: string;
  /** `-u` explicit UID. */
  u?: number;
  /** `-o` allow a non-unique UID. */
  o?: boolean;
  /** `-r` create a system account. */
  r?: boolean;
  /** `-N` do not create a user-private group. */
  N?: boolean;
  /** `-p` pre-hashed password. */
  p?: string;
  /** `-e` account expiry date, days since epoch. */
  e?: number;
  /** `-f` password inactivity grace, in days. */
  f?: number;
}

export class LinuxUserManager {
  private users: Map<string, LinuxUserAccount> = new Map();
  private groups: Map<string, LinuxGroup> = new Map();
  /** Plaintext password store for simulation (username → password) */
  private passwords: Map<string, string> = new Map();
  /** UID/GID allocation cursors — seeded from the {@link LoginDefs} policy. */
  private nextUid: number;
  private nextGid: number;
  private nextSystemUid: number;
  private nextSystemGid: number;
  currentUser = 'root';
  currentUid = 0;
  currentGid = 0;

  /** Reactive sink — null until the owning device attaches its bus. */
  private bus: IEventBus | null = null;
  private deviceId = '';

  /** System-wide policy (`/etc/login.defs`) — drives UID/GID allocation. */
  private readonly loginDefs: LoginDefs;
  /** `useradd` fallback defaults (`/etc/default/useradd`). */
  private readonly useraddDefaults: UseraddDefaults;
  /** Keeps the on-disk account database, config and spools coherent. */
  private readonly iamFs: IamFilesystem;

  constructor(private vfs: VirtualFileSystem) {
    this.loginDefs = LoginDefs.defaults();
    this.useraddDefaults = UseraddDefaults.defaults();
    this.iamFs = new IamFilesystem(vfs);
    this.nextUid = this.loginDefs.uidMin;
    this.nextGid = this.loginDefs.gidMin;
    this.nextSystemUid = this.loginDefs.sysUidMin;
    this.nextSystemGid = this.loginDefs.sysGidMin;
    this.initDefaults();
  }

  /** The system login policy (`/etc/login.defs`). */
  getLoginDefs(): LoginDefs {
    return this.loginDefs;
  }

  /** The `useradd` fallback defaults (`/etc/default/useradd`). */
  getUseraddDefaults(): UseraddDefaults {
    return this.useraddDefaults;
  }

  /**
   * Attach the owning device's event bus so IAM mutations become
   * observable. Idempotent; safe to call at any point after construction.
   */
  attachBus(bus: IEventBus, deviceId: string): void {
    this.bus = bus;
    this.deviceId = deviceId;
  }

  private publish(event: LinuxIamDomainEvent): void {
    this.bus?.publish(event);
  }

  private initDefaults(): void {
    // System users
    this.addUser(new LinuxUserAccount({
      username: 'root', uid: 0, gid: 0, gecos: 'root', home: '/root', shell: '/bin/bash',
      password: 'x', locked: false, systemAccount: true,
    }));
    this.passwords.set('root', 'admin');
    this.addUser(new LinuxUserAccount({
      username: 'daemon', uid: 1, gid: 1, gecos: 'daemon', home: '/usr/sbin', shell: '/usr/sbin/nologin',
      password: '*', locked: true, systemAccount: true,
    }));
    this.addUser(new LinuxUserAccount({
      username: 'nobody', uid: 65534, gid: 65534, gecos: 'nobody', home: '/nonexistent', shell: '/usr/sbin/nologin',
      password: '*', locked: true, systemAccount: true,
    }));

    // System groups
    this.addGroup(new LinuxGroup({ name: 'root', gid: 0, systemGroup: true }));
    this.addGroup(new LinuxGroup({ name: 'daemon', gid: 1, systemGroup: true }));
    this.addGroup(new LinuxGroup({ name: 'adm', gid: 4, systemGroup: true }));
    this.addGroup(new LinuxGroup({ name: 'sudo', gid: 27, systemGroup: true }));
    this.addGroup(new LinuxGroup({ name: 'video', gid: 44, systemGroup: true }));
    this.addGroup(new LinuxGroup({ name: 'plugdev', gid: 46, systemGroup: true }));
    this.addGroup(new LinuxGroup({ name: 'users', gid: 100, systemGroup: true }));
    this.addGroup(new LinuxGroup({ name: 'nogroup', gid: 65534, systemGroup: true }));

    // Seed the policy / defaults configuration and the skeleton directory,
    // then materialise the account database.
    this.iamFs.seedConfiguration(this.loginDefs, this.useraddDefaults);
    this.syncToFilesystem();
  }

  private daysSinceEpoch(): number {
    return daysSinceEpochOf();
  }

  private addUser(u: LinuxUserAccount): void {
    this.users.set(u.username, u);
    if (u.uid >= this.nextUid && u.uid < 65534) this.nextUid = u.uid + 1;
  }

  private addGroup(g: LinuxGroup): void {
    this.groups.set(g.name, g);
    if (g.gid >= this.nextGid && g.gid < 65534) this.nextGid = g.gid + 1;
  }

  // ─── Public API ─────────────────────────────────────────────────

  getUser(username: string): UserEntry | undefined {
    return this.users.get(username);
  }

  /** Typed accessor for the rich account entity (callers that need behaviour). */
  getAccount(username: string): LinuxUserAccount | undefined {
    return this.users.get(username);
  }

  getGroup(name: string): GroupEntry | undefined {
    return this.groups.get(name);
  }

  getGroupEntity(name: string): LinuxGroup | undefined {
    return this.groups.get(name);
  }

  getUserByUid(uid: number): UserEntry | undefined {
    for (const u of this.users.values()) {
      if (u.uid === uid) return u;
    }
    return undefined;
  }

  getGroupByGid(gid: number): GroupEntry | undefined {
    for (const g of this.groups.values()) {
      if (g.gid === gid) return g;
    }
    return undefined;
  }

  uidToName(uid: number): string {
    return this.getUserByUid(uid)?.username ?? uid.toString();
  }

  gidToName(gid: number): string {
    return this.getGroupByGid(gid)?.name ?? gid.toString();
  }

  resolveUid(name: string): number {
    return this.users.get(name)?.uid ?? -1;
  }

  resolveGid(name: string): number {
    return this.groups.get(name)?.gid ?? -1;
  }

  getAllUsers(): UserEntry[] {
    return [...this.users.values()];
  }

  getAllGroups(): GroupEntry[] {
    return [...this.groups.values()];
  }

  /** Get all groups a user belongs to */
  getUserGroups(username: string): GroupEntry[] {
    const user = this.users.get(username);
    if (!user) return [];
    const result: GroupEntry[] = [];
    for (const g of this.groups.values()) {
      if (g.gid === user.gid || g.members.includes(username)) {
        result.push(g);
      }
    }
    return result;
  }

  // ─── User operations ──────────────────────────────────────────────

  useradd(username: string, opts: UseraddOptions = {}): string {
    if (this.users.has(username)) return `useradd: user '${username}' already exists`;

    // UID — explicit (`-u`) or auto-allocated. Uniqueness enforced unless `-o`.
    let uid: number;
    if (opts.u !== undefined) {
      if (!opts.o && this.getUserByUid(opts.u)) {
        return `useradd: UID ${opts.u} is not unique`;
      }
      uid = opts.u;
      if (uid >= this.nextUid && uid < 65534) this.nextUid = uid + 1;
    } else if (opts.r) {
      uid = this.nextSystemUid++;
    } else {
      uid = this.nextUid++;
    }

    // Primary group resolution.
    let gid: number;
    let userPrivateGroupCreated = false;
    if (opts.g) {
      const grp = this.groups.get(opts.g) ?? this.findGroupByGidString(opts.g);
      if (!grp) return `useradd: group '${opts.g}' does not exist`;
      gid = grp.gid;
    } else if (opts.N) {
      gid = DEFAULT_USER_GID;
    } else {
      // Create a user-private group with the same name. System accounts get
      // their group from the system GID range too.
      gid = opts.r ? this.nextSystemGid++ : this.nextGid++;
      const pg = new LinuxGroup({ name: username, gid, userPrivateGroup: true });
      this.addGroup(pg);
      userPrivateGroupCreated = true;
      this.publish({
        topic: 'linux.iam.group.created',
        payload: { deviceId: this.deviceId, groupName: pg.name, gid: pg.gid, systemGroup: pg.systemGroup, userPrivateGroup: true },
      });
    }

    const home = opts.d || `/home/${username}`;
    const shell = opts.s || '/bin/sh';
    const account = new LinuxUserAccount({
      username, uid, gid, home, shell,
      gecos: opts.c ?? '',
      password: opts.p ?? '!',
      locked: false,
      systemAccount: opts.r ?? undefined,
      nonUnique: opts.o ?? false,
      expireDate: opts.e ?? -1,
      inactiveDays: opts.f ?? -1,
    });
    this.addUser(account);

    // Supplementary groups.
    const joinedGroups: string[] = [];
    if (opts.G) {
      for (const gName of opts.G.split(',')) {
        const grp = this.groups.get(gName.trim());
        if (grp && grp.addMember(username)) {
          joinedGroups.push(grp.name);
          this.publish({
            topic: 'linux.iam.group.membership-changed',
            payload: { deviceId: this.deviceId, groupName: grp.name, gid: grp.gid, username, action: 'added' },
          });
        }
      }
    }

    // Create home directory (`-m` requested and not vetoed by `-M`).
    if (opts.m && !opts.M) {
      this.vfs.mkdirp(home, 0o755, uid, gid);
    }

    // Materialise the mailbox for interactive accounts (CREATE_MAIL_SPOOL).
    if (this.useraddDefaults.createMailSpool && !account.systemAccount) {
      this.iamFs.createMailSpool(username, uid, gid);
    }

    this.syncToFilesystem();
    this.publish({
      topic: 'linux.iam.user.created',
      payload: {
        deviceId: this.deviceId,
        username, uid, gid, home, shell,
        kind: account.kind,
        supplementaryGroups: joinedGroups,
        userPrivateGroupCreated,
      },
    });
    return '';
  }

  /** Resolve a `-g` argument that may be a numeric GID string. */
  private findGroupByGidString(value: string): LinuxGroup | undefined {
    const n = parseInt(value, 10);
    if (Number.isNaN(n)) return undefined;
    for (const g of this.groups.values()) {
      if (g.gid === n) return g;
    }
    return undefined;
  }

  usermod(username: string, opts: { s?: string; d?: string; m?: boolean; aG?: string; L?: boolean; U?: boolean; g?: string }): string {
    const user = this.users.get(username);
    if (!user) return `usermod: user '${username}' does not exist`;

    const changed: string[] = [];

    if (opts.s) { user.shell = opts.s; changed.push('shell'); }
    if (opts.d) {
      user.home = opts.d;
      changed.push('home');
      if (opts.m) {
        this.vfs.mkdirp(opts.d, 0o755, user.uid, user.gid);
      }
    }
    if (opts.L && !user.locked) {
      user.lock();
      this.publish({ topic: 'linux.iam.user.lock-state-changed', payload: { deviceId: this.deviceId, username, uid: user.uid, locked: true } });
    }
    if (opts.U && user.locked) {
      user.unlock();
      this.publish({ topic: 'linux.iam.user.lock-state-changed', payload: { deviceId: this.deviceId, username, uid: user.uid, locked: false } });
    }

    if (opts.aG) {
      for (const gName of opts.aG.split(',')) {
        const grp = this.groups.get(gName.trim());
        if (grp && grp.addMember(username)) {
          changed.push('groups');
          this.publish({
            topic: 'linux.iam.group.membership-changed',
            payload: { deviceId: this.deviceId, groupName: grp.name, gid: grp.gid, username, action: 'added' },
          });
        }
      }
    }

    this.syncToFilesystem();
    if (changed.length > 0) {
      this.publish({
        topic: 'linux.iam.user.modified',
        payload: { deviceId: this.deviceId, username, uid: user.uid, changedFields: [...new Set(changed)] },
      });
    }
    return '';
  }

  userdel(username: string, removeHome: boolean): string {
    const user = this.users.get(username);
    if (!user) return `userdel: user '${username}' does not exist`;

    // Remove from all groups
    for (const g of this.groups.values()) {
      g.removeMember(username);
      g.admins = g.admins.filter(a => a !== username);
    }

    // Remove user's personal group if it exists and is empty
    const personalGroup = this.groups.get(username);
    if (personalGroup && personalGroup.members.length === 0) {
      this.groups.delete(username);
      this.publish({
        topic: 'linux.iam.group.deleted',
        payload: { deviceId: this.deviceId, groupName: personalGroup.name, gid: personalGroup.gid },
      });
    }

    if (removeHome) {
      this.vfs.rmrf(user.home);
    }
    this.iamFs.removeMailSpool(username);

    this.users.delete(username);
    this.passwords.delete(username);
    this.syncToFilesystem();
    this.publish({
      topic: 'linux.iam.user.deleted',
      payload: { deviceId: this.deviceId, username, uid: user.uid, homeRemoved: removeHome },
    });
    return '';
  }

  setPassword(username: string, password: string): string {
    const user = this.users.get(username);
    if (!user) return `passwd: user '${username}' does not exist`;
    user.password = `$6$simulated$${password}`;
    user.lastChange = this.daysSinceEpoch();
    this.passwords.set(username, password);
    this.syncToFilesystem();
    this.publish({
      topic: 'linux.iam.user.password-changed',
      payload: { deviceId: this.deviceId, username, uid: user.uid, disabled: false },
    });
    return '';
  }

  /** Set GECOS fields (Full Name, Room, Work Phone, Home Phone, Other) */
  setUserGecos(username: string, fullName: string, room: string, workPhone: string, homePhone: string, other: string): string {
    const user = this.users.get(username);
    if (!user) return `chfn: user '${username}' does not exist`;
    user.gecosInfo = new GecosInfo(fullName, room, workPhone, homePhone, other);
    this.syncToFilesystem();
    this.publish({
      topic: 'linux.iam.user.gecos-changed',
      payload: { deviceId: this.deviceId, username, uid: user.uid, gecos: user.gecos },
    });
    return '';
  }

  /** chfn — change finger information. Only updates the specified fields. */
  chfn(username: string, opts: { f?: string; r?: string; w?: string; h?: string }): string {
    const user = this.users.get(username);
    if (!user) return `chfn: user '${username}' does not exist`;

    const current = user.gecosInfo;
    let next = current;
    if (opts.f !== undefined) next = next.withFullName(opts.f);
    if (opts.r !== undefined) next = next.withRoomNumber(opts.r);
    if (opts.w !== undefined) next = next.withWorkPhone(opts.w);
    if (opts.h !== undefined) next = next.withHomePhone(opts.h);

    user.gecosInfo = next;
    this.syncToFilesystem();
    this.publish({
      topic: 'linux.iam.user.gecos-changed',
      payload: { deviceId: this.deviceId, username, uid: user.uid, gecos: user.gecos },
    });
    return '';
  }

  /** finger — display user information */
  finger(username?: string): string {
    const name = username || this.currentUser;
    const user = this.users.get(name);
    if (!user) return `finger: ${name}: no such user.`;

    const info = user.gecosInfo;
    const lines = [
      `Login: ${user.username}${' '.repeat(Math.max(1, 24 - user.username.length - 7))}Name: ${info.fullName}`,
      `Directory: ${user.home}${' '.repeat(Math.max(1, 24 - user.home.length - 11))}Shell: ${user.shell}`,
    ];
    if (info.roomNumber) lines.push(`Office: ${info.roomNumber}`);
    if (info.workPhone) lines.push(`Office Phone: ${info.workPhone}`);
    if (info.homePhone) lines.push(`Home Phone: ${info.homePhone}`);

    return lines.join('\n');
  }

  /** Verify a user's password. Returns true if correct. */
  checkPassword(username: string, password: string): boolean {
    const stored = this.passwords.get(username);
    if (stored === undefined) return false;
    return stored === password;
  }

  passwdStatus(username: string): string {
    const user = this.users.get(username);
    if (!user) return `passwd: user '${username}' does not exist`;
    const status = user.locked ? 'L' : (user.password === '!' ? 'NP' : 'P');
    const lastChange = new Date(user.lastChange * 86400000).toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: 'numeric' });
    return `${username} ${status} ${lastChange} ${user.minDays} ${user.maxDays} ${user.warnDays} ${user.inactiveDays}`;
  }

  chage(username: string, opts: { M?: number; m?: number; W?: number; d?: number; l?: boolean }): string {
    const user = this.users.get(username);
    if (!user) return `chage: user '${username}' does not exist`;

    if (opts.l) {
      const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
      const fmtDate = (days: number) => {
        if (days <= 0) return 'Jan 01, 1970';
        const d = new Date(days * 86400000);
        return `${months[d.getUTCMonth()]} ${String(d.getUTCDate()).padStart(2, '0')}, ${d.getUTCFullYear()}`;
      };
      const lastChange = fmtDate(user.lastChange);
      const expire = user.expireDate === -1 ? 'never' : fmtDate(user.expireDate);
      return [
        `Last password change\t\t\t\t\t: ${lastChange}`,
        `Password expires\t\t\t\t\t: ${user.maxDays === 99999 ? 'never' : 'in ' + user.maxDays + ' days'}`,
        `Password inactive\t\t\t\t\t: ${user.inactiveDays === -1 ? 'never' : 'in ' + user.inactiveDays + ' days'}`,
        `Account expires\t\t\t\t\t\t: ${expire}`,
        `Minimum number of days between password change\t\t: ${user.minDays}`,
        `Maximum number of days between password change\t\t: ${user.maxDays}`,
        `Number of days of Warning before password expires\t: ${user.warnDays}`,
      ].join('\n');
    }

    const changed: string[] = [];
    if (opts.M !== undefined) { user.maxDays = opts.M; changed.push('maxDays'); }
    if (opts.m !== undefined) { user.minDays = opts.m; changed.push('minDays'); }
    if (opts.W !== undefined) { user.warnDays = opts.W; changed.push('warnDays'); }
    if (opts.d !== undefined) { user.lastChange = opts.d; changed.push('lastChange'); }

    this.syncToFilesystem();
    if (changed.length > 0) {
      this.publish({
        topic: 'linux.iam.user.modified',
        payload: { deviceId: this.deviceId, username, uid: user.uid, changedFields: changed },
      });
    }
    return '';
  }

  // ─── Group operations ─────────────────────────────────────────────

  groupadd(name: string, opts: { g?: number } = {}): string {
    if (this.groups.has(name)) return `groupadd: group '${name}' already exists`;
    const gid = opts.g ?? this.nextGid++;
    const group = new LinuxGroup({ name, gid });
    this.addGroup(group);
    this.syncToFilesystem();
    this.publish({
      topic: 'linux.iam.group.created',
      payload: { deviceId: this.deviceId, groupName: name, gid, systemGroup: group.systemGroup, userPrivateGroup: false },
    });
    return '';
  }

  groupmod(name: string, opts: { g?: number; n?: string }): string {
    const group = this.groups.get(name);
    if (!group) return `groupmod: group '${name}' does not exist`;

    const changed: string[] = [];
    if (opts.g !== undefined) { group.gid = opts.g; changed.push('gid'); }
    if (opts.n) {
      this.groups.delete(name);
      group.name = opts.n;
      this.groups.set(opts.n, group);
      changed.push('name');
    }

    this.syncToFilesystem();
    if (changed.length > 0) {
      this.publish({
        topic: 'linux.iam.group.modified',
        payload: { deviceId: this.deviceId, groupName: group.name, gid: group.gid, changedFields: changed },
      });
    }
    return '';
  }

  groupdel(name: string): string {
    const group = this.groups.get(name);
    if (!group) return `groupdel: group '${name}' does not exist`;
    this.groups.delete(name);
    this.syncToFilesystem();
    this.publish({
      topic: 'linux.iam.group.deleted',
      payload: { deviceId: this.deviceId, groupName: name, gid: group.gid },
    });
    return '';
  }

  gpasswd(args: string[]): string {
    // gpasswd -d user group  (remove user from group)
    // gpasswd -A admins group
    // gpasswd -M members group
    if (args.length < 2) return '';

    if (args[0] === '-d' && args.length >= 3) {
      const group = this.groups.get(args[2]);
      if (!group) return `gpasswd: group '${args[2]}' does not exist`;
      if (group.removeMember(args[1])) {
        this.publish({
          topic: 'linux.iam.group.membership-changed',
          payload: { deviceId: this.deviceId, groupName: group.name, gid: group.gid, username: args[1], action: 'removed' },
        });
      }
      this.syncToFilesystem();
      return '';
    }

    if (args[0] === '-A' && args.length >= 3) {
      const group = this.groups.get(args[2]);
      if (!group) return `gpasswd: group '${args[2]}' does not exist`;
      group.setAdmins(args[1].split(',').map(s => s.trim()));
      this.syncToFilesystem();
      this.publish({
        topic: 'linux.iam.group.modified',
        payload: { deviceId: this.deviceId, groupName: group.name, gid: group.gid, changedFields: ['admins'] },
      });
      return '';
    }

    if (args[0] === '-M' && args.length >= 3) {
      const group = this.groups.get(args[2]);
      if (!group) return `gpasswd: group '${args[2]}' does not exist`;
      group.setMembers(args[1].split(',').map(s => s.trim()));
      this.syncToFilesystem();
      this.publish({
        topic: 'linux.iam.group.modified',
        payload: { deviceId: this.deviceId, groupName: group.name, gid: group.gid, changedFields: ['members'] },
      });
      return '';
    }

    return '';
  }

  // ─── Query commands ───────────────────────────────────────────────

  id(username?: string): string {
    const name = username || this.currentUser;
    const user = this.users.get(name);
    if (!user) return `id: '${name}': no such user`;
    const groups = this.getUserGroups(name);
    const primaryGroup = this.getGroupByGid(user.gid);
    const groupsStr = groups.map(g => `${g.gid}(${g.name})`).join(',');
    return `uid=${user.uid}(${user.username}) gid=${user.gid}(${primaryGroup?.name || user.gid}) groups=${groupsStr}`;
  }

  /**
   * `id` with flag support: -u/-g/-G select which id(s), -n prints
   * names instead of numbers, -r selects the real (vs effective) id.
   * Returns an `id: ...` error string for invalid flag combinations.
   */
  idWithFlags(
    username: string | undefined,
    opts: { u?: boolean; g?: boolean; G?: boolean; n?: boolean; r?: boolean },
  ): string {
    const name = username || this.currentUser;
    const user = this.users.get(name);
    if (!user) return `id: '${name}': no such user`;

    const selectors = [opts.u, opts.g, opts.G].filter(Boolean).length;
    if (selectors === 0) {
      if (opts.n || opts.r) {
        return 'id: cannot print only names or real IDs in default format';
      }
      return this.id(name);
    }
    if (selectors > 1) {
      return 'id: cannot print "only" of more than one choice';
    }

    const groups = this.getUserGroups(name);
    const primary = this.getGroupByGid(user.gid);
    if (opts.u) return opts.n ? user.username : String(user.uid);
    if (opts.g) return opts.n ? (primary?.name ?? String(user.gid)) : String(user.gid);
    // -G : every group id (or name with -n)
    return groups.map(g => (opts.n ? g.name : String(g.gid))).join(' ');
  }

  whoami(): string {
    return this.currentUser;
  }

  groupsCmd(username?: string): string {
    const name = username || this.currentUser;
    const user = this.users.get(name);
    if (!user) return `groups: '${name}': no such user`;
    const groups = this.getUserGroups(name);
    const groupNames = groups.map(g => g.name).join(' ');
    return username ? `${name} : ${groupNames}` : groupNames;
  }

  getent(db: string, key: string): string {
    if (db === 'group') {
      const group = this.groups.get(key);
      if (!group) return '';
      return group.toGroupLine();
    }
    if (db === 'passwd') {
      const user = this.users.get(key);
      if (!user) return '';
      return user.toPasswdLine();
    }
    return '';
  }

  sudoList(username: string): string {
    const user = this.users.get(username);
    if (!user) return `User ${username} is not allowed to run sudo`;
    const groups = this.getUserGroups(username);
    const isSudo = groups.some(g => g.name === 'sudo');
    if (isSudo || username === 'root') {
      return `User ${username} may run the following commands on this host:\n    (ALL : ALL) ALL`;
    }
    // Check sudoers.d
    const sudoersDir = this.vfs.listDirectory('/etc/sudoers.d');
    if (sudoersDir) {
      for (const entry of sudoersDir) {
        if (entry.name === '.' || entry.name === '..') continue;
        const content = this.vfs.readFile(`/etc/sudoers.d/${entry.name}`);
        if (content && content.includes(username)) {
          return `User ${username} may run the following commands on this host:\n    ${content.trim()}`;
        }
      }
    }
    return `User ${username} is not allowed to run sudo`;
  }

  who(): string {
    return `${this.currentUser}  pts/0  ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`;
  }

  w(uptimeSeconds = 0): string {
    const now = new Date();
    const time = now.toTimeString().slice(0, 8);
    return [
      uptimeHeader(1, uptimeSeconds),
      `USER     TTY      FROM             LOGIN@   IDLE   JCPU   PCPU WHAT`,
      `${this.currentUser.padEnd(8)} pts/0    -                ${time}  0.00s  0.00s  0.00s -bash`,
    ].join('\n');
  }

  last(args: string[] = []): string {
    return this.renderUtmpLog('/var/log/wtmp.json', 'wtmp', args, true);
  }

  lastb(args: string[] = []): string {
    return this.renderUtmpLog('/var/log/btmp.json', 'btmp', args, false);
  }

  /**
   * Render `last` / `lastb` output from a JSON-encoded utmp log.
   *
   * The synthetic line for the currently-logged-in user (matching the previous
   * `last` behaviour) is preserved for wtmp only — the simulator boots with
   * an empty log otherwise. Real OpenSSH prepends a `reboot` row; we keep
   * that for parity.
   */
  private renderUtmpLog(
    path: string,
    label: 'wtmp' | 'btmp',
    args: string[],
    includeSyntheticHead: boolean,
  ): string {
    const userFilter = args.find((a) => !a.startsWith('-'));
    const numFlag = args.find((a) => /^-\d+$/.test(a) || a === '-n');
    const limit = numFlag
      ? numFlag === '-n'
        ? parseInt(args[args.indexOf(numFlag) + 1] ?? '0', 10)
        : Math.abs(parseInt(numFlag, 10))
      : 0;

    const raw = this.vfs.readFile(path);
    let entries: Array<{
      user: string;
      ip: string;
      at: number;
      type?: string;
      reason?: string;
      tty?: string;
    }> = [];
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as unknown;
        if (Array.isArray(parsed)) entries = parsed as typeof entries;
      } catch {
        entries = [];
      }
    }

    let rows = entries
      .slice()
      .reverse()
      .filter((e) => !userFilter || e.user === userFilter);
    if (limit > 0) rows = rows.slice(0, limit);

    const lines: string[] = [];
    const now = new Date();
    const headDate = formatLastDate(now);
    const headTime = now.toTimeString().slice(0, 5);

    if (includeSyntheticHead && !userFilter) {
      lines.push(
        `${this.currentUser.padEnd(8)} pts/0        -                ${headDate} ${headTime}   still logged in`,
      );
      lines.push(
        `reboot   system boot  5.4.0-generic    ${headDate} ${headTime}   still running`,
      );
    }

    for (const e of rows) {
      const d = new Date(e.at);
      const date = formatLastDate(d);
      const time = d.toTimeString().slice(0, 5);
      const user = e.user.padEnd(8);
      const tty = (e.tty ?? 'pts/0').padEnd(12);
      const from = (e.ip ?? '').padEnd(16);
      if (label === 'btmp') {
        lines.push(
          `${user} ${tty} ${from} ${date} ${time} - ${time} (00:00)`,
        );
      } else {
        lines.push(
          `${user} ${tty} ${from} ${date} ${time}   still logged in`,
        );
      }
    }

    lines.push('');
    lines.push(`${label} begins ${headDate}`);
    return lines.join('\n');
  }

  // ─── Filesystem sync ──────────────────────────────────────────────

  /**
   * Materialise the in-memory IAM state onto the filesystem — `/etc/passwd`,
   * `/etc/shadow`, `/etc/group`, `/etc/gshadow`, the subordinate-id maps and
   * the `-` backups. Delegated to {@link IamFilesystem} (Single
   * Responsibility): the manager reasons about identities, not file formats.
   */
  syncToFilesystem(): void {
    this.iamFs.writeAccountDatabase(
      [...this.users.values()],
      [...this.groups.values()],
    );
  }
}

function formatLastDate(d: Date): string {
  return d.toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  });
}
