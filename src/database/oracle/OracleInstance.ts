/**
 * OracleInstance — Simulates an Oracle database instance.
 *
 * Manages instance state (SHUTDOWN → NOMOUNT → MOUNT → OPEN),
 * background processes, SGA/PGA parameters, and redo log groups.
 */

import type { OracleDatabaseConfig } from '../engine/types/DatabaseConfig';
import { defaultOracleConfig } from '../engine/types/DatabaseConfig';

export type InstanceState = 'SHUTDOWN' | 'NOMOUNT' | 'MOUNT' | 'OPEN';

export interface BackgroundProcess {
  name: string;
  pid: number;
  description: string;
}

export interface RedoLogGroup {
  group: number;
  status: 'CURRENT' | 'ACTIVE' | 'INACTIVE' | 'UNUSED';
  members: string[];
  sizeBytes: number;
  sequence: number;
}

export interface SGAInfo {
  totalSize: string;
  sharedPool: string;
  bufferCache: string;
  redoLogBuffer: string;
  javaPool: string;
  largePool: string;
}

export class OracleInstance {
  readonly config: OracleDatabaseConfig;
  private _state: InstanceState = 'SHUTDOWN';
  private _startupTime: Date | null = null;
  private _backgroundProcesses: BackgroundProcess[] = [];
  private _redoLogGroups: RedoLogGroup[] = [];
  private _currentRedoGroup: number = 1;
  private _redoSequence: number = 1;
  private _alertLog: string[] = [];
  private _parameters: Map<string, string> = new Map();
  private _archiveLogMode: boolean;
  private _pidCounter: number = 1000;

  constructor(config?: Partial<OracleDatabaseConfig>) {
    this.config = { ...defaultOracleConfig(), ...config };
    this._archiveLogMode = this.config.archiveLogMode;
    this.initParameters();
    this.initRedoLogs();
  }

  // ── State management ─────────────────────────────────────────────

  get state(): InstanceState { return this._state; }
  get startupTime(): Date | null { return this._startupTime; }
  get isOpen(): boolean { return this._state === 'OPEN'; }

  startup(mode?: 'NOMOUNT' | 'MOUNT' | 'RESTRICT' | 'FORCE'): string[] {
    const output: string[] = [];
    const now = new Date();

    if (mode === 'FORCE' && this._state !== 'SHUTDOWN') {
      output.push(...this.shutdown('ABORT'));
    }

    if (this._state !== 'SHUTDOWN') {
      return [`ORA-01081: cannot start already-running ORACLE - shut it down first`];
    }

    this._startupTime = now;
    this.logAlert(`Starting ORACLE instance (normal)`);
    output.push(`ORACLE instance started.`);
    output.push('');

    // NOMOUNT
    this._state = 'NOMOUNT';
    this.startBackgroundProcesses();
    output.push(`Total System Global Area  ${this.config.sgaTarget} bytes`);
    output.push(`Fixed Size                  2.0M bytes`);
    output.push(`Variable Size             256.0M bytes`);
    output.push(`Database Buffers          128.0M bytes`);
    output.push(`Redo Buffers               16.0M bytes`);

    if (mode === 'NOMOUNT') {
      this.logAlert('Instance started in NOMOUNT mode');
      return output;
    }

    // MOUNT
    this._state = 'MOUNT';
    output.push(`Database mounted.`);
    this.logAlert('Database mounted');

    if (mode === 'MOUNT') return output;

    // OPEN
    this._state = 'OPEN';
    this._redoLogGroups[0].status = 'CURRENT';
    output.push(`Database opened.`);
    this.logAlert('Database opened');

    if (mode === 'RESTRICT') {
      output.push('Database opened in restricted mode.');
      this.logAlert('Database opened in restricted mode');
    }

    return output;
  }

  shutdown(mode?: 'NORMAL' | 'IMMEDIATE' | 'TRANSACTIONAL' | 'ABORT'): string[] {
    const output: string[] = [];

    if (this._state === 'SHUTDOWN') {
      return ['ORA-01034: ORACLE not available'];
    }

    const effectiveMode = mode ?? 'NORMAL';
    this.logAlert(`Shutting down instance (${effectiveMode.toLowerCase()})`);

    if (this._state === 'OPEN') {
      output.push('Database closed.');
      this.logAlert('Database closed');
    }
    if (this._state === 'OPEN' || this._state === 'MOUNT') {
      output.push('Database dismounted.');
      this.logAlert('Database dismounted');
    }

    output.push('ORACLE instance shut down.');
    this.logAlert('Instance shut down');

    this._state = 'SHUTDOWN';
    this._startupTime = null;
    this._backgroundProcesses = [];
    for (const rg of this._redoLogGroups) rg.status = 'UNUSED';

    return output;
  }

  // ── Background processes ──────────────────────────────────────────

  private startBackgroundProcesses(): void {
    const procs: [string, string][] = [
      ['PMON', 'Process Monitor'],
      ['SMON', 'System Monitor'],
      ['DBW0', 'Database Writer 0'],
      ['LGWR', 'Log Writer'],
      ['CKPT', 'Checkpoint'],
      ['RECO', 'Recovery'],
      ['MMON', 'Manageability Monitor'],
      ['MMNL', 'Manageability Monitor Light'],
    ];
    if (this._archiveLogMode) {
      procs.push(['ARC0', 'Archiver 0']);
    }
    this._backgroundProcesses = procs.map(([name, description]) => ({
      name, pid: this._pidCounter++, description,
    }));
  }

  getBackgroundProcesses(): BackgroundProcess[] {
    return [...this._backgroundProcesses];
  }

  // ── Redo logs ────────────────────────────────────────────────────

  private initRedoLogs(): void {
    this._redoLogGroups = [
      { group: 1, status: 'UNUSED', members: ['/u01/app/oracle/oradata/ORCL/redo01.log'], sizeBytes: 52428800, sequence: 0 },
      { group: 2, status: 'UNUSED', members: ['/u01/app/oracle/oradata/ORCL/redo02.log'], sizeBytes: 52428800, sequence: 0 },
      { group: 3, status: 'UNUSED', members: ['/u01/app/oracle/oradata/ORCL/redo03.log'], sizeBytes: 52428800, sequence: 0 },
    ];
  }

  switchLogfile(): string {
    if (this._state !== 'OPEN') return 'ORA-01034: ORACLE not available';
    const currentGroup = this._redoLogGroups.find(g => g.status === 'CURRENT');
    if (currentGroup) {
      currentGroup.status = 'ACTIVE';
      currentGroup.sequence = this._redoSequence;
    }
    this._redoSequence++;
    this._currentRedoGroup = (this._currentRedoGroup % this._redoLogGroups.length) + 1;
    const nextGroup = this._redoLogGroups[this._currentRedoGroup - 1];
    nextGroup.status = 'CURRENT';
    nextGroup.sequence = this._redoSequence;
    this.logAlert(`Thread 1 advanced to log sequence ${this._redoSequence}`);
    return `System altered.`;
  }

  getRedoLogGroups(): RedoLogGroup[] {
    return [...this._redoLogGroups];
  }

  // ── Parameters ───────────────────────────────────────────────────

  private initParameters(): void {
    const p = this._parameters;
    p.set('db_name', this.config.sid);
    p.set('db_block_size', String(this.config.dbBlockSize));
    p.set('sga_target', this.config.sgaTarget);
    p.set('pga_aggregate_target', this.config.pgaAggregateTarget);
    p.set('processes', String(this.config.processes));
    p.set('sessions', String(this.config.maxSessions));
    p.set('open_cursors', String(this.config.openCursors));
    p.set('undo_management', this.config.undoManagement);
    p.set('undo_tablespace', this.config.undoTablespace);
    p.set('compatible', this.config.compatibleVersion);
    p.set('audit_trail', this.config.auditTrail);
    p.set('db_domain', 'localdomain');
    p.set('instance_name', this.config.sid);
    p.set('service_names', this.config.serviceName);
    p.set('remote_login_passwordfile', 'EXCLUSIVE');
    p.set('diagnostic_dest', '/u01/app/oracle');
    p.set('control_files', '/u01/app/oracle/oradata/ORCL/control01.ctl, /u01/app/oracle/oradata/ORCL/control02.ctl');
    p.set('log_archive_dest_1', `LOCATION=/u01/app/oracle/archivelog`);
    p.set('archive_log_mode', this._archiveLogMode ? 'ENABLED' : 'DISABLED');
  }

  getParameter(name: string): string | undefined {
    return this._parameters.get(name.toLowerCase());
  }

  setParameter(name: string, value: string): void {
    this._parameters.set(name.toLowerCase(), value);
  }

  getAllParameters(): Map<string, string> {
    return new Map(this._parameters);
  }

  // ── SGA Info ─────────────────────────────────────────────────────

  getSGAInfo(): SGAInfo {
    return {
      totalSize: this.config.sgaTarget,
      sharedPool: '256M',
      bufferCache: '128M',
      redoLogBuffer: '16M',
      javaPool: '64M',
      largePool: '32M',
    };
  }

  // ── Alert log ────────────────────────────────────────────────────

  private logAlert(message: string): void {
    const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
    this._alertLog.push(`${ts}: ${message}`);
  }

  getAlertLog(): string[] {
    return [...this._alertLog];
  }

  // ── Archive log mode ─────────────────────────────────────────────

  get archiveLogMode(): boolean { return this._archiveLogMode; }

  setArchiveLogMode(enabled: boolean): string {
    if (this._state !== 'MOUNT') {
      return 'ORA-01126: database must be mounted and not open for this operation';
    }
    this._archiveLogMode = enabled;
    this._parameters.set('archive_log_mode', enabled ? 'ENABLED' : 'DISABLED');
    this.logAlert(`Archive log mode ${enabled ? 'enabled' : 'disabled'}`);
    return 'Database altered.';
  }

  // ── Version ──────────────────────────────────────────────────────

  getVersionBanner(): string[] {
    return [
      'Oracle Database 19c Enterprise Edition Release 19.0.0.0.0 - Production',
      'Version 19.3.0.0.0',
    ];
  }
}
