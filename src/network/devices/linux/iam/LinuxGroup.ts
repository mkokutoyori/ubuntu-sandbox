/**
 * LinuxGroup — domain entity for a Unix group.
 *
 * `GroupEntry` is the structural contract (`/etc/group` + `/etc/gshadow`).
 * `LinuxGroup` implements it with the behaviour a real group carries:
 * membership management, administrator roster, and the system-vs-regular
 * and user-private-group classifications that `useradd` relies on.
 */

import { SYSTEM_UID_CEILING } from './LinuxUserAccount';

// ─── Structural contract ────────────────────────────────────────────────

export interface GroupEntry {
  name: string;
  gid: number;
  members: string[];
  admins: string[];
  password: string;
}

export interface LinuxGroupInit {
  name: string;
  gid: number;
  members?: string[];
  admins?: string[];
  password?: string;
  systemGroup?: boolean;
  /** True when this group was auto-created by `useradd` as a user-private group. */
  userPrivateGroup?: boolean;
  createdAt?: number;
}

/** GID below which a group is conventionally a system group. */
export const SYSTEM_GID_CEILING = SYSTEM_UID_CEILING;

// ─── Entity ─────────────────────────────────────────────────────────────

export class LinuxGroup implements GroupEntry {
  name: string;
  gid: number;
  members: string[];
  admins: string[];
  password: string;

  /** A daemon/service group rather than a user-facing one. */
  systemGroup: boolean;
  /** Auto-created 1:1 with a user by `useradd` (Debian "user private group"). */
  userPrivateGroup: boolean;
  readonly createdAt: number;

  constructor(init: LinuxGroupInit) {
    this.name = init.name;
    this.gid = init.gid;
    this.members = init.members ? [...init.members] : [];
    this.admins = init.admins ? [...init.admins] : [];
    this.password = init.password ?? '';
    this.systemGroup = init.systemGroup ?? init.gid < SYSTEM_GID_CEILING;
    this.userPrivateGroup = init.userPrivateGroup ?? false;
    this.createdAt = init.createdAt ?? Date.now();
  }

  /** Adapt a plain `GroupEntry` record into an entity. */
  static fromEntry(entry: GroupEntry): LinuxGroup {
    return new LinuxGroup({
      name: entry.name,
      gid: entry.gid,
      members: entry.members,
      admins: entry.admins,
      password: entry.password,
    });
  }

  // ─── Membership ──────────────────────────────────────────────────────

  hasMember(username: string): boolean {
    return this.members.includes(username);
  }

  /** Add a member; returns true when the roster actually changed. */
  addMember(username: string): boolean {
    if (this.members.includes(username)) return false;
    this.members.push(username);
    return true;
  }

  /** Remove a member; returns true when the roster actually changed. */
  removeMember(username: string): boolean {
    const next = this.members.filter((m) => m !== username);
    if (next.length === this.members.length) return false;
    this.members = next;
    return true;
  }

  isAdmin(username: string): boolean {
    return this.admins.includes(username);
  }

  setAdmins(admins: string[]): void {
    this.admins = [...admins];
  }

  setMembers(members: string[]): void {
    this.members = [...members];
  }

  isEmpty(): boolean {
    return this.members.length === 0;
  }

  // ─── Serialisation ───────────────────────────────────────────────────

  /** Render the `/etc/group` line. */
  toGroupLine(): string {
    return `${this.name}:x:${this.gid}:${this.members.join(',')}`;
  }

  /** Render the `/etc/gshadow` line. */
  toGshadowLine(): string {
    return `${this.name}:${this.password || '!'}:${this.admins.join(',')}:${this.members.join(',')}`;
  }

  toEntry(): GroupEntry {
    return {
      name: this.name,
      gid: this.gid,
      members: [...this.members],
      admins: [...this.admins],
      password: this.password,
    };
  }
}
