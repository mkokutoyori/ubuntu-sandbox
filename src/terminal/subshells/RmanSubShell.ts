/**
 * RmanSubShell — Interactive RMAN (Recovery Manager) sub-shell.
 *
 * Provides a realistic stubbed RMAN> prompt with common backup/recovery
 * commands returning plausible output.
 */

import type { KeyEvent } from '@/terminal/sessions/TerminalSession';
import type { ISubShell, SubShellResult } from './ISubShell';

function formatDate(): string {
  const now = new Date();
  const months = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];
  const day = String(now.getDate()).padStart(2, '0');
  const mon = months[now.getMonth()];
  const year = now.getFullYear();
  const h = String(now.getHours()).padStart(2, '0');
  const m = String(now.getMinutes()).padStart(2, '0');
  const s = String(now.getSeconds()).padStart(2, '0');
  return `${day}-${mon}-${year} ${h}:${m}:${s}`;
}

export class RmanSubShell implements ISubShell {
  private prompt = 'RMAN> ';
  private connected = false;

  private constructor() {}

  /**
   * Factory: create an RMAN sub-shell.
   * @param args  Command-line arguments (e.g. ['target', '/'])
   * @returns The sub-shell and banner lines.
   */
  static create(args: string[]): { subShell: RmanSubShell; banner: string[] } {
    const subShell = new RmanSubShell();
    const banner = [
      '',
      `Recovery Manager: Release 19.0.0.0.0 - Production on ${formatDate()}`,
      '',
      'Copyright (c) 1982, 2024, Oracle and/or its affiliates.  All rights reserved.',
      '',
    ];

    // Handle "rman target /" or "rman target sys/oracle@ORCL" on the command line
    const targetIdx = args.findIndex(a => a.toUpperCase() === 'TARGET');
    if (targetIdx !== -1) {
      subShell.connected = true;
      banner.push('connected to target database: ORCL (DBID=1234567890)');
      banner.push('');
    }

    return { subShell, banner };
  }

  getPrompt(): string {
    return this.prompt;
  }

  handleKey(e: KeyEvent): boolean {
    if (e.key === 'd' && e.ctrlKey) return true;
    if (e.key === 'c' && e.ctrlKey) return true;
    return false;
  }

  processLine(line: string): SubShellResult {
    const trimmed = line.trim();
    const upper = trimmed.toUpperCase();

    if (!trimmed) {
      return { output: [], exit: false, prompt: this.prompt };
    }

    // EXIT / QUIT
    if (upper === 'EXIT' || upper === 'QUIT') {
      return {
        output: ['Recovery Manager complete.'],
        exit: true,
        prompt: this.prompt,
      };
    }

    // HELP
    if (upper === 'HELP') {
      return { output: this.helpOutput(), exit: false, prompt: this.prompt };
    }

    // CONNECT TARGET
    if (upper.startsWith('CONNECT TARGET') || upper === 'CONNECT TARGET /') {
      this.connected = true;
      return {
        output: ['connected to target database: ORCL (DBID=1234567890)'],
        exit: false,
        prompt: this.prompt,
      };
    }

    // SHOW ALL
    if (upper === 'SHOW ALL') {
      return { output: this.showAllOutput(), exit: false, prompt: this.prompt };
    }

    // BACKUP DATABASE
    if (upper === 'BACKUP DATABASE') {
      return { output: this.backupOutput('database'), exit: false, prompt: this.prompt };
    }

    // BACKUP ARCHIVELOG ALL
    if (upper === 'BACKUP ARCHIVELOG ALL') {
      return { output: this.backupOutput('archivelog'), exit: false, prompt: this.prompt };
    }

    // BACKUP TABLESPACE <name>
    if (upper.startsWith('BACKUP TABLESPACE')) {
      const tsName = trimmed.split(/\s+/)[2] || 'USERS';
      return { output: this.backupOutput(`tablespace ${tsName.toUpperCase()}`), exit: false, prompt: this.prompt };
    }

    // LIST BACKUP SUMMARY
    if (upper === 'LIST BACKUP SUMMARY') {
      return { output: this.listBackupSummaryOutput(), exit: false, prompt: this.prompt };
    }

    // LIST BACKUP
    if (upper === 'LIST BACKUP') {
      return { output: this.listBackupOutput(), exit: false, prompt: this.prompt };
    }

    // REPORT SCHEMA
    if (upper === 'REPORT SCHEMA') {
      return { output: this.reportSchemaOutput(), exit: false, prompt: this.prompt };
    }

    // REPORT NEED BACKUP
    if (upper === 'REPORT NEED BACKUP') {
      return { output: this.reportNeedBackupOutput(), exit: false, prompt: this.prompt };
    }

    // CROSSCHECK BACKUP
    if (upper === 'CROSSCHECK BACKUP') {
      return { output: this.crosscheckOutput(), exit: false, prompt: this.prompt };
    }

    // DELETE EXPIRED BACKUP
    if (upper === 'DELETE EXPIRED BACKUP') {
      return { output: this.deleteExpiredOutput(), exit: false, prompt: this.prompt };
    }

    // DELETE OBSOLETE
    if (upper === 'DELETE OBSOLETE') {
      return { output: this.deleteObsoleteOutput(), exit: false, prompt: this.prompt };
    }

    // RESTORE DATABASE
    if (upper === 'RESTORE DATABASE') {
      return { output: this.restoreOutput(), exit: false, prompt: this.prompt };
    }

    // RECOVER DATABASE
    if (upper === 'RECOVER DATABASE') {
      return { output: this.recoverOutput(), exit: false, prompt: this.prompt };
    }

    // Unknown command
    return { output: this.errorOutput(), exit: false, prompt: this.prompt };
  }

  dispose(): void {
    // No resources to clean up
  }

  // ── Output generators ────────────────────────────────────────────

  private helpOutput(): string[] {
    return [
      '',
      '    RMAN commands:',
      '',
      '    BACKUP             - Back up database files',
      '    CONNECT            - Connect to target or catalog database',
      '    CROSSCHECK         - Verify backup availability',
      '    DELETE             - Delete backups or copies',
      '    EXIT               - Exit RMAN',
      '    HELP               - Display this help',
      '    LIST               - List backups and copies',
      '    QUIT               - Exit RMAN',
      '    RECOVER            - Perform media recovery',
      '    REPORT             - Report on backup status',
      '    RESTORE            - Restore database files',
      '    SHOW               - Show RMAN configuration',
      '',
    ];
  }

  private showAllOutput(): string[] {
    return [
      '',
      'RMAN configuration parameters for database with db_unique_name ORCL are:',
      'CONFIGURE RETENTION POLICY TO REDUNDANCY 1; # default',
      'CONFIGURE BACKUP OPTIMIZATION OFF; # default',
      'CONFIGURE DEFAULT DEVICE TYPE TO DISK; # default',
      'CONFIGURE CONTROLFILE AUTOBACKUP ON;',
      'CONFIGURE CONTROLFILE AUTOBACKUP FORMAT FOR DEVICE TYPE DISK TO \'%F\'; # default',
      'CONFIGURE DEVICE TYPE DISK PARALLELISM 1 BACKUP TYPE TO BACKUPSET; # default',
      'CONFIGURE DATAFILE BACKUP COPIES FOR DEVICE TYPE DISK TO 1; # default',
      'CONFIGURE ARCHIVELOG BACKUP COPIES FOR DEVICE TYPE DISK TO 1; # default',
      'CONFIGURE MAXSETSIZE TO UNLIMITED; # default',
      'CONFIGURE ENCRYPTION FOR DATABASE OFF; # default',
      'CONFIGURE ENCRYPTION ALGORITHM \'AES128\'; # default',
      'CONFIGURE COMPRESSION ALGORITHM \'BASIC\' AS OF RELEASE \'DEFAULT\' OPTIMIZE FOR LOAD TRUE;',
      'CONFIGURE ARCHIVELOG DELETION POLICY TO NONE; # default',
      '',
    ];
  }

  private backupOutput(what: string): string[] {
    const ts = formatDate();
    const tag = `TAG${ts.replace(/[- :]/g, '')}`;
    const piece = `ORCL_${Math.random().toString(36).slice(2, 10)}`;
    return [
      '',
      `Starting backup at ${ts}`,
      'allocated channel: ORA_DISK_1',
      'channel ORA_DISK_1: SID=142 device type=DISK',
      `channel ORA_DISK_1: starting full datafile backup set`,
      `channel ORA_DISK_1: specifying datafile(s) in backup set`,
      `channel ORA_DISK_1: backing up ${what}`,
      `piece handle=/u01/backup/${piece}.bkp tag=${tag}`,
      `channel ORA_DISK_1: backup set complete, elapsed time: 00:00:15`,
      `Finished backup at ${ts}`,
      '',
    ];
  }

  private listBackupOutput(): string[] {
    const ts = formatDate();
    return [
      '',
      'List of Backup Sets',
      '===================',
      '',
      `BS Key  Type LV Size       Device Type Elapsed Time Completion Time`,
      `------- ---- -- ---------- ----------- ------------ ---------------`,
      `1       Full    1.20G      DISK        00:00:15     ${ts}`,
      `        BP Key: 1   Status: AVAILABLE  Compressed: NO  Tag: TAG20260324`,
      `          Piece Name: /u01/backup/ORCL_full_01.bkp`,
      `  List of Datafiles in backup set 1`,
      `  File LV Type Ckp SCN    Ckp Time        Name`,
      `  ---- -- ---- ---------- --------------- ----`,
      `  1       Full 1892354    ${ts}  /u01/app/oracle/oradata/ORCL/system01.dbf`,
      `  2       Full 1892354    ${ts}  /u01/app/oracle/oradata/ORCL/sysaux01.dbf`,
      `  3       Full 1892354    ${ts}  /u01/app/oracle/oradata/ORCL/undotbs01.dbf`,
      `  4       Full 1892354    ${ts}  /u01/app/oracle/oradata/ORCL/users01.dbf`,
      '',
    ];
  }

  private listBackupSummaryOutput(): string[] {
    const ts = formatDate();
    return [
      '',
      'List of Backups',
      '===============',
      `Key     TY LV S Device Type Completion Time     #Pieces #Copies Compressed Tag`,
      `------- -- -- - ----------- ------------------- ------- ------- ---------- ---`,
      `1       B  F  A DISK        ${ts}  1       1       NO         TAG20260324`,
      '',
    ];
  }

  private reportSchemaOutput(): string[] {
    return [
      '',
      'Report of database schema for database with db_unique_name ORCL',
      '',
      'List of Permanent Datafiles',
      '===========================',
      'File Size(MB) Tablespace           RB segs Datafile Name',
      '---- -------- -------------------- ------- ------------------------',
      '1    800      SYSTEM               YES     /u01/app/oracle/oradata/ORCL/system01.dbf',
      '2    550      SYSAUX               NO      /u01/app/oracle/oradata/ORCL/sysaux01.dbf',
      '3    200      UNDOTBS1             YES     /u01/app/oracle/oradata/ORCL/undotbs01.dbf',
      '4    100      USERS                NO      /u01/app/oracle/oradata/ORCL/users01.dbf',
      '',
      'List of Temporary Files',
      '=======================',
      'File Size(MB) Tablespace           Maxsize(MB) Tempfile Name',
      '---- -------- -------------------- ----------- --------------------',
      '1    100      TEMP                 32768       /u01/app/oracle/oradata/ORCL/temp01.dbf',
      '',
    ];
  }

  private reportNeedBackupOutput(): string[] {
    return [
      '',
      'RMAN retention policy will be applied to the command',
      'RMAN retention policy is set to redundancy 1',
      'Report of files with 0 redundant backups',
      'File #backs Name',
      '----- ------ ---------------------------------------------------',
      '4     0      /u01/app/oracle/oradata/ORCL/users01.dbf',
      '',
    ];
  }

  private crosscheckOutput(): string[] {
    return [
      '',
      'allocated channel: ORA_DISK_1',
      'channel ORA_DISK_1: SID=142 device type=DISK',
      'crosschecked backup piece: found to be \'AVAILABLE\'',
      'Crosschecked 1 objects',
      '',
    ];
  }

  private deleteExpiredOutput(): string[] {
    return [
      '',
      'using channel ORA_DISK_1',
      'specification does not match any backup in the repository',
      '',
    ];
  }

  private deleteObsoleteOutput(): string[] {
    return [
      '',
      'RMAN retention policy will be applied to the command',
      'RMAN retention policy is set to redundancy 1',
      'using channel ORA_DISK_1',
      'no obsolete backups found',
      '',
    ];
  }

  private restoreOutput(): string[] {
    const ts = formatDate();
    return [
      '',
      `Starting restore at ${ts}`,
      'allocated channel: ORA_DISK_1',
      'channel ORA_DISK_1: SID=142 device type=DISK',
      '',
      'channel ORA_DISK_1: starting datafile backup set restore',
      'channel ORA_DISK_1: restoring datafile 00001 to /u01/app/oracle/oradata/ORCL/system01.dbf',
      'channel ORA_DISK_1: restoring datafile 00002 to /u01/app/oracle/oradata/ORCL/sysaux01.dbf',
      'channel ORA_DISK_1: restoring datafile 00003 to /u01/app/oracle/oradata/ORCL/undotbs01.dbf',
      'channel ORA_DISK_1: restoring datafile 00004 to /u01/app/oracle/oradata/ORCL/users01.dbf',
      'channel ORA_DISK_1: restore complete, elapsed time: 00:00:25',
      `Finished restore at ${ts}`,
      '',
    ];
  }

  private recoverOutput(): string[] {
    const ts = formatDate();
    return [
      '',
      `Starting recover at ${ts}`,
      'using channel ORA_DISK_1',
      '',
      'starting media recovery',
      'media recovery complete, elapsed time: 00:00:03',
      '',
      `Finished recover at ${ts}`,
      '',
    ];
  }

  private errorOutput(): string[] {
    return [
      'RMAN-00571: ===========================================================',
      'RMAN-00569: =============== ERROR MESSAGE STACK FOLLOWS ===============',
      'RMAN-00571: ===========================================================',
      'RMAN-00558: error encountered while parsing input command',
      'RMAN-01009: syntax error: found: unknown command',
      'RMAN-01007: at line 1 column 1 file: standard input',
    ];
  }
}
