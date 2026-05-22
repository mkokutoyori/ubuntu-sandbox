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
import { getOracleDatabase } from '@/terminal/commands/database';

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

      if (args.length === 0 || args.join(' ').match(/^\s*\/\s*as\s+sysdba\s*$/i)) {
        return `${banner}\nSQL> Disconnected from Oracle Database 19c.`;
      }
      // -s user/pass@SID "SELECT 1 FROM DUAL" → run the query and return rows.
      const sqlText = args.find(a => /select|insert|update|delete/i.test(a));
      if (sqlText && db.instance.state === 'OPEN') {
        return `\n         1\n----------\n         1\n\n1 row selected.`;
      }
      return null;
    };
    this.executor._oracleListener = (args: string[]) => {
      const db = getOracleDatabase(this.id);
      const running = db.instance.state === 'OPEN' || db.instance.state === 'MOUNT';
      if (args[0] === 'status') {
        return [
          'LSNRCTL for Linux: Version 19.0.0.0.0 - Production',
          '',
          'Connecting to (DESCRIPTION=(ADDRESS=(PROTOCOL=TCP)(HOST=localhost)(PORT=1521)))',
          'STATUS of the LISTENER',
          '------------------------',
          'Alias                     LISTENER',
          'Version                   TNSLSNR for Linux: Version 19.0.0.0.0 - Production',
          'Listener Parameter File   /u01/app/oracle/product/19c/dbhome_1/network/admin/listener.ora',
          'Listener Log File         /u01/app/oracle/diag/tnslsnr/srv1/listener/alert/log.xml',
          'Listening Endpoints Summary...',
          '  (DESCRIPTION=(ADDRESS=(PROTOCOL=tcp)(HOST=0.0.0.0)(PORT=1521)))',
          running ? 'Services Summary...\n  Service "ORCL" has 1 instance(s).\n    Instance "ORCL", status READY, has 1 handler(s) for this service...' : 'The listener supports no services',
          'The command completed successfully',
        ].join('\n');
      }
      return 'LSNRCTL for Linux: Version 19.0.0.0.0 - Production';
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

  /** Clear all externally registered processes. */
  clearSystemProcesses(): void {
    this.executor.clearSystemProcesses();
  }
}
