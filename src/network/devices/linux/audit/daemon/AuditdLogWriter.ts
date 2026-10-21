import type { AppendDescriptor, VirtualFileSystem } from '../../VirtualFileSystem';
import type { AuditdConfig, AuditPriority, FailureAction } from './AuditdConfig';

const MEGABYTE = 1024 * 1024;
const BLOCK_SIZE = 4096;
const NO_SPACE = 'No space left on device';
const NO_SUCH_FILE = 'No such file or directory';
const MIN_FREE_BLOCKS = 5;

export interface AuditdLogEnv {
  readonly vfs: VirtualFileSystem;
  syslog(priority: AuditPriority, text: string): void;
  stopDaemon(): void;
  changeRunlevel(level: 'single' | 'halt'): void;
  execute(path: string): void;
  sendMail(subject: string, body: string, account: string): void;
}

function isAppendFailure(value: AppendDescriptor | { error: string }): value is { error: string } {
  return 'error' in value;
}

export class AuditdLogWriter {
  private handle: AppendDescriptor | null = null;
  private logSize = 0;
  private suspended = false;
  private spaceLeft = true;
  private spaceWarning = false;
  private adminSpaceWarning = false;
  private diskErrorWarnings = 0;
  private knownLogs = 0;
  private lastLog = 1;

  constructor(private config: AuditdConfig, private readonly env: AuditdLogEnv) {}

  get settings(): AuditdConfig {
    return this.config;
  }

  get isSuspended(): boolean {
    return this.suspended;
  }

  get hasLogOpen(): boolean {
    return this.handle !== null;
  }

  start(): boolean {
    this.handle = null;
    this.fixDiskPermissions();
    if (this.openAuditLog()) return false;
    this.setupPercentages();
    this.checkLogFileSize();
    this.checkExcessLogs();
    this.checkSpaceLeft();
    return true;
  }

  shutdown(): void {
    this.handle = null;
  }

  write(line: string): void {
    if (this.suspended || !this.config.writeLogs || this.handle === null) return;
    const written = this.handle.append(`${line}\n`);
    if (written === null) {
      this.logSize += line.length + 1;
      this.checkLogFileSize();
      if (this.logSize % 8 < 3) this.checkSpaceLeft();
      this.diskErrorWarnings = 0;
      return;
    }
    if (written === NO_SPACE) {
      if (this.spaceLeft) {
        this.spaceLeft = false;
        this.doDiskFullAction();
      }
      return;
    }
    this.doDiskErrorAction('write', written);
  }

  rotateNow(): void {
    if (this.config.maxLogSizeAction === 'KEEP_LOGS') this.shiftLogs();
    else this.rotateLogs(0, 0);
  }

  resumeLogging(): void {
    this.env.syslog('NOTICE', 'Audit daemon is attempting to resume logging.');
    this.suspended = false;
    this.spaceLeft = true;
    if (this.handle === null) {
      this.fixDiskPermissions();
      if (this.openAuditLog()) {
        this.env.syslog('WARNING', 'Could not reopen a log after resume logging');
        this.suspended = true;
        this.doDiskErrorAction('resume', NO_SUCH_FILE);
      } else {
        this.checkLogFileSize();
      }
      this.env.syslog('NOTICE', 'Audit daemon resumed logging.');
    }
    this.diskErrorWarnings = 0;
    this.spaceWarning = false;
    this.adminSpaceWarning = false;
  }

  reconfigure(next: AuditdConfig): void {
    const current = this.config;
    let needSizeCheck = false;
    let needReopen = false;
    let needSpaceCheck = false;

    current.diskErrorAction = next.diskErrorAction;
    current.diskErrorExe = next.diskErrorExe;
    this.diskErrorWarnings = 0;
    current.numLogs = next.numLogs;
    current.freq = next.freq;
    current.priorityBoost = next.priorityBoost;
    current.logFormat = next.logFormat;
    if (current.writeLogs !== next.writeLogs) {
      current.writeLogs = next.writeLogs;
      needReopen = true;
    }
    if (current.logGroup !== next.logGroup) {
      current.logGroup = next.logGroup;
      needReopen = true;
    }
    current.actionMailAcct = next.actionMailAcct;
    if (current.nodeNameFormat !== next.nodeNameFormat || (current.nodeName !== null && next.nodeName !== null && current.nodeName !== next.nodeName)) {
      current.nodeNameFormat = next.nodeNameFormat;
      current.nodeName = next.nodeName;
    }
    current.distributeNetworkEvents = next.distributeNetworkEvents;
    current.qDepth = next.qDepth;
    current.overflowAction = next.overflowAction;
    current.maxRestarts = next.maxRestarts;
    current.pluginDir = next.pluginDir;

    if (current.maxLogSizeAction !== next.maxLogSizeAction) {
      current.maxLogSizeAction = next.maxLogSizeAction;
      needSizeCheck = true;
    }
    if (current.maxLogSize !== next.maxLogSize) {
      current.maxLogSize = next.maxLogSize;
      needSizeCheck = true;
    }
    if (needSizeCheck) {
      this.suspended = false;
      this.checkLogFileSize();
    }

    if (current.flush !== next.flush) {
      current.flush = next.flush;
      needReopen = true;
    }
    if (current.logFile !== next.logFile) {
      current.logFile = next.logFile;
      needReopen = true;
      needSpaceCheck = true;
    }
    if (needReopen) {
      this.handle = null;
      this.fixDiskPermissions();
      if (this.openAuditLog()) {
        this.env.syslog('ERR', 'Could not reopen a log after reconfigure');
        this.suspended = true;
        this.doDiskErrorAction('reconfig', NO_SUCH_FILE);
      } else {
        this.suspended = false;
        this.checkLogFileSize();
      }
    }

    if (current.spaceLeft !== next.spaceLeft) {
      current.spaceLeft = next.spaceLeft;
      needSpaceCheck = true;
    }
    if (current.spaceLeftPercent !== next.spaceLeftPercent) {
      current.spaceLeftPercent = next.spaceLeftPercent;
      needSpaceCheck = true;
    }
    if (current.spaceLeftAction !== next.spaceLeftAction) {
      current.spaceLeftAction = next.spaceLeftAction;
      needSpaceCheck = true;
    }
    if (current.spaceLeftExe !== null || next.spaceLeftExe !== null) {
      if (next.spaceLeftExe !== null && current.spaceLeftExe !== next.spaceLeftExe) needSpaceCheck = true;
      current.spaceLeftExe = next.spaceLeftExe;
    }
    if (current.adminSpaceLeft !== next.adminSpaceLeft) {
      current.adminSpaceLeft = next.adminSpaceLeft;
      needSpaceCheck = true;
    }
    if (current.adminSpaceLeftPercent !== next.adminSpaceLeftPercent) {
      current.adminSpaceLeftPercent = next.adminSpaceLeftPercent;
      needSpaceCheck = true;
    }
    if (current.adminSpaceLeftAction !== next.adminSpaceLeftAction) {
      current.adminSpaceLeftAction = next.adminSpaceLeftAction;
      needSpaceCheck = true;
    }
    if (current.adminSpaceLeftExe !== null || next.adminSpaceLeftExe !== null) {
      if (next.adminSpaceLeftExe !== null && current.adminSpaceLeftExe !== next.adminSpaceLeftExe) needSpaceCheck = true;
      current.adminSpaceLeftExe = next.adminSpaceLeftExe;
    }
    if (current.diskFullAction !== next.diskFullAction) {
      current.diskFullAction = next.diskFullAction;
      needSpaceCheck = true;
    }
    if (current.diskFullExe !== null || next.diskFullExe !== null) {
      if (next.diskFullExe !== null && current.diskFullExe !== next.diskFullExe) needSpaceCheck = true;
      current.diskFullExe = next.diskFullExe;
    }

    if (needSpaceCheck) {
      const savedSuspended = this.suspended;
      this.setupPercentages();
      this.spaceWarning = false;
      this.adminSpaceWarning = false;
      this.spaceLeft = true;
      this.suspended = false;
      this.checkExcessLogs();
      this.checkSpaceLeft();
      if (!this.suspended) this.suspended = savedSuspended;
    }
  }

  stateLines(): string[] {
    const lines = [`writing to logs = ${this.config.writeLogs ? 'yes' : 'no'}`];
    if (!this.config.writeLogs) return lines;
    lines.push(
      `current log size = ${Math.floor(this.logSize / 1024)} KB`,
      `max log size = ${this.config.maxLogSize * (MEGABYTE / 1024)} KB`,
      `logs detected last rotate/shift = ${this.knownLogs}`,
      `space left on partition = ${this.spaceLeft ? 'yes' : 'no'}`,
    );
    if (this.handle !== null) {
      lines.push(
        `Logging partition free space ${Math.floor(this.freeBlocks() * BLOCK_SIZE / MEGABYTE)} MB`,
        `space_left setting ${this.config.spaceLeft} MB`,
        `admin_space_left setting ${this.config.adminSpaceLeft} MB`,
      );
    }
    lines.push(
      `logging suspended = ${this.suspended ? 'yes' : 'no'}`,
      `file system space action performed = ${this.spaceWarning ? 'yes' : 'no'}`,
      `admin space action performed = ${this.adminSpaceWarning ? 'yes' : 'no'}`,
      `disk error detected = ${this.diskErrorWarnings > 0 ? 'yes' : 'no'}`,
    );
    return lines;
  }

  private totalBlocks(): number {
    return Math.floor(this.env.vfs.getCapacityBytes() / BLOCK_SIZE);
  }

  private freeBlocks(): number {
    return Math.floor(this.env.vfs.freeBytes() / BLOCK_SIZE);
  }

  private setupPercentages(): void {
    const config = this.config;
    if (!config.writeLogs) return;
    const toMegabytes = (percent: number): number =>
      Math.floor((BLOCK_SIZE * Math.floor(this.totalBlocks() * (percent / 100))) / MEGABYTE);
    if (config.spaceLeftPercent !== 0) config.spaceLeft = toMegabytes(config.spaceLeftPercent);
    if (config.adminSpaceLeftPercent !== 0) config.adminSpaceLeft = toMegabytes(config.adminSpaceLeftPercent);
    if (config.spaceLeft <= config.adminSpaceLeft) {
      this.env.syslog('ERR', `Error - space_left(${config.spaceLeft}) must be larger than admin_space_left(${config.adminSpaceLeft})`);
    }
  }

  private closeLog(): void {
    this.handle = null;
  }

  private suspendLogging(): void {
    this.closeLog();
    this.suspended = true;
  }

  private checkLogFileSize(): void {
    const config = this.config;
    if (!config.writeLogs) return;
    const megabytes = Math.floor(this.logSize / MEGABYTE);
    if (megabytes < config.maxLogSize) return;
    switch (config.maxLogSizeAction) {
      case 'IGNORE':
        break;
      case 'SYSLOG':
        this.env.syslog('ERR', 'Audit daemon log file is larger than max size');
        break;
      case 'SUSPEND':
        this.env.syslog('ERR', 'Audit daemon is suspending logging due to logfile size.');
        this.suspendLogging();
        break;
      case 'ROTATE':
        if (config.numLogs > 1) {
          this.env.syslog('NOTICE', 'Audit daemon rotating log files');
          this.rotateLogs(0, 0);
        }
        break;
      case 'KEEP_LOGS':
        this.env.syslog('NOTICE', 'Audit daemon rotating log files with keep option');
        this.shiftLogs();
        break;
    }
  }

  private checkSpaceLeft(): void {
    if (this.handle === null) return;
    const config = this.config;
    const available = this.freeBlocks();
    if (available < MIN_FREE_BLOCKS) {
      this.spaceLeft = false;
      this.doDiskFullAction();
      return;
    }
    const blocksFor = (megabytes: number): number => megabytes * (MEGABYTE / BLOCK_SIZE);
    if (available < blocksFor(config.spaceLeft)) {
      if (!this.spaceWarning) {
        this.doSpaceLeftAction(false);
        if (config.spaceLeftAction !== 'ROTATE') this.spaceWarning = true;
      }
    } else if (this.spaceWarning && config.spaceLeftAction === 'SYSLOG') {
      this.spaceWarning = false;
    }
    if (available < blocksFor(config.adminSpaceLeft)) {
      if (!this.adminSpaceWarning) {
        this.doSpaceLeftAction(true);
        if (config.adminSpaceLeftAction !== 'ROTATE') this.adminSpaceWarning = true;
      }
    } else if (this.adminSpaceWarning && config.adminSpaceLeftAction === 'SYSLOG') {
      this.adminSpaceWarning = false;
    }
  }

  private runFailureAction(
    action: FailureAction,
    exe: string | null,
    messages: { readonly suspend: string | null; readonly single: string; readonly halt: string; readonly syslog: string | null; readonly unknown: string },
  ): void {
    switch (action) {
      case 'IGNORE':
        break;
      case 'SYSLOG':
        if (messages.syslog !== null) this.env.syslog('ALERT', messages.syslog);
        break;
      case 'ROTATE':
        if (this.config.numLogs > 1) {
          this.env.syslog('NOTICE', 'Audit daemon rotating log files');
          this.rotateLogs(0, 0);
        }
        break;
      case 'EXEC':
        this.suspendLogging();
        if (exe === null) this.env.syslog('ALERT', 'Safe_exec passed NULL for program to execute');
        else this.env.execute(exe);
        break;
      case 'SUSPEND':
        if (messages.suspend !== null) this.env.syslog('ALERT', messages.suspend);
        this.suspendLogging();
        break;
      case 'SINGLE':
        this.env.syslog('ALERT', messages.single);
        this.env.changeRunlevel('single');
        this.env.stopDaemon();
        break;
      case 'HALT':
        this.env.syslog('ALERT', messages.halt);
        this.env.changeRunlevel('halt');
        this.env.stopDaemon();
        break;
      default:
        this.env.syslog('ALERT', messages.unknown);
        break;
    }
  }

  private doSpaceLeftAction(admin: boolean): void {
    const config = this.config;
    const action = admin ? config.adminSpaceLeftAction : config.spaceLeftAction;
    if (action === 'EMAIL') {
      if (!admin) {
        this.env.sendMail('Audit Disk Space Alert',
          'The audit daemon is low on disk space for logging! Please take action\nto ensure no loss of service.', config.actionMailAcct);
        this.env.syslog('ALERT', 'Audit daemon is low on disk space for logging');
      } else {
        this.env.sendMail('Audit Admin Space Alert',
          'The audit daemon is very low on disk space for logging! Immediate action\nis required to ensure no loss of service.', config.actionMailAcct);
        this.env.syslog('ALERT', 'Audit daemon is very low on disk space for logging');
      }
      return;
    }
    this.runFailureAction(action, admin ? config.adminSpaceLeftExe : config.spaceLeftExe, {
      syslog: 'Audit daemon is low on disk space for logging',
      suspend: 'Audit daemon is suspending logging due to low disk space.',
      single: 'The audit daemon is now changing the system to single user mode and exiting due to low disk space',
      halt: 'The audit daemon is now halting the system and exiting due to low disk space',
      unknown: 'Audit daemon is low on disk space for logging and unknown action requested',
    });
  }

  private doDiskFullAction(): void {
    this.env.syslog('ALERT', 'Audit daemon has no space left on logging partition');
    this.runFailureAction(this.config.diskFullAction, this.config.diskFullExe, {
      syslog: null,
      suspend: 'Audit daemon is suspending logging due to no space left on logging partition.',
      single: 'The audit daemon is now changing the system to single user mode and exiting due to no space left on logging partition',
      halt: 'The audit daemon is now halting the system and exiting due to no space left on logging partition',
      unknown: 'Unknown disk full action requested',
    });
  }

  private doDiskErrorAction(func: string, error: string): void {
    const config = this.config;
    if (config.diskErrorAction === 'SYSLOG') {
      if (this.diskErrorWarnings < 5) {
        this.env.syslog('ALERT', `${func}: Audit daemon detected an error writing an event to disk (${error})`);
        this.diskErrorWarnings++;
      }
      return;
    }
    this.runFailureAction(config.diskErrorAction, config.diskErrorExe, {
      syslog: null,
      suspend: 'Audit daemon is suspending logging due to previously mentioned write error',
      single: 'The audit daemon is now changing the system to single user mode and exiting due to previously mentioned write error',
      halt: 'The audit daemon is now halting the system and exiting due to previously mentioned write error.',
      unknown: 'Unknown disk error action requested',
    });
  }

  private checkExcessLogs(): void {
    const config = this.config;
    if (config.maxLogSizeAction !== 'ROTATE' || config.numLogs < 2) return;
    for (let i = config.numLogs; ; i++) {
      const name = `${config.logFile}.${i}`;
      if (!this.env.vfs.deleteFile(name)) break;
      this.env.syslog('NOTICE', `Log ${name} removed as it exceeds num_logs parameter`);
    }
  }

  private fixDiskPermissions(): void {
    const config = this.config;
    const vfs = this.env.vfs;
    const dir = config.logFile.slice(0, Math.max(config.logFile.lastIndexOf('/'), 1));
    vfs.chmod(dir, config.logGroup !== 0 ? 0o750 : 0o700);
    vfs.chown(dir, 0, config.logGroup !== 0 ? config.logGroup : 0);
    for (let i = 1; i < config.numLogs; i++) {
      if (!vfs.chmod(`${config.logFile}.${i}`, config.logGroup !== 0 ? 0o440 : 0o400)) break;
    }
    vfs.chmod(config.logFile, config.logGroup !== 0 ? 0o640 : 0o600);
  }

  private renameLog(from: string, to: string): string | null {
    const vfs = this.env.vfs;
    if (vfs.resolveInode(from, false) === null) return NO_SUCH_FILE;
    return vfs.rename(from, to) ? null : 'Input/output error';
  }

  private rotateLogs(requestedLogs: number, keepLogs: number): void {
    const config = this.config;
    const vfs = this.env.vfs;
    if (config.numLogs < 2 && keepLogs === 0) {
      this.env.syslog('NOTICE', 'Log rotation disabled (num_logs < 2), skipping');
      return;
    }
    if (this.handle !== null) {
      vfs.chmod(config.logFile, config.logGroup !== 0 ? 0o440 : 0o400);
      vfs.chown(config.logFile, 0, config.logGroup);
      this.handle = null;
    }
    const numLogs = requestedLogs === 0 ? config.numLogs : requestedLogs;
    this.knownLogs = 0;
    for (let i = numLogs - 1; i > 1; i--) {
      const oldName = `${config.logFile}.${i - 1}`;
      const newName = `${config.logFile}.${i}`;
      const failure = this.renameLog(oldName, newName);
      if (failure === null) {
        if (this.knownLogs === 0) this.knownLogs = i + 1;
      } else if (failure !== NO_SUCH_FILE) {
        this.env.syslog('ERR', `Error rotating logs from ${oldName} to ${newName} (${failure})`);
        this.doDiskErrorAction('rotate', failure);
      }
    }
    const lowest = `${config.logFile}.1`;
    const failure = this.renameLog(config.logFile, lowest);
    if (failure !== null && failure !== NO_SUCH_FILE) {
      this.env.syslog('ERR', `Error rotating logs from ${config.logFile} to ${lowest} (${failure})`);
      this.doDiskErrorAction('rotate2', failure);
      vfs.chmod(config.logFile, config.logGroup !== 0 ? 0o640 : 0o600);
    }
    if (this.openAuditLog()) {
      this.env.syslog('CRIT', 'Could not reopen a log after rotating.');
      this.suspended = true;
      this.doDiskErrorAction('reopen', NO_SUCH_FILE);
    }
  }

  private shiftLogs(): void {
    const config = this.config;
    const vfs = this.env.vfs;
    const present = (name: string): boolean => vfs.resolveInode(name, true) !== null;
    let numLogs = this.lastLog;
    let name = `${config.logFile}.${numLogs}`;
    while (numLogs !== 0) {
      name = `${config.logFile}.${numLogs}`;
      if (!present(name)) break;
      numLogs++;
    }
    this.knownLogs = numLogs;
    if (numLogs <= this.lastLog && this.lastLog > 1) {
      this.env.syslog('WARNING', `Last known log disappeared (${name})`);
      numLogs = this.lastLog = 1;
      while (numLogs !== 0) {
        name = `${config.logFile}.${numLogs}`;
        if (!present(name)) break;
        numLogs++;
      }
      this.env.syslog('INFO', `Next log to use will be ${name}`);
    }
    this.lastLog = numLogs;
    this.rotateLogs(numLogs + 1, 1);
  }

  private openAuditLog(): boolean {
    const config = this.config;
    const vfs = this.env.vfs;
    if (!config.writeLogs) return false;
    const path = config.logFile;
    const existing = vfs.resolveInode(path, false);
    if (existing === null) {
      if (vfs.createFileAt(path, '', 0o640, 0, 0) === null) {
        this.env.syslog('ERR', `Unable to create ${path} (${NO_SUCH_FILE})`);
        this.env.syslog('CRIT', `Couldn't create log file ${path} (${NO_SUCH_FILE})`);
        return true;
      }
      this.logSize = 0;
    }
    const opened = vfs.openAppend(path, {
      mode: 0o640, uid: null, gid: null, directoryMode: 0o750, directoryUid: null, directoryGid: null,
      createDirectories: false, followSymlinks: false,
    });
    if (isAppendFailure(opened)) {
      this.env.syslog('CRIT', `Couldn't open log file ${path} (${opened.error})`);
      return true;
    }
    if (existing !== null) this.logSize = existing.size;
    vfs.chmod(path, config.logGroup !== 0 ? 0o640 : 0o600);
    vfs.chown(path, 0, config.logGroup);
    this.handle = opened;
    return false;
  }
}
