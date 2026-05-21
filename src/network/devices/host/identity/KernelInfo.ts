/**
 * KernelInfo — domain model of the running kernel.
 *
 * Mirrors the `uname(2)` / `utsname` record (minus the node name, which is
 * the host's separately-managed hostname): kernel name, release, build
 * version, hardware architecture and the GNU userland label. It is the
 * single source of truth behind `uname`, `/proc/version` and the
 * `/proc/sys/kernel/*` entries.
 */

export interface KernelInfoInit {
  sysname?: string;
  release?: string;
  version?: string;
  machine?: string;
  operatingSystem?: string;
  buildHost?: string;
  compiler?: string;
}

export class KernelInfo {
  /** Kernel name (`uname -s`), e.g. `Linux`. */
  sysname: string;
  /** Kernel release (`uname -r`), e.g. `5.15.0-130-generic`. */
  release: string;
  /** Kernel build version string (`uname -v`). */
  version: string;
  /** Hardware architecture (`uname -m`), e.g. `x86_64`. */
  machine: string;
  /** GNU operating-system label (`uname -o`), e.g. `GNU/Linux`. */
  operatingSystem: string;
  /** Build host shown in `/proc/version`. */
  buildHost: string;
  /** Compiler banner shown in `/proc/version`. */
  compiler: string;

  constructor(init: KernelInfoInit = {}) {
    this.sysname = init.sysname ?? 'Linux';
    this.release = init.release ?? '5.15.0-130-generic';
    this.version = init.version ?? '#140-Ubuntu SMP Wed Apr 16 12:00:00 UTC 2025';
    this.machine = init.machine ?? 'x86_64';
    this.operatingSystem = init.operatingSystem ?? 'GNU/Linux';
    this.buildHost = init.buildHost ?? 'buildd@lcy02-amd64-001';
    this.compiler =
      init.compiler ??
      '(gcc (Ubuntu 11.4.0-1ubuntu1~22.04) 11.4.0, GNU ld (GNU Binutils for Ubuntu) 2.38)';
  }

  static ubuntu(): KernelInfo {
    return new KernelInfo();
  }

  /** Render `/proc/version`. */
  toProcVersion(): string {
    return `${this.sysname} version ${this.release} (${this.buildHost}) ` +
      `${this.compiler} ${this.version}\n`;
  }
}
