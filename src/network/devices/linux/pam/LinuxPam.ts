import type { LinuxLogManager } from '../LinuxLogManager';
import type { LinuxUserManager } from '../LinuxUserManager';
import type { VirtualFileSystem } from '../VirtualFileSystem';
import { LinuxPamAccounts } from './LinuxPamAccounts';
import { LinuxPamFiles } from './LinuxPamFiles';
import { createLinuxPamModules } from './LinuxPamModules';
import { formatPamLogLine, type PamLogEntry } from './PamHandle';
import { defaultRlimits } from './PamRlimitDefaults';
import type { LinuxPamHost, PamCaller, PamLoginEntry, PamRlimit, PamRlimitResource } from './PamLinuxHost';
import { PamTransaction } from './PamTransaction';

export interface LinuxPamDeps {
  readonly vfs: VirtualFileSystem;
  readonly users: LinuxUserManager;
  readonly logs: LinuxLogManager;
  readonly clock: () => number;
  readonly logins: () => readonly PamLoginEntry[];
  readonly auditdRunning: () => boolean;
  readonly processLimits?: (uid: number) => ReadonlyMap<PamRlimitResource, PamRlimit>;
}

export interface PamSyslogIdentity {
  readonly tag: string;
  readonly pid?: number;
  readonly unit?: string;
}

export interface PamTransactionOptions {
  readonly caller: PamCaller;
  readonly identity?: PamSyslogIdentity;
}

export class LinuxPam {
  private readonly files: LinuxPamFiles;
  private readonly accounts: LinuxPamAccounts;
  private nextPid = 3000;

  constructor(private readonly deps: LinuxPamDeps) {
    this.files = new LinuxPamFiles(deps.vfs);
    this.accounts = new LinuxPamAccounts(deps.users, (path) => deps.vfs.readFile(path), this.files);
  }

  begin(service: string, options: PamTransactionOptions): PamTransaction<LinuxPamHost> {
    const identity = options.identity ?? { tag: service };
    const pid = identity.pid ?? this.nextPid++;
    const host: LinuxPamHost = {
      readFile: (path) => this.deps.vfs.readFile(path),
      now: this.deps.clock,
      log: (entry: PamLogEntry) => this.deps.logs.logAuth(identity.tag, formatPamLogLine(entry), pid, identity.unit, entry.priority),
      accounts: this.accounts,
      files: this.files,
      caller: options.caller,
      logins: this.deps.logins,
      auditdRunning: this.deps.auditdRunning,
      process: {
        umask: 0o022,
        priority: 0,
        loginUid: null,
        limits: defaultRlimits(this.deps.processLimits?.(options.caller.uid)),
      },
    };
    return new PamTransaction(service, host, createLinuxPamModules(), host);
  }
}
