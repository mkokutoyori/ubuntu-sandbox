/**
 * LinuxServer - Linux server (root profile + Oracle process API).
 *
 * Phase 3: all logic lives in `LinuxMachine`. `LinuxServer` is a thin
 * shell that provides the server profile to the parent constructor
 * and exposes the Oracle-specific pass-throughs (`registerProcess`,
 * `unregisterProcess`, `clearSystemProcesses`) used by
 * `OracleFilesystemSync` to keep the Linux process table in sync with
 * `STARTUP` / `SHUTDOWN` reactively.
 */

import type { DeviceType } from '../core/types';
import { LinuxMachine } from './LinuxMachine';
import { LINUX_SERVER_PROFILE } from './linux/LinuxProfile';
import { getOracleDatabase, createSQLPlusSession } from '@/terminal/commands/database';
import { handleLsnrctl, handleTnsping, handleAdrci, handleExpdp, handleImpdp } from '@/terminal/commands/OracleCommands';
import { ReactiveRmanSubShell } from '@/terminal/subshells/rman';
import type { HostCapableDevice } from '@/network';

export class LinuxServer extends LinuxMachine {
  constructor(
    type: DeviceType = 'linux-server',
    name: string = 'Server',
    x: number = 0,
    y: number = 0,
  ) {
    super(type, name, x, y, LINUX_SERVER_PROFILE);
    // Wire Oracle bootstrap so `sqlplus` from the bash interpreter
    // actually boots the instance (pmon/smon/lgwr appear in ps -ef).
    this.executor._oracleBootstrap = (args: string[], stdin?: string) => {
      const db = getOracleDatabase(this.id);
      const banner =
        'SQL*Plus: Release 19.0.0.0.0 - Production\n\n' +
        'Connected to:\nOracle Database 19c Enterprise Edition Release 19.0.0.0.0\n';
      // SQL commands can arrive on the command line or piped on stdin
      // (`echo "SHUTDOWN ABORT;" | sqlplus / as sysdba`).
      const script = `${args.join(' ')}\n${stdin ?? ''}`;

      // SHUTDOWN [ABORT|IMMEDIATE|TRANSACTIONAL|NORMAL] — stop the
      // instance; OracleInstance.shutdown publishes background-process-
      // stopped, which clears ora_pmon/ora_smon from the process table.
      const shut = /\bSHUTDOWN\b\s*(ABORT|IMMEDIATE|TRANSACTIONAL|NORMAL)?/i.exec(script);
      if (shut) {
        const mode = (shut[1]?.toUpperCase() ?? 'NORMAL') as
          'NORMAL' | 'IMMEDIATE' | 'TRANSACTIONAL' | 'ABORT';
        const lines = db.instance.shutdown(mode);
        return `${banner}\nSQL> ${lines.join('\n')}\nSQL> Disconnected from Oracle Database 19c.`;
      }
      // STARTUP piped in re-opens a stopped instance.
      if (/\bSTARTUP\b/i.test(script) && db.instance.state === 'SHUTDOWN') {
        const lines = db.instance.startup();
        return `${banner}\nSQL> ${lines.join('\n')}\nSQL> Disconnected from Oracle Database 19c.`;
      }

      // Run piped/arg SQL through the real engine — for both
      // `user/pass@conn "SQL"` and `… | sqlplus / as sysdba` (used to
      // drop the SQL on the sysdba path and fake "1 row selected" on the
      // password path).
      const isSysdba = /^\s*\/\s+as\s+sysdba\s*$/i.test(args.join(' '));
      const connectArg = args.find(a => !a.startsWith('-') && (a.includes('/') || a.includes('@')));
      const sqlRe = /\b(select|insert|update|delete|merge|begin|exec|create|drop|alter|commit|rollback|truncate|grant|revoke)\b/i;
      const sqlSource = [
        ...args.filter(a => a !== connectArg && !a.startsWith('-') && sqlRe.test(a)),
        stdin ?? '',
      ].join('\n').trim();
      const connArgs = isSysdba ? ['/', 'as', 'sysdba'] : connectArg ? [connectArg] : null;
      if (sqlSource && connArgs && db.instance.state === 'OPEN') {
        const { session, loginOutput } = createSQLPlusSession(this.id, connArgs);
        if (loginOutput.some(l => /^ERROR|ORA-\d/.test(l))) return loginOutput.join('\n');
        const out: string[] = [];
        for (const raw of sqlSource.split(';')) {
          const stmt = raw.trim();
          if (stmt) out.push(...session.processLine(`${stmt};`).output);
        }
        session.disconnect();
        return out.join('\n');
      }
      if (args.length === 0 || isSysdba) {
        return `${banner}\nSQL> Disconnected from Oracle Database 19c.`;
      }
      return null;
    };
    // Both the interactive terminal and the programmatic shell path
    // (executeShellCommandSync / SSH / scripts) go through the same real
    // handlers so lsnrctl/tnsping never diverge.
    this.executor._oracleListener = (args: string[]) => {
      const lines: string[] = [];
      handleLsnrctl(this as unknown as HostCapableDevice, args, (text) => lines.push(text));
      return lines.join('\n');
    };
    this.executor._oracleTnsping = (args: string[]) => {
      const lines: string[] = [];
      handleTnsping(this as unknown as HostCapableDevice, args, (text) => lines.push(text));
      return lines.join('\n');
    };
    this.executor._oracleUtil = (cmd: string, args: string[]) => {
      const handler = cmd === 'expdp' ? handleExpdp
        : cmd === 'impdp' ? handleImpdp
        : cmd === 'adrci' ? handleAdrci : null;
      if (!handler) return null;
      const lines: string[] = [];
      handler(this as unknown as HostCapableDevice, args, (text) => lines.push(text));
      return lines.join('\n');
    };
    // `rman target / <<EOF … EOF` and `echo "BACKUP …;" | rman target /`
    // drive the real reactive RMAN engine, not a banner-only stub.
    this.executor._oracleRman = (args: string[], stdin?: string) => {
      const { subShell, banner } = ReactiveRmanSubShell.create(this, args);
      const out = [...banner];
      const script = (stdin ?? '').split(/\r?\n/).map(l => l.trim()).filter(Boolean);
      for (const line of script) {
        const res = subShell.processLine(line);
        out.push(...res.output);
        if (res.exit) break;
      }
      subShell.dispose();
      return out.join('\n');
    };
  }

  /** Expose a background process in `ps` output (used by Oracle DBMS). */
  registerProcess(pid: number, user: string, command: string): void {
    this.executor.registerProcess(pid, user, command);
  }

  /** Reactive counterpart of registerProcess — removes one entry. */
  unregisterProcess(pid: number): void {
    this.executor.unregisterProcess(pid);
  }

  externalPidForOsPid(osPid: number): number | undefined {
    return this.executor.externalPidForOsPid(osPid);
  }

  /** Clear all externally registered processes. */
  clearSystemProcesses(): void {
    this.executor.clearSystemProcesses();
  }
}
