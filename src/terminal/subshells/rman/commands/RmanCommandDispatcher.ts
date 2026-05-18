/**
 * RmanCommandDispatcher — pattern-matching invoker for IRmanCommand.
 *
 * First registered regex that matches wins. registerCommand() is the
 * Open/Closed extension point.
 */

import { ok, err, type Result } from '../core/Result';
import type { RmanError } from '../core/RmanError';
import type { IRmanCommand, RmanCommandContext } from './types';
import { BackupCommand } from './BackupCommand';
import { RestoreCommand } from './RestoreCommand';
import { RecoverCommand } from './RecoverCommand';
import { CrosscheckCommand } from './CrosscheckCommand';
import { DeleteCommand } from './DeleteCommand';
import { ListBackupCommand } from './ListBackupCommand';
import { ReportCommand } from './ReportCommand';
import { ShowCommand } from './ShowCommand';
import { ConnectCommand } from './ConnectCommand';
import { HelpCommand } from './HelpCommand';
import { ConfigureCommand } from './ConfigureCommand';
import { AllocateChannelCommand } from './AllocateChannelCommand';
import { ReleaseChannelCommand } from './ReleaseChannelCommand';
import { CatalogCommand } from './CatalogCommand';
import { DuplicateCommand } from './DuplicateCommand';
import { ChangeCommand } from './ChangeCommand';
import { SetCommand } from './SetCommand';
import { ValidateCommand } from './ValidateCommand';
import { ConnectAuxiliaryCommand } from './ConnectAuxiliaryCommand';
import { ResyncCatalogCommand } from './ResyncCatalogCommand';
import {
  CreateCatalogCommand, CreateVirtualCatalogCommand, GrantCatalogCommand,
  RegisterDatabaseCommand, UnregisterDatabaseCommand, ConnectCatalogCommand,
  ListDbUniqueNameCommand, AlterDatabaseOpenResetlogsCommand,
  SwitchDatafileCommand, ResetDatabaseCommand, SqlMacroCommand,
} from './RecoveryCatalogCommands';
import { BlockRecoverCommand } from './BlockRecoverCommand';
import { RestoreSystemCommand } from './RestoreSystemCommands';
import {
  CreateScriptCommand, ReplaceScriptCommand, DeleteScriptCommand,
  PrintScriptCommand, ExecuteScriptCommand, ListScriptNamesCommand,
} from './ScriptCommands';

interface DispatchEntry {
  pattern: RegExp;
  command: IRmanCommand<unknown>;
}

export class RmanCommandDispatcher {
  private readonly _entries: DispatchEntry[] = [];

  constructor() { this._registerDefaults(); }

  registerCommand(pattern: RegExp, command: IRmanCommand<unknown>): void {
    this._entries.push({ pattern, command });
  }

  dispatch(line: string, cmdCtx: RmanCommandContext): Result<string[], RmanError> {
    const trimmed = line.trim();
    for (const { pattern, command } of this._entries) {
      // Test the upper-cased line so command keywords are case-insensitive,
      // but if there are capture groups, re-run against the original line
      // to preserve user-typed argument case.
      const m = trimmed.toUpperCase().match(pattern);
      if (m) {
        const capturedRaw = trimmed.match(pattern);
        const args = (capturedRaw ?? m).slice(1).filter((x): x is string => x !== undefined);
        const r = command.execute(args, cmdCtx);
        if (!r.ok) return r as Result<string[], RmanError>;
        const value = r.value;
        return ok(Array.isArray(value) ? (value as string[]) : []);
      }
    }
    return err({ code: 'RMAN_01009', message: `syntax error: found: unknown command: ${trimmed}` });
  }

  private _registerDefaults(): void {
    this._entries.push(
      { pattern: /^CONNECT TARGET(.*)$/i,                          command: new ConnectCommand() },
      // Recovery-catalog DDL (in-memory no-ops)
      { pattern: /^CREATE CATALOG$/i,                                            command: new CreateCatalogCommand() },
      { pattern: /^CREATE VIRTUAL CATALOG (\S+)$/i,                              command: new CreateVirtualCatalogCommand() },
      { pattern: /^GRANT CATALOG FOR DATABASE (\S+) TO (\S+)$/i,                 command: new GrantCatalogCommand() },
      { pattern: /^REGISTER DATABASE$/i,                                         command: new RegisterDatabaseCommand() },
      { pattern: /^UNREGISTER DATABASE(?:\s+(\S+))?(?:\s+NOPROMPT)?$/i,          command: new UnregisterDatabaseCommand() },
      { pattern: /^CONNECT CATALOG(?:\s+(.*))?$/i,                               command: new ConnectCatalogCommand() },
      { pattern: /^LIST DB_UNIQUE_NAME OF DATABASE$/i,                           command: new ListDbUniqueNameCommand() },
      { pattern: /^ALTER DATABASE OPEN RESETLOGS$/i,                             command: new AlterDatabaseOpenResetlogsCommand() },
      { pattern: /^SWITCH DATAFILE (ALL|\d+)$/i,                                 command: new SwitchDatafileCommand() },
      { pattern: /^RESET DATABASE(?: TO INCARNATION (\d+))?$/i,                  command: new ResetDatabaseCommand() },
      { pattern: /^SQL ("[^"]+"|'[^']+')$/i,                                     command: new SqlMacroCommand() },
      // Block-level recovery
      { pattern: /^BLOCKRECOVER DATAFILE (\d+) BLOCK (\d+)$/i,                   command: new BlockRecoverCommand('BY_BLOCK') },
      { pattern: /^BLOCKRECOVER CORRUPTION LIST$/i,                              command: new BlockRecoverCommand('CORRUPTION_LIST') },
      { pattern: /^RECOVER COPY OF DATABASE$/i,                                  command: new BlockRecoverCommand('COPY_OF_DATABASE') },
      { pattern: /^RECOVER COPY OF DATAFILE (\d+)$/i,                            command: new BlockRecoverCommand('COPY_OF_DATAFILE') },
      // Stored scripts
      { pattern: /^CREATE SCRIPT (\S+)\s*\{.*\}\s*;?$/i,                         command: new CreateScriptCommand() },
      { pattern: /^CREATE SCRIPT (\S+)$/i,                                       command: new CreateScriptCommand() },
      { pattern: /^REPLACE SCRIPT (\S+)\s*\{.*\}\s*;?$/i,                        command: new ReplaceScriptCommand() },
      { pattern: /^DELETE SCRIPT (\S+)$/i,                                       command: new DeleteScriptCommand() },
      { pattern: /^PRINT SCRIPT (\S+)$/i,                                        command: new PrintScriptCommand() },
      { pattern: /^EXECUTE SCRIPT (\S+|'[^']+')$/i,                              command: new ExecuteScriptCommand() },
      { pattern: /^LIST SCRIPT NAMES$/i,                                         command: new ListScriptNamesCommand() },
      // VALIDATE / CONTROLFILE / INCREMENTAL — match before plain "BACKUP DATABASE"
      { pattern: /^BACKUP VALIDATE DATABASE$/i,                    command: new BackupCommand('validate') },
      { pattern: /^BACKUP CURRENT CONTROLFILE(.*)$/i,              command: new BackupCommand('controlfile') },
      { pattern: /^BACKUP INCREMENTAL LEVEL (\d)(?:\s+(CUMULATIVE))? DATABASE(.*)$/i, command: new BackupCommand('incremental') },
      { pattern: /^BACKUP COMPRESSED BACKUPSET DATABASE(.*)$/i,    command: new BackupCommand('database', true) },
      { pattern: /^BACKUP NOT BACKED UP (\d+) TIMES DATABASE(.*)$/i, command: new BackupCommand('database', false, true) },
      { pattern: /^BACKUP DATABASE(.*)$/i,                         command: new BackupCommand('database') },
      { pattern: /^BACKUP ARCHIVELOG ALL(.*)$/i,                   command: new BackupCommand('archivelog') },
      { pattern: /^BACKUP ARCHIVELOG (FROM SCN \d+.*)$/i,          command: new BackupCommand('archivelog') },
      { pattern: /^BACKUP TABLESPACE (\S+)(.*)$/i,                 command: new BackupCommand('tablespace') },
      { pattern: /^BACKUP DATAFILE (\d+)(.*)$/i,                   command: new BackupCommand('datafile')   },
      { pattern: /^BACKUP SPFILE(.*)$/i,                           command: new BackupCommand('spfile')     },
      // RESTORE CONTROLFILE / SPFILE — précédent les autres RESTORE pour ne pas
      // matcher la pattern DATABASE accidentellement
      { pattern: /^RESTORE CONTROLFILE FROM AUTOBACKUP$/i,           command: new RestoreSystemCommand('CONTROLFILE_AUTOBACKUP') },
      { pattern: /^RESTORE CONTROLFILE FROM ('[^']+')$/i,            command: new RestoreSystemCommand('CONTROLFILE_FROM') },
      { pattern: /^RESTORE SPFILE FROM AUTOBACKUP$/i,                command: new RestoreSystemCommand('SPFILE_AUTOBACKUP') },
      { pattern: /^RESTORE SPFILE TO ('[^']+')$/i,                   command: new RestoreSystemCommand('SPFILE_TO') },
      { pattern: /^RESTORE (DATABASE)(?:\s+(.*))?$/i,     command: new RestoreCommand() },
      { pattern: /^RESTORE (TABLESPACE) (\S+)(?:\s+(.*))?$/i, command: new RestoreCommand() },
      { pattern: /^RESTORE (DATAFILE) (\d+)(?:\s+(.*))?$/i,   command: new RestoreCommand() },
      { pattern: /^RECOVER (DATABASE)(?:\s+(.*))?$/i,        command: new RecoverCommand() },
      { pattern: /^RECOVER (TABLESPACE) (\S+)(?:\s+(.*))?$/i, command: new RecoverCommand() },
      { pattern: /^RECOVER (DATAFILE) (\d+)(?:\s+(.*))?$/i,   command: new RecoverCommand() },
      { pattern: /^LIST BACKUP SUMMARY$/i,       command: new ListBackupCommand('SUMMARY') },
      { pattern: /^LIST BACKUP$/i,               command: new ListBackupCommand('DETAIL') },
      { pattern: /^LIST ARCHIVELOG ALL$/i,       command: new ListBackupCommand('ARCHIVELOG') },
      { pattern: /^LIST EXPIRED BACKUP$/i,       command: new ListBackupCommand('EXPIRED') },
      { pattern: /^LIST OBSOLETE$/i,             command: new ListBackupCommand('OBSOLETE') },
      { pattern: /^LIST COPY(?:\s+.*)?$/i,       command: new ListBackupCommand('COPY') },
      { pattern: /^LIST INCARNATION(?:\s+OF DATABASE)?$/i, command: new ListBackupCommand('INCARNATION') },
      // VALIDATE (12c+) — distinct from BACKUP VALIDATE
      { pattern: /^VALIDATE DATABASE$/i,                  command: new ValidateCommand('DATABASE') },
      { pattern: /^VALIDATE TABLESPACE (\S+)$/i,          command: new ValidateCommand('TABLESPACE') },
      { pattern: /^VALIDATE DATAFILE (\d+)$/i,            command: new ValidateCommand('DATAFILE') },
      { pattern: /^VALIDATE BACKUPSET (\d+)$/i,           command: new ValidateCommand('BACKUPSET') },
      { pattern: /^REPORT SCHEMA$/i,             command: new ReportCommand('SCHEMA') },
      { pattern: /^REPORT NEED BACKUP(?:\s+(.+))?$/i,                                 command: new ReportCommand('NEED_BACKUP') },
      { pattern: /^REPORT OBSOLETE(?:\s+(.+))?$/i,                                    command: new ReportCommand('OBSOLETE') },
      { pattern: /^REPORT UNRECOVERABLE$/i,      command: new ReportCommand('UNRECOVERABLE') },
      { pattern: /^CROSSCHECK BACKUP$/i,         command: new CrosscheckCommand() },
      { pattern: /^DELETE (?:NOPROMPT )?EXPIRED BACKUP$/i,           command: new DeleteCommand('EXPIRED') },
      { pattern: /^DELETE (?:NOPROMPT )?OBSOLETE(?:\s+(.+))?$/i,     command: new DeleteCommand('OBSOLETE') },
      { pattern: /^DELETE (?:NOPROMPT )?BACKUP TAG '([^']+)'$/i,     command: new DeleteCommand('BY_TAG') },
      { pattern: /^DELETE (?:NOPROMPT )?BACKUPSET (\d+)$/i,          command: new DeleteCommand('BY_BSKEY') },
      { pattern: /^DELETE (?:NOPROMPT )?ARCHIVELOG ALL$/i,           command: new DeleteCommand('ARCHIVELOG') },
      { pattern: /^SHOW ALL$/i,                       command: new ShowCommand('ALL') },
      { pattern: /^SHOW RETENTION POLICY$/i,          command: new ShowCommand('RETENTION_POLICY') },
      { pattern: /^SHOW DEFAULT DEVICE TYPE$/i,       command: new ShowCommand('DEFAULT_DEVICE_TYPE') },
      { pattern: /^SHOW CONTROLFILE AUTOBACKUP$/i,    command: new ShowCommand('CONTROLFILE_AUTOBACKUP') },
      { pattern: /^SHOW CHANNEL(?:\s+FOR DEVICE TYPE (DISK|SBT))?$/i, command: new ShowCommand('CHANNEL') },
      { pattern: /^CROSSCHECK ARCHIVELOG ALL$/i,      command: new CrosscheckCommand('ARCHIVELOG') },
      { pattern: /^HELP$/i,                      command: new HelpCommand() },
      // CONFIGURE — capture the everything after the keyword in args[0]
      { pattern: /^CONFIGURE (.+)$/i,            command: new ConfigureCommand() },
      // Explicit channels (inside RUN blocks)
      { pattern: /^ALLOCATE CHANNEL (\S+) DEVICE TYPE (DISK|SBT)(?:\s+.*)?$/i,          command: new AllocateChannelCommand() },
      { pattern: /^ALLOCATE AUXILIARY CHANNEL (\S+) DEVICE TYPE (DISK|SBT)(?:\s+.*)?$/i, command: new AllocateChannelCommand() },
      { pattern: /^RELEASE CHANNEL (\S+)$/i,                                              command: new ReleaseChannelCommand() },
      // Manual catalog registration (DEF-RMAN-16)
      { pattern: /^CATALOG DATAFILECOPY (.+)$/i, command: new CatalogCommand('DATAFILECOPY') },
      { pattern: /^CATALOG BACKUPPIECE (.+)$/i,  command: new CatalogCommand('BACKUPPIECE')  },
      // DUPLICATE DATABASE (DEF-RMAN-17) — wide pattern catches every Oracle clause
      { pattern: /^DUPLICATE (?:TARGET )?DATABASE TO (\S+)(?:\s+(.*))?$/i, command: new DuplicateCommand() },
      // CHANGE (UN)AVAILABLE + tag-scoped delete
      { pattern: /^CHANGE BACKUPSET (\d+) UNAVAILABLE$/i,           command: new ChangeCommand('UNAVAILABLE')  },
      { pattern: /^CHANGE BACKUPSET (\d+) AVAILABLE$/i,             command: new ChangeCommand('AVAILABLE')    },
      { pattern: /^CHANGE BACKUP TAG '([^']+)' DELETE$/i,           command: new ChangeCommand('DELETE_BY_TAG') },
      // SET NEWNAME (RUN-block binding consumed by RESTORE / DUPLICATE)
      { pattern: /^SET NEWNAME FOR DATAFILE (\d+) TO ('[^']+')$/i,  command: new SetCommand('NEWNAME') },
      // SET UNTIL — PITR precursor inherited by later RESTORE/RECOVER in
      // the same RUN block
      { pattern: /^SET UNTIL TIME '([^']+)'$/i,                     command: new SetCommand('UNTIL_TIME') },
      { pattern: /^SET UNTIL SCN (\d+)$/i,                          command: new SetCommand('UNTIL_SCN')  },
      // CONNECT AUXILIARY — accepted no-op against the in-memory aux
      { pattern: /^CONNECT AUXILIARY(.*)$/i,                        command: new ConnectAuxiliaryCommand() },
      // RESYNC CATALOG — accepted no-op against the in-memory catalog
      { pattern: /^RESYNC CATALOG$/i,                               command: new ResyncCatalogCommand() },
    );
  }
}
