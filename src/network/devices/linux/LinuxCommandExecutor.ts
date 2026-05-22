/**
 * Linux command executor - orchestrates parsing and dispatching to command modules.
 */

import { VirtualFileSystem } from './VirtualFileSystem';
import { LinuxUserManager } from './LinuxUserManager';
import { SshAgent } from '../../protocols/ssh/SshAgent';
import { LinuxCronManager } from './LinuxCronManager';
import { LinuxIptablesManager } from './LinuxIptablesManager';
import { LinuxFirewallManager } from './LinuxFirewallManager';
import { LinuxLogManager } from './LinuxLogManager';
import { type ShellContext, cmdTouch, cmdLs, cmdCat, cmdEcho, cmdCp, cmdMv, cmdRm, cmdMkdir, cmdRmdir, cmdLn, cmdPwd, cmdTee, expandGlob } from './LinuxFileCommands';
import { cmdGrep, cmdHead, cmdTail, cmdWc, cmdSort, cmdCut, cmdUniq, cmdTr, cmdAwk } from './LinuxTextCommands';
import { cmdFind, cmdLocate, cmdWhich, cmdWhereis, cmdCommand, cmdUpdatedb } from './LinuxSearchCommands';
import { cmdChmod, cmdChown, cmdChgrp, cmdStat, cmdUmask, cmdTest, cmdMkfifo } from './LinuxPermCommands';
import { cmdUseradd, cmdUsermod, cmdUserdel, cmdPasswd, cmdChpasswd, cmdChage, cmdFaillock, cmdGroupadd, cmdGroupmod, cmdGroupdel, cmdGpasswd, cmdId, cmdWhoami, cmdGroups, cmdWho, cmdW, cmdLast, cmdLastb, cmdSudoCheck } from './LinuxUserCommands';
import { parseUseraddArgs } from './iam/useraddOptions';
import { parseAdduserArgs, type AdduserRequest } from './iam/adduserOptions';
import { IamAuthLogProjection } from './iam/fs/IamAuthLogProjection';
import { IamPolicyFilesProjection } from './iam/fs/IamPolicyFilesProjection';
import { HardwareProfile } from '../host/hardware';
import { HostLifecycle } from '../host/lifecycle';
import { SystemIdentity } from '../host/identity';
import { runScript, runScriptContent } from '@/bash/runtime/ScriptRunner';
import { AliasTable } from '@/bash/runtime/AliasTable';
import { type IpNetworkContext } from './LinuxIpCommand';
import { cmdDf, cmdDu, cmdFree, cmdMount, cmdLsblk } from './LinuxSystemCommands';
import { cmdIfconfig, cmdNetstat, cmdSs, cmdCurl, cmdWget, cmdArping, cmdTcpdump } from './LinuxNetCommands';
import { PacketCaptureLog } from './network/PacketCaptureLog';
import type { SocketTable } from '../../core/SocketTable';
import { IanaServiceRegistry } from '../../core/ports/IanaServiceRegistry';
import { LinuxAuditLog } from './audit/LinuxAuditLog';
import { AuditTrailProjection } from './audit/AuditTrailProjection';
import { cmdAusearch, cmdAureport, cmdAuditctl } from './audit/AuditCommands';
import { PortsFilesystem } from './ports/PortsFilesystem';
import { ServicePortProjection } from './ports/ServicePortProjection';
import { LinuxServiceJournalProjection } from './LinuxServiceJournalProjection';
import { LinuxAtQueue, cmdAt, cmdAtq, cmdAtrm } from './jobs/LinuxAtQueue';
import { PortActivityLogProjection } from './ports/PortActivityLogProjection';
import { LinuxProcessManager, type Signal, SIGNAL_NUMBERS } from './LinuxProcessManager';
import { LinuxServiceManager } from './LinuxServiceManager';
import { cmdPs, cmdTop, cmdKill, cmdPidof, cmdPgrep, cmdPkill, cmdKillall, cmdSystemctl, cmdService } from './LinuxProcessCommands';
import { LinuxJobTable } from './jobs/LinuxJobTable';
import { cmdJobs, cmdFg, cmdBg, cmdDisown, cmdWait, cmdPstree } from './jobs/JobCommands';
import { runSshClient } from './network/LinuxSshClient';
import { findHostByAddress } from './network/HostLookup';
import { SshKnownHostEntry } from './network/SshKnownHostEntry';
import { SshForwardingTable } from './network/SshForwardingTable';
import type { SshSessionTable } from './network/SshSessionTable';
import { cmdDate, cmdUptime, cmdUname, cmdTty, cmdRunlevel } from './system/SystemInfo';
import type { IEventBus } from '@/events/EventBus';
import { LinuxServiceSupervisor } from './supervisor/LinuxServiceSupervisor';
import { cmdNice, cmdRenice, cmdChrt, cmdIonice, cmdTaskset } from './process/PriorityCommands';
import type { LinuxShellSession } from './shell/LinuxShellSession';
import { LinuxLastlogRegistry } from './LinuxLastlogRegistry';
import { NameServiceSwitch } from './nss/NameServiceSwitch';
import { FilesNssSource } from './nss/FilesNssSource';
import { DnsNssSource } from './nss/DnsNssSource';
import { ETC_NETWORKS, ETC_PROTOCOLS, ETC_RPC, ETC_SERVICES } from './nss/SystemFiles';
import { runGetent } from './nss/GetentCommand';

/** Commands that commonly read from stdin when piped. */
const STDIN_COMMANDS = new Set([
  'sort', 'wc', 'grep', 'head', 'tail', 'tr', 'cut', 'uniq', 'tee',
  'awk', 'sed', 'cat', 'xargs', 'less', 'more',
]);

/**
 * Every command name the Linux executor knows how to run. Backs shell
 * completion and `command -v` / `which` / `type` resolution — the
 * simulator's stand-in for walking `$PATH`.
 */
const KNOWN_LINUX_COMMANDS: readonly string[] = [
  // File/dir basics
  'ls', 'cd', 'cat', 'cp', 'mv', 'rm', 'mkdir', 'rmdir', 'touch', 'chmod',
  'chown', 'chgrp', 'ln', 'find', 'grep', 'egrep', 'fgrep', 'head', 'tail',
  'wc', 'sort', 'cut', 'uniq', 'tr', 'awk', 'sed', 'stat', 'test', 'mkfifo',
  'tee', 'basename', 'dirname', 'readlink', 'realpath', 'file', 'xargs',
  'less', 'more', 'diff', 'cmp', 'patch',
  // Shell builtins and basics
  'echo', 'printf', 'pwd', 'bash', 'sh', 'export', 'unset', 'source',
  'alias', 'unalias', 'set', 'shift', 'declare', 'readonly', 'local',
  'read', 'type', 'eval', 'exec', 'trap', 'return', 'break', 'continue',
  'let', 'history', 'jobs', 'bg', 'fg', 'wait', 'disown',
  // Users and groups
  'id', 'whoami', 'groups', 'who', 'w', 'last', 'lastb', 'hostname', 'uname', 'sleep', 'kill',
  'useradd', 'adduser', 'userdel', 'deluser', 'usermod', 'passwd', 'chpasswd', 'chage',
  'faillock', 'ausearch', 'aureport', 'auditctl',
  'groupadd', 'addgroup', 'groupmod', 'groupdel', 'gpasswd', 'getent', 'sudo', 'su',
  'login', 'logout',
  // Lookup
  'which', 'whereis', 'command', 'locate', 'updatedb', 'apropos', 'man', 'info',
  // System / processes / time
  'crontab', 'at', 'atq', 'atrm', 'clear', 'reset', 'date', 'uptime', 'umask', 'true', 'false',
  'runlevel', 'hostnamectl', 'timedatectl',
  'exit', 'help', 'ps', 'top', 'htop', 'free', 'df', 'du', 'mount', 'umount',
  'pkill', 'pgrep', 'pidof', 'killall',
  'systemctl', 'service', 'journalctl', 'dmesg', 'lsof', 'fuser', 'nice',
  'renice', 'timeout', 'watch', 'env', 'printenv', 'lscpu', 'nproc',
  // Networking
  'ifconfig', 'ip', 'ping', 'ping6', 'traceroute', 'tracepath', 'netstat',
  'ss', 'route', 'arp', 'arping', 'dhclient', 'nslookup', 'dig', 'host', 'curl', 'wget',
  'ssh', 'scp', 'sftp', 'rsync', 'telnet', 'nc', 'ncat', 'tcpdump',
  'iptables', 'iptables-save', 'iptables-restore', 'nft', 'ufw', 'firewall-cmd',
  // Editors
  'nano', 'vi', 'vim', 'emacs', 'ed',
  // Archives / packages
  'tar', 'gzip', 'gunzip', 'zip', 'unzip', 'bzip2', 'bunzip2', 'xz', 'unxz',
  'apt', 'apt-get', 'apt-cache', 'dpkg', 'snap',
];

/** Fast membership test for {@link KNOWN_LINUX_COMMANDS}. */
const KNOWN_LINUX_COMMAND_SET: ReadonlySet<string> = new Set(KNOWN_LINUX_COMMANDS);

export class LinuxCommandExecutor {
  readonly vfs: VirtualFileSystem;
  readonly userMgr: LinuxUserManager;
  /**
   * In-memory ssh-agent — one per device, lazily populated by `ssh-add`
   * and surfaced to outgoing SSH connections that honour `ssh -A`.
   */
  readonly sshAgent: SshAgent = new SshAgent();
  /**
   * Last-login registry — populated by the SSH server on successful auth
   * (and by the console-login flow in the future). Read by ssh client code
   * when composing the post-login banner.
   */
  readonly lastlog: LinuxLastlogRegistry = new LinuxLastlogRegistry();
  /**
   * Name Service Switch — the resolver consulted by `getent`, `id`,
   * `gethostbyname`-equivalent code paths. Owns the per-database
   * source chain declared in `/etc/nsswitch.conf`; subscribes to IAM
   * + topology events so future cache layers can invalidate without
   * polling. Created lazily so VFS / userMgr exist before sources are
   * wired (see `constructor`).
   */
  readonly nss: NameServiceSwitch;
  /**
   * Direct handle on the `files` source — kept so `getent -s files`
   * can bypass the full resolver chain when the operator forces a
   * source override.
   */
  private readonly filesNss: FilesNssSource;
  readonly cron: LinuxCronManager;
  readonly iptables: LinuxIptablesManager;
  readonly firewall: LinuxFirewallManager;
  readonly logMgr: LinuxLogManager;
  /** Kernel audit subsystem — the security audit trail (`/var/log/audit`). */
  readonly auditLog: LinuxAuditLog;
  /** Reactive bridge feeding security events into the audit trail. */
  private auditTrail: AuditTrailProjection | null = null;
  /** Reactive bridge writing systemd unit lifecycle lines to the journal. */
  private serviceJournal: LinuxServiceJournalProjection | null = null;
  /** `at` deferred-job spool, drained by the `atd` daemon. */
  private readonly atQueue: LinuxAtQueue = new LinuxAtQueue();
  readonly processMgr: LinuxProcessManager;
  readonly serviceMgr: LinuxServiceManager;
  private ipNetworkCtx: IpNetworkContext | null = null;
  private socketTable: SocketTable | null = null;
  /** Active SSH port-forwards (`-L`/`-R`/`-D`) owned by this machine. */
  private forwarding: SshForwardingTable | null = null;
  /** Captured TCP traffic — rendered by `tcpdump`. */
  readonly captureLog = new PacketCaptureLog();
  /** Shared SSH session table — backs `who` / `w` / `last`. */
  private sessionTable: SshSessionTable | null = null;
  /** IANA port⇄name registry — backs `/etc/services` and `getent services`. */
  private readonly ianaServices: IanaServiceRegistry = IanaServiceRegistry.standard();
  /** Reactive socket-table coherence for service-owned listening ports. */
  private servicePortProjection: ServicePortProjection | null = null;
  /** Records port bind / release activity into the system log, reactively. */
  private portActivityLog: PortActivityLogProjection | null = null;
  private cwd = '/root';
  private umask = 0o022;
  private isServer: boolean;
  /**
   * Shared hardware inventory — source of truth for lscpu / free / /proc.
   * Replaced coherently via {@link setHardware} (never reassigned directly,
   * so the procfs cannot drift from the model).
   */
  hardware: HardwareProfile;
  /** Shared power/boot state machine — source of truth for uptime. */
  readonly lifecycle: HostLifecycle;
  /** Shared system identity — source of truth for uname / hostnamectl / etc. */
  readonly identity: SystemIdentity;
  private env: Map<string, string> = new Map();
  /**
   * Shell environment of the command currently being dispatched — exported
   * variables plus per-command `VAR=val` prefix assignments. Consulted by
   * env-aware commands (`ssh` SendEnv forwarding, `locale`).
   */
  private _cmdEnv?: Record<string, string>;
  /** Registered system processes (pid → {user, command}) for ps command */
  private _systemProcesses: Map<number, { user: string; command: string; startTime: string }> = new Map();
  /** caller-supplied PID → OS-managed PID, so unregisterProcess can find the spawn back. */
  private _externalToOsPid: Map<number, number> = new Map();
  // Stack for su sessions: stores previous user context
  private suStack: Array<{ user: string; uid: number; gid: number; cwd: string; umask: number }> = [];
  // Command history (like bash HISTFILE)
  private commandHistory: string[] = [];
  /** Reactive service supervisor (auto-restart per Restart= policy). */
  private supervisor: LinuxServiceSupervisor | null = null;
  /** Reactive projection: IAM domain events → /var/log/auth.log. */
  private iamAuthLog: IamAuthLogProjection | null = null;
  private iamPolicyFiles: IamPolicyFilesProjection | null = null;
  /** Unsubscribe handle for the identity-file re-seed subscription. */
  private identityFilesUnsub: (() => void) | null = null;
  /** Unsubscribe handle for the remote-device power-off subscription. */
  private powerOffUnsub: (() => void) | null = null;
  /** PID of the interactive -bash; backs `$$` and `ps -p $$`. */
  private shellPid = 0;
  /** Parent PID of the interactive shell; backs `$PPID`. */
  private shellPpid = 0;
  /** Per-shell job control table; populated by `cmd &`. */
  private jobTable = new LinuxJobTable();
  /** Per-shell command aliases — `alias` / `unalias`, shared with the interpreter. */
  readonly aliases = new AliasTable();

  /** Optional Oracle bootstrap hook — called by sqlplus on first run. */
  _oracleBootstrap: ((args: string[], stdin?: string) => string | null) | null = null;
  /** Optional Oracle listener hook — backs `lsnrctl`. */
  _oracleListener: ((args: string[]) => string) | null = null;

  constructor(
    isServer = false,
    hardware?: HardwareProfile,
    lifecycle?: HostLifecycle,
    identity?: SystemIdentity,
  ) {
    this.hardware = hardware ?? HardwareProfile.defaultFor(isServer ? 'server' : 'workstation');
    this.lifecycle = lifecycle ?? new HostLifecycle();
    this.identity = identity ?? SystemIdentity.ubuntu();
    this.vfs = new VirtualFileSystem();
    this.userMgr = new LinuxUserManager(this.vfs);
    this.cron = new LinuxCronManager();
    this.iptables = new LinuxIptablesManager(this.vfs);
    this.firewall = new LinuxFirewallManager(this.vfs, this.iptables);
    this.logMgr = new LinuxLogManager(this.vfs);
    this.auditLog = new LinuxAuditLog(this.vfs);
    this.processMgr = new LinuxProcessManager();
    this.serviceMgr = new LinuxServiceManager(this.vfs, this.processMgr, { isServer });
    this.isServer = isServer;

    // ── NSS provisioning ────────────────────────────────────────────
    // Seed the canonical NSS-backed system files (a fresh Ubuntu
    // install ships these). Each is created only when missing so an
    // operator's runtime edits survive a reboot.
    if (this.vfs.readFile('/etc/services')  == null) this.vfs.writeFile('/etc/services',  ETC_SERVICES,  0, 0, 0o022);
    if (this.vfs.readFile('/etc/protocols') == null) this.vfs.writeFile('/etc/protocols', ETC_PROTOCOLS, 0, 0, 0o022);
    if (this.vfs.readFile('/etc/networks')  == null) this.vfs.writeFile('/etc/networks',  ETC_NETWORKS,  0, 0, 0o022);
    if (this.vfs.readFile('/etc/rpc')       == null) this.vfs.writeFile('/etc/rpc',       ETC_RPC,       0, 0, 0o022);

    // ── NSS resolver ────────────────────────────────────────────────
    this.filesNss = new FilesNssSource(this.vfs, this.userMgr);
    this.nss = new NameServiceSwitch(
      this.vfs,
      new Map([
        ['files', this.filesNss],
        ['dns',   new DnsNssSource()],
      ]),
    );
    this.nss.seedConfigIfMissing();

    // Default environment
    this.env.set('PATH', '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/usr/games:/usr/local/games');

    if (!isServer) {
      // Regular PC: default user is 'user' (non-root)
      const uid = 1000;
      const gid = 1000;
      this.userMgr.useradd('user', { m: true, s: '/bin/bash' });
      // Add default groups for regular user (like Ubuntu)
      this.userMgr.usermod('user', { aG: 'sudo,adm' });
      // Set default password 'admin'
      this.userMgr.setPassword('user', 'admin');
      // Create skeleton files
      this.createSkeletonFiles('/home/user', uid, gid);
      this.userMgr.currentUser = 'user';
      this.userMgr.currentUid = uid;
      this.userMgr.currentGid = gid;
      this.cwd = '/home/user';
    }

    // Every interactive shell shows up in the process table as -bash, like a
    // real login shell. Server profiles run as root.
    const shellUser = !isServer ? 'user' : 'root';
    const shellUid = !isServer ? 1000 : 0;
    // A login shell is a child of sshd when one is running, else of init.
    const sshd = this.processMgr.list({ comm: 'sshd' })[0];
    const shellPpid = sshd?.pid ?? 1;
    const shell = this.processMgr.spawn({
      command: '-bash',
      comm: '-bash',
      user: shellUser,
      uid: shellUid,
      gid: shellUid,
      ppid: shellPpid,
      tty: 'pts/0',
      cwd: this.cwd,
    });
    this.shellPid = shell.pid;
    this.shellPpid = shell.ppid;

    // Expose the hardware inventory and boot clock as procfs pseudo-files.
    this.registerHardwareProcFiles();
    // Materialise the system identity onto /etc and /proc.
    this.seedIdentityFiles();
    this.registerKernelProcFiles();
  }

  /**
   * Write the system-identity files to `/etc` from the live model:
   * `/etc/os-release`, `/etc/lsb-release`, `/etc/machine-id`,
   * `/etc/timezone`, `/etc/default/locale`. Re-run whenever the identity
   * changes so the on-disk view never drifts from `hostnamectl` /
   * `timedatectl` / `uname`.
   */
  private seedIdentityFiles(): void {
    const id = this.identity;
    this.vfs.writeFile('/etc/os-release', id.os.render(), 0, 0, 0o022);
    this.vfs.writeFile('/etc/lsb-release', id.os.renderLsbRelease(), 0, 0, 0o022);
    this.vfs.writeFile('/etc/machine-id', `${id.machineId}\n`, 0, 0, 0o022);
    this.vfs.writeFile('/etc/timezone', `${id.timezone}\n`, 0, 0, 0o022);
    this.vfs.writeFile('/etc/default/locale', id.toLocaleConf(), 0, 0, 0o022);
  }

  /**
   * Register the kernel `/proc` entries as generated pseudo-files, so
   * `/proc/version` and `/proc/sys/kernel/*` track the identity model live.
   */
  private registerKernelProcFiles(): void {
    this.vfs.mkdirp('/proc/sys/kernel', 0o755, 0, 0);
    const k = () => this.identity.kernel;
    this.vfs.registerGeneratedFile('/proc/version', () => k().toProcVersion());
    this.vfs.registerGeneratedFile('/proc/sys/kernel/ostype', () => `${k().sysname}\n`);
    this.vfs.registerGeneratedFile('/proc/sys/kernel/osrelease', () => `${k().release}\n`);
    this.vfs.registerGeneratedFile('/proc/sys/kernel/version', () => `${k().version}\n`);
  }

  /**
   * Register `/proc/cpuinfo`, `/proc/meminfo` and `/proc/uptime` as generated
   * pseudo-files. Each is produced on read from the live model, so the procfs
   * can never drift from `lscpu` / `free` / `uptime` — it stays coherent
   * whether the hardware is swapped via {@link setHardware} or its fields are
   * mutated in place, exactly like a real kernel procfs.
   */
  private registerHardwareProcFiles(): void {
    this.vfs.registerGeneratedFile('/proc/cpuinfo', () => this.hardware.cpu.toProcCpuinfo());
    this.vfs.registerGeneratedFile('/proc/meminfo', () => this.hardware.memory.toProcMeminfo());
    this.vfs.registerGeneratedFile('/proc/uptime', () => {
      const up = this.lifecycle.uptimeSeconds();
      return `${up}.00 ${up}.00\n`;
    });
  }

  /**
   * Re-spec the host's hardware. Swapping the reference is enough: the procfs
   * pseudo-files generate from `this.hardware` on every read, so `lscpu`,
   * `free`, `nproc` and `/proc/*` all stay coherent. Called by
   * `LinuxMachine.setHardware`.
   */
  setHardware(profile: HardwareProfile): void {
    this.hardware = profile;
  }

  /**
   * Attach the owning device's event bus so the process table and
   * service layer publish deviceId-scoped domain events.
   */
  attachEventBus(bus: IEventBus, deviceId: string): void {
    this.processMgr.attachBus(bus, deviceId);
    this.serviceMgr.attachBus(bus, deviceId);
    this.userMgr.attachBus(bus, deviceId);
    this.supervisor?.dispose();
    this.supervisor = new LinuxServiceSupervisor(bus, this.serviceMgr, deviceId);
    // The syslog daemon's lifecycle drives /var/log/* file coherence.
    this.logMgr.attachBus(bus);
    // Record systemd "Started/Stopped <unit>" lines in the journal.
    this.serviceJournal?.dispose();
    this.serviceJournal = new LinuxServiceJournalProjection(bus, this.logMgr, deviceId);
    // Keep /var/log/auth.log coherent with account changes, reactively.
    this.iamAuthLog?.dispose();
    this.iamAuthLog = new IamAuthLogProjection(bus, this.logMgr, deviceId);
    // Feed security events into the kernel audit trail, reactively.
    this.auditTrail?.dispose();
    this.auditTrail = new AuditTrailProjection(bus, this.auditLog, deviceId);
    // Keep the PAM password-policy config files coherent with the policy
    // model, reactively (pwquality.conf / login.defs / faillock.conf).
    this.iamPolicyFiles?.dispose();
    this.iamPolicyFiles = new IamPolicyFilesProjection(bus, this.userMgr, deviceId);
    // Keep the socket table coherent with the service layer: a service's
    // listening ports are bound on start and released on stop.
    this.servicePortProjection?.dispose();
    this.portActivityLog?.dispose();
    if (this.socketTable) {
      // Log port activity *before* the port projection runs its initial
      // reconcile, so boot-time binds are recorded too.
      this.portActivityLog = new PortActivityLogProjection(bus, this.logMgr, deviceId);
      this.servicePortProjection = new ServicePortProjection(
        bus, deviceId, this.socketTable, this.serviceMgr,
      );
    }
    // Keep the /etc identity files coherent when the identity model changes.
    this.identityFilesUnsub?.();
    this.identityFilesUnsub = bus.subscribe(
      'host.identity.changed',
      () => this.seedIdentityFiles(),
    );
    // A background `ssh host …` job dies when its remote host powers off:
    // react to the power-off event and reap the matching jobs.
    this.powerOffUnsub?.();
    this.powerOffUnsub = bus.subscribe(
      'device.power-off',
      (e: { payload: { id: string } }) => this.reapSshJobsForDevice(e.payload.id),
    );
    // Rebuild NSS with bus-aware invalidation. Re-use the same files
    // source so the privileged-uid check still points at this executor.
    this.nss.dispose();
    (this as { nss: NameServiceSwitch }).nss = new NameServiceSwitch(
      this.vfs,
      new Map([
        ['files', this.filesNss],
        ['dns',   new DnsNssSource()],
      ]),
      bus,
      deviceId,
    );
    this.nss.seedConfigIfMissing();
  }

  /** Set the network context for ip command support */
  setIpNetworkContext(ctx: IpNetworkContext): void {
    this.ipNetworkCtx = ctx;
  }

  /**
   * scp / sftp / rsync share the SSH transport: same lookup + sshd gating
   * as runSshClient, but with command-specific output for the success case.
   * Mirrors real OpenSSH where these tools fail with the same
   * "Connection refused" / "Could not resolve hostname" as the parent.
   */
  private runSshTransport(cmd: 'scp' | 'sftp' | 'rsync', args: string[]): { output: string; exitCode: number } {
    // Extract the destination spec: user@host[:path] (positional argv).
    const positional = args.filter(a => !a.startsWith('-'));
    const dest = positional.find(p => /[@:]/.test(p)) ?? positional[0];
    if (!dest) {
      const usage = cmd === 'sftp'
        ? 'usage: sftp [-options] [user@]host[:path]'
        : cmd === 'scp'
          ? 'usage: scp [-options] source ... target'
          : 'rsync: no destination specified';
      return { output: usage, exitCode: 1 };
    }
    const hostPart = dest.replace(/^([\w.-]+@)?/, '').split(':')[0];
    // scp / sftp select an alternate port with -P (rsync uses -e); translate
    // it into the ssh client's own -p so the probe targets the right port.
    const pIdx = args.indexOf('-P');
    const probeArgs = pIdx >= 0 && args[pIdx + 1]
      ? ['-p', args[pIdx + 1], hostPart, 'true']
      : [hostPart, 'true'];
    // Probe via the same ssh client; if it returns Connection refused, propagate.
    const probe = runSshClient({ ...this.buildSshClientOpts(probeArgs) });
    if (probe.exitCode !== 0) {
      // scp prefixes with "scp:" / "rsync:" but reuses the ssh message body.
      const prefix = cmd === 'rsync' ? 'rsync: connection unexpectedly closed' : `${cmd}: `;
      return { output: prefix + probe.output, exitCode: probe.exitCode };
    }
    // Success: simulate a typical line of output per tool.
    const summary = cmd === 'sftp'
      ? `Connected to ${hostPart}.\nsftp> `
      : cmd === 'scp'
        ? `${positional[0]}                                     100% 1024     1.0KB/s   00:00`
        : `sent 128 bytes  received 32 bytes  ${'160.00 bytes/sec'}\ntotal size is 1024  speedup is 6.40`;
    return { output: summary, exitCode: 0 };
  }

  /**
   * Home directory backing this host's SSH per-user state (~/.ssh).
   * Interactive sessions on a simulated host run in root's environment —
   * the executor's shell starts in /root — so SSH config, known_hosts and
   * identities are rooted at /root/.ssh, the same base ssh-keygen defaults
   * to and the location the whole SSH toolchain reads and writes.
   */
  private sshHomeDir(): string {
    return this.userMgr.getUser('root')?.home ?? '/root';
  }

  /** Build the standard SshClientOpts (used by `ssh` and ssh-transport). */
  private buildSshClientOpts(args: string[], callerEnv?: Record<string, string>) {
    const hostname = (this.vfs.readFile('/etc/hostname') ?? 'localhost').trim();
    const sourceIp = this.firstConfiguredIp() ?? '127.0.0.1';
    const user = this.userMgr.currentUser;
    const home = this.sshHomeDir();
    return {
      args,
      sourceHostname: hostname,
      sourceIp,
      sourceUser: user,
      sourceHome: home,
      callerEnv,
      localForwarding: this.forwarding ?? undefined,
      localAgent: this.sshAgent,
      localVfs: {
        readFile: (p: string) => this.vfs.readFile(p),
        writeFile: (p: string, c: string, uid: number, gid: number, umask: number) =>
          this.vfs.writeFile(p, c, uid, gid, umask),
        resolveInode: (p: string) => this.vfs.resolveInode(p),
        mkdirp: (p: string, perm: number, uid: number, gid: number) => this.vfs.mkdirp(p, perm, uid, gid),
      },
    };
  }

  /**
   * `ssh-keyscan <host>` — print the remote's host public key in the
   * same format as a known_hosts line. Used to seed known_hosts non-
   * interactively.
   */
  private runSshKeyscan(args: string[]): { output: string; exitCode: number } {
    const host = args.find(a => !a.startsWith('-'));
    if (!host) return { output: 'usage: ssh-keyscan [-Hv46cD] [-f file] [-p port] [-t type] [host | addrlist namelist]', exitCode: 1 };
    const found = findHostByAddress(host);
    if (!found) return { output: `# ${host} unknown host`, exitCode: 1 };
    const remoteVfs = (found.device as unknown as { executor: { vfs: { readFile: (p: string) => string | null } } }).executor?.vfs;
    if (!remoteVfs) return { output: `# ${host} no host key`, exitCode: 1 };
    const pub = (remoteVfs.readFile('/etc/ssh/ssh_host_ed25519_key.pub') ?? '').trim();
    if (!pub) return { output: `# ${host} no host key`, exitCode: 1 };
    const tokens = pub.split(/\s+/);
    return { output: `${found.ip} ${tokens[0]} ${tokens[1]}`, exitCode: 0 };
  }

  /**
   * `ssh-keygen -R <host>` — remove all entries matching the host from
   * the local known_hosts. Other subcommands (-y, -F, -t) flow through
   * the existing key-management dispatcher.
   */
  private runSshKeygen(args: string[]): { output: string; exitCode: number } {
    if (args[0] === '-R' && args[1]) {
      const path = `${this.sshHomeDir()}/.ssh/known_hosts`;
      const existing = this.vfs.readFile(path) ?? '';
      const before = SshKnownHostEntry.parseFile(existing);
      const after = before.filter(e => !e.matches(args[1]));
      this.vfs.writeFile(path, SshKnownHostEntry.serializeFile(after), 0, 0, 0o022);
      return { output: `# Host ${args[1]} found: line 1\n/root/.ssh/known_hosts updated.\nOriginal contents retained as /root/.ssh/known_hosts.old`, exitCode: 0 };
    }
    // Fall back to the keypair generator already wired into handleSshAdd
    // path. The existing implementation only supports -t / -f / -N / -q
    // / -y for the simulator, which is enough for the new tests.
    return this.handleSshKeygenLegacy(args);
  }

  /**
   * Bridge to the legacy ssh-keygen handler kept inside handleSshAdd.
   * Wraps the simple `-t / -f / -N / -y / -q` interface that has lived
   * here for a while.
   */
  private handleSshKeygenLegacy(args: string[]): { output: string; exitCode: number } {
    // The legacy bash interpreter saw `ssh-keygen` as an unknown command
    // and returned "command not found". Provide a minimal compatible
    // implementation that creates a file pair under -f and -N.
    const fIdx = args.indexOf('-f');
    const file = fIdx >= 0 ? args[fIdx + 1] : `${this.sshHomeDir()}/.ssh/id_ed25519`;
    if (args.includes('-y')) {
      // Read the private key, output its public form (stub).
      return { output: `ssh-ed25519 AAAA${Math.random().toString(36).slice(2, 16)} ${this.userMgr.currentUser}@localhost`, exitCode: 0 };
    }
    // Generate: write two files (private + .pub).
    const sshDir = file.replace(/\/[^/]+$/, '');
    if (!this.vfs.resolveInode(sshDir)) {
      this.vfs.mkdirp(sshDir, 0o700, 0, 0);
    }
    const pubKey = `ssh-ed25519 AAAA${Math.random().toString(36).slice(2, 16)} ${this.userMgr.currentUser}@${(this.vfs.readFile('/etc/hostname') ?? 'localhost').trim()}`;
    this.vfs.writeFile(file, '-----BEGIN OPENSSH PRIVATE KEY-----\n(stub)\n-----END OPENSSH PRIVATE KEY-----\n', 0, 0, 0o077);
    this.vfs.writeFile(`${file}.pub`, pubKey + '\n', 0, 0, 0o022);
    return { output: '', exitCode: 0 };
  }

  /**
   * `ssh-copy-id [-i identity] [-p port] [user@]host` — install the local
   * public key into the remote user's ~/.ssh/authorized_keys so subsequent
   * logins can use public-key authentication.
   */
  private runSshCopyId(args: string[]): { output: string; exitCode: number } {
    let identity: string | null = null;
    let target: string | null = null;
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === '-i' && args[i + 1]) { identity = args[++i]; continue; }
      if (a === '-p' && args[i + 1]) { i++; continue; }
      if (a.startsWith('-')) continue;
      if (!target) target = a;
    }
    if (!target) {
      return { output: 'usage: ssh-copy-id [-i [identity_file]] [-p port] [user@]hostname', exitCode: 1 };
    }

    // Resolve the public key to install (honour -i, else the default set).
    const home = this.sshHomeDir();
    const pubCandidates = identity
      ? [identity.endsWith('.pub') ? identity : `${identity}.pub`]
      : [
          `${home}/.ssh/id_ed25519.pub`,
          `${home}/.ssh/id_rsa.pub`,
          `${home}/.ssh/id_ecdsa.pub`,
        ];
    let pubKey: string | null = null;
    let pubSource = pubCandidates[0];
    for (const c of pubCandidates) {
      const data = this.vfs.readFile(c);
      if (data && data.trim()) { pubKey = data.trim(); pubSource = c; break; }
    }
    if (!pubKey) {
      return {
        output: '/usr/bin/ssh-copy-id: ERROR: No identities found',
        exitCode: 1,
      };
    }

    const parsed = /^(?:([\w.-]+)@)?([\w.-]+)$/.exec(target);
    if (!parsed) {
      return { output: `ssh-copy-id: Could not resolve hostname ${target}`, exitCode: 1 };
    }
    const remoteUser = parsed[1] ?? this.userMgr.currentUser;
    const host = parsed[2];
    const found = findHostByAddress(host, { readFile: (p) => this.vfs.readFile(p) });
    if (!found || found.poweredOff || found.interfaceDown) {
      return {
        output: `/usr/bin/ssh-copy-id: ERROR: ssh: connect to host ${host} port 22: No route to host`,
        exitCode: 255,
      };
    }
    const remoteExec = (found.device as unknown as {
      isServiceActive?: (n: string) => boolean;
      executor?: {
        vfs: VirtualFileSystem;
        userMgr: { getUser: (u: string) => { uid: number; gid: number; home?: string } | undefined };
      };
    });
    if (typeof remoteExec.isServiceActive !== 'function' || !remoteExec.isServiceActive('ssh')) {
      return {
        output: `/usr/bin/ssh-copy-id: ERROR: ssh: connect to host ${host} port 22: Connection refused`,
        exitCode: 255,
      };
    }
    const rexec = remoteExec.executor;
    const remoteUserEntry = rexec?.userMgr.getUser(remoteUser);
    if (!rexec || !remoteUserEntry) {
      return {
        output: `/usr/bin/ssh-copy-id: ERROR: ${remoteUser}@${host}: Permission denied (publickey,password).`,
        exitCode: 255,
      };
    }
    const remoteHome = remoteUserEntry.home ?? `/home/${remoteUser}`;
    const sshDir = `${remoteHome}/.ssh`;
    const akPath = `${sshDir}/authorized_keys`;
    if (!rexec.vfs.resolveInode(sshDir)) {
      rexec.vfs.mkdirp(sshDir, 0o755, remoteUserEntry.uid, remoteUserEntry.gid);
    }
    const existing = rexec.vfs.readFile(akPath) ?? '';
    if (existing.split('\n').some((l) => l.trim() === pubKey)) {
      return {
        output: '/usr/bin/ssh-copy-id: WARNING: All keys were skipped because they already exist on the remote system.',
        exitCode: 0,
      };
    }
    const sep = existing.length === 0 || existing.endsWith('\n') ? '' : '\n';
    rexec.vfs.writeFile(
      akPath,
      existing + sep + pubKey + '\n',
      remoteUserEntry.uid,
      remoteUserEntry.gid,
      0o022,
    );
    rexec.vfs.chmod(akPath, 0o644);
    return {
      output: [
        `/usr/bin/ssh-copy-id: INFO: Source of key(s) to be installed: "${pubSource}"`,
        '/usr/bin/ssh-copy-id: INFO: attempting to log in with the new key(s), to filter out any that are already installed',
        '',
        'Number of key(s) added: 1',
        '',
        `Now try logging into the machine, with:   "ssh '${remoteUser}@${host}'"`,
        'and check to make sure that only the key(s) you wanted were added.',
      ].join('\n'),
      exitCode: 0,
    };
  }

  /** First non-loopback IPv4 address configured on this machine. */
  private firstConfiguredIp(): string | null {
    if (!this.ipNetworkCtx) return null;
    for (const name of this.ipNetworkCtx.getInterfaceNames()) {
      if (name === 'lo') continue;
      const info = this.ipNetworkCtx.getInterfaceInfo(name);
      // An administratively-down NIC cannot source traffic, so its address
      // is unusable until the interface is brought back up.
      if (info?.ip && info.isUp) return info.ip;
    }
    return null;
  }

  /** Wire the device's socket table so netstat/ss output is dynamic */
  setSocketTable(table: SocketTable): void {
    this.socketTable = table;
    // SSH port-forwards bind their listeners on the very same table, so
    // `-L`/`-R`/`-D` tunnels surface through `ss` / `netstat`.
    this.forwarding = new SshForwardingTable(table);
    // Now that the socket table exists, keep the port subsystem coherent on
    // disk: seed /etc/services and expose /proc/net/{tcp,udp} as generated
    // files that always reflect the live table.
    const portsFs = new PortsFilesystem(this.vfs);
    portsFs.seedServicesFile(this.ianaServices);
    portsFs.registerProcNet(table);
  }

  /** The SSH port-forwarding table — `-R` listeners are bound here too. */
  get forwardingTable(): SshForwardingTable | null {
    return this.forwarding;
  }

  /**
   * Share the owning machine's SSH session table so `who` / `w` / `last`
   * render from it — even inside compound commands and ssh exec mode,
   * which bypass LinuxMachine's standalone-only fast path.
   */
  setSessionTable(table: SshSessionTable): void {
    this.sessionTable = table;
  }

  /** Register a system process (e.g. Oracle background processes) visible via `ps` */
  registerProcess(pid: number, user: string, command: string): void {
    this._systemProcesses.set(pid, { user, command, startTime: new Date().toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit' }) });
    // Also surface this in the real process table so ps/top see it.
    // The OS-managed PID differs from the caller-supplied one, so we
    // remember the mapping for unregisterProcess to clean up later.
    if (!this._externalToOsPid.has(pid)) {
      const uid = user === 'root' ? 0 : 1;
      const proc = this.processMgr.spawn({ command, user, uid, gid: uid });
      this._externalToOsPid.set(pid, proc.pid);
    }
  }

  /** Unregister a previously externally-registered process. */
  unregisterProcess(externalPid: number): boolean {
    const osPid = this._externalToOsPid.get(externalPid);
    if (osPid !== undefined) this.processMgr.kill(osPid, 'SIGKILL');
    this._externalToOsPid.delete(externalPid);
    return this._systemProcesses.delete(externalPid);
  }

  /** Clear all registered system processes */
  clearSystemProcesses(): void {
    for (const osPid of this._externalToOsPid.values()) {
      this.processMgr.kill(osPid, 'SIGKILL');
    }
    this._externalToOsPid.clear();
    this._systemProcesses.clear();
  }

  /** Build the context object passed to ps/top/kill/pgrep/pkill commands. */
  private processCmdContext() {
    return {
      pm: this.processMgr,
      currentUser: this.userMgr.currentUser,
      currentUid: this.userMgr.currentUid,
      tty: 'pts/0',
      shellPid: this.shellPid,
    };
  }

  /** Context for job builtins (jobs/bg/fg/wait/disown/pstree). */
  private jobsCmdContext() {
    return { pm: this.processMgr, jobs: this.jobTable };
  }

  /**
   * Pre-scan the input for trailing `&` and, if present, treat the
   * preceding command as a background job: spawn a process entry,
   * register the job, and return the announcement.
   *
   * Returns null when the input is not a backgrounded command.
   */
  private handleBackgroundIfTrailing(input: string): string | null {
    if (!endsWithUnquotedAmp(input)) return null;
    let cmdLine = input.replace(/\s*&\s*$/, '').trim();
    if (!cmdLine) return null;

    // `nohup CMD &` — strip the nohup wrapper and detach from the shell.
    let nohup = false;
    if (/^nohup\s+/.test(cmdLine)) {
      nohup = true;
      cmdLine = cmdLine.replace(/^nohup\s+/, '');
    }

    const argv = simpleTokenize(cmdLine);
    if (argv.length === 0) return null;
    const c = this.ctx();
    const proc = this.processMgr.spawn({
      command: cmdLine,
      comm: basenameOf(argv[0]),
      user: this.userMgr.currentUser,
      uid: c.uid,
      gid: c.gid,
      ppid: nohup ? 1 : this.shellPid,
      tty: nohup ? '?' : 'pts/0',
      cwd: this.cwd,
    });
    const job = this.jobTable.add(proc.pid, `${cmdLine} &`);
    // Actually carry out the work: the only thing "background" skips is
    // blocking the foreground shell. Side effects — an SSH connection's
    // auth.log line and session-table entry, file writes, … — must still
    // happen so `jobs`, `who`, `w` and the logs stay coherent. The
    // command's own stdout is detached from the terminal.
    try { this.execute(cmdLine); } catch { /* background failures are silent */ }
    const lines: string[] = [];
    if (nohup) lines.push(`nohup: ignoring input and appending output to 'nohup.out'`);
    lines.push(`[${job.id}] ${proc.pid}`);
    return lines.join('\n');
  }

  /**
   * Intercept job-control builtins and pstree so they bypass the bash
   * interpreter (which doesn't know about them). Returns null when the
   * input is not one of these commands.
   */
  private runJobBuiltinIfMatching(input: string): string | null {
    const argv = simpleTokenize(input);
    if (argv.length === 0) return null;
    const cmd = argv[0];
    const args = argv.slice(1);
    const ctx = this.jobsCmdContext();
    switch (cmd) {
      case 'jobs':   return cmdJobs(args, ctx).output;
      case 'fg': {
        // Bringing a remote-killed ssh job to the foreground surfaces the
        // disconnect notice OpenSSH prints when its transport drops.
        const j = ctx.jobs.resolve(args[0] ?? '%+');
        if (j && j.state === 'Killed') {
          const host = LinuxCommandExecutor.sshTargetHost(j.command);
          if (host) {
            ctx.jobs.remove(j.id);
            return `Connection closed by ${host}`;
          }
        }
        return cmdFg(args, ctx).output;
      }
      case 'bg':     return cmdBg(args, ctx).output;
      case 'wait':   return cmdWait(args, ctx).output;
      case 'disown': return cmdDisown(args, ctx).output;
      case 'pstree': return cmdPstree(args, ctx).output;
      case 'kill': {
        // Bash resolves %jobspec before invoking kill(2). Do the same so
        // we can also drop the corresponding job from the table.
        return this.runKillWithJobspecs(args);
      }
      default: return null;
    }
  }

  /**
   * Extract the host (IP or name) an `ssh` command line connects to, or
   * null when the command is not an ssh invocation. Value-taking short
   * options consume the following token so the host is not misread.
   */
  private static sshTargetHost(command: string): string | null {
    const argv = simpleTokenize(command.replace(/\s*&\s*$/, ''));
    if (argv[0] !== 'ssh') return null;
    for (let i = 1; i < argv.length; i++) {
      const a = argv[i];
      if (a.startsWith('-')) {
        // A bundle ending in a value-taking flag eats the next token.
        if (/[bcDEeFIiJLlmOopRSWw]$/.test(a)) i++;
        continue;
      }
      const at = a.indexOf('@');
      return at >= 0 ? a.slice(at + 1) : a;
    }
    return null;
  }

  /**
   * Reap background `ssh host …` jobs whose remote host is the device
   * that just powered off — a real ssh client loses its transport and
   * exits, so the job moves to `Killed`. Driven reactively by the
   * `device.power-off` event.
   */
  private reapSshJobsForDevice(deadDeviceId: string): void {
    for (const job of this.jobTable.list()) {
      if (!job.isRunning()) continue;
      const host = LinuxCommandExecutor.sshTargetHost(job.command);
      if (!host) continue;
      const found = findHostByAddress(host);
      if (found && found.device.getId() === deadDeviceId) {
        job.complete({ signal: 'SIGHUP' });
      }
    }
  }

  /** kill with %jobspec support — drops resolved jobs from the table. */
  private runKillWithJobspecs(args: string[]): string {
    const resolved: string[] = [];
    const droppedJobIds: number[] = [];
    for (const a of args) {
      if (a.startsWith('%')) {
        const j = this.jobTable.resolve(a);
        if (!j) return `bash: kill: ${a}: no such job`;
        resolved.push(String(j.pid));
        droppedJobIds.push(j.id);
      } else {
        resolved.push(a);
      }
    }
    const r = cmdKill(resolved, this.processCmdContext());
    if (r.exitCode === 0) droppedJobIds.forEach(id => this.jobTable.remove(id));
    return r.output;
  }

  private ctx(): ShellContext {
    return {
      vfs: this.vfs,
      userMgr: this.userMgr,
      cwd: this.cwd,
      umask: this.umask,
      uid: this.userMgr.currentUid,
      gid: this.userMgr.currentGid,
    };
  }

  /**
   * Execute a command string through the bash interpreter.
   * Handles variables, control structures, pipes, redirections, functions, etc.
   */
  /** Exit code of the most recent execute() call. Cleared per call. */
  lastExitCode = 0;

  /**
   * Run a command in the context of a specific shell session. Implements the
   * per-terminal isolation required by terminal_gap.md §2.
   *
   * Real-OS analogy: the kernel scheduler pins one process state to the
   * single CPU at a time. Here we briefly pin `session`'s state onto the
   * executor's fields, run the synchronous bash interpreter (and any
   * sync-dispatched builtins), then capture the mutations back into the
   * session and restore the executor's default state.
   *
   * Safety: `execute()` and `dispatchFromInterpreter()` are synchronous, so
   * no other code can interleave between swap-in and swap-out. Concurrent
   * `executeInSession` calls from different terminals are serialised by the
   * owning `LinuxMachine` (see `LinuxMachine.executeCommandInSession`).
   */
  executeInSession(input: string, session: LinuxShellSession): string {
    if (session.disposed) return '';
    const baseline = this.snapshotState();
    this.swapInSession(session);
    try {
      const result = this.execute(input);
      this.captureStateInto(session);
      return result;
    } finally {
      this.restoreFromSnapshot(baseline);
    }
  }

  /**
   * Snapshot the per-process state of the executor (for swap-and-restore).
   * @internal — used by LinuxMachine.executeCommandInSession. Do not call
   * from outside the device layer.
   */
  snapshotState() {
    return {
      cwd: this.cwd,
      user: this.userMgr.currentUser,
      uid: this.userMgr.currentUid,
      gid: this.userMgr.currentGid,
      umask: this.umask,
      env: new Map(this.env),
      suStack: [...this.suStack],
      commandHistory: this.commandHistory,
      shellPid: this.shellPid,
      shellPpid: this.shellPpid,
      jobTable: this.jobTable,
      lastExitCode: this.lastExitCode,
    };
  }

  /** @internal */
  swapInSession(s: LinuxShellSession): void {
    this.cwd = s.cwd;
    this.userMgr.currentUser = s.user;
    this.userMgr.currentUid = s.uid;
    this.userMgr.currentGid = s.gid;
    this.umask = s.umask;
    this.env = new Map(s.env);
    this.suStack = [...s.suStack];
    this.commandHistory = s.commandHistory;
    this.shellPid = s.shellPid;
    this.shellPpid = s.shellPpid;
    this.jobTable = s.jobTable;
    this.lastExitCode = s.lastExitCode;
  }

  /** @internal */
  captureStateInto(s: LinuxShellSession): void {
    s.cwd = this.cwd;
    s.user = this.userMgr.currentUser;
    s.uid = this.userMgr.currentUid;
    s.gid = this.userMgr.currentGid;
    s.umask = this.umask;
    s.env = new Map(this.env);
    s.suStack = [...this.suStack];
    s.lastExitCode = this.lastExitCode;
    // commandHistory + jobTable are passed by reference, so any in-place
    // mutations during execute() are already reflected on the session.
  }

  /** @internal */
  restoreFromSnapshot(b: ReturnType<LinuxCommandExecutor['snapshotState']>): void {
    this.cwd = b.cwd;
    this.userMgr.currentUser = b.user;
    this.userMgr.currentUid = b.uid;
    this.userMgr.currentGid = b.gid;
    this.umask = b.umask;
    this.env = b.env;
    this.suStack = b.suStack;
    this.commandHistory = b.commandHistory;
    this.shellPid = b.shellPid;
    this.shellPpid = b.shellPpid;
    this.jobTable = b.jobTable;
    this.lastExitCode = b.lastExitCode;
  }

  execute(input: string): string {
    const trimmed = input.trim();
    if (!trimmed) { this.lastExitCode = 0; return ''; }

    // Track command in history (store the raw input, like bash)
    this.commandHistory.push(trimmed);

    // Intercept builtins that the bash interpreter doesn't know about.
    const builtin = this.runJobBuiltinIfMatching(trimmed);
    if (builtin !== null) return builtin;

    // Handle top-level background `cmd &` (and `nohup cmd &`).
    const bgHandled = this.handleBackgroundIfTrailing(trimmed);
    if (bgHandled !== null) return bgHandled;

    // Route through the bash interpreter for full bash syntax support
    const io = this.buildIOContext();
    const initialPwd = this.cwd;
    const initialVars = this.buildEnvVars();
    const result = runScriptContent(
      trimmed,
      'bash',
      [],
      (argv, env) => this.dispatchFromInterpreter(argv, env),
      initialVars,
      io,
      { pid: this.shellPid, ppid: this.shellPpid },
      this.aliases,
    );

    // Sync interpreter state back to executor
    if (result.env) {
      // Sync PWD → this.cwd only if the interpreter's cd builtin changed it
      // (not if an external command like su changed this.cwd through dispatch)
      const interpPwd = result.env['PWD'];
      if (interpPwd && interpPwd !== initialPwd && this.cwd === initialPwd) {
        // The interpreter changed PWD but dispatch didn't change this.cwd
        // → the cd builtin was used; validate and apply
        const inode = this.vfs.resolveInode(interpPwd);
        if (inode && inode.type === 'directory') {
          this.cwd = interpPwd;
        }
      }
      // Sync variables back to executor's env
      for (const [key, value] of Object.entries(result.env)) {
        // Skip internal/special vars and positional params
        if (/^\d+$/.test(key) || ['?', '$', '!', '@', '#', '*', '0', 'PWD', 'OLDPWD'].includes(key)) continue;
        if (value !== initialVars[key]) {
          this.env.set(key, value);
        }
      }
    }

    this.lastExitCode = result.exitCode ?? 0;

    // A terminal does not echo a trailing blank line after a command
    // (e.g. `echo x` shows one line, not two). Drop a single trailing
    // newline so output is consistent across builtins and externals.
    return result.output.replace(/\n$/, '');
  }

  /**
   * Run a command line with extra environment variables overlaid for the
   * duration of the command, then restore the prior environment. Used by
   * inbound SSH exec-mode to apply AcceptEnv-forwarded variables on the
   * remote side without leaking them into the persistent shell env.
   */
  executeWithEnv(input: string, extraEnv: Record<string, string>): string {
    const saved = new Map<string, string | undefined>();
    for (const [k, v] of Object.entries(extraEnv)) {
      saved.set(k, this.env.has(k) ? this.env.get(k) : undefined);
      this.env.set(k, v);
    }
    try {
      return this.execute(input);
    } finally {
      for (const [k, v] of saved) {
        if (v === undefined) this.env.delete(k);
        else this.env.set(k, v);
      }
    }
  }

  /**
   * Bridge between the bash interpreter and the command dispatcher.
   * Called by the interpreter for external (non-builtin) commands.
   */
  private dispatchFromInterpreter(
    argv: string[],
    env?: Record<string, string>,
  ): { output: string; exitCode: number } {
    // Remember the shell environment of the command currently being
    // dispatched so env-aware commands (ssh forwarding, locale) can read
    // exported variables and `VAR=val` prefix assignments.
    this._cmdEnv = env;
    if (argv.length === 0) return { output: '', exitCode: 0 };

    // The last argument may be pipe input (passed by the interpreter)
    // Detect: if there are more args than expected and the last contains newlines, treat as stdin
    const cmd = argv[0];
    const args = argv.slice(1);

    // Handle sudo prefix
    let cmdArgs = [...argv];
    let isSudo = false;
    let savedUser: { user: string; uid: number; gid: number; cwd: string } | null = null;
    if (cmdArgs[0] === 'sudo') {
      isSudo = true;
      cmdArgs = cmdArgs.slice(1);
      // `-S` reads the sudo password from stdin — detect it before the
      // flag group is stripped below.
      const readsStdinPassword = cmdArgs.some(
        (a) => a.startsWith('-') && !a.startsWith('--') && a.includes('S'),
      );
      // Strip flags that don't consume a value (-n non-interactive, -S
      // read password from stdin, -E preserve env, -k reset timestamp).
      while (cmdArgs.length > 0 && /^-[nSEkbiHvP]+$/.test(cmdArgs[0])) cmdArgs.shift();
      if (cmdArgs.length === 0) return { output: 'usage: sudo [-u user] command\n       sudo -l', exitCode: 1 };
      if (cmdArgs[0] === '-l') return this.dispatch('sudo', cmdArgs, undefined, true);
      if (!this.canSudo()) {
        return {
          output: `${this.userMgr.currentUser} is not in the sudoers file. This incident will be reported.`,
          exitCode: 1,
        };
      }
      // `sudo -S` authenticates against the invoking user's password,
      // piped in on stdin. A wrong password is rejected and audited
      // through PAM, exactly as on a real host.
      if (readsStdinPassword) {
        const last = cmdArgs[cmdArgs.length - 1];
        const supplied = last && last.includes('\n')
          ? (last.replace(/\n+$/, '').split('\n').pop() ?? '').trim()
          : '';
        if (!this.userMgr.checkPassword(this.userMgr.currentUser, supplied)) {
          if (this.serviceMgr.isActive('rsyslog')) {
            const ts = new Date().toUTCString().replace(/^... /, '').slice(0, 15);
            const hostname = (this.vfs.readFile('/etc/hostname') ?? 'localhost').trim();
            const u = this.userMgr.currentUser;
            const cmdStr = cmdArgs.filter((a) => !a.includes('\n')).join(' ');
            const fail =
              `${ts} ${hostname} sudo: pam_unix(sudo:auth): authentication failure; ` +
              `logname=${u} uid=${this.userMgr.currentUid} euid=0 tty=pts/0 ruser=${u} rhost=  user=${u}\n` +
              `${ts} ${hostname} sudo:  ${u} : 1 incorrect password attempt ; TTY=pts/0 ; ` +
              `PWD=${this.cwd} ; USER=root ; COMMAND=/usr/bin/${cmdStr}\n`;
            const existing = this.vfs.readFile('/var/log/auth.log') ?? '';
            this.vfs.writeFile('/var/log/auth.log', existing + fail, 0, 0, 0o022);
          }
          return {
            output: `[sudo] password for ${this.userMgr.currentUser}: \n` +
              'Sorry, try again.\nsudo: 1 incorrect password attempt',
            exitCode: 1,
          };
        }
        // Correct password — drop the stdin token so the command never
        // sees it as an argument.
        if (last && last.includes('\n')) cmdArgs.pop();
      }
      // Audit: write a syslog-style sudo line to /var/log/auth.log
      // (real sudo logs through pam_systemd → journald → rsyslog).
      if (this.serviceMgr.isActive('rsyslog')) {
        const ts = new Date().toUTCString().replace(/^... /, '').slice(0, 15);
        const hostname = (this.vfs.readFile('/etc/hostname') ?? 'localhost').trim();
        const line = `${ts} ${hostname} sudo: ${this.userMgr.currentUser} : TTY=pts/0 ; PWD=${this.cwd} ; USER=root ; COMMAND=/usr/bin/${cmdArgs.join(' ')}\n`;
        const existing = this.vfs.readFile('/var/log/auth.log') ?? '';
        this.vfs.writeFile('/var/log/auth.log', existing + line, 0, 0, 0o022);
      }
      let sudoTargetUser: string | null = null;
      if (cmdArgs[0] === '-u' && cmdArgs.length >= 3) {
        sudoTargetUser = cmdArgs[1];
        cmdArgs = cmdArgs.slice(2);
      }
      savedUser = { user: this.userMgr.currentUser, uid: this.userMgr.currentUid, gid: this.userMgr.currentGid, cwd: this.cwd };
      if (sudoTargetUser) {
        const targetUserEntry = this.userMgr.getUser(sudoTargetUser);
        if (targetUserEntry) {
          this.userMgr.currentUser = targetUserEntry.username;
          this.userMgr.currentUid = targetUserEntry.uid;
          this.userMgr.currentGid = targetUserEntry.gid;
        } else {
          return { output: `sudo: unknown user: ${sudoTargetUser}`, exitCode: 1 };
        }
      } else {
        this.userMgr.currentUser = 'root';
        this.userMgr.currentUid = 0;
        this.userMgr.currentGid = 0;
      }
    }

    if (cmdArgs.length === 0) {
      if (savedUser) { this.userMgr.currentUser = savedUser.user; this.userMgr.currentUid = savedUser.uid; this.userMgr.currentGid = savedUser.gid; }
      return { output: '', exitCode: 0 };
    }

    const actualCmd = isSudo ? cmdArgs[0] : cmd;
    const actualArgs = isSudo ? cmdArgs.slice(1) : args;

    // Detect pipe input: the interpreter appends stdin content as last arg
    let stdin: string | undefined;
    if (actualArgs.length > 0) {
      const lastArg = actualArgs[actualArgs.length - 1];
      // Heuristic: if last arg contains newlines, it's likely pipe input
      if (lastArg?.includes('\n')) {
        stdin = lastArg;
        actualArgs.pop();
      } else if (lastArg && STDIN_COMMANDS.has(actualCmd) && lastArg.includes(' ')) {
        // For text processing commands, multi-word content without newlines is also stdin
        stdin = lastArg;
        actualArgs.pop();
      }
    }

    let result: { output: string; exitCode: number };
    try {
      result = this.dispatch(actualCmd, actualArgs, stdin, isSudo);
    } catch {
      result = { output: `${actualCmd}: error`, exitCode: 1 };
    }

    // Restore user after sudo — BUT NOT if the command was `su` (su manages its own context)
    if (savedUser && actualCmd !== 'su') {
      this.userMgr.currentUser = savedUser.user;
      this.userMgr.currentUid = savedUser.uid;
      this.userMgr.currentGid = savedUser.gid;
    }
    // For sudo su: fix the suStack to return to the original (pre-sudo) user, not root
    if (savedUser && actualCmd === 'su' && this.suStack.length > 0) {
      const top = this.suStack[this.suStack.length - 1];
      top.user = savedUser.user;
      top.uid = savedUser.uid;
      top.gid = savedUser.gid;
      top.cwd = savedUser.cwd;
    }

    return result;
  }

  /** Build an IOContext for the bash interpreter. */
  private buildIOContext(): import('@/bash/interpreter/BashInterpreter').IOContext {
    return {
      writeFile: (path: string, content: string, append: boolean) => {
        const absPath = this.vfs.normalizePath(path, this.cwd);
        // Check if target is a directory
        const existing = this.vfs.resolveInode(absPath);
        if (existing && existing.type === 'directory') {
          throw new Error(`bash: ${path}: Is a directory`);
        }
        this.vfs.writeFile(absPath, content, this.ctx().uid, this.ctx().gid, this.umask, append);
      },
      readFile: (path: string) => {
        const absPath = this.vfs.normalizePath(path, this.cwd);
        return this.vfs.readFile(absPath);
      },
      resolvePath: (path: string) => {
        return this.vfs.normalizePath(path, this.cwd);
      },
      stat: (path: string) => {
        const absPath = this.vfs.normalizePath(path, this.cwd);
        const inode = this.vfs.resolveInode(absPath);
        if (!inode) return null;
        return { type: inode.type === 'directory' ? 'directory' as const : 'file' as const };
      },
    };
  }

  /** Build initial environment variables for the bash interpreter. */
  private buildEnvVars(): Record<string, string> {
    const user = this.userMgr.currentUser;
    const home = this.userMgr.currentUid === 0 ? '/root' : `/home/${user}`;
    const hostname = (this.vfs.readFile('/etc/hostname') ?? 'localhost').trim();
    const vars: Record<string, string> = {
      HOME: home,
      PWD: this.cwd,
      USER: user,
      LOGNAME: user,
      UID: String(this.userMgr.currentUid),
      SHELL: '/bin/bash',
      PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
      // Standard interactive-session variables a real login shell exports.
      HOSTNAME: hostname,
      TERM: 'xterm-256color',
      MAIL: `/var/mail/${user}`,
      SHLVL: '1',
    };
    // Include exported env vars
    for (const [k, v] of this.env) {
      vars[k] = v;
    }
    return vars;
  }

  private dispatch(cmd: string, args: string[], stdin?: string, isSudo = false): { output: string; exitCode: number } {
    const c = this.ctx();

    // Root-only commands — reject if not root. `ufw` is intentionally
    // absent: like `iptables` (which the device router runs un-gated), the
    // simulator's interactive operator manages the firewall directly.
    const rootOnlyCmds = ['useradd', 'adduser', 'addgroup', 'usermod', 'userdel', 'deluser',
      'groupadd', 'groupmod', 'groupdel', 'chpasswd', 'chage', 'faillock', 'chown', 'chgrp',
      'ausearch', 'aureport', 'auditctl',
      'iptables', 'iptables-save', 'iptables-restore'];
    if (rootOnlyCmds.includes(cmd) && this.userMgr.currentUid !== 0) {
      return { output: `${cmd}: Permission denied`, exitCode: 1 };
    }
    // passwd: non-root can only change own password (no args)
    if (cmd === 'passwd' && this.userMgr.currentUid !== 0 && args.length > 0 && !args[0].startsWith('-')) {
      return { output: `passwd: You may not view or modify password information for ${args[0]}.`, exitCode: 1 };
    }

    switch (cmd) {
      // File commands
      case 'touch': return { output: cmdTouch(c, args), exitCode: 0 };
      case 'ls': {
        const out = cmdLs(c, args);
        const isErr = out.includes('cannot access');
        return { output: out, exitCode: isErr ? 2 : 0 };
      }
      case 'cat': {
        // If no file args and stdin is provided, output stdin (cat from stdin)
        const fileArgs = args.filter(a => !a.startsWith('-'));
        if (fileArgs.length === 0 && stdin) {
          const content = stdin.endsWith('\n') ? stdin.slice(0, -1) : stdin;
          return { output: content, exitCode: 0 };
        }
        // Permission check: can user read this file?
        for (const arg of fileArgs) {
          const path = this.vfs.normalizePath(arg, this.cwd);
          const inode = this.vfs.resolveInode(path);
          if (inode && !this.checkPermission(inode, 'r')) {
            return { output: `cat: ${arg}: Permission denied`, exitCode: 1 };
          }
        }
        const out = cmdCat(c, args);
        const isError = out.includes('No such file');
        return { output: out, exitCode: isError ? 1 : 0 };
      }
      case 'echo': {
        // Expand env vars in args before echo
        const expanded = args.map(a => this.expandEnvVars(a));
        return { output: cmdEcho(c, expanded), exitCode: 0 };
      }
      case 'cp': return { output: cmdCp(c, args), exitCode: 0 };
      case 'mv': return { output: cmdMv(c, args), exitCode: 0 };
      case 'rm': return { output: cmdRm(c, args), exitCode: 0 };
      case 'mkdir': return { output: cmdMkdir(c, args), exitCode: 0 };
      case 'rmdir': return { output: cmdRmdir(c, args), exitCode: 0 };
      case 'ln': return { output: cmdLn(c, args), exitCode: 0 };
      case 'pwd': return { output: cmdPwd(c), exitCode: 0 };
      case 'tee': return { output: cmdTee(c, args, stdin ?? ''), exitCode: 0 };

      // cd changes state
      case 'cd': {
        let target = args[0];
        if (!target || target === '~') {
          // Default to current user's home dir
          const user = this.userMgr.getUser(this.userMgr.currentUser);
          target = user?.home || '/root';
        } else if (target.startsWith('~/')) {
          const user = this.userMgr.getUser(this.userMgr.currentUser);
          target = (user?.home || '/root') + target.slice(1);
        } else if (target === '-') {
          const user = this.userMgr.getUser(this.userMgr.currentUser);
          target = user?.home || '/root';
        }
        const newCwd = this.vfs.normalizePath(target, this.cwd);
        const inode = this.vfs.resolveInode(newCwd);
        if (!inode) {
          return { output: `bash: cd: ${args[0] || target}: No such file or directory`, exitCode: 1 };
        }
        if (inode.type !== 'directory') {
          return { output: `bash: cd: ${args[0] || target}: Not a directory`, exitCode: 1 };
        }
        // Check execute permission on directory
        if (!this.checkPermission(inode, 'x')) {
          return { output: `bash: cd: ${args[0] || target}: Permission denied`, exitCode: 1 };
        }
        this.cwd = newCwd;
        return { output: '', exitCode: 0 };
      }

      // Text commands
      case 'grep': return { output: cmdGrep(c, args, stdin), exitCode: 0 };
      case 'head': return { output: cmdHead(c, args, stdin), exitCode: 0 };
      case 'tail': return { output: cmdTail(c, args, stdin), exitCode: 0 };
      case 'wc': return { output: cmdWc(c, args, stdin), exitCode: 0 };
      case 'sort': return { output: cmdSort(c, args, stdin), exitCode: 0 };
      case 'cut': return { output: cmdCut(c, args, stdin), exitCode: 0 };
      case 'uniq': return { output: cmdUniq(c, args, stdin), exitCode: 0 };
      case 'tr': return { output: cmdTr(c, args, stdin), exitCode: 0 };
      case 'awk': return { output: cmdAwk(c, args, stdin), exitCode: 0 };

      // Search commands
      case 'find': return { output: cmdFind(c, args), exitCode: 0 };
      case 'locate': return { output: cmdLocate(c, args), exitCode: 0 };
      case 'which': return { output: cmdWhich(c, args), exitCode: 0 };
      case 'whereis': return { output: cmdWhereis(c, args), exitCode: 0 };
      case 'command': return cmdCommand(c, args, KNOWN_LINUX_COMMAND_SET);
      case 'updatedb': return { output: cmdUpdatedb(c), exitCode: 0 };

      // Permission commands
      case 'chmod': return { output: cmdChmod(c, args), exitCode: 0 };
      case 'chown': return { output: cmdChown(c, args), exitCode: 0 };
      case 'chgrp': return { output: cmdChgrp(c, args), exitCode: 0 };
      case 'stat': return { output: cmdStat(c, args), exitCode: 0 };
      case 'umask': {
        const result = cmdUmask(c, args);
        if (result.newUmask !== undefined) this.umask = result.newUmask;
        return { output: result.output, exitCode: 0 };
      }
      case 'test':
      case '[': {
        // Handle [ ... ] syntax
        const testArgs = cmd === '[' ? args.filter(a => a !== ']') : args;
        const result = cmdTest(c, testArgs);
        return { output: '', exitCode: result.success ? 0 : 1 };
      }
      case 'mkfifo': return { output: cmdMkfifo(c, args), exitCode: 0 };

      // User commands
      case 'useradd': {
        const out = cmdUseradd(c, args);
        if (!out) {
          // Create skeleton files in the new home dir when `-m` was given.
          const req = parseUseraddArgs(args);
          if (req.username && req.createHome && !req.noCreateHome) {
            const user = this.userMgr.getUser(req.username);
            if (user) this.createSkeletonFiles(user.home, user.uid, user.gid);
          }
        }
        return { output: out, exitCode: out ? 1 : 0 };
      }
      case 'adduser': return this.handleAdduser(args);
      case 'addgroup': return this.handleAdduser(args, true);
      case 'usermod': return { output: cmdUsermod(c, args), exitCode: 0 };
      case 'userdel': return this.handleUserdel(args);
      case 'deluser': return this.handleDeluser(args);
      case 'passwd': return this.handlePasswd(args);
      case 'chpasswd': return { output: cmdChpasswd(c, stdin ?? ''), exitCode: 0 };
      case 'chage': return { output: cmdChage(c, args), exitCode: 0 };
      case 'faillock': return { output: cmdFaillock(c, args), exitCode: 0 };
      case 'at': {
        const atdActive = this.serviceMgr.status('atd')?.state === 'active';
        const out = cmdAt(this.atQueue, args, stdin ?? '', this.userMgr.currentUser, atdActive);
        return { output: out, exitCode: atdActive ? 0 : 1 };
      }
      case 'atq': return { output: cmdAtq(this.atQueue), exitCode: 0 };
      case 'atrm': return { output: cmdAtrm(this.atQueue, args), exitCode: 0 };
      case 'ausearch': return { output: cmdAusearch(this.auditLog, args), exitCode: 0 };
      case 'aureport': return { output: cmdAureport(this.auditLog, args), exitCode: 0 };
      case 'auditctl': return { output: cmdAuditctl(this.auditLog, args), exitCode: 0 };
      case 'groupadd': return { output: cmdGroupadd(c, args), exitCode: 0 };
      case 'groupmod': return { output: cmdGroupmod(c, args), exitCode: 0 };
      case 'groupdel': return { output: cmdGroupdel(c, args), exitCode: 0 };
      case 'gpasswd': return this.handleGpasswd(args);
      case 'chfn': return this.handleChfn(args);
      case 'finger': return this.handleFinger(args);
      case 'id': {
        const out = cmdId(c, args);
        return { output: out, exitCode: out.includes('no such user') ? 1 : 0 };
      }
      case 'whoami': return { output: cmdWhoami(c), exitCode: 0 };
      case 'groups': return { output: cmdGroups(c, args), exitCode: 0 };
      case 'who': {
        if (this.sessionTable) {
          this.sessionTable.ensureConsoleSession(this.userMgr.currentUser, this.userMgr.currentUid);
          return { output: this.sessionTable.renderWho(), exitCode: 0 };
        }
        return { output: cmdWho(c), exitCode: 0 };
      }
      case 'w': {
        if (this.sessionTable) {
          this.sessionTable.ensureConsoleSession(this.userMgr.currentUser, this.userMgr.currentUid);
          return { output: this.sessionTable.renderW(), exitCode: 0 };
        }
        return { output: cmdW(c, this.lifecycle.uptimeSeconds()), exitCode: 0 };
      }
      case 'last': {
        if (this.sessionTable) {
          this.sessionTable.ensureConsoleSession(this.userMgr.currentUser, this.userMgr.currentUid);
          const nIdx = args.findIndex(a => a === '-n' || a === '--limit');
          const limit = nIdx >= 0 ? Number.parseInt(args[nIdx + 1] ?? '10', 10) : 10;
          return { output: this.sessionTable.renderLast(limit), exitCode: 0 };
        }
        return { output: cmdLast(c, args), exitCode: 0 };
      }
      case 'lastb': return { output: cmdLastb(c, args), exitCode: 0 };
      case 'getent': {
        // Real getent consults `/etc/nsswitch.conf` and walks the
        // declared sources per database. All output / exit-code logic
        // lives in the NSS module; we just pass the argv through.
        return runGetent(this.nss, args, this.filesNss);
      }
      case 'sudo': return this.handleSudoCmd(args);

      // su - switch user
      case 'su': return this.handleSu(args);

      // source / . — execute file in current shell context
      case 'source':
      case '.': {
        if (args.length === 0) return { output: 'bash: source: filename argument required', exitCode: 2 };
        // In simulator, source is a no-op but we silently succeed
        return { output: '', exitCode: 0 };
      }

      // export — set environment variable
      case 'export': {
        for (const arg of args) {
          const eqIdx = arg.indexOf('=');
          if (eqIdx > 0) {
            const key = arg.slice(0, eqIdx);
            const val = this.expandEnvVars(arg.slice(eqIdx + 1));
            this.env.set(key, val);
          }
        }
        return { output: '', exitCode: 0 };
      }

      // env — print environment
      case 'env': {
        const lines: string[] = [];
        for (const [k, v] of this.env) { lines.push(`${k}=${v}`); }
        return { output: lines.join('\n'), exitCode: 0 };
      }

      // printenv — print the whole environment, or specific variables.
      // With names, one value per line; exit 1 if any name is unset.
      case 'printenv': {
        const envView = this._cmdEnv ?? Object.fromEntries(this.env);
        const names = args.filter((a) => !a.startsWith('-'));
        if (names.length === 0) {
          return {
            output: Object.entries(envView).map(([k, v]) => `${k}=${v}`).join('\n'),
            exitCode: 0,
          };
        }
        const out: string[] = [];
        let missing = false;
        for (const name of names) {
          const v = envView[name];
          if (v === undefined) missing = true;
          else out.push(v);
        }
        return { output: out.join('\n'), exitCode: missing ? 1 : 0 };
      }

      // time — run a command and report its elapsed wall/user/sys time
      case 'time': {
        if (args.length === 0) {
          return { output: '\nreal\t0m0.000s\nuser\t0m0.000s\nsys\t0m0.000s', exitCode: 0 };
        }
        const started = Date.now();
        const inner = this.dispatchFromInterpreter(args, this._cmdEnv);
        const elapsed = ((Date.now() - started) / 1000).toFixed(3);
        const body = inner.output ? inner.output.replace(/\n$/, '') + '\n' : '';
        return {
          output: `${body}\nreal\t0m${elapsed}s\nuser\t0m0.001s\nsys\t0m0.001s`,
          exitCode: inner.exitCode,
        };
      }

      // locale — report the active locale, sourced from the live shell
      // environment so SSH-forwarded LANG / LC_* are reflected.
      case 'locale': {
        const e = this._cmdEnv ?? Object.fromEntries(this.env);
        const lang = e['LANG'] ?? '';
        const lcAll = e['LC_ALL'] ?? '';
        const effective = lcAll || lang || 'C';
        const cat = (name: string) =>
          `${name}="${e[name] ?? effective}"`;
        return {
          output: [
            `LANG=${lang}`,
            `LANGUAGE=${e['LANGUAGE'] ?? ''}`,
            cat('LC_CTYPE'),
            cat('LC_NUMERIC'),
            cat('LC_TIME'),
            cat('LC_COLLATE'),
            cat('LC_MONETARY'),
            cat('LC_MESSAGES'),
            cat('LC_PAPER'),
            cat('LC_NAME'),
            cat('LC_ADDRESS'),
            cat('LC_TELEPHONE'),
            cat('LC_MEASUREMENT'),
            cat('LC_IDENTIFICATION'),
            `LC_ALL=${lcAll}`,
          ].join('\n'),
          exitCode: 0,
        };
      }

      // Crontab
      case 'crontab': return this.handleCrontab(args, stdin);

      // Script execution
      case 'bash':
      case 'sh': {
        const execCmd = (argv: string[], env?: Record<string, string>) =>
          this.dispatchFromInterpreter(argv, env);
        // Parse the leading option group(s). bash accepts combined flags
        // such as `-lc` (login + command); `-l` makes $0 a login `-bash`.
        let i = 0;
        let login = false;
        let cmdString: string | null = null;
        while (i < args.length && args[i].startsWith('-') && args[i] !== '-') {
          const flags = args[i].slice(1);
          if (flags.includes('l')) login = true;
          if (flags.includes('c')) {
            cmdString = args[i + 1] ?? '';
            i += 2;
            break;
          }
          i++;
        }
        const arg0 = login ? '-bash' : cmd;
        if (cmdString !== null) {
          const result = runScriptContent(
            cmdString, arg0, args.slice(i), execCmd,
            this.buildEnvVars(), this.buildIOContext(), undefined, this.aliases,
          );
          return { output: result.output, exitCode: result.exitCode };
        }
        if (i < args.length) {
          const result = runScript(c, args[i], args.slice(i + 1), execCmd, this.aliases);
          return { output: result.output, exitCode: result.exitCode };
        }
        return { output: '', exitCode: 0 };
      }

      // UFW (Uncomplicated Firewall)
      case 'ufw': {
        const out = this.firewall.execute(args);
        return { output: out, exitCode: out.startsWith('ERROR') ? 1 : 0 };
      }

      // iptables — real packet filtering firewall
      case 'iptables': {
        const result = this.iptables.execute(args);
        return { output: result.output, exitCode: result.exitCode };
      }

      // iptables-save — dump all rules in iptables-save format
      case 'iptables-save': {
        return { output: this.iptables.executeSave(), exitCode: 0 };
      }

      // iptables-restore — load rules from stdin
      case 'iptables-restore': {
        const input = stdin ?? '';
        if (!input) return { output: 'iptables-restore: unable to read from stdin', exitCode: 1 };
        const result = this.iptables.executeRestore(input);
        return { output: result.output, exitCode: result.exitCode };
      }

      // Logging commands
      case 'logger': {
        const out = this.logMgr.executeLogger(args, this.userMgr.currentUser);
        return { output: out, exitCode: out ? 1 : 0 };
      }
      case 'journalctl': {
        const out = this.logMgr.executeJournalctl(args);
        return { output: out, exitCode: out.startsWith('Invalid') ? 1 : 0 };
      }
      case 'dmesg': {
        const out = this.logMgr.executeDmesg(args, this.userMgr.currentUid);
        return { output: out, exitCode: out.includes('Permission denied') ? 1 : 0 };
      }

      // Hostname
      case 'hostname': {
        if (args[0]) return { output: args[0], exitCode: 0 };
        const hn = this.vfs.readFile('/etc/hostname');
        return { output: (hn ?? 'localhost').trim(), exitCode: 0 };
      }

      // history — command history management
      case 'history': return this.handleHistory(args);

      // clear - send ANSI escape to clear terminal
      case 'clear': return { output: '\x1b[2J\x1b[H', exitCode: 0 };
      case 'reset': return { output: '\x1b[2J\x1b[H', exitCode: 0 };

      // Sleep — non-blocking simulator no-op
      case 'sleep': return { output: '', exitCode: 0 };

      // kill — send signal via process manager
      case 'kill': {
        const r = cmdKill(args, this.processCmdContext());
        return r;
      }
      case 'pkill': {
        const r = cmdPkill(args, this.processCmdContext());
        return r;
      }
      case 'killall': {
        const r = cmdKillall(args, this.processCmdContext());
        return r;
      }
      case 'arping':
        return { output: cmdArping(args), exitCode: 0 };
      case 'pgrep': {
        const r = cmdPgrep(args, this.processCmdContext());
        return r;
      }
      case 'pidof': {
        const r = cmdPidof(args, this.processCmdContext());
        return r;
      }

      // Priorities / scheduling — set with one cmd, read back with another
      case 'nice': return cmdNice(args, this.processCmdContext());
      case 'renice': return cmdRenice(args, this.processCmdContext());
      case 'chrt': return cmdChrt(args, this.processCmdContext());
      case 'ionice': return cmdIonice(args, this.processCmdContext());
      case 'taskset': return cmdTaskset(args, this.processCmdContext());

      // ps — process listing backed by ProcessManager
      case 'ps': return { output: cmdPs(args, this.processCmdContext()), exitCode: 0 };

      // date, uptime, uname, tty, runlevel, hostnamectl — system info
      case 'date': return { output: cmdDate(args), exitCode: 0 };
      case 'uptime': return { output: cmdUptime(args, this.lifecycle), exitCode: 0 };
      case 'uname': return { output: cmdUname(args, (this.vfs.readFile('/etc/hostname') ?? 'localhost').trim(), this.identity.kernel), exitCode: 0 };
      case 'tty': return { output: cmdTty('pts/0'), exitCode: 0 };
      case 'runlevel': return { output: cmdRunlevel(this.isServer), exitCode: 0 };
      case 'hostnamectl': {
        const hn = (this.vfs.readFile('/etc/hostname') ?? 'localhost').trim();
        return { output: this.identity.toHostnamectl(hn), exitCode: 0 };
      }
      case 'timedatectl': return { output: this.identity.toTimedatectl(), exitCode: 0 };

      // true/false
      case 'true': return { output: '', exitCode: 0 };
      case 'false': return { output: '', exitCode: 1 };

      // ipsec (strongSwan) — IPsec management
      case 'ipsec':
        return this.handleIPSec(args);

      // ── System administration commands ──────────────────────────────
      case 'systemctl': return cmdSystemctl(args, this.serviceMgr);
      case 'service': return cmdService(args, this.serviceMgr);
      case 'df': return { output: cmdDf(c, args), exitCode: 0 };
      case 'du': return { output: cmdDu(c, args), exitCode: 0 };
      case 'free': return { output: cmdFree(args, this.hardware.memory), exitCode: 0 };
      case 'mount': return { output: cmdMount(c, args), exitCode: 0 };
      case 'umount': return { output: '', exitCode: 0 };
      case 'lsblk': return { output: cmdLsblk(args), exitCode: 0 };
      case 'top': return { output: cmdTop(args, this.processCmdContext()), exitCode: 0 };
      case 'htop': return { output: cmdTop(args, this.processCmdContext()), exitCode: 0 };

      // ── Network commands ────────────────────────────────────────────
      case 'ifconfig': return { output: cmdIfconfig(args, this.ipNetworkCtx), exitCode: 0 };
      case 'netstat': return { output: cmdNetstat(args, this.ipNetworkCtx, this.isServer, this.socketTable), exitCode: 0 };
      case 'ss': return { output: cmdSs(args, this.isServer, this.socketTable), exitCode: 0 };
      case 'curl': return { output: cmdCurl(args), exitCode: 0 };
      case 'wget': return { output: cmdWget(args), exitCode: 0 };
      // @deprecated — The following stubs (ping, traceroute, nslookup, dig,
      // host) are retained only as a fallback for scripts executed inside the
      // bash interpreter. Since Phase 3, LinuxMachine intercepts these
      // commands *before* they reach the executor and routes them through the
      // real EndHost network stack (see linux/commands/net/Ping.ts, etc.).
      // These stubs will never fire for interactive terminal commands.
      case 'ping': {
        const host = args.filter(a => !a.startsWith('-'))[0];
        if (!host) return { output: 'ping: usage error: Destination address required', exitCode: 1 };
        return { output: `PING ${host} (${host}) 56(84) bytes of data.\n64 bytes from ${host}: icmp_seq=1 ttl=64 time=0.5 ms\n64 bytes from ${host}: icmp_seq=2 ttl=64 time=0.4 ms\n\n--- ${host} ping statistics ---\n2 packets transmitted, 2 received, 0% packet loss, time 1001ms\nrtt min/avg/max/mdev = 0.4/0.45/0.5/0.05 ms`, exitCode: 0 };
      }
      case 'traceroute': {
        const host = args.filter(a => !a.startsWith('-'))[0];
        if (!host) return { output: 'Usage: traceroute host', exitCode: 1 };
        return { output: `traceroute to ${host}, 30 hops max, 60 byte packets\n 1  gateway (10.0.0.1)  0.5 ms  0.4 ms  0.3 ms\n 2  ${host}  1.2 ms  1.1 ms  1.0 ms`, exitCode: 0 };
      }
      case 'nslookup':
      case 'dig':
      case 'host': {
        const host = args.filter(a => !a.startsWith('-'))[0];
        if (!host) return { output: `Usage: ${cmd} hostname`, exitCode: 1 };
        return { output: `Server:\t\t127.0.0.53\nAddress:\t127.0.0.53#53\n\nNon-authoritative answer:\nName:\t${host}\nAddress: 93.184.216.34`, exitCode: 0 };
      }

      // ── Miscellaneous common commands ────────────────────────────────
      case 'apt':
      case 'apt-get': {
        const sub = args[0] || '';
        if (sub === 'update') return { output: 'Hit:1 http://archive.ubuntu.com/ubuntu jammy InRelease\nReading package lists... Done', exitCode: 0 };
        if (sub === 'install') return { output: `Reading package lists... Done\nBuilding dependency tree... Done\n${args.slice(1).join(', ')} is already the newest version.\n0 upgraded, 0 newly installed, 0 to remove and 0 not upgraded.`, exitCode: 0 };
        if (sub === 'upgrade') return { output: 'Reading package lists... Done\nBuilding dependency tree... Done\nCalculating upgrade... Done\n0 upgraded, 0 newly installed, 0 to remove and 0 not upgraded.', exitCode: 0 };
        if (sub === 'remove' || sub === 'purge') return { output: 'Reading package lists... Done\nBuilding dependency tree... Done\n0 upgraded, 0 newly installed, 0 to remove and 0 not upgraded.', exitCode: 0 };
        if (sub === 'list' && args.includes('--installed')) return { output: 'Listing... Done\nbash/jammy,now 5.1-6ubuntu1 amd64 [installed]\ncoreutils/jammy,now 8.32-4.1ubuntu1 amd64 [installed]\nopenssl/jammy,now 3.0.2-0ubuntu1 amd64 [installed]', exitCode: 0 };
        return { output: `Usage: ${cmd} [update|install|upgrade|remove|list]`, exitCode: 0 };
      }
      case 'dpkg': {
        if (args[0] === '-l' || args[0] === '--list') return { output: 'Desired=Unknown/Install/Remove/Purge/Hold\n| Status=Not/Inst/Conf-files/Unpacked/halF-conf/Half-inst/trig-aWait/Trig-pend\n||/ Name                Version          Architecture Description\n+++-===================-================-============-================================\nii  bash                5.1-6ubuntu1     amd64        GNU Bourne Again SHell\nii  coreutils           8.32-4.1ubuntu1  amd64        GNU core utilities\nii  openssl             3.0.2-0ubuntu1   amd64        Secure Sockets Layer toolkit', exitCode: 0 };
        return { output: 'dpkg: need an action option\nUse dpkg --help for help.', exitCode: 1 };
      }
      case 'lscpu': return { output: this.hardware.cpu.toLscpu(), exitCode: 0 };
      case 'nproc': return { output: String(this.hardware.cpu.logicalCpus), exitCode: 0 };
      case 'lsof': return { output: 'COMMAND   PID   USER   FD   TYPE DEVICE SIZE/OFF NODE NAME\nsystemd     1   root  cwd    DIR    8,1     4096    2 /\nsshd      985   root    3u  IPv4  15432      0t0  TCP *:22 (LISTEN)', exitCode: 0 };
      case 'file': {
        const target = args.filter(a => !a.startsWith('-'))[0];
        if (!target) return { output: 'Usage: file [-options] file...', exitCode: 1 };
        return { output: `${target}: ASCII text`, exitCode: 0 };
      }
      case 'md5sum':
      case 'sha256sum':
      case 'sha1sum': {
        const target = args.filter(a => !a.startsWith('-'))[0];
        if (!target) return { output: `${cmd}: missing file operand`, exitCode: 1 };
        const hash = Array.from({length: cmd === 'sha256sum' ? 64 : 32}, () => Math.floor(Math.random() * 16).toString(16)).join('');
        return { output: `${hash}  ${target}`, exitCode: 0 };
      }
      case 'tar': return { output: '', exitCode: 0 };
      case 'gzip':
      case 'gunzip':
      case 'zip':
      case 'unzip':
        return { output: '', exitCode: 0 };
      case 'scp':
      case 'sftp':
      case 'rsync': {
        return this.runSshTransport(cmd, args);
      }
      case 'ssh': {
        const result = runSshClient(this.buildSshClientOpts(args, this._cmdEnv));
        // A completed TCP handshake leaves a trace `tcpdump` can render.
        if (result.connection) {
          const srcPort = this.socketTable?.allocateEphemeralPort()
            ?? 49152 + Math.floor(Math.random() * 16000);
          this.captureLog.captureTcpHandshake(
            { ip: result.connection.localIp, port: srcPort },
            { ip: result.connection.peerIp, port: result.connection.peerPort },
          );
        }
        return { output: result.output, exitCode: result.exitCode };
      }
      case 'tcpdump':
        return { output: cmdTcpdump(args, this.captureLog), exitCode: 0 };
      case 'ssh-add':
        return this.handleSshAdd(args);
      case 'ssh-keyscan': return this.runSshKeyscan(args);
      case 'ssh-keygen':  return this.runSshKeygen(args);
      case 'ssh-copy-id': return this.runSshCopyId(args);
      case 'xargs': {
        if (!stdin) return { output: '', exitCode: 0 };
        const xCmd = args[0] || 'echo';
        return { output: stdin.split('\n').filter(l => l.trim()).map(l => `${xCmd} ${l.trim()}`).join('\n'), exitCode: 0 };
      }
      // alias / unalias / type / set / unset / declare / local / readonly
      // are shell builtins resolved inside the bash interpreter; they only
      // reach this dispatcher when the interpreter is bypassed.
      case 'tput':
      case 'stty':
      case 'type':
      case 'set':
      case 'unset':
      case 'declare':
      case 'local':
      case 'readonly':
        return { output: '', exitCode: 0 };
      case 'seq': {
        const nums = args.filter(a => !a.startsWith('-')).map(Number);
        if (nums.length === 1) return { output: Array.from({length: nums[0]}, (_, i) => i + 1).join('\n'), exitCode: 0 };
        if (nums.length === 2) return { output: Array.from({length: nums[1] - nums[0] + 1}, (_, i) => nums[0] + i).join('\n'), exitCode: 0 };
        if (nums.length === 3) { const r: number[] = []; for (let i = nums[0]; i <= nums[2]; i += nums[1]) r.push(i); return { output: r.join('\n'), exitCode: 0 }; }
        return { output: 'seq: missing operand', exitCode: 1 };
      }
      case 'rev': return { output: (stdin || '').split('\n').map(l => l.split('').reverse().join('')).join('\n'), exitCode: 0 };
      case 'basename': return { output: (args[0] || '').split('/').pop() || '', exitCode: 0 };

      // Non-interactive fallbacks for commands the GUI normally routes to
      // overlays (editors) or sub-shells (Oracle CLIs). When invoked via
      // SSH there is no TTY, so these commands behave like their batch
      // counterparts: silent for editors, version banners for CLIs.
      case 'nano':
      case 'vi':
      case 'vim': {
        // `nano file` opens (or creates) the file in the editor. In batch
        // mode we honour the "create if missing" behaviour so that
        // subsequent SSH commands can write to it.
        const target = args.find((a) => !a.startsWith('-'));
        if (target) {
          const abs = this.vfs.normalizePath(target, this.cwd);
          if (!this.vfs.exists(abs)) {
            this.vfs.writeFile(abs, '', this.userMgr.currentUid, this.userMgr.currentGid, this.umask);
          }
        }
        return { output: '', exitCode: 0 };
      }
      case 'clear':
      case 'reset':
        return { output: '', exitCode: 0 };
      case 'sqlplus': {
        if (args.includes('-V') || args.includes('-version')) {
          return {
            output:
              'SQL*Plus: Release 19.0.0.0.0 - Production on ' +
              new Date().toUTCString(),
            exitCode: 0,
          };
        }
        // Oracle Server profile: actually boot the instance the first
        // time sqlplus is invoked, so ps -ef shows ora_pmon/ora_smon
        // and lsnrctl status can read the listener state.
        if (this.isServer && this._oracleBootstrap) {
          const out = this._oracleBootstrap(args, stdin);
          if (out !== null) return { output: out, exitCode: 0 };
        }
        return {
          output:
            'SQL*Plus: Release 19.0.0.0.0 - Production\n\n' +
            'ERROR:\nORA-12162: TNS:net service name is incorrectly specified\n\n' +
            'SP2-0157: unable to CONNECT to ORACLE after 3 attempts, exiting SQL*Plus',
          exitCode: 1,
        };
      }
      case 'lsnrctl': {
        if (this.isServer && this._oracleListener) {
          return { output: this._oracleListener(args), exitCode: 0 };
        }
        return { output: 'LSNRCTL: command not found on this host', exitCode: 1 };
      }
      case 'rman':
        return {
          output: 'Recovery Manager: Release 19.0.0.0.0 - Production',
          exitCode: 0,
        };
      case 'lsnrctl': {
        if (args[0] === 'version') {
          return {
            output:
              'LSNRCTL for Linux: Version 19.0.0.0.0 - Production',
            exitCode: 0,
          };
        }
        return {
          output: 'LSNRCTL for Linux: Version 19.0.0.0.0 - Production',
          exitCode: 0,
        };
      }
      case 'tnsping': {
        const target = args[0] || '';
        return {
          output:
            `TNS Ping Utility for Linux: Version 19.0.0.0.0 - Production\n` +
            (target ? `TNS-03505: Failed to resolve name "${target}"` : ''),
          exitCode: target ? 1 : 0,
        };
      }
      case 'dbca':
      case 'orapwd':
      case 'adrci':
        return {
          output: `${cmd}: interactive Oracle utility — non-interactive batch mode not supported in this simulator`,
          exitCode: 0,
        };

      case 'dirname': { const p = args[0] || ''; const idx = p.lastIndexOf('/'); return { output: idx > 0 ? p.slice(0, idx) : (idx === 0 ? '/' : '.'), exitCode: 0 }; }
      case 'readlink': return { output: args.filter(a => !a.startsWith('-'))[0] || '', exitCode: 0 };
      case 'mktemp': return { output: '/tmp/tmp.' + Math.random().toString(36).slice(2, 12), exitCode: 0 };

      default: {
        // Check if it's an executable script (./script.sh or /path/to/script)
        if (cmd.startsWith('./') || cmd.startsWith('/')) {
          const absPath = this.vfs.normalizePath(cmd, this.cwd);
          if (this.vfs.exists(absPath)) {
            const result = runScript(
              c, cmd, args,
              (argv) => this.dispatchFromInterpreter(argv), this.aliases,
            );
            return { output: result.output, exitCode: result.exitCode };
          }
        }

        return { output: `${cmd}: command not found`, exitCode: 127 };
      }
    }
  }

  private handleHistory(args: string[]): { output: string; exitCode: number } {
    // history -c : clear history
    if (args[0] === '-c') {
      this.commandHistory.length = 0;
      return { output: '', exitCode: 0 };
    }

    // history -d N : delete entry at position N (1-based)
    if (args[0] === '-d') {
      const pos = parseInt(args[1], 10);
      if (isNaN(pos) || pos < 1 || pos > this.commandHistory.length) {
        return { output: `bash: history: ${args[1] || ''}: history position out of range`, exitCode: 1 };
      }
      this.commandHistory.splice(pos - 1, 1);
      return { output: '', exitCode: 0 };
    }

    // history -w : write history to ~/.bash_history
    if (args[0] === '-w') {
      const home = this.userMgr.getUser(this.userMgr.currentUser)?.home || '/root';
      const histFile = home + '/.bash_history';
      this.vfs.writeFile(histFile, this.commandHistory.join('\n'), this.userMgr.currentUid, this.userMgr.currentGid, this.umask);
      return { output: '', exitCode: 0 };
    }

    // history -r : read history from ~/.bash_history (append to current history)
    if (args[0] === '-r') {
      const home = this.userMgr.getUser(this.userMgr.currentUser)?.home || '/root';
      const histFile = home + '/.bash_history';
      const content = this.vfs.readFile(histFile);
      if (content) {
        const lines = content.split('\n').filter(l => l.length > 0);
        this.commandHistory.push(...lines);
      }
      return { output: '', exitCode: 0 };
    }

    // history [N] : display last N entries (or all)
    let count = this.commandHistory.length;
    if (args.length > 0 && !args[0].startsWith('-')) {
      const n = parseInt(args[0], 10);
      if (!isNaN(n) && n > 0) {
        count = Math.min(n, this.commandHistory.length);
      }
    }

    const start = this.commandHistory.length - count;
    const lines: string[] = [];
    for (let i = start; i < this.commandHistory.length; i++) {
      const num = (i + 1).toString().padStart(5);
      lines.push(`${num}  ${this.commandHistory[i]}`);
    }
    return { output: lines.join('\n'), exitCode: 0 };
  }

  private handleCrontab(args: string[], stdin?: string): { output: string; exitCode: number } {
    if (args[0] === '-l') {
      const content = this.cron.list();
      if (content === null) return { output: 'no crontab for ' + this.userMgr.currentUser, exitCode: 1 };
      return { output: content, exitCode: 0 };
    }
    if (args[0] === '-r') {
      this.cron.remove();
      return { output: '', exitCode: 0 };
    }
    if (args[0] === '-') {
      // Read the new crontab from stdin.
      if (stdin) {
        const user = this.userMgr.currentUser;
        this.cron.install(stdin, user);
        // A running cron daemon picks up the new table: it logs the
        // reload and fires any job already due in the current minute.
        if (this.serviceMgr.isActive('cron')) {
          this.logMgr.logDaemon('cron', `(${user}) RELOAD (crontabs/${user})`);
          for (const job of this.cron.dueJobs()) {
            this.logMgr.logDaemon('CRON', `(${user}) CMD (${job.command})`);
          }
        }
      }
      return { output: '', exitCode: 0 };
    }
    return { output: '', exitCode: 0 };
  }

  // ─── Permission checking ──────────────────────────────────────────

  /** Check if current user has permission (r/w/x) on an inode */
  private checkPermission(inode: { permissions: number; uid: number; gid: number }, mode: 'r' | 'w' | 'x'): boolean {
    const uid = this.userMgr.currentUid;
    if (uid === 0) return true; // root can do anything

    const perms = inode.permissions & 0o7777;
    const bit = mode === 'r' ? 4 : mode === 'w' ? 2 : 1;

    // Owner
    if (inode.uid === uid) {
      return !!((perms >> 6) & bit);
    }

    // Group
    const gid = this.userMgr.currentGid;
    const userGroups = this.userMgr.getUserGroups(this.userMgr.currentUser);
    const isInGroup = inode.gid === gid || userGroups.some(g => g.gid === inode.gid);
    if (isInGroup) {
      return !!((perms >> 3) & bit);
    }

    // Other
    return !!(perms & bit);
  }

  // ─── su handler ──────────────────────────────────────────────────

  private handleSshAdd(args: string[]): { output: string; exitCode: number } {
    const home =
      this.userMgr.currentUid === 0
        ? '/root'
        : `/home/${this.userMgr.currentUser}`;

    // `-D` — delete all identities.
    if (args.includes('-D')) {
      this.sshAgent.removeAll();
      return { output: 'All identities removed.', exitCode: 0 };
    }

    // `-d <path>` — delete a single identity (or default if none given).
    const dIdx = args.indexOf('-d');
    if (dIdx >= 0) {
      const path =
        args[dIdx + 1] && !args[dIdx + 1].startsWith('-')
          ? args[dIdx + 1]
          : `${home}/.ssh/id_ed25519`;
      const removed = this.sshAgent.remove(path);
      return removed
        ? { output: `Identity removed: ${path}`, exitCode: 0 }
        : { output: 'Could not remove identity: not loaded', exitCode: 1 };
    }

    // `-l` — short fingerprint listing.
    if (args.includes('-l')) {
      const keys = this.sshAgent.list();
      if (keys.length === 0) {
        return { output: 'The agent has no identities.', exitCode: 1 };
      }
      const lines = keys.map(
        (k) => `${k.bits} ${k.fingerprint} ${k.path} (${k.algorithm})`,
      );
      return { output: lines.join('\n'), exitCode: 0 };
    }

    // `-L` — long form (public-key material). Pedagogical stub.
    if (args.includes('-L')) {
      const keys = this.sshAgent.list();
      if (keys.length === 0) {
        return { output: 'The agent has no identities.', exitCode: 1 };
      }
      const lines = keys.map(
        (k) => `ssh-${k.algorithm.toLowerCase()} ${k.material.replace(/\n/g, '')} ${k.comment}`,
      );
      return { output: lines.join('\n'), exitCode: 0 };
    }

    // Default — load identities listed in args, or fall back to discovery.
    const explicit = args.filter((a) => !a.startsWith('-'));
    if (explicit.length > 0) {
      const lines: string[] = [];
      let anyFailed = false;
      for (const path of explicit) {
        if (this.sshAgent.add(path, this.vfs)) {
          lines.push(`Identity added: ${path}`);
        } else {
          lines.push(`Could not open key file ${path}: No such file or directory`);
          anyFailed = true;
        }
      }
      return { output: lines.join('\n'), exitCode: anyFailed ? 1 : 0 };
    }

    const added = this.sshAgent.addAll(home, this.vfs);
    if (added.length === 0) {
      return {
        output: `Could not open a connection to your authentication agent.`,
        exitCode: 2,
      };
    }
    return {
      output: added.map((p) => `Identity added: ${p}`).join('\n'),
      exitCode: 0,
    };
  }

  private handleSu(args: string[]): { output: string; exitCode: number } {
    let loginShell = false;
    let targetUser = 'root';
    for (const arg of args) {
      if (arg === '-' || arg === '-l' || arg === '--login') { loginShell = true; continue; }
      if (!arg.startsWith('-')) targetUser = arg;
    }

    const user = this.userMgr.getUser(targetUser);
    if (!user) return { output: `su: user ${targetUser} does not exist`, exitCode: 1 };
    if (user.shell === '/sbin/nologin' || user.shell === '/usr/sbin/nologin') {
      return { output: `su: user ${targetUser} does not have a login shell`, exitCode: 1 };
    }

    // Save current context to suStack
    this.suStack.push({
      user: this.userMgr.currentUser,
      uid: this.userMgr.currentUid,
      gid: this.userMgr.currentGid,
      cwd: this.cwd,
      umask: this.umask,
    });

    // Switch user
    this.userMgr.currentUser = user.username;
    this.userMgr.currentUid = user.uid;
    this.userMgr.currentGid = user.gid;

    if (loginShell) {
      this.cwd = user.home;
    }

    return { output: '', exitCode: 0 };
  }

  /** Handle exit/logout — pops su stack if in su session */
  handleExit(): { output: string; inSu: boolean } {
    if (this.suStack.length > 0) {
      const prev = this.suStack.pop()!;
      this.userMgr.currentUser = prev.user;
      this.userMgr.currentUid = prev.uid;
      this.userMgr.currentGid = prev.gid;
      this.cwd = prev.cwd;
      this.umask = prev.umask;
      return { output: 'logout', inSu: true };
    }
    return { output: '', inSu: false };
  }

  /** Reset terminal session — clear su stack and restore original user/cwd */
  resetSession(): void {
    // Pop all su contexts to return to original user
    while (this.suStack.length > 0) {
      const prev = this.suStack.pop()!;
      this.userMgr.currentUser = prev.user;
      this.userMgr.currentUid = prev.uid;
      this.userMgr.currentGid = prev.gid;
      this.cwd = prev.cwd;
      this.umask = prev.umask;
    }
  }

  /** Is the current session inside a `su` context? */
  isInSu(): boolean { return this.suStack.length > 0; }

  /** Get current username for prompt */
  getCurrentUser(): string { return this.userMgr.currentUser; }

  /** Get current UID (0 = root) */
  getCurrentUid(): number { return this.userMgr.currentUid; }

  /** Check password for a user */
  checkPassword(username: string, password: string): boolean {
    return this.userMgr.checkPassword(username, password);
  }

  /** Set password for a user */
  setUserPassword(username: string, password: string): void {
    this.userMgr.setPassword(username, password);
  }

  /** Check if a user exists */
  userExists(username: string): boolean {
    return !!this.userMgr.getUser(username);
  }

  /** Set GECOS fields for a user */
  setUserGecos(username: string, fullName: string, room: string, workPhone: string, homePhone: string, other: string): void {
    this.userMgr.setUserGecos(username, fullName, room, workPhone, homePhone, other);
  }

  // ─── Improved command handlers ────────────────────────────────────

  private handlePasswd(args: string[]): { output: string; exitCode: number } {
    // A bare `passwd` / `passwd <user>` is driven by the interactive flow —
    // the Terminal applies the new secret after prompting.
    const hasFlag = args.some((a) => a.startsWith('-'));
    if (!hasFlag) {
      if (args.length > 0) {
        const user = this.userMgr.getUser(args[0]);
        if (!user) return { output: `passwd: user '${args[0]}' does not exist`, exitCode: 1 };
      }
      return { output: 'passwd: password updated successfully', exitCode: 0 };
    }

    // Flag overloads — status / lock / unlock / expire / delete / aging.
    const output = cmdPasswd(this.ctx(), args);
    const exitCode = output.includes('does not exist') ? 1 : 0;
    return { output, exitCode };
  }

  private handleUserdel(args: string[]): { output: string; exitCode: number } {
    let removeHome = false;
    let username = '';
    for (const a of args) {
      if (a === '-r') removeHome = true;
      else if (!a.startsWith('-')) username = a;
    }
    if (!username) return { output: 'userdel: missing username', exitCode: 1 };

    const result = this.userMgr.userdel(username, removeHome);
    if (result) return { output: result, exitCode: 1 };

    const lines: string[] = [];
    if (removeHome) {
      lines.push(`userdel: ${username} mail spool (/var/mail/${username}) not found`);
    }
    return { output: lines.join('\n'), exitCode: 0 };
  }

  /**
   * Debian/Ubuntu `adduser` front-end (also serves `addgroup` via the
   * `addGroupAlias` flag). Faithful to the real tool: it is overloaded over
   * three operations — create a user, add an existing user to a group, or
   * create a group — and emits the same progress banner the real command
   * prints. The interactive password / GECOS capture is layered on top by
   * `LinuxFlowBuilder` when the terminal session runs the command.
   */
  private handleAdduser(args: string[], addGroupAlias = false): { output: string; exitCode: number } {
    const req = parseAdduserArgs(args, addGroupAlias);

    if (req.mode === 'create-group') {
      return this.adduserCreateGroup(req, addGroupAlias ? 'addgroup' : 'adduser');
    }
    if (!req.name) {
      return { output: 'adduser: missing user name', exitCode: 1 };
    }
    if (req.mode === 'add-to-group') {
      return this.adduserAddToGroup(req);
    }
    return this.adduserCreateUser(req);
  }

  /** `adduser <user>` / `adduser --system <user>` — create an account. */
  private adduserCreateUser(req: AdduserRequest): { output: string; exitCode: number } {
    if (this.userMgr.getUser(req.name)) {
      return { output: `adduser: The user \`${req.name}' already exists.`, exitCode: 1 };
    }
    if (req.ingroup && !this.userMgr.getGroup(req.ingroup)) {
      return { output: `adduser: The group \`${req.ingroup}' does not exist.`, exitCode: 1 };
    }

    const createHome = !req.noCreateHome;
    const shell = req.shell ?? (req.system ? '/usr/sbin/nologin' : '/bin/bash');
    const result = this.userMgr.useradd(req.name, {
      m: createHome,
      M: req.noCreateHome,
      s: shell,
      d: req.home,
      g: req.ingroup,
      c: req.gecos,
      u: req.uid,
      r: req.system,
    });
    if (result) return { output: `adduser: ${result}`, exitCode: 1 };

    const user = this.userMgr.getUser(req.name)!;
    if (createHome) this.createSkeletonFiles(user.home, user.uid, user.gid);

    const groupName = this.userMgr.gidToName(user.gid);
    const lines: string[] = [];
    lines.push(req.system
      ? `Adding system user \`${req.name}' (${user.uid}) ...`
      : `Adding user \`${req.name}' ...`);
    if (!req.ingroup) {
      lines.push(`Adding new group \`${groupName}' (${user.gid}) ...`);
    }
    lines.push(`Adding new user \`${req.name}' (${user.uid}) with group \`${groupName}' ...`);
    if (createHome) {
      lines.push(`Creating home directory \`${user.home}' ...`);
      lines.push(`Copying files from \`/etc/skel' ...`);
    } else {
      lines.push(`Not creating home directory \`${user.home}'.`);
    }
    return { output: lines.join('\n'), exitCode: 0 };
  }

  /** `adduser <user> <group>` — add an existing user to an existing group. */
  private adduserAddToGroup(req: AdduserRequest): { output: string; exitCode: number } {
    if (!this.userMgr.getUser(req.name)) {
      return { output: `adduser: The user \`${req.name}' does not exist.`, exitCode: 1 };
    }
    if (!this.userMgr.getGroup(req.group)) {
      return { output: `adduser: The group \`${req.group}' does not exist.`, exitCode: 1 };
    }
    this.userMgr.usermod(req.name, { aG: req.group });
    return {
      output: `Adding user \`${req.name}' to group \`${req.group}' ...\nDone.`,
      exitCode: 0,
    };
  }

  /** `adduser --group <group>` / `addgroup <group>` — create a group. */
  private adduserCreateGroup(req: AdduserRequest, cmd: string): { output: string; exitCode: number } {
    if (!req.name) return { output: `${cmd}: missing group name`, exitCode: 1 };
    if (this.userMgr.getGroup(req.name)) {
      return { output: `${cmd}: The group \`${req.name}' already exists.`, exitCode: 1 };
    }
    const result = this.userMgr.groupadd(req.name, { g: req.gid });
    if (result) return { output: `${cmd}: ${result}`, exitCode: 1 };
    const group = this.userMgr.getGroup(req.name)!;
    return {
      output: `Adding group \`${req.name}' (GID ${group.gid}) ...\nDone.`,
      exitCode: 0,
    };
  }

  private handleChfn(args: string[]): { output: string; exitCode: number } {
    let f: string | undefined, r: string | undefined, w: string | undefined, h: string | undefined;
    let username = '';

    for (let i = 0; i < args.length; i++) {
      switch (args[i]) {
        case '-f': f = args[++i]; break;
        case '-r': r = args[++i]; break;
        case '-w': w = args[++i]; break;
        case '-h': h = args[++i]; break;
        default:
          if (!args[i].startsWith('-')) username = args[i];
          break;
      }
    }

    if (!username) username = this.userMgr.currentUser;
    const result = this.userMgr.chfn(username, { f, r, w, h });
    if (result) return { output: result, exitCode: 1 };
    return { output: '', exitCode: 0 };
  }

  private handleFinger(args: string[]): { output: string; exitCode: number } {
    const username = args.find(a => !a.startsWith('-'));
    const out = this.userMgr.finger(username);
    return { output: out, exitCode: out.includes('no such user') ? 1 : 0 };
  }

  private handleDeluser(args: string[]): { output: string; exitCode: number } {
    let removeHome = false;
    let username = '';
    let fromGroup = '';
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--remove-home') { removeHome = true; continue; }
      if (!args[i].startsWith('-')) {
        if (!username) username = args[i];
        else fromGroup = args[i];
      }
    }
    if (!username) return { output: 'deluser: missing username', exitCode: 1 };

    // deluser user group — remove user from group
    if (fromGroup) {
      const grp = this.userMgr.getGroup(fromGroup);
      if (!grp) return { output: `deluser: group '${fromGroup}' does not exist`, exitCode: 1 };
      grp.members = grp.members.filter(m => m !== username);
      this.userMgr.syncToFilesystem();
      return { output: `Removing user \`${username}' from group \`${fromGroup}' ...\nDone.`, exitCode: 0 };
    }

    // deluser --remove-home user
    const result = this.userMgr.userdel(username, removeHome);
    if (result) return { output: result, exitCode: 1 };

    const lines: string[] = [];
    if (removeHome) {
      lines.push('Looking for files to backup/remove ...');
      lines.push('Removing files ...');
    }
    lines.push(`Removing user \`${username}' ...`);
    lines.push('Done.');
    return { output: lines.join('\n'), exitCode: 0 };
  }

  private handleGpasswd(args: string[]): { output: string; exitCode: number } {
    // gpasswd -d user group
    if (args[0] === '-d' && args.length >= 3) {
      const group = this.userMgr.getGroup(args[2]);
      if (!group) return { output: `gpasswd: group '${args[2]}' does not exist`, exitCode: 1 };
      group.members = group.members.filter(m => m !== args[1]);
      this.userMgr.syncToFilesystem();
      return { output: `Removing user ${args[1]} from group ${args[2]}`, exitCode: 0 };
    }
    return { output: cmdGpasswd(this.ctx(), args), exitCode: 0 };
  }

  private handleSudoCmd(args: string[]): { output: string; exitCode: number } {
    if (args.length === 0 || args[0] === '-l') {
      // sudo -l: show what current user can do
      const hostname = 'linux-pc';
      const user = this.userMgr.currentUser;
      const userGroups = this.userMgr.getUserGroups(user);
      const isSudoer = user === 'root' || userGroups.some(g => g.name === 'sudo');
      if (!isSudoer) {
        return {
          output: `${user} is not in the sudoers file. This incident will be reported.`,
          exitCode: 1,
        };
      }
      return {
        output: [
          `Matching Defaults entries for ${user} on ${hostname}:`,
          `    env_reset, mail_badpass, secure_path=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/snap/bin`,
          ``,
          `User ${user} may run the following commands on ${hostname}:`,
          `    (ALL : ALL) ALL`,
        ].join('\n'),
        exitCode: 0,
      };
    }
    return { output: cmdSudoCheck(this.ctx(), args), exitCode: 0 };
  }

  /** Check if the current user is allowed to use sudo */
  canSudo(): boolean {
    const user = this.userMgr.currentUser;
    if (user === 'root' || this.userMgr.currentUid === 0) return true;
    const userGroups = this.userMgr.getUserGroups(user);
    return userGroups.some(g => g.name === 'sudo');
  }

  // ─── IPSec (strongSwan) ─────────────────────────────────────────

  private ipsecStarted = false;

  private handleIPSec(args: string[]): { output: string; exitCode: number } {
    if (args.length === 0) {
      return { output: 'Usage: ipsec <command> [arguments]\n\nCommands:\n  start        start the IPsec subsystem\n  stop         stop the IPsec subsystem\n  restart      restart the IPsec subsystem\n  status       show IPsec status\n  statusall    show detailed IPsec status\n  up <conn>    bring up a connection\n  down <conn>  tear down a connection\n  reload       reload configuration\n  version      show strongSwan version', exitCode: 0 };
    }

    switch (args[0]) {
      case 'start':
        this.ipsecStarted = true;
        return { output: 'Starting strongSwan 5.9.8 IPsec [starter]...', exitCode: 0 };
      case 'stop':
        this.ipsecStarted = false;
        return { output: 'Stopping strongSwan IPsec...', exitCode: 0 };
      case 'restart':
        this.ipsecStarted = true;
        return { output: 'Stopping strongSwan IPsec...\nStarting strongSwan 5.9.8 IPsec [starter]...', exitCode: 0 };
      case 'reload':
        if (!this.ipsecStarted) return { output: 'IPsec is not running', exitCode: 1 };
        return { output: 'Reloading strongSwan IPsec configuration...', exitCode: 0 };
      case 'status':
        if (!this.ipsecStarted) return { output: 'IPsec is not running', exitCode: 1 };
        return { output: 'Security Associations (0 up, 0 connecting):\n  none', exitCode: 0 };
      case 'statusall':
        if (!this.ipsecStarted) return { output: 'IPsec is not running', exitCode: 1 };
        return {
          output: 'Status of IKE charon daemon (strongSwan 5.9.8, Linux 5.15.0-generic, x86_64):\n' +
            '  uptime: 0 seconds, since now\n' +
            '  worker threads: 16 of 16 idle, 5/0/0/0 working, job queue: 0/0/0/0\n' +
            '  loaded plugins: charon aes sha2 sha1 md5 hmac pem x509 kernel-netlink\n' +
            'Security Associations (0 up, 0 connecting):\n  none',
          exitCode: 0,
        };
      case 'up': {
        if (!this.ipsecStarted) return { output: 'IPsec is not running', exitCode: 1 };
        const conn = args[1] || '';
        if (!conn) return { output: 'Usage: ipsec up <connection-name>', exitCode: 1 };
        return { output: `initiating IKE_SA ${conn}[1] to 0.0.0.0\ngenerating IKE_SA_INIT request`, exitCode: 0 };
      }
      case 'down': {
        if (!this.ipsecStarted) return { output: 'IPsec is not running', exitCode: 1 };
        const conn = args[1] || '';
        if (!conn) return { output: 'Usage: ipsec down <connection-name>', exitCode: 1 };
        return { output: `closing IKE_SA ${conn}[1]`, exitCode: 0 };
      }
      case 'version':
        return { output: 'Linux strongSwan U5.9.8/K5.15.0-generic\nUniversity of Applied Sciences Rapperswil, Switzerland', exitCode: 0 };
      default:
        return { output: `unknown command: ${args[0]}`, exitCode: 1 };
    }
  }

  // ─── Skeleton files ───────────────────────────────────────────────

  /**
   * Populate a freshly created home directory by copying `/etc/skel` — the
   * same coherent path real `useradd -m` / `adduser` take. The skeleton
   * directory itself is seeded by the IAM filesystem layer at boot.
   */
  private createSkeletonFiles(home: string, uid: number, gid: number): void {
    const entries = this.vfs.listDirectory('/etc/skel');
    if (!entries) return;
    for (const entry of entries) {
      if (entry.name === '.' || entry.name === '..') continue;
      const content = this.vfs.readFile(`/etc/skel/${entry.name}`);
      if (content !== null) {
        this.vfs.createFileAt(`${home}/${entry.name}`, content, 0o644, uid, gid);
      }
    }
  }

  // ─── Environment variable expansion ───────────────────────────────

  private expandEnvVars(str: string): string {
    // Only expand variables that exist in env — leave unknown $VARS intact (for scripts)
    return str.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (match, name) => {
      return this.env.has(name) ? this.env.get(name)! : match;
    }).replace(/\$([A-Za-z_][A-Za-z0-9_]*)/g, (match, name) => {
      return this.env.has(name) ? this.env.get(name)! : match;
    });
  }

  /** Get current working directory */
  getCwd(): string { return this.cwd; }

  /** Read a file from the virtual filesystem (returns null if not found) */
  readFile(path: string): string | null {
    const absPath = this.vfs.normalizePath(path, this.cwd);
    return this.vfs.readFile(absPath);
  }

  /** Tab completion: returns matching completions for a partial input */
  getCompletions(partial: string): string[] {
    const trimmed = partial.trimStart();
    if (!trimmed) return [];

    // Split into words — complete the last word
    const parts = trimmed.split(/\s+/);
    const word = parts[parts.length - 1] || '';

    // Environment variable completion: $VAR or ${VAR
    const dollarMatch = word.match(/^(\$\{?)([A-Za-z_][A-Za-z0-9_]*)?$/);
    if (dollarMatch) {
      const sigil = dollarMatch[1];
      const varPrefix = dollarMatch[2] || '';
      const closeBrace = sigil === '${' ? '}' : '';
      const names = this.getEnvVarNames(varPrefix);
      return names.map(n => sigil + n + closeBrace).sort();
    }

    const isFirstWord = parts.length <= 1;
    // After `sudo`, complete commands for the next word
    const afterSudo = parts.length === 2 && parts[0] === 'sudo';

    if (isFirstWord || afterSudo) {
      const prefix = isFirstWord ? word : parts[1];
      // For script execution ./foo, or absolute/home paths, complete as path
      if (prefix.startsWith('./') || prefix.startsWith('/') || prefix.startsWith('~')) {
        return this.getPathCompletions(prefix);
      }
      return this.getCommandCompletions(prefix);
    }

    // Complete file/directory paths
    return this.getPathCompletions(word);
  }

  private getEnvVarNames(prefix: string): string[] {
    const all = new Set<string>(Object.keys(this.buildEnvVars()));
    const names: string[] = [];
    for (const key of all) {
      if (!prefix || key.startsWith(prefix)) names.push(key);
    }
    return names;
  }

  private getCommandCompletions(prefix: string): string[] {
    const unique = Array.from(new Set(KNOWN_LINUX_COMMANDS));
    if (!prefix) return unique.sort();
    return unique.filter(c => c.startsWith(prefix)).sort();
  }

  private getHomeDir(): string {
    return this.userMgr.currentUid === 0 ? '/root' : `/home/${this.userMgr.currentUser}`;
  }

  private expandTilde(word: string): string {
    if (word === '~') return this.getHomeDir();
    if (word.startsWith('~/')) return this.getHomeDir() + word.slice(1);
    return word;
  }

  private getPathCompletions(word: string): string[] {
    // Determine directory to list and prefix to match
    let dir: string;
    let prefix: string;
    let displayPrefix: string;

    // Expand ~ for directory resolution but preserve display as typed
    const expanded = this.expandTilde(word);

    if (word.includes('/')) {
      const lastSlash = word.lastIndexOf('/');
      displayPrefix = word.slice(0, lastSlash + 1);
      prefix = word.slice(lastSlash + 1);
      const expandedDisplay = this.expandTilde(displayPrefix);
      dir = this.vfs.normalizePath(expandedDisplay, this.cwd);
    } else if (word === '~') {
      // Complete "~" itself to the home directory
      return [this.getHomeDir() + '/'];
    } else {
      displayPrefix = '';
      prefix = word;
      dir = this.cwd;
    }

    const entries = this.vfs.listDirectory(dir);
    if (!entries) return [];

    const matches: string[] = [];
    for (const entry of entries) {
      if (entry.name === '.' || entry.name === '..') continue;
      // Hide dotfiles unless prefix starts with a dot
      if (!prefix.startsWith('.') && entry.name.startsWith('.')) continue;
      if (!prefix || entry.name.startsWith(prefix)) {
        const suffix = entry.inode.type === 'directory' ? '/' : '';
        matches.push(displayPrefix + entry.name + suffix);
      }
    }

    return matches.sort();
  }
}

// ─── small parsing helpers (kept private to this file) ────────────────

/**
 * True when the input ends with an unquoted `&` that is not part of
 * `&&`. Used to detect a backgrounded command.
 */
function endsWithUnquotedAmp(input: string): boolean {
  let quote: '"' | "'" | null = null;
  let escaped = false;
  let lastAmpAt = -1;
  let prevCh = '';
  for (let i = 0; i < input.length; i++) {
    const c = input[i];
    if (escaped) { escaped = false; prevCh = c; continue; }
    if (c === '\\' && quote !== "'") { escaped = true; prevCh = c; continue; }
    if (quote) {
      if (c === quote) quote = null;
      prevCh = c; continue;
    }
    if (c === '"' || c === "'") { quote = c; prevCh = c; continue; }
    if (c === '&' && prevCh !== '&' && input[i + 1] !== '&') {
      lastAmpAt = i;
    }
    prevCh = c;
  }
  if (lastAmpAt < 0) return false;
  // Only treat as background if nothing but whitespace follows.
  return /^\s*$/.test(input.slice(lastAmpAt + 1));
}

/** Minimal quote-aware tokenizer for the helpers above. */
function simpleTokenize(input: string): string[] {
  const out: string[] = [];
  let buf = '';
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (quote) {
      if (ch === quote) quote = null;
      else buf += ch;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (/\s/.test(ch)) {
      if (buf) { out.push(buf); buf = ''; }
      continue;
    }
    buf += ch;
  }
  if (buf) out.push(buf);
  return out;
}

function basenameOf(path: string): string {
  const i = path.lastIndexOf('/');
  return i >= 0 ? path.slice(i + 1) : path;
}
