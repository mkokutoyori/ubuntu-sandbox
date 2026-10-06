import type { PamHost } from './PamHandle';

export interface PamShadowRecord {
  readonly hash: string;
  readonly lastChange: number;
  readonly min: number;
  readonly max: number;
  readonly warn: number;
  readonly inactive: number;
  readonly expire: number;
}

export interface PamUserRecord {
  readonly name: string;
  readonly uid: number;
  readonly gid: number;
  readonly home: string;
  readonly shell: string;
  readonly gecos: string;
  readonly shadow: PamShadowRecord | null;
}

export interface PamGroupRecord {
  readonly name: string;
  readonly gid: number;
  readonly members: readonly string[];
}

export interface PamFileStat {
  readonly mode: number;
  readonly regular: boolean;
  readonly directory: boolean;
  readonly size: number;
  readonly accessTime: number;
  readonly modifyTime: number;
}

export interface PamAccountsPort {
  findUser(name: string): PamUserRecord | null;
  findUserByUid(uid: number): PamUserRecord | null;
  findGroup(name: string): PamGroupRecord | null;
  findGroupByGid(gid: number): PamGroupRecord | null;
  passwordMatches(name: string, password: string): boolean;
  setPassword(name: string, password: string): void;
  rememberedPasswordUsed(name: string, password: string, depth: number): boolean;
  rememberPassword(name: string, oldPassword: string, depth: number): void;
  groupNames(name: string): readonly string[];
}

export interface PamWritableFiles {
  writeFile(path: string, content: string): boolean;
  exists(path: string): boolean;
  stat(path: string): PamFileStat | null;
  mkdirp(path: string): void;
  listDirectory(path: string): readonly string[] | null;
  remove(path: string): void;
}

export interface PamCaller {
  readonly uid: number;
  readonly euid: number;
  readonly loginName: string;
}

export type PamRlimitResource =
  | 'cpu' | 'fsize' | 'data' | 'stack' | 'core' | 'rss' | 'nproc' | 'nofile' | 'memlock'
  | 'as' | 'locks' | 'sigpending' | 'msgqueue' | 'nice' | 'rtprio' | 'rttime';

export const PAM_RLIMIT_RESOURCES: readonly PamRlimitResource[] = [
  'cpu', 'fsize', 'data', 'stack', 'core', 'rss', 'nproc', 'nofile', 'memlock',
  'as', 'locks', 'sigpending', 'msgqueue', 'nice', 'rtprio', 'rttime',
];

export interface PamRlimit {
  soft: number;
  hard: number;
}

export interface PamKeyrings {
  userSessionKeyring(uid: number): number;
  joinAnonymousSession(uid: number, gid: number): number;
  linkUserKeyring(uid: number, session: number): boolean;
  revoke(id: number, asUid: number): boolean;
}

export const CAPABILITY_NAMES: readonly string[] = [
  'cap_chown', 'cap_dac_override', 'cap_dac_read_search', 'cap_fowner', 'cap_fsetid', 'cap_kill',
  'cap_setgid', 'cap_setuid', 'cap_setpcap', 'cap_linux_immutable', 'cap_net_bind_service',
  'cap_net_broadcast', 'cap_net_admin', 'cap_net_raw', 'cap_ipc_lock', 'cap_ipc_owner',
  'cap_sys_module', 'cap_sys_rawio', 'cap_sys_chroot', 'cap_sys_ptrace', 'cap_sys_pacct',
  'cap_sys_admin', 'cap_sys_boot', 'cap_sys_nice', 'cap_sys_resource', 'cap_sys_time',
  'cap_sys_tty_config', 'cap_mknod', 'cap_lease', 'cap_audit_write', 'cap_audit_control',
  'cap_setfcap', 'cap_mac_override', 'cap_mac_admin', 'cap_syslog', 'cap_wake_alarm',
  'cap_block_suspend', 'cap_audit_read', 'cap_perfmon', 'cap_bpf', 'cap_checkpoint_restore',
];

export interface PamCapabilityState {
  inheritable: Set<string>;
  ambient: Set<string>;
  bounding: Set<string>;
  keepCaps: boolean;
}

export interface PamProcessState {
  capabilities: PamCapabilityState;
  supplementaryGroups: number[];
  sessionKeyring: number | null;
  umask: number;
  priority: number;
  loginUid: number | null;
  readonly limits: Map<PamRlimitResource, PamRlimit>;
}

export interface PamLoginEntry {
  readonly user: string;
}

export interface PamLocalTime {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly weekday: number;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
  readonly abbreviation: string;
}

export interface LinuxPamHost extends PamHost {
  readonly process: PamProcessState;
  readonly logins: () => readonly PamLoginEntry[];
  readonly auditdRunning: () => boolean;
  readonly hostname: () => string;
  readonly localTime: (epochMs: number) => PamLocalTime;
  readonly resolveHost: (name: string) => readonly string[];
  readonly keyrings: PamKeyrings;
  readonly updateMotd: (() => string | null) | null;
  readonly accounts: PamAccountsPort;
  readonly files: PamWritableFiles;
  readonly caller: PamCaller;
}

export function daysSinceEpoch(host: PamHost): number {
  return Math.floor(host.now() / 86_400_000);
}
