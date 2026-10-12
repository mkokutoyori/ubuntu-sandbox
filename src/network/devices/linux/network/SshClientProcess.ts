export interface SshClientPlacement {
  readonly ppid: number;
  readonly tty: string;
  readonly user: string;
  readonly uid: number;
  readonly gid: number;
  readonly cwd: string;
}

export interface SshClientHandle {
  readonly pid: number;
  readonly retire: () => void;
}
