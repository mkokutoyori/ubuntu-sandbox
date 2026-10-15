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
import type {
  LinuxPamHost, PamCaller, PamFailedLogins, PamLastlogRecord, PamLoginEntry, PamRlimit, PamRlimitResource,
} from './PamLinuxHost';
import { UT, UTMPX_SIZE, Utmpx } from '../login/UtmpxRecord';
import { binaryStringToBytes } from '@/crypto/encoding';
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
  readonly lastlog: {
    read(user: string): PamLastlogRecord | null;
    write(user: string, record: PamLastlogRecord): void;
  };
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

const BTMP_PATH = '/var/log/btmp';

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

  private failedLoginsSince(user: string, sinceSeconds: number): PamFailedLogins | null {
    const bytes = binaryStringToBytes(this.deps.vfs.readFile(BTMP_PATH) ?? '');
    let count = 0;
    let last: PamLastlogRecord | null = null;
    for (let offset = 0; offset + UTMPX_SIZE <= bytes.length; offset += UTMPX_SIZE) {
      const entry = new Utmpx(bytes.subarray(offset, offset + UTMPX_SIZE));
      if (entry.type === UT.EMPTY || entry.seconds < sinceSeconds || entry.text('user') !== user) continue;
      count += 1;
      last = { time: entry.seconds, line: entry.text('line'), host: entry.text('host') };
    }
    return last === null ? null : { count, last };
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
      lastlog: {
        read: (user) => this.deps.lastlog.read(user),
        write: (user, record) => this.deps.lastlog.write(user, record),
        failedSince: (user, since) => this.failedLoginsSince(user, since),
      },
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
