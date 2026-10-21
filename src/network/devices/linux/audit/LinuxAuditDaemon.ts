import type { IEventBus, Unsubscribe } from '@/events/EventBus';
import { simulationNowMs } from '@/network/core/SystemClock';
import type { VirtualFileSystem } from '../VirtualFileSystem';
import type { LinuxServiceManager } from '../LinuxServiceManager';
import type { ServiceLifecyclePayload, ProcessSignalledPayload } from '../events';
import type { LinuxAuditLog } from './LinuxAuditLog';
import { AUDIT_UNSET } from './AuditUserMessage';
import { K } from './tools/AuditKernelConstants';
import type { Interpreter } from './tools/AuditInterpret';
import type { LinuxAuditRules } from './LinuxAuditRules';
import {
  AUDITD_CONF_PATH, clearConfig, loadAuditdConfig, type AuditdConfig, type AuditdConfigFs, type AuditMessage,
  type AuditPriority,
} from './daemon/AuditdConfig';
import { formatEnriched, formatRaw } from './daemon/AuditdFormat';
import { AuditdLogWriter, type AuditdLogEnv } from './daemon/AuditdLogWriter';
import { AudispDispatcher, type DispatcherSettings } from './daemon/dispatch/AudispDispatcher';
import { AUDISP_PROGRAMS } from './daemon/dispatch/AudispPlugins';

export type AuditdState = 'running' | 'stopped' | 'suspended';
export type AuditdStartupState = 'disable' | 'enable' | 'nochange';

export interface AuditdLaunchOptions {
  configFile: string;
  allowLinks: boolean;
  startup: AuditdStartupState;
  foreground: boolean;
}

export interface AuditdLaunchResult {
  exitCode: number;
  stderr: string;
}

const SERVICE_LAUNCH: AuditdLaunchOptions = { configFile: AUDITD_CONF_PATH, allowLinks: false, startup: 'enable', foreground: false };
export const AUDITD_PID_FILE = '/var/run/auditd.pid';

export const AUDITD_STATE_FILE = '/var/run/auditd.state';
const AUDIT_VERSION = '3.1.2';
const TRAPPED_SIGNALS: readonly string[] = ['SIGHUP', 'SIGUSR1', 'SIGUSR2', 'SIGCONT'];

export interface AuditdDeps {
  auditLog: LinuxAuditLog;
  rules: LinuxAuditRules;
  vfs: VirtualFileSystem;
  serviceMgr: LinuxServiceManager;
  configFs: AuditdConfigFs;
  logEnv: Omit<AuditdLogEnv, 'vfs' | 'stopDaemon' | 'syslog'>;
  syslog: (priority: AuditPriority, text: string) => void;
  interpreter: () => Interpreter;
  hostName: () => string;
  hostAddress: () => string | null;
  localTime: (nowSec: number) => string;
  kernelRelease: () => string;
  loadRules: () => void;
  trapSignals: (pid: number, signals: readonly string[]) => void;
  process: {
    spawn: () => number;
    exit: (pid: number) => void;
  };
  plugins: {
    listDirectory: (path: string) => readonly string[] | null;
    spawn: (command: string, ppid: number) => number;
    isAlive: (pid: number) => boolean;
    terminate: (pid: number) => void;
    libcSyslog: (priorityWithFacility: number, ident: string, pid: number, text: string) => void;
  };
}

export class LinuxAuditDaemon {
  private state: AuditdState = 'stopped';
  private config: AuditdConfig = clearConfig();
  private writer: AuditdLogWriter | null = null;
  private dispatcher: AudispDispatcher | null = null;
  private ownPid: number | null = null;
  private foreground = false;
  private foregroundLines: string[] = [];
  private readonly subs: Unsubscribe[] = [];

  constructor(
    private readonly bus: IEventBus,
    private readonly deviceId: string,
    private readonly deps: AuditdDeps,
  ) {
    this.subs.push(
      bus.subscribe('linux.service.started', (e) => this.onLifecycle(e.payload, 'start')),
      bus.subscribe('linux.service.stopped', (e) => this.onLifecycle(e.payload, 'stop')),
      bus.subscribe('linux.process.signalled', (e) => this.onSignal(e.payload)),
    );
    if (deps.serviceMgr.isActive('auditd')) this.runStart(SERVICE_LAUNCH);
  }

  dispose(): void {
    for (const off of this.subs) off();
    this.subs.length = 0;
    this.deps.auditLog.setSink(null);
  }

  get running(): boolean {
    return this.state !== 'stopped';
  }

  get suspended(): boolean {
    return this.state === 'suspended';
  }

  get currentState(): AuditdState {
    return this.state;
  }

  get settings(): AuditdConfig {
    return this.config;
  }

  private onLifecycle(p: ServiceLifecyclePayload, kind: 'start' | 'stop'): void {
    if (p.deviceId !== this.deviceId || p.name !== 'auditd') return;
    if (kind === 'start') this.runStart(SERVICE_LAUNCH);
    else this.runStop();
  }

  private onSignal(p: ProcessSignalledPayload): void {
    if (p.deviceId !== this.deviceId || !p.delivered) return;
    const mainPid = this.deps.serviceMgr.status('auditd')?.mainPid;
    if (p.comm !== 'auditd' && p.pid !== mainPid) return;
    if (p.signal === 'SIGHUP') this.runReload();
    else if (p.signal === 'SIGTERM' || p.signal === 'SIGKILL') this.runStop();
    else if (p.signal === 'SIGUSR1') this.runRotate(p.pid);
    else if (p.signal === 'SIGUSR2') this.runResume(p.pid);
    else if (p.signal === 'SIGCONT') this.writeStateFile();
  }

  private emit(messages: readonly AuditMessage[]): void {
    for (const entry of messages) this.log(entry.priority, entry.text);
  }

  private log(priority: AuditPriority, text: string): void {
    if (this.foreground) this.foregroundLines.push(`${text}\n`);
    else this.deps.syslog(priority, text);
  }

  private pid(): number {
    return this.ownPid ?? this.deps.serviceMgr.status('auditd')?.mainPid ?? 1;
  }

  launch(options: AuditdLaunchOptions): AuditdLaunchResult {
    this.foreground = options.foreground;
    this.foregroundLines = [];
    const previous = this.ownPid;
    const spawned = this.deps.process.spawn();
    this.ownPid = spawned;
    const exitCode = this.runStart(options);
    const stderr = this.foregroundLines.join('');
    this.foreground = false;
    this.foregroundLines = [];
    if (exitCode !== 0) {
      this.ownPid = previous;
      this.deps.process.exit(spawned);
    }
    return { exitCode, stderr };
  }

  private resolveNode(config: AuditdConfig): boolean {
    switch (config.nodeNameFormat) {
      case 'NONE':
        return true;
      case 'USER':
        if (config.nodeName === null) {
          this.log('ERR', 'User defined name missing');
          return false;
        }
        return true;
      case 'NUMERIC': {
        const address = this.deps.hostAddress();
        if (address === null) {
          this.log('ERR', `Cannot resolve hostname ${this.deps.hostName()} (Name or service not known)`);
          return false;
        }
        config.nodeName = address;
        return true;
      }
      default:
        config.nodeName = this.deps.hostName().replace(/ /g, '_');
        return true;
    }
  }

  private abortStart(): number {
    this.log('ERR', 'Unable to set audit pid, exiting');
    this.deps.auditLog.record('DAEMON_ABORT', {
      op: 'set-pid', auid: AUDIT_UNSET, pid: this.pid(), uid: 0, ses: AUDIT_UNSET, subj: 'unconfined', res: 'failed',
    });
    this.deps.vfs.deleteFile(AUDITD_PID_FILE);
    this.deps.vfs.deleteFile(AUDITD_STATE_FILE);
    return 1;
  }

  private failStart(): number {
    this.exitProcess(this.pid());
    return 1;
  }

  private exitProcess(pid: number): void {
    if (pid > 1) this.deps.process.exit(pid);
  }

  private runStart(options: AuditdLaunchOptions): number {
    if (this.state !== 'stopped') return this.abortStart();
    const loaded = loadAuditdConfig(this.deps.configFs, { configFile: options.configFile, allowLinks: options.allowLinks });
    this.emit(loaded.messages);
    if (loaded.rc !== 0) return 6;
    const config = loaded.config;
    if (options.foreground) config.writeLogs = false;
    if (!this.resolveNode(config)) return this.failStart();
    this.deps.vfs.writeFile(AUDITD_PID_FILE, `${this.pid()}\n`, 0, 0, 0o133);
    const writer = new AuditdLogWriter(config, {
      ...this.deps.logEnv,
      vfs: this.deps.vfs,
      syslog: (priority, text) => this.log(priority, text),
      stopDaemon: () => this.runStop(),
    });
    if (!writer.start()) {
      this.deps.vfs.deleteFile(AUDITD_PID_FILE);
      return this.failStart();
    }
    this.config = config;
    this.writer = writer;
    this.state = 'running';
    this.deps.auditLog.setSink((line) => this.dispatch(line));
    this.dispatcher = this.newDispatcher(config);
    this.dispatcher.init();
    this.registerWithKernel(options.startup);
    this.deps.trapSignals(this.pid(), TRAPPED_SIGNALS);
    this.deps.auditLog.record('DAEMON_START', {
      op: 'start',
      ver: AUDIT_VERSION,
      format: config.logFormat.toLowerCase(),
      kernel: this.deps.kernelRelease(),
      auid: AUDIT_UNSET,
      pid: this.pid(),
      uid: 0,
      ses: AUDIT_UNSET,
      subj: 'unconfined',
      res: 'success',
    });
    this.log('NOTICE', `Init complete, auditd ${AUDIT_VERSION} listening for events (startup state ${options.startup})`);
    this.deps.rules.runAsDaemon(() => this.deps.loadRules());
    this.syncState();
    return 0;
  }

  private dispatcherSettings(config: AuditdConfig): DispatcherSettings {
    return { qDepth: config.qDepth, overflowAction: config.overflowAction, maxRestarts: config.maxRestarts, pluginDir: config.pluginDir };
  }

  private newDispatcher(config: AuditdConfig): AudispDispatcher {
    const { vfs, plugins } = this.deps;
    const programName = (path: string): string | null => {
      const real = vfs.realpath(path);
      return real === null ? null : real.slice(real.lastIndexOf('/') + 1);
    };
    return new AudispDispatcher({
      fs: this.deps.configFs,
      listDirectory: plugins.listDirectory,
      syslog: (priority, text) => this.log(priority, text),
      spawn: (plugin) => plugins.spawn([plugin.path ?? '', ...plugin.args].join(' '), this.pid()),
      isAlive: plugins.isAlive,
      terminate: plugins.terminate,
      programFor: (path) => {
        const name = programName(path);
        return name === null ? null : AUDISP_PROGRAMS[name] ?? null;
      },
      startProgram: (program, plugin, pid) => program(plugin.args, {
        pid,
        vfs,
        libcSyslog: (priority, ident, text) => plugins.libcSyslog(priority, ident, pid, text),
        localTime: this.deps.localTime,
        interpreter: this.deps.interpreter,
      }),
    }, this.dispatcherSettings(config));
  }

  private syncState(): void {
    if (this.writer === null) return;
    this.state = this.writer.isSuspended ? 'suspended' : 'running';
  }

  private dispatch(line: string): void {
    const writer = this.writer;
    if (writer === null) return;
    const config = writer.settings;
    if (config.logFormat === 'NOLOG') return;
    const formatted = config.logFormat === 'ENRICHED'
      ? formatEnriched(line, config, this.deps.interpreter())
      : formatRaw(line, config);
    writer.write(formatted);
    this.dispatcher?.dispatch(config.logFormat === 'ENRICHED' ? formatted : line);
    this.syncState();
  }

  private registerWithKernel(startup: AuditdStartupState): void {
    const kernel = this.deps.rules.kernel;
    this.deps.rules.runAsDaemon(() => {
      if (startup !== 'nochange' && kernel.status.enabled < 2) {
        kernel.request(K.AUDIT_SET, 0, {
          kind: 'status',
          status: { ...kernel.status, mask: K.AUDIT_STATUS_ENABLED, enabled: startup === 'enable' ? 1 : 0 },
        });
      }
    });
    kernel.status.pid = this.pid();
  }

  private runStop(): void {
    if (this.state === 'stopped') return;
    this.deps.auditLog.record('DAEMON_END', {
      op: 'terminate',
      auid: AUDIT_UNSET,
      uid: 0,
      ses: AUDIT_UNSET,
      pid: this.pid(),
      subj: 'unconfined',
      res: 'success',
    });
    this.dispatcher?.shutdown();
    this.dispatcher = null;
    this.state = 'stopped';
    this.deps.rules.kernel.status.pid = 0;
    this.deps.auditLog.setSink(null);
    this.writer?.shutdown();
    this.writer = null;
    this.deps.vfs.deleteFile(AUDITD_STATE_FILE);
    this.deps.vfs.deleteFile(AUDITD_PID_FILE);
    this.exitProcess(this.pid());
    this.ownPid = null;
  }

  private runReload(): void {
    if (this.writer === null) return;
    const loaded = loadAuditdConfig(this.deps.configFs, { configFile: AUDITD_CONF_PATH, allowLinks: false });
    this.emit(loaded.messages);
    if (loaded.rc !== 0) return;
    this.log('NOTICE', `config change requested by pid=${this.pid()} auid=${AUDIT_UNSET} subj=?`);
    this.writer.reconfigure(loaded.config);
    this.config = this.writer.settings;
    this.dispatcher?.reconfigure(this.dispatcherSettings(this.config));
    this.deps.auditLog.record('DAEMON_CONFIG', {
      op: 'reconfigure',
      state: 'changed',
      auid: AUDIT_UNSET,
      pid: this.pid(),
      subj: 'unconfined',
      res: 'success',
    });
    this.syncState();
  }

  private runRotate(senderPid: number): void {
    if (this.writer === null) return;
    this.writer.rotateNow();
    this.deps.auditLog.record('DAEMON_ROTATE', {
      op: 'rotate-logs', auid: AUDIT_UNSET, uid: 0, ses: AUDIT_UNSET, pid: senderPid, subj: 'unconfined', res: 'success',
    });
    this.syncState();
  }

  private runResume(senderPid: number): void {
    if (this.writer === null) return;
    this.writer.resumeLogging();
    this.deps.auditLog.record('DAEMON_RESUME', {
      op: 'resume-logging', auid: AUDIT_UNSET, pid: senderPid, subj: 'unconfined', res: 'success',
    });
    this.syncState();
  }

  private writeStateFile(): void {
    if (this.writer === null) return;
    const seconds = Math.floor(simulationNowMs() / 1000);
    const lines = [
      `audit version = ${AUDIT_VERSION}`,
      `current time = ${this.deps.localTime(seconds)}`,
      `process priority = ${-this.config.priorityBoost}`,
      ...this.writer.stateLines(),
      ...(this.dispatcher?.stateLines() ?? []),
    ];
    this.deps.vfs.writeFile(AUDITD_STATE_FILE, `${lines.join('\n')}\n`, 0, 0, 0o137);
  }
}
