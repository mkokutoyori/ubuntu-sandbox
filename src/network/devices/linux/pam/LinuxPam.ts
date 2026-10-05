import type { LinuxLogManager } from '../LinuxLogManager';
import type { LinuxUserManager } from '../LinuxUserManager';
import type { VirtualFileSystem } from '../VirtualFileSystem';
import { LinuxPamAccounts } from './LinuxPamAccounts';
import { LinuxPamFiles } from './LinuxPamFiles';
import { createLinuxPamModules } from './LinuxPamModules';
import { formatPamLogLine, type PamLogEntry } from './PamHandle';
import type { KeyringTable } from '../kernel/KeyringTable';
import { localTimeIn } from './PamLocalTime';
import { defaultCapabilities, defaultRlimits } from './PamRlimitDefaults';
import type { LinuxPamHost, PamCaller, PamLoginEntry, PamRlimit, PamRlimitResource } from './PamLinuxHost';
import { PamTransaction } from './PamTransaction';
import type { FaillockToolHost } from './FaillockTool';

export interface LinuxPamDeps {
  readonly vfs: VirtualFileSystem;
  readonly users: LinuxUserManager;
  readonly logs: LinuxLogManager;
  readonly clock: () => number;
  readonly logins: () => readonly PamLoginEntry[];
  readonly auditdRunning: () => boolean;
  readonly hostname: () => string;
  readonly timezone: () => string;
  readonly resolveHost: (name: string) => readonly string[];
  readonly keyrings: KeyringTable;
  readonly updateMotd?: () => string | null;
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

  constructor(private readonly deps: LinuxPamDeps) {
    this.files = new LinuxPamFiles(deps.vfs);
    this.accounts = new LinuxPamAccounts(deps.users, (path) => deps.vfs.readFile(path), this.files);
  }

  private supplementaryGroupsOf(uid: number): number[] {
    const entry = this.deps.users.getUserByUid(uid);
    return entry === undefined ? [] : this.deps.users.getUserGroups(entry.username).map((group) => group.gid);
  }

  faillockToolHost(): FaillockToolHost {
    return {
      readFile: (path) => this.deps.vfs.readFile(path),
      files: this.files,
      localTime: (epochMs) => localTimeIn(this.deps.timezone(), epochMs),
    };
  }

  begin(service: string, options: PamTransactionOptions): PamTransaction<LinuxPamHost> {
    const identity = options.identity ?? { tag: service };
    const pid = identity.pid ?? this.deps.logs.allocatePid();
    const host: LinuxPamHost = {
      readFile: (path) => this.deps.vfs.readFile(path),
      now: this.deps.clock,
      log: (entry: PamLogEntry) => this.deps.logs.logAuth(identity.tag, formatPamLogLine(entry), pid, identity.unit, entry.priority),
      accounts: this.accounts,
      files: this.files,
      caller: options.caller,
      logins: this.deps.logins,
      auditdRunning: this.deps.auditdRunning,
      hostname: this.deps.hostname,
      localTime: (epochMs) => localTimeIn(this.deps.timezone(), epochMs),
      resolveHost: this.deps.resolveHost,
      updateMotd: this.deps.updateMotd ?? null,
      keyrings: {
        userSessionKeyring: (uid) => this.deps.keyrings.userSessionKeyring(uid).id,
        joinAnonymousSession: (uid, gid) => this.deps.keyrings.joinAnonymousSession(uid, gid).id,
        linkUserKeyring: (uid, session) => this.deps.keyrings.link(this.deps.keyrings.userKeyring(uid).id, session),
        revoke: (id, asUid) => this.deps.keyrings.revoke(id, asUid),
      },
      process: {
        capabilities: defaultCapabilities(),
        supplementaryGroups: this.supplementaryGroupsOf(options.caller.uid),
        sessionKeyring: this.deps.keyrings.userSessionKeyring(options.caller.uid).id,
        umask: 0o022,
        priority: 0,
        loginUid: null,
        limits: defaultRlimits(this.deps.processLimits?.(options.caller.uid)),
      },
    };
    return new PamTransaction(service, host, createLinuxPamModules(), host);
  }
}
