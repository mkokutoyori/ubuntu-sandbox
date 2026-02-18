/**
 * User and group management for Linux simulation.
 * Manages /etc/passwd, /etc/shadow, /etc/group, /etc/gshadow state.
 */

import { VirtualFileSystem } from './VirtualFileSystem';

export interface UserEntry {
  username: string;
  uid: number;
  gid: number;
  gecos: string;
  home: string;
  shell: string;
  password: string;  // hashed (simulated)
  locked: boolean;
  lastChange: number;  // days since epoch
  minDays: number;
  maxDays: number;
  warnDays: number;
  inactiveDays: number;
  expireDate: number;
}

export interface GroupEntry {
  name: string;
  gid: number;
  members: string[];
  admins: string[];
  password: string;
}

export class LinuxUserManager {
  private users: Map<string, UserEntry> = new Map();
  private groups: Map<string, GroupEntry> = new Map();
  /** Plaintext password store for simulation (username → password) */
  private passwords: Map<string, string> = new Map();
  private nextUid = 1000;
  private nextGid = 1000;
  currentUser = 'root';
  currentUid = 0;
  currentGid = 0;

  constructor(private vfs: VirtualFileSystem) {
    this.initDefaults();
  }

  private initDefaults(): void {
    // System users
    this.addUser({ username: 'root', uid: 0, gid: 0, gecos: 'root', home: '/root', shell: '/bin/bash',
      password: 'x', locked: false, lastChange: this.daysSinceEpoch(), minDays: 0, maxDays: 99999, warnDays: 7, inactiveDays: -1, expireDate: -1 });
    this.passwords.set('root', 'admin');
    this.addUser({ username: 'daemon', uid: 1, gid: 1, gecos: 'daemon', home: '/usr/sbin', shell: '/usr/sbin/nologin',
      password: '*', locked: true, lastChange: this.daysSinceEpoch(), minDays: 0, maxDays: 99999, warnDays: 7, inactiveDays: -1, expireDate: -1 });
    this.addUser({ username: 'nobody', uid: 65534, gid: 65534, gecos: 'nobody', home: '/nonexistent', shell: '/usr/sbin/nologin',
      password: '*', locked: true, lastChange: this.daysSinceEpoch(), minDays: 0, maxDays: 99999, warnDays: 7, inactiveDays: -1, expireDate: -1 });

    // System groups
    this.addGroup({ name: 'root', gid: 0, members: [], admins: [], password: '' });
    this.addGroup({ name: 'daemon', gid: 1, members: [], admins: [], password: '' });
    this.addGroup({ name: 'adm', gid: 4, members: [], admins: [], password: '' });
    this.addGroup({ name: 'sudo', gid: 27, members: [], admins: [], password: '' });
    this.addGroup({ name: 'video', gid: 44, members: [], admins: [], password: '' });
    this.addGroup({ name: 'plugdev', gid: 46, members: [], admins: [], password: '' });
    this.addGroup({ name: 'users', gid: 100, members: [], admins: [], password: '' });
    this.addGroup({ name: 'nogroup', gid: 65534, members: [], admins: [], password: '' });

    this.syncToFilesystem();
  }

  private daysSinceEpoch(): number {
    return Math.floor(Date.now() / 86400000);
  }

  private addUser(u: UserEntry): void {
    this.users.set(u.username, u);
    if (u.uid >= this.nextUid && u.uid < 65534) this.nextUid = u.uid + 1;
  }

  private addGroup(g: GroupEntry): void {
    this.groups.set(g.name, g);
    if (g.gid >= this.nextGid && g.gid < 65534) this.nextGid = g.gid + 1;
  }

  // ─── Public API ─────────────────────────────────────────────────

  getUser(username: string): UserEntry | undefined {
    return this.users.get(username);
  }

  getGroup(name: string): GroupEntry | undefined {
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

  useradd(username: string, opts: { m?: boolean; s?: string; G?: string; d?: string; g?: string; c?: string }): string {
    if (this.users.has(username)) return `useradd: user '${username}' already exists`;

    const uid = this.nextUid++;
    let gid: number;

    if (opts.g) {
      const grp = this.groups.get(opts.g);
      if (!grp) return `useradd: group '${opts.g}' does not exist`;
      gid = grp.gid;
    } else {
      // Create a group with the same name
      gid = this.nextGid++;
      this.addGroup({ name: username, gid, members: [], admins: [], password: '' });
    }

    const home = opts.d || `/home/${username}`;
    const shell = opts.s || '/bin/sh';
    const gecos = opts.c || '';

    this.addUser({
      username, uid, gid, gecos, home, shell,
      password: '!', locked: false,
      lastChange: this.daysSinceEpoch(),
      minDays: 0, maxDays: 99999, warnDays: 7, inactiveDays: -1, expireDate: -1,
    });

    // Add to supplementary groups
    if (opts.G) {
      for (const gName of opts.G.split(',')) {
        const grp = this.groups.get(gName.trim());
        if (grp && !grp.members.includes(username)) {
          grp.members.push(username);
        }
      }
    }

    // Create home directory
    if (opts.m) {
      this.vfs.mkdirp(home, 0o755, uid, gid);
    }

    this.syncToFilesystem();
    return '';
  }

  usermod(username: string, opts: { s?: string; d?: string; m?: boolean; aG?: string; L?: boolean; U?: boolean; g?: string }): string {
    const user = this.users.get(username);
    if (!user) return `usermod: user '${username}' does not exist`;

    if (opts.s) user.shell = opts.s;
    if (opts.d) {
      user.home = opts.d;
      if (opts.m) {
        this.vfs.mkdirp(opts.d, 0o755, user.uid, user.gid);
      }
    }
    if (opts.L) user.locked = true;
    if (opts.U) user.locked = false;

    if (opts.aG) {
      for (const gName of opts.aG.split(',')) {
        const grp = this.groups.get(gName.trim());
        if (grp && !grp.members.includes(username)) {
          grp.members.push(username);
        }
      }
    }

    this.syncToFilesystem();
    return '';
  }

  userdel(username: string, removeHome: boolean): string {
    const user = this.users.get(username);
    if (!user) return `userdel: user '${username}' does not exist`;

    // Remove from all groups
    for (const g of this.groups.values()) {
      g.members = g.members.filter(m => m !== username);
      g.admins = g.admins.filter(a => a !== username);
    }

    // Remove user's personal group if it exists and is empty
    const personalGroup = this.groups.get(username);
    if (personalGroup && personalGroup.members.length === 0) {
      this.groups.delete(username);
    }

    if (removeHome) {
      this.vfs.rmrf(user.home);
    }

    this.users.delete(username);
    this.passwords.delete(username);
    this.syncToFilesystem();
    return '';
  }

  setPassword(username: string, password: string): string {
    const user = this.users.get(username);
    if (!user) return `passwd: user '${username}' does not exist`;
    user.password = `$6$simulated$${password}`;
    user.lastChange = this.daysSinceEpoch();
    this.passwords.set(username, password);
    this.syncToFilesystem();
    return '';
  }

  /** Set GECOS fields (Full Name, Room, Work Phone, Home Phone, Other) */
  setUserGecos(username: string, fullName: string, room: string, workPhone: string, homePhone: string, other: string): string {
    const user = this.users.get(username);
    if (!user) return `chfn: user '${username}' does not exist`;
    user.gecos = [fullName, room, workPhone, homePhone, other].join(',');
    this.syncToFilesystem();
    return '';
  }

  /** chfn — change finger information. Only updates the specified fields. */
  chfn(username: string, opts: { f?: string; r?: string; w?: string; h?: string }): string {
    const user = this.users.get(username);
    if (!user) return `chfn: user '${username}' does not exist`;

    // Parse existing GECOS subfields
    const parts = user.gecos.split(',');
    const fullName = parts[0] || '';
    const room = parts[1] || '';
    const workPhone = parts[2] || '';
    const homePhone = parts[3] || '';
    const other = parts[4] || '';

    // Update only what was specified
    const newFullName = opts.f !== undefined ? opts.f : fullName;
    const newRoom = opts.r !== undefined ? opts.r : room;
    const newWorkPhone = opts.w !== undefined ? opts.w : workPhone;
    const newHomePhone = opts.h !== undefined ? opts.h : homePhone;

    user.gecos = [newFullName, newRoom, newWorkPhone, newHomePhone, other].join(',');
    this.syncToFilesystem();
    return '';
  }

  /** finger — display user information */
  finger(username?: string): string {
    const name = username || this.currentUser;
    const user = this.users.get(name);
    if (!user) return `finger: ${name}: no such user.`;

    const parts = user.gecos.split(',');
    const fullName = parts[0] || '';
    const groups = this.getUserGroups(name);
    const primaryGroup = this.getGroupByGid(user.gid);

    const lines = [
      `Login: ${user.username}${' '.repeat(Math.max(1, 24 - user.username.length - 7))}Name: ${fullName}`,
      `Directory: ${user.home}${' '.repeat(Math.max(1, 24 - user.home.length - 11))}Shell: ${user.shell}`,
    ];
    if (parts[1]) lines.push(`Office: ${parts[1]}`);
    if (parts[2]) lines.push(`Office Phone: ${parts[2]}`);
    if (parts[3]) lines.push(`Home Phone: ${parts[3]}`);

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

    if (opts.M !== undefined) user.maxDays = opts.M;
    if (opts.m !== undefined) user.minDays = opts.m;
    if (opts.W !== undefined) user.warnDays = opts.W;
    if (opts.d !== undefined) user.lastChange = opts.d;

    this.syncToFilesystem();
    return '';
  }

  // ─── Group operations ─────────────────────────────────────────────

  groupadd(name: string, opts: { g?: number } = {}): string {
    if (this.groups.has(name)) return `groupadd: group '${name}' already exists`;
    const gid = opts.g ?? this.nextGid++;
    this.addGroup({ name, gid, members: [], admins: [], password: '' });
    this.syncToFilesystem();
    return '';
  }

  groupmod(name: string, opts: { g?: number; n?: string }): string {
    const group = this.groups.get(name);
    if (!group) return `groupmod: group '${name}' does not exist`;

    if (opts.g !== undefined) group.gid = opts.g;
    if (opts.n) {
      this.groups.delete(name);
      group.name = opts.n;
      this.groups.set(opts.n, group);
    }

    this.syncToFilesystem();
    return '';
  }

  groupdel(name: string): string {
    if (!this.groups.has(name)) return `groupdel: group '${name}' does not exist`;
    this.groups.delete(name);
    this.syncToFilesystem();
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
      group.members = group.members.filter(m => m !== args[1]);
      this.syncToFilesystem();
      return '';
    }

    if (args[0] === '-A' && args.length >= 3) {
      const group = this.groups.get(args[2]);
      if (!group) return `gpasswd: group '${args[2]}' does not exist`;
      group.admins = args[1].split(',').map(s => s.trim());
      this.syncToFilesystem();
      return '';
    }

    if (args[0] === '-M' && args.length >= 3) {
      const group = this.groups.get(args[2]);
      if (!group) return `gpasswd: group '${args[2]}' does not exist`;
      group.members = args[1].split(',').map(s => s.trim());
      this.syncToFilesystem();
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
      return `${group.name}:x:${group.gid}:${group.members.join(',')}`;
    }
    if (db === 'passwd') {
      const user = this.users.get(key);
      if (!user) return '';
      return `${user.username}:x:${user.uid}:${user.gid}:${user.gecos}:${user.home}:${user.shell}`;
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

  w(): string {
    const now = new Date();
    const time = now.toTimeString().slice(0, 8);
    return [
      ` ${time} up 1 day,  0:00,  1 user,  load average: 0.00, 0.00, 0.00`,
      `USER     TTY      FROM             LOGIN@   IDLE   JCPU   PCPU WHAT`,
      `${this.currentUser.padEnd(8)} pts/0    -                ${time}  0.00s  0.00s  0.00s -bash`,
    ].join('\n');
  }

  last(): string {
    const now = new Date();
    const dateStr = now.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
    const timeStr = now.toTimeString().slice(0, 5);
    return [
      `${this.currentUser.padEnd(8)} pts/0        -                ${dateStr} ${timeStr}   still logged in`,
      `reboot   system boot  5.4.0-generic    ${dateStr} ${timeStr}   still running`,
      '',
      'wtmp begins ' + dateStr,
    ].join('\n');
  }

  // ─── Filesystem sync ──────────────────────────────────────────────

  syncToFilesystem(): void {
    // Write /etc/passwd
    const passwdLines: string[] = [];
    for (const u of this.users.values()) {
      passwdLines.push(`${u.username}:x:${u.uid}:${u.gid}:${u.gecos}:${u.home}:${u.shell}`);
    }
    this.vfs.writeFile('/etc/passwd', passwdLines.join('\n') + '\n', 0, 0, 0o022);

    // Write /etc/shadow
    const shadowLines: string[] = [];
    for (const u of this.users.values()) {
      const pwd = u.locked ? `!${u.password}` : u.password;
      shadowLines.push(`${u.username}:${pwd}:${u.lastChange}:${u.minDays}:${u.maxDays}:${u.warnDays}:${u.inactiveDays === -1 ? '' : u.inactiveDays}:${u.expireDate === -1 ? '' : u.expireDate}:`);
    }
    this.vfs.writeFile('/etc/shadow', shadowLines.join('\n') + '\n', 0, 0, 0o022);

    // Write /etc/group
    const groupLines: string[] = [];
    for (const g of this.groups.values()) {
      groupLines.push(`${g.name}:x:${g.gid}:${g.members.join(',')}`);
    }
    this.vfs.writeFile('/etc/group', groupLines.join('\n') + '\n', 0, 0, 0o022);
  }
}
