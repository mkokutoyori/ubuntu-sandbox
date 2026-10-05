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

export interface PamProcessState {
  umask: number;
  priority: number;
  loginUid: number | null;
  readonly limits: Map<PamRlimitResource, PamRlimit>;
}

export interface PamLoginEntry {
  readonly user: string;
}

export interface LinuxPamHost extends PamHost {
  readonly process: PamProcessState;
  readonly logins: () => readonly PamLoginEntry[];
  readonly auditdRunning: () => boolean;
  readonly accounts: PamAccountsPort;
  readonly files: PamWritableFiles;
  readonly caller: PamCaller;
}

export function daysSinceEpoch(host: PamHost): number {
  return Math.floor(host.now() / 86_400_000);
}
