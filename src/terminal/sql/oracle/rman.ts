/**
 * Oracle RMAN (Recovery Manager) Interface
 * Command-line tool for backup and recovery operations
 */

import { SQLEngine } from '../generic/engine';
import { parseSQL } from '../generic/parser';
import { OracleSecurityManager } from './security';

export interface RMANResult {
  output: string;
  error?: string;
  exit?: boolean;
}

export interface RMANSession {
  engine: SQLEngine;
  securityManager: OracleSecurityManager;
  connected: boolean;
  targetDatabase: string;
  catalogDatabase: string | null;
  channel: string;
  autobackup: boolean;
  retentionPolicy: string;
  backupOptimization: boolean;
  compressionAlgorithm: string;
  controlfileAutobackup: boolean;
  deviceType: string;
  parallelism: number;
  lastBackupId: number;
}

/**
 * Create a new RMAN session
 */
export function createRMANSession(engine?: SQLEngine): RMANSession {
  const sqlEngine = engine || new SQLEngine({
    caseSensitiveIdentifiers: false,
    defaultSchema: 'SYS',
    autoCommit: true
  });

  if (!engine) {
    sqlEngine.createSchema('SYS');
    sqlEngine.setCurrentSchema('SYS');
  }

  const securityManager = new OracleSecurityManager(sqlEngine);

  return {
    engine: sqlEngine,
    securityManager,
    connected: false,
    targetDatabase: '',
    catalogDatabase: null,
    channel: 'ORA_DISK_1',
    autobackup: true,
    retentionPolicy: 'RECOVERY WINDOW OF 7 DAYS',
    backupOptimization: true,
    compressionAlgorithm: 'BASIC',
    controlfileAutobackup: true,
    deviceType: 'DISK',
    parallelism: 1,
    lastBackupId: 1000
  };
}

/**
 * Execute an RMAN command
 */
export function executeRMAN(session: RMANSession, input: string): RMANResult {
  const trimmed = input.trim();

  if (!trimmed) {
    return { output: '' };
  }

  const upperInput = trimmed.toUpperCase();

  // EXIT/QUIT
  if (upperInput === 'EXIT' || upperInput === 'QUIT' ||
      upperInput === 'EXIT;' || upperInput === 'QUIT;') {
    return {
      output: '\nRecovery Manager complete.',
      exit: true
    };
  }

  // HELP
  if (upperInput === 'HELP' || upperInput === '?') {
    return { output: getRMANHelp() };
  }

  // CONNECT TARGET
  if (upperInput.startsWith('CONNECT TARGET')) {
    return handleConnectTarget(session, trimmed);
  }

  // CONNECT CATALOG
  if (upperInput.startsWith('CONNECT CATALOG')) {
    return handleConnectCatalog(session, trimmed);
  }

  // Check if connected before allowing other commands
  if (!session.connected) {
    return {
      output: '',
      error: 'RMAN-06003: ORACLE error from target database: not connected'
    };
  }

  // BACKUP commands
  if (upperInput.startsWith('BACKUP ')) {
    return handleBackup(session, trimmed);
  }

  // RESTORE commands
  if (upperInput.startsWith('RESTORE ')) {
    return handleRestore(session, trimmed);
  }

  // RECOVER commands
  if (upperInput.startsWith('RECOVER ')) {
    return handleRecover(session, trimmed);
  }

  // LIST commands
  if (upperInput.startsWith('LIST ')) {
    return handleList(session, trimmed);
  }

  // REPORT commands
  if (upperInput.startsWith('REPORT ')) {
    return handleReport(session, trimmed);
  }

  // CROSSCHECK commands
  if (upperInput.startsWith('CROSSCHECK ')) {
    return handleCrosscheck(session, trimmed);
  }

  // DELETE commands
  if (upperInput.startsWith('DELETE ')) {
    return handleDelete(session, trimmed);
  }

  // VALIDATE commands
  if (upperInput.startsWith('VALIDATE ')) {
    return handleValidate(session, trimmed);
  }

  // CONFIGURE commands
  if (upperInput.startsWith('CONFIGURE ')) {
    return handleConfigure(session, trimmed);
  }

  // SHOW commands
  if (upperInput.startsWith('SHOW ')) {
    return handleShow(session, trimmed);
  }

  // ALLOCATE CHANNEL
  if (upperInput.startsWith('ALLOCATE CHANNEL')) {
    return handleAllocateChannel(session, trimmed);
  }

  // RELEASE CHANNEL
  if (upperInput.startsWith('RELEASE CHANNEL')) {
    return handleReleaseChannel(session, trimmed);
  }

  // RUN block
  if (upperInput.startsWith('RUN ') || upperInput.startsWith('RUN{')) {
    return handleRun(session, trimmed);
  }

  // SQL command
  if (upperInput.startsWith('SQL ')) {
    return handleSQL(session, trimmed);
  }

  // SHUTDOWN
  if (upperInput.startsWith('SHUTDOWN')) {
    return handleShutdown(session, trimmed);
  }

  // STARTUP
  if (upperInput.startsWith('STARTUP')) {
    return handleStartup(session, trimmed);
  }

  return {
    output: '',
    error: `RMAN-00558: error encountered while parsing input command\nRMAN-01009: syntax error: found "${trimmed.split(' ')[0]}": expecting one of: "allocate, backup, catalog, change, configure, connect, crosscheck, delete, duplicate, exit, flashback, host, list, print, quit, recover, register, release, repair, replace, report, reset, restore, resync, revoke, run, send, set, show, shutdown, spool, sql, startup, switch, transport, unregister, upgrade, validate"`
    };
}

/**
 * Handle CONNECT TARGET command
 */
function handleConnectTarget(session: RMANSession, cmd: string): RMANResult {
  const match = cmd.match(/connect\s+target\s*(?:(\S+))?/i);

  let connectionInfo = '/';
  if (match && match[1]) {
    connectionInfo = match[1];
  }

  session.connected = true;
  session.targetDatabase = 'ORCL';

  return {
    output: `connected to target database: ORCL (DBID=1234567890)`
  };
}

/**
 * Handle CONNECT CATALOG command
 */
function handleConnectCatalog(session: RMANSession, cmd: string): RMANResult {
  const match = cmd.match(/connect\s+catalog\s+(\S+)/i);

  if (!match) {
    return { output: '', error: 'RMAN-06004: ORACLE error from recovery catalog database: invalid connection' };
  }

  session.catalogDatabase = 'RCAT';

  return {
    output: `connected to recovery catalog database`
  };
}

/**
 * Handle BACKUP command
 */
function handleBackup(session: RMANSession, cmd: string): RMANResult {
  const upperCmd = cmd.toUpperCase();
  const startTime = new Date();
  const backupId = ++session.lastBackupId;

  let backupType = 'FULL';
  let inputType = 'DB FULL';
  let pieces = 1;
  let inputBytes = 0;
  let outputBytes = 0;

  // Parse backup type
  if (upperCmd.includes('INCREMENTAL LEVEL 0')) {
    backupType = 'INCREMENTAL LEVEL 0';
    inputType = 'DB INCR';
  } else if (upperCmd.includes('INCREMENTAL LEVEL 1')) {
    backupType = 'INCREMENTAL LEVEL 1';
    inputType = 'DB INCR';
    inputBytes = 52428800; // 50MB
    outputBytes = 10485760; // 10MB
  } else if (upperCmd.includes('DATABASE')) {
    inputType = 'DB FULL';
    inputBytes = 2147483648; // 2GB
    outputBytes = 1073741824; // 1GB
    pieces = 4;
  } else if (upperCmd.includes('TABLESPACE')) {
    inputType = 'DATAFILE FULL';
    inputBytes = 536870912; // 512MB
    outputBytes = 268435456; // 256MB
  } else if (upperCmd.includes('ARCHIVELOG ALL')) {
    inputType = 'ARCHIVELOG';
    inputBytes = 104857600; // 100MB
    outputBytes = 52428800; // 50MB
  } else if (upperCmd.includes('ARCHIVELOG')) {
    inputType = 'ARCHIVELOG';
    inputBytes = 52428800;
    outputBytes = 26214400;
  } else if (upperCmd.includes('CURRENT CONTROLFILE')) {
    inputType = 'CONTROLFILE';
    inputBytes = 10485760;
    outputBytes = 5242880;
  } else if (upperCmd.includes('SPFILE')) {
    inputType = 'SPFILE';
    inputBytes = 2097152;
    outputBytes = 1048576;
  }

  const elapsedSeconds = Math.floor(Math.random() * 120) + 30;
  const endTime = new Date(startTime.getTime() + elapsedSeconds * 1000);

  // Insert backup record into V_RMAN_BACKUP_JOB_DETAILS$ table
  insertBackupRecord(session, {
    sessionKey: backupId,
    commandId: `BACKUP_${backupId}`,
    inputType,
    status: 'COMPLETED',
    inputBytes,
    outputBytes,
    elapsedSeconds,
    startTime,
    endTime
  });

  // Generate output
  const output = generateBackupOutput(session, {
    backupType,
    inputType,
    backupId,
    pieces,
    inputBytes,
    outputBytes,
    elapsedSeconds,
    startTime,
    endTime,
    cmd
  });

  return { output };
}

/**
 * Generate backup output
 */
function generateBackupOutput(session: RMANSession, opts: {
  backupType: string;
  inputType: string;
  backupId: number;
  pieces: number;
  inputBytes: number;
  outputBytes: number;
  elapsedSeconds: number;
  startTime: Date;
  endTime: Date;
  cmd: string;
}): string {
  const lines: string[] = [];

  lines.push('');
  lines.push(`Starting backup at ${formatRMANDate(opts.startTime)}`);
  lines.push(`using channel ${session.channel}`);

  if (opts.inputType.includes('DB')) {
    lines.push('channel ' + session.channel + ': starting full datafile backup set');
    lines.push('channel ' + session.channel + ': specifying datafile(s) in backup set');
    lines.push('input datafile file number=00001 name=/u01/app/oracle/oradata/ORCL/system01.dbf');
    lines.push('input datafile file number=00002 name=/u01/app/oracle/oradata/ORCL/sysaux01.dbf');
    lines.push('input datafile file number=00003 name=/u01/app/oracle/oradata/ORCL/undotbs01.dbf');
    lines.push('input datafile file number=00004 name=/u01/app/oracle/oradata/ORCL/users01.dbf');
  } else if (opts.inputType === 'ARCHIVELOG') {
    lines.push('channel ' + session.channel + ': starting archived log backup set');
    lines.push('channel ' + session.channel + ': specifying archived log(s) in backup set');
    lines.push('input archived log thread=1 sequence=100 RECID=1 STAMP=1234567890');
    lines.push('input archived log thread=1 sequence=101 RECID=2 STAMP=1234567891');
    lines.push('input archived log thread=1 sequence=102 RECID=3 STAMP=1234567892');
  } else if (opts.inputType === 'CONTROLFILE') {
    lines.push('channel ' + session.channel + ': starting control file backup set');
    lines.push('input control file');
  } else if (opts.inputType === 'SPFILE') {
    lines.push('channel ' + session.channel + ': starting spfile backup set');
    lines.push('input spfile');
  }

  for (let i = 1; i <= opts.pieces; i++) {
    const pieceBytes = Math.floor(opts.outputBytes / opts.pieces);
    lines.push(`channel ${session.channel}: piece ${i} created`);
    lines.push(`piece handle=/u01/app/oracle/fast_recovery_area/ORCL/backupset/${formatBackupDate(opts.startTime)}/o1_mf_${opts.inputType.toLowerCase().replace(' ', '_')}_${opts.backupId}_${i}.bkp tag=TAG${formatBackupTag(opts.startTime)}`);
    lines.push(`piece ${i}: ${formatBytes(pieceBytes)}`);
  }

  lines.push(`channel ${session.channel}: backup set complete, elapsed time: ${formatElapsedTime(opts.elapsedSeconds)}`);

  if (session.controlfileAutobackup) {
    lines.push('');
    lines.push('channel ' + session.channel + ': starting control file autobackup');
    lines.push('piece handle=/u01/app/oracle/fast_recovery_area/ORCL/autobackup/' + formatBackupDate(opts.startTime) + '/o1_mf_s_' + Math.floor(opts.startTime.getTime() / 1000) + '.bkp');
    lines.push('channel ' + session.channel + ': control file autobackup complete');
  }

  lines.push('');
  lines.push(`Finished backup at ${formatRMANDate(opts.endTime)}`);
  lines.push('');

  return lines.join('\n');
}

/**
 * Insert backup record into V_RMAN_BACKUP_JOB_DETAILS$
 */
function insertBackupRecord(session: RMANSession, record: {
  sessionKey: number;
  commandId: string;
  inputType: string;
  status: string;
  inputBytes: number;
  outputBytes: number;
  elapsedSeconds: number;
  startTime: Date;
  endTime: Date;
}): void {
  try {
    const sql = `INSERT INTO SYS.V_RMAN_BACKUP_JOB_DETAILS$ (SESSION_KEY, COMMAND_ID, INPUT_TYPE, STATUS, INPUT_BYTES, OUTPUT_BYTES, ELAPSED_SECONDS, START_TIME, END_TIME) VALUES (${record.sessionKey}, '${record.commandId}', '${record.inputType}', '${record.status}', ${record.inputBytes}, ${record.outputBytes}, ${record.elapsedSeconds}, '${formatSQLDate(record.startTime)}', '${formatSQLDate(record.endTime)}')`;

    const originalSchema = session.engine.getCurrentSchema();
    session.engine.setCurrentSchema('SYS');

    const parsed = parseSQL(sql);
    if (parsed.success && parsed.statements.length > 0) {
      session.engine.executeInsert(parsed.statements[0] as any);
    }

    session.engine.setCurrentSchema(originalSchema);
  } catch (e) {
    // Silently ignore insertion errors
  }
}

/**
 * Handle RESTORE command
 */
function handleRestore(session: RMANSession, cmd: string): RMANResult {
  const upperCmd = cmd.toUpperCase();
  const startTime = new Date();

  let restoreType = 'DATABASE';
  if (upperCmd.includes('TABLESPACE')) {
    restoreType = 'TABLESPACE';
  } else if (upperCmd.includes('DATAFILE')) {
    restoreType = 'DATAFILE';
  } else if (upperCmd.includes('CONTROLFILE')) {
    restoreType = 'CONTROLFILE';
  } else if (upperCmd.includes('SPFILE')) {
    restoreType = 'SPFILE';
  } else if (upperCmd.includes('ARCHIVELOG')) {
    restoreType = 'ARCHIVELOG';
  }

  const elapsedSeconds = Math.floor(Math.random() * 180) + 60;
  const endTime = new Date(startTime.getTime() + elapsedSeconds * 1000);

  const lines: string[] = [];
  lines.push('');
  lines.push(`Starting restore at ${formatRMANDate(startTime)}`);
  lines.push(`using channel ${session.channel}`);
  lines.push('');

  if (restoreType === 'DATABASE') {
    lines.push('channel ' + session.channel + ': starting datafile backup set restore');
    lines.push('channel ' + session.channel + ': specifying datafile(s) to restore from backup set');
    lines.push('channel ' + session.channel + ': restoring datafile 00001 to /u01/app/oracle/oradata/ORCL/system01.dbf');
    lines.push('channel ' + session.channel + ': restoring datafile 00002 to /u01/app/oracle/oradata/ORCL/sysaux01.dbf');
    lines.push('channel ' + session.channel + ': restoring datafile 00003 to /u01/app/oracle/oradata/ORCL/undotbs01.dbf');
    lines.push('channel ' + session.channel + ': restoring datafile 00004 to /u01/app/oracle/oradata/ORCL/users01.dbf');
    lines.push('channel ' + session.channel + ': reading from backup piece /u01/app/oracle/fast_recovery_area/ORCL/backupset/2024_01_15/o1_mf_db_full_1001_1.bkp');
    lines.push('channel ' + session.channel + ': piece handle=/u01/app/oracle/fast_recovery_area/ORCL/backupset/2024_01_15/o1_mf_db_full_1001_1.bkp tag=TAG20240115T100000');
    lines.push('channel ' + session.channel + ': restored backup piece 1');
    lines.push('channel ' + session.channel + ': restore complete, elapsed time: ' + formatElapsedTime(elapsedSeconds));
  } else if (restoreType === 'CONTROLFILE') {
    lines.push('channel ' + session.channel + ': starting controlfile restore');
    lines.push('channel ' + session.channel + ': restoring controlfile');
    lines.push('channel ' + session.channel + ': reading from backup piece /u01/app/oracle/fast_recovery_area/ORCL/autobackup/2024_01_15/o1_mf_s_1234567890.bkp');
    lines.push('channel ' + session.channel + ': restored controlfile');
    lines.push('channel ' + session.channel + ': restore complete, elapsed time: ' + formatElapsedTime(elapsedSeconds));
  } else if (restoreType === 'SPFILE') {
    lines.push('channel ' + session.channel + ': starting spfile restore');
    lines.push('channel ' + session.channel + ': restoring spfile to /u01/app/oracle/product/19c/dbs/spfileORCL.ora');
    lines.push('channel ' + session.channel + ': restore complete, elapsed time: ' + formatElapsedTime(elapsedSeconds));
  }

  lines.push('');
  lines.push(`Finished restore at ${formatRMANDate(endTime)}`);
  lines.push('');

  return { output: lines.join('\n') };
}

/**
 * Handle RECOVER command
 */
function handleRecover(session: RMANSession, cmd: string): RMANResult {
  const upperCmd = cmd.toUpperCase();
  const startTime = new Date();

  let recoverType = 'DATABASE';
  if (upperCmd.includes('TABLESPACE')) {
    recoverType = 'TABLESPACE';
  } else if (upperCmd.includes('DATAFILE')) {
    recoverType = 'DATAFILE';
  }

  const elapsedSeconds = Math.floor(Math.random() * 60) + 10;
  const endTime = new Date(startTime.getTime() + elapsedSeconds * 1000);

  const lines: string[] = [];
  lines.push('');
  lines.push(`Starting recover at ${formatRMANDate(startTime)}`);
  lines.push(`using channel ${session.channel}`);
  lines.push('');

  lines.push('starting media recovery');
  lines.push('');
  lines.push('archived log for thread 1 with sequence 100 is already on disk as file');
  lines.push('/u01/app/oracle/fast_recovery_area/ORCL/archivelog/2024_01_15/o1_mf_1_100.arc');
  lines.push('archived log for thread 1 with sequence 101 is already on disk as file');
  lines.push('/u01/app/oracle/fast_recovery_area/ORCL/archivelog/2024_01_15/o1_mf_1_101.arc');
  lines.push('archived log for thread 1 with sequence 102 is already on disk as file');
  lines.push('/u01/app/oracle/fast_recovery_area/ORCL/archivelog/2024_01_15/o1_mf_1_102.arc');
  lines.push('');
  lines.push('channel default: archived log restore complete, elapsed time: 00:00:15');
  lines.push('');
  lines.push('media recovery complete, elapsed time: ' + formatElapsedTime(elapsedSeconds));
  lines.push('');
  lines.push(`Finished recover at ${formatRMANDate(endTime)}`);
  lines.push('');

  return { output: lines.join('\n') };
}

/**
 * Handle LIST command
 */
function handleList(session: RMANSession, cmd: string): RMANResult {
  const upperCmd = cmd.toUpperCase();

  if (upperCmd.includes('BACKUP SUMMARY')) {
    return listBackupSummary(session);
  } else if (upperCmd.includes('BACKUP OF DATABASE')) {
    return listBackupOfDatabase(session);
  } else if (upperCmd.includes('BACKUP OF ARCHIVELOG')) {
    return listBackupOfArchivelog(session);
  } else if (upperCmd.includes('BACKUP')) {
    return listBackup(session);
  } else if (upperCmd.includes('INCARNATION')) {
    return listIncarnation(session);
  } else if (upperCmd.includes('FAILURE')) {
    return listFailure(session);
  } else if (upperCmd.includes('ARCHIVELOG ALL')) {
    return listArchivelog(session);
  }

  return { output: '', error: 'RMAN-00558: error encountered while parsing input command' };
}

/**
 * List backup summary
 */
function listBackupSummary(session: RMANSession): RMANResult {
  const lines: string[] = [];
  lines.push('');
  lines.push('List of Backups');
  lines.push('===============');
  lines.push('');
  lines.push('Key     TY LV S Device Type Completion Time    #Pieces #Copies Compressed Tag');
  lines.push('------- -- -- - ----------- -------------------- ------- ------- ---------- ---');

  // Query backup records
  try {
    const originalSchema = session.engine.getCurrentSchema();
    session.engine.setCurrentSchema('SYS');

    const sql = 'SELECT * FROM SYS.V_RMAN_BACKUP_JOB_DETAILS$';
    const parsed = parseSQL(sql);

    if (parsed.success && parsed.statements.length > 0) {
      const result = session.engine.executeSelect(parsed.statements[0] as any);
      if (result.success && result.resultSet) {
        for (const row of result.resultSet.rows) {
          const key = String(row.SESSION_KEY || '').padEnd(7);
          const ty = 'B ';
          const lv = 'F ';
          const status = 'A';
          const device = 'DISK       ';
          const completion = formatRMANDate(new Date(String(row.END_TIME || new Date())));
          const pieces = '1      ';
          const copies = '1      ';
          const compressed = 'NO        ';
          const tag = 'TAG' + formatBackupTag(new Date(String(row.START_TIME || new Date())));

          lines.push(`${key}${ty}${lv}${status} ${device}${completion} ${pieces}${copies}${compressed}${tag}`);
        }
      }
    }

    session.engine.setCurrentSchema(originalSchema);
  } catch (e) {
    // Add sample data if query fails
    lines.push('1001    B  F  A DISK        15-JAN-24 10:00:00 1       1       NO         TAG20240115T100000');
    lines.push('1002    B  F  A DISK        15-JAN-24 12:00:00 1       1       NO         TAG20240115T120000');
    lines.push('1003    B  F  A DISK        16-JAN-24 10:00:00 1       1       NO         TAG20240116T100000');
  }

  lines.push('');
  return { output: lines.join('\n') };
}

/**
 * List backup
 */
function listBackup(session: RMANSession): RMANResult {
  const lines: string[] = [];
  lines.push('');
  lines.push('List of Backup Sets');
  lines.push('===================');
  lines.push('');

  lines.push('BS Key  Type LV Size       Device Type Elapsed Time Completion Time');
  lines.push('------- ---- -- ---------- ----------- ------------ -------------------');
  lines.push('1001    Full    2.00G      DISK        00:02:30     15-JAN-24 10:00:00');
  lines.push('        BP Key: 1001   Status: AVAILABLE  Compressed: NO  Tag: TAG20240115T100000');
  lines.push('        Piece Name: /u01/app/oracle/fast_recovery_area/ORCL/backupset/2024_01_15/o1_mf_db_full_1001_1.bkp');
  lines.push('  List of Datafiles in backup set 1001');
  lines.push('  File LV Type Ckp SCN    Ckp Time            Abs Fuz SCN Sparse Name');
  lines.push('  ---- -- ---- ---------- ------------------- ----------- ------ ----');
  lines.push('  1       Full 1234567    15-JAN-24 09:55:00              NO     /u01/app/oracle/oradata/ORCL/system01.dbf');
  lines.push('  2       Full 1234567    15-JAN-24 09:55:00              NO     /u01/app/oracle/oradata/ORCL/sysaux01.dbf');
  lines.push('  3       Full 1234567    15-JAN-24 09:55:00              NO     /u01/app/oracle/oradata/ORCL/undotbs01.dbf');
  lines.push('  4       Full 1234567    15-JAN-24 09:55:00              NO     /u01/app/oracle/oradata/ORCL/users01.dbf');
  lines.push('');
  lines.push('BS Key  Type LV Size       Device Type Elapsed Time Completion Time');
  lines.push('------- ---- -- ---------- ----------- ------------ -------------------');
  lines.push('1002    Arch    100.00M    DISK        00:00:30     15-JAN-24 12:00:00');
  lines.push('        BP Key: 1002   Status: AVAILABLE  Compressed: NO  Tag: TAG20240115T120000');
  lines.push('        Piece Name: /u01/app/oracle/fast_recovery_area/ORCL/backupset/2024_01_15/o1_mf_arch_1002_1.bkp');
  lines.push('  List of Archived Logs in backup set 1002');
  lines.push('  Thrd Seq     Low SCN    Low Time            Next SCN   Next Time');
  lines.push('  ---- ------- ---------- ------------------- ---------- ---------');
  lines.push('  1    100     1234500    15-JAN-24 08:00:00  1234567    15-JAN-24 09:00:00');
  lines.push('  1    101     1234567    15-JAN-24 09:00:00  1234600    15-JAN-24 10:00:00');
  lines.push('  1    102     1234600    15-JAN-24 10:00:00  1234700    15-JAN-24 11:00:00');
  lines.push('');

  return { output: lines.join('\n') };
}

/**
 * List backup of database
 */
function listBackupOfDatabase(session: RMANSession): RMANResult {
  const lines: string[] = [];
  lines.push('');
  lines.push('List of Backup Sets');
  lines.push('===================');
  lines.push('');
  lines.push('BS Key  Type LV Size       Device Type Elapsed Time Completion Time');
  lines.push('------- ---- -- ---------- ----------- ------------ -------------------');
  lines.push('1001    Full    2.00G      DISK        00:02:30     15-JAN-24 10:00:00');
  lines.push('        BP Key: 1001   Status: AVAILABLE  Compressed: NO  Tag: TAG20240115T100000');
  lines.push('        Piece Name: /u01/app/oracle/fast_recovery_area/ORCL/backupset/2024_01_15/o1_mf_db_full_1001_1.bkp');
  lines.push('  List of Datafiles in backup set 1001');
  lines.push('  Container ID: 0, PDB Name: ORCL');
  lines.push('  File LV Type Ckp SCN    Ckp Time            Name');
  lines.push('  ---- -- ---- ---------- ------------------- ----');
  lines.push('  1       Full 1234567    15-JAN-24 09:55:00  /u01/app/oracle/oradata/ORCL/system01.dbf');
  lines.push('  2       Full 1234567    15-JAN-24 09:55:00  /u01/app/oracle/oradata/ORCL/sysaux01.dbf');
  lines.push('  3       Full 1234567    15-JAN-24 09:55:00  /u01/app/oracle/oradata/ORCL/undotbs01.dbf');
  lines.push('  4       Full 1234567    15-JAN-24 09:55:00  /u01/app/oracle/oradata/ORCL/users01.dbf');
  lines.push('');

  return { output: lines.join('\n') };
}

/**
 * List backup of archivelog
 */
function listBackupOfArchivelog(session: RMANSession): RMANResult {
  const lines: string[] = [];
  lines.push('');
  lines.push('List of Backup Sets');
  lines.push('===================');
  lines.push('');
  lines.push('BS Key  Size       Device Type Elapsed Time Completion Time');
  lines.push('------- ---------- ----------- ------------ -------------------');
  lines.push('1002    100.00M    DISK        00:00:30     15-JAN-24 12:00:00');
  lines.push('        BP Key: 1002   Status: AVAILABLE  Compressed: NO  Tag: TAG20240115T120000');
  lines.push('        Piece Name: /u01/app/oracle/fast_recovery_area/ORCL/backupset/2024_01_15/o1_mf_arch_1002_1.bkp');
  lines.push('');
  lines.push('  List of Archived Logs in backup set 1002');
  lines.push('  Thrd Seq     Low SCN    Low Time            Next SCN   Next Time');
  lines.push('  ---- ------- ---------- ------------------- ---------- ---------');
  lines.push('  1    100     1234500    15-JAN-24 08:00:00  1234567    15-JAN-24 09:00:00');
  lines.push('  1    101     1234567    15-JAN-24 09:00:00  1234600    15-JAN-24 10:00:00');
  lines.push('  1    102     1234600    15-JAN-24 10:00:00  1234700    15-JAN-24 11:00:00');
  lines.push('');

  return { output: lines.join('\n') };
}

/**
 * List incarnation
 */
function listIncarnation(session: RMANSession): RMANResult {
  const lines: string[] = [];
  lines.push('');
  lines.push('List of Database Incarnations');
  lines.push('DB Key  Inc Key DB Name  DB ID            STATUS   Reset SCN  Reset Time');
  lines.push('------- ------- -------- ---------------- -------- ---------- ----------');
  lines.push('1       1       ORCL     1234567890       CURRENT  1          01-JAN-20');
  lines.push('');

  return { output: lines.join('\n') };
}

/**
 * List failure
 */
function listFailure(session: RMANSession): RMANResult {
  const lines: string[] = [];
  lines.push('');
  lines.push('List of Database Failures');
  lines.push('=========================');
  lines.push('');
  lines.push('no failures found that match specification');
  lines.push('');

  return { output: lines.join('\n') };
}

/**
 * List archivelog
 */
function listArchivelog(session: RMANSession): RMANResult {
  const lines: string[] = [];
  lines.push('');
  lines.push('List of Archived Log Copies for database with db_unique_name ORCL');
  lines.push('=====================================================================');
  lines.push('');
  lines.push('Key     Thrd Seq     S Low Time');
  lines.push('------- ---- ------- - -------------------');
  lines.push('1       1    100     A 15-JAN-24 08:00:00');
  lines.push('        Name: /u01/app/oracle/fast_recovery_area/ORCL/archivelog/2024_01_15/o1_mf_1_100.arc');
  lines.push('2       1    101     A 15-JAN-24 09:00:00');
  lines.push('        Name: /u01/app/oracle/fast_recovery_area/ORCL/archivelog/2024_01_15/o1_mf_1_101.arc');
  lines.push('3       1    102     A 15-JAN-24 10:00:00');
  lines.push('        Name: /u01/app/oracle/fast_recovery_area/ORCL/archivelog/2024_01_15/o1_mf_1_102.arc');
  lines.push('');

  return { output: lines.join('\n') };
}

/**
 * Handle REPORT command
 */
function handleReport(session: RMANSession, cmd: string): RMANResult {
  const upperCmd = cmd.toUpperCase();

  if (upperCmd.includes('OBSOLETE')) {
    return reportObsolete(session);
  } else if (upperCmd.includes('NEED BACKUP')) {
    return reportNeedBackup(session);
  } else if (upperCmd.includes('UNRECOVERABLE')) {
    return reportUnrecoverable(session);
  } else if (upperCmd.includes('SCHEMA')) {
    return reportSchema(session);
  }

  return { output: '', error: 'RMAN-00558: error encountered while parsing input command' };
}

/**
 * Report obsolete
 */
function reportObsolete(session: RMANSession): RMANResult {
  const lines: string[] = [];
  lines.push('');
  lines.push('RMAN retention policy will be applied to the command');
  lines.push('RMAN retention policy is set to recovery window of 7 days');
  lines.push('Report of obsolete backups and copies');
  lines.push('Type                 Key    Completion Time    Filename/Handle');
  lines.push('-------------------- ------ ------------------- -------------------');
  lines.push('no obsolete backups found');
  lines.push('');

  return { output: lines.join('\n') };
}

/**
 * Report need backup
 */
function reportNeedBackup(session: RMANSession): RMANResult {
  const lines: string[] = [];
  lines.push('');
  lines.push('RMAN retention policy will be applied to the command');
  lines.push('RMAN retention policy is set to recovery window of 7 days');
  lines.push('Report of files whose recovery needs more than 7 days of archived logs');
  lines.push('File Days  Name');
  lines.push('---- ----- -------------------------------------------------------------');
  lines.push('no files need more than 7 days of archived logs for recovery');
  lines.push('');

  return { output: lines.join('\n') };
}

/**
 * Report unrecoverable
 */
function reportUnrecoverable(session: RMANSession): RMANResult {
  const lines: string[] = [];
  lines.push('');
  lines.push('Report of files that need backup due to unrecoverable operations');
  lines.push('File Type Name');
  lines.push('---- ---- -------------------------------------------------------------');
  lines.push('no files have unrecoverable operations');
  lines.push('');

  return { output: lines.join('\n') };
}

/**
 * Report schema
 */
function reportSchema(session: RMANSession): RMANResult {
  const lines: string[] = [];
  lines.push('');
  lines.push('Report of database schema for database with db_unique_name ORCL');
  lines.push('');
  lines.push('List of Permanent Datafiles');
  lines.push('===========================');
  lines.push('File Size(MB) Tablespace           RB segs Datafile Name');
  lines.push('---- -------- -------------------- ------- ------------------------');
  lines.push('1    800      SYSTEM               YES     /u01/app/oracle/oradata/ORCL/system01.dbf');
  lines.push('2    600      SYSAUX               NO      /u01/app/oracle/oradata/ORCL/sysaux01.dbf');
  lines.push('3    200      UNDOTBS1             YES     /u01/app/oracle/oradata/ORCL/undotbs01.dbf');
  lines.push('4    100      USERS                NO      /u01/app/oracle/oradata/ORCL/users01.dbf');
  lines.push('');
  lines.push('List of Temporary Files');
  lines.push('=======================');
  lines.push('File Size(MB) Tablespace           Maxsize(MB) Tempfile Name');
  lines.push('---- -------- -------------------- ----------- --------------------');
  lines.push('1    100      TEMP                 32767       /u01/app/oracle/oradata/ORCL/temp01.dbf');
  lines.push('');

  return { output: lines.join('\n') };
}

/**
 * Handle CROSSCHECK command
 */
function handleCrosscheck(session: RMANSession, cmd: string): RMANResult {
  const upperCmd = cmd.toUpperCase();
  const lines: string[] = [];

  lines.push('');
  lines.push(`using channel ${session.channel}`);

  if (upperCmd.includes('BACKUP')) {
    lines.push('crosschecked backup piece: found to be \'AVAILABLE\'');
    lines.push('backup piece handle=/u01/app/oracle/fast_recovery_area/ORCL/backupset/2024_01_15/o1_mf_db_full_1001_1.bkp RECID=1 STAMP=1234567890');
    lines.push('crosschecked backup piece: found to be \'AVAILABLE\'');
    lines.push('backup piece handle=/u01/app/oracle/fast_recovery_area/ORCL/backupset/2024_01_15/o1_mf_arch_1002_1.bkp RECID=2 STAMP=1234567891');
    lines.push('Crosschecked 2 objects');
  } else if (upperCmd.includes('ARCHIVELOG')) {
    lines.push('crosschecked archived log: found to be \'AVAILABLE\'');
    lines.push('archived log file name=/u01/app/oracle/fast_recovery_area/ORCL/archivelog/2024_01_15/o1_mf_1_100.arc RECID=1 STAMP=1234567890');
    lines.push('crosschecked archived log: found to be \'AVAILABLE\'');
    lines.push('archived log file name=/u01/app/oracle/fast_recovery_area/ORCL/archivelog/2024_01_15/o1_mf_1_101.arc RECID=2 STAMP=1234567891');
    lines.push('crosschecked archived log: found to be \'AVAILABLE\'');
    lines.push('archived log file name=/u01/app/oracle/fast_recovery_area/ORCL/archivelog/2024_01_15/o1_mf_1_102.arc RECID=3 STAMP=1234567892');
    lines.push('Crosschecked 3 objects');
  } else if (upperCmd.includes('COPY')) {
    lines.push('crosschecked datafile copy: found to be \'AVAILABLE\'');
    lines.push('Crosschecked 1 objects');
  }

  lines.push('');
  return { output: lines.join('\n') };
}

/**
 * Handle DELETE command
 */
function handleDelete(session: RMANSession, cmd: string): RMANResult {
  const upperCmd = cmd.toUpperCase();
  const lines: string[] = [];

  lines.push('');
  lines.push(`using channel ${session.channel}`);

  if (upperCmd.includes('OBSOLETE')) {
    lines.push('');
    lines.push('RMAN retention policy will be applied to the command');
    lines.push('RMAN retention policy is set to recovery window of 7 days');
    lines.push('no obsolete backups found');
  } else if (upperCmd.includes('EXPIRED')) {
    lines.push('');
    lines.push('no expired backups found');
  } else if (upperCmd.includes('NOPROMPT')) {
    lines.push('');
    lines.push('deleted backup piece');
    lines.push('backup piece handle=/u01/app/oracle/fast_recovery_area/ORCL/backupset/2024_01_01/o1_mf_db_full_old.bkp RECID=1 STAMP=1234500000');
    lines.push('Deleted 1 objects');
  } else {
    lines.push('');
    lines.push('Do you really want to delete the above objects (enter YES or NO)? ');
    lines.push('(Simulation: assuming YES)');
    lines.push('deleted backup piece');
    lines.push('Deleted 1 objects');
  }

  lines.push('');
  return { output: lines.join('\n') };
}

/**
 * Handle VALIDATE command
 */
function handleValidate(session: RMANSession, cmd: string): RMANResult {
  const upperCmd = cmd.toUpperCase();
  const startTime = new Date();
  const lines: string[] = [];

  lines.push('');
  lines.push(`Starting validate at ${formatRMANDate(startTime)}`);
  lines.push(`using channel ${session.channel}`);
  lines.push('');

  if (upperCmd.includes('DATABASE')) {
    lines.push('channel ' + session.channel + ': starting validation of datafile');
    lines.push('channel ' + session.channel + ': specifying datafile(s) for validation');
    lines.push('input datafile file number=00001 name=/u01/app/oracle/oradata/ORCL/system01.dbf');
    lines.push('input datafile file number=00002 name=/u01/app/oracle/oradata/ORCL/sysaux01.dbf');
    lines.push('input datafile file number=00003 name=/u01/app/oracle/oradata/ORCL/undotbs01.dbf');
    lines.push('input datafile file number=00004 name=/u01/app/oracle/oradata/ORCL/users01.dbf');
    lines.push('channel ' + session.channel + ': validation complete, elapsed time: 00:00:30');
    lines.push('');
    lines.push('List of Datafiles');
    lines.push('=================');
    lines.push('File Status Marked Corrupt Empty Blocks Blocks Examined High SCN');
    lines.push('---- ------ -------------- ------------ --------------- ----------');
    lines.push('1    OK     0              1234         102400          1234700');
    lines.push('2    OK     0              567          76800           1234700');
    lines.push('3    OK     0              890          25600           1234700');
    lines.push('4    OK     0              123          12800           1234700');
  } else if (upperCmd.includes('BACKUPSET')) {
    lines.push('channel ' + session.channel + ': starting validation of backup set');
    lines.push('channel ' + session.channel + ': reading from backup piece /u01/app/oracle/fast_recovery_area/ORCL/backupset/2024_01_15/o1_mf_db_full_1001_1.bkp');
    lines.push('channel ' + session.channel + ': piece handle=/u01/app/oracle/fast_recovery_area/ORCL/backupset/2024_01_15/o1_mf_db_full_1001_1.bkp tag=TAG20240115T100000');
    lines.push('channel ' + session.channel + ': backup set validated, elapsed time: 00:00:15');
    lines.push('');
    lines.push('Backup set validated.');
  }

  lines.push('');
  lines.push(`Finished validate at ${formatRMANDate(new Date())}`);
  lines.push('');

  return { output: lines.join('\n') };
}

/**
 * Handle CONFIGURE command
 */
function handleConfigure(session: RMANSession, cmd: string): RMANResult {
  const upperCmd = cmd.toUpperCase();
  const lines: string[] = [];

  if (upperCmd.includes('RETENTION POLICY')) {
    if (upperCmd.includes('REDUNDANCY')) {
      const match = cmd.match(/redundancy\s+(\d+)/i);
      const copies = match ? match[1] : '1';
      session.retentionPolicy = `REDUNDANCY ${copies}`;
      lines.push(`new RMAN configuration parameters:`);
      lines.push(`CONFIGURE RETENTION POLICY TO REDUNDANCY ${copies};`);
    } else if (upperCmd.includes('RECOVERY WINDOW')) {
      const match = cmd.match(/recovery\s+window\s+of\s+(\d+)\s+days/i);
      const days = match ? match[1] : '7';
      session.retentionPolicy = `RECOVERY WINDOW OF ${days} DAYS`;
      lines.push(`new RMAN configuration parameters:`);
      lines.push(`CONFIGURE RETENTION POLICY TO RECOVERY WINDOW OF ${days} DAYS;`);
    } else if (upperCmd.includes('NONE')) {
      session.retentionPolicy = 'NONE';
      lines.push(`new RMAN configuration parameters:`);
      lines.push(`CONFIGURE RETENTION POLICY TO NONE;`);
    } else if (upperCmd.includes('CLEAR')) {
      session.retentionPolicy = 'RECOVERY WINDOW OF 7 DAYS';
      lines.push(`old RMAN configuration parameters:`);
      lines.push(`CONFIGURE RETENTION POLICY CLEARED;`);
    }
  } else if (upperCmd.includes('BACKUP OPTIMIZATION')) {
    if (upperCmd.includes('ON')) {
      session.backupOptimization = true;
      lines.push(`new RMAN configuration parameters:`);
      lines.push(`CONFIGURE BACKUP OPTIMIZATION ON;`);
    } else if (upperCmd.includes('OFF') || upperCmd.includes('CLEAR')) {
      session.backupOptimization = false;
      lines.push(`new RMAN configuration parameters:`);
      lines.push(`CONFIGURE BACKUP OPTIMIZATION OFF;`);
    }
  } else if (upperCmd.includes('CONTROLFILE AUTOBACKUP')) {
    if (upperCmd.includes('ON')) {
      session.controlfileAutobackup = true;
      lines.push(`new RMAN configuration parameters:`);
      lines.push(`CONFIGURE CONTROLFILE AUTOBACKUP ON;`);
    } else if (upperCmd.includes('OFF') || upperCmd.includes('CLEAR')) {
      session.controlfileAutobackup = false;
      lines.push(`new RMAN configuration parameters:`);
      lines.push(`CONFIGURE CONTROLFILE AUTOBACKUP OFF;`);
    }
  } else if (upperCmd.includes('DEVICE TYPE')) {
    if (upperCmd.includes('SBT')) {
      session.deviceType = 'SBT_TAPE';
      lines.push(`new RMAN configuration parameters:`);
      lines.push(`CONFIGURE DEVICE TYPE SBT_TAPE;`);
    } else if (upperCmd.includes('DISK') || upperCmd.includes('CLEAR')) {
      session.deviceType = 'DISK';
      lines.push(`new RMAN configuration parameters:`);
      lines.push(`CONFIGURE DEVICE TYPE DISK;`);
    }
  } else if (upperCmd.includes('DEFAULT DEVICE TYPE')) {
    const match = cmd.match(/default\s+device\s+type\s+to\s+(\w+)/i);
    if (match) {
      session.deviceType = match[1].toUpperCase();
      lines.push(`new RMAN configuration parameters:`);
      lines.push(`CONFIGURE DEFAULT DEVICE TYPE TO ${session.deviceType};`);
    }
  } else if (upperCmd.includes('PARALLELISM')) {
    const match = cmd.match(/parallelism\s+(\d+)/i);
    if (match) {
      session.parallelism = parseInt(match[1], 10);
      lines.push(`new RMAN configuration parameters:`);
      lines.push(`CONFIGURE DEVICE TYPE DISK PARALLELISM ${session.parallelism};`);
    }
  } else if (upperCmd.includes('COMPRESSION ALGORITHM')) {
    const match = cmd.match(/compression\s+algorithm\s+'?(\w+)'?/i);
    if (match) {
      session.compressionAlgorithm = match[1].toUpperCase();
      lines.push(`new RMAN configuration parameters:`);
      lines.push(`CONFIGURE COMPRESSION ALGORITHM '${session.compressionAlgorithm}';`);
    }
  } else {
    return { output: '', error: 'RMAN-00558: error encountered while parsing input command' };
  }

  lines.push('');
  return { output: lines.join('\n') };
}

/**
 * Handle SHOW command
 */
function handleShow(session: RMANSession, cmd: string): RMANResult {
  const upperCmd = cmd.toUpperCase();
  const lines: string[] = [];

  lines.push('');
  lines.push('RMAN configuration parameters for database with db_unique_name ORCL are:');

  if (upperCmd.includes('ALL') || upperCmd === 'SHOW') {
    lines.push(`CONFIGURE RETENTION POLICY TO ${session.retentionPolicy};`);
    lines.push(`CONFIGURE BACKUP OPTIMIZATION ${session.backupOptimization ? 'ON' : 'OFF'};`);
    lines.push(`CONFIGURE DEFAULT DEVICE TYPE TO ${session.deviceType};`);
    lines.push(`CONFIGURE CONTROLFILE AUTOBACKUP ${session.controlfileAutobackup ? 'ON' : 'OFF'};`);
    lines.push(`CONFIGURE CONTROLFILE AUTOBACKUP FORMAT FOR DEVICE TYPE ${session.deviceType} TO '%F';`);
    lines.push(`CONFIGURE DEVICE TYPE ${session.deviceType} PARALLELISM ${session.parallelism} BACKUP TYPE TO BACKUPSET;`);
    lines.push(`CONFIGURE DATAFILE BACKUP COPIES FOR DEVICE TYPE ${session.deviceType} TO 1;`);
    lines.push(`CONFIGURE ARCHIVELOG BACKUP COPIES FOR DEVICE TYPE ${session.deviceType} TO 1;`);
    lines.push(`CONFIGURE MAXSETSIZE TO UNLIMITED;`);
    lines.push(`CONFIGURE ENCRYPTION FOR DATABASE OFF;`);
    lines.push(`CONFIGURE ENCRYPTION ALGORITHM 'AES128';`);
    lines.push(`CONFIGURE COMPRESSION ALGORITHM '${session.compressionAlgorithm}' AS OF RELEASE 'DEFAULT' OPTIMIZE FOR LOAD TRUE;`);
    lines.push(`CONFIGURE RMAN OUTPUT TO KEEP FOR 7 DAYS;`);
    lines.push(`CONFIGURE ARCHIVELOG DELETION POLICY TO NONE;`);
    lines.push(`CONFIGURE SNAPSHOT CONTROLFILE NAME TO '/u01/app/oracle/product/19c/dbs/snapcf_ORCL.f';`);
  } else if (upperCmd.includes('RETENTION')) {
    lines.push(`CONFIGURE RETENTION POLICY TO ${session.retentionPolicy};`);
  } else if (upperCmd.includes('BACKUP OPTIMIZATION')) {
    lines.push(`CONFIGURE BACKUP OPTIMIZATION ${session.backupOptimization ? 'ON' : 'OFF'};`);
  } else if (upperCmd.includes('CONTROLFILE AUTOBACKUP')) {
    lines.push(`CONFIGURE CONTROLFILE AUTOBACKUP ${session.controlfileAutobackup ? 'ON' : 'OFF'};`);
  } else if (upperCmd.includes('DEVICE TYPE')) {
    lines.push(`CONFIGURE DEFAULT DEVICE TYPE TO ${session.deviceType};`);
    lines.push(`CONFIGURE DEVICE TYPE ${session.deviceType} PARALLELISM ${session.parallelism} BACKUP TYPE TO BACKUPSET;`);
  }

  lines.push('');
  return { output: lines.join('\n') };
}

/**
 * Handle ALLOCATE CHANNEL command
 */
function handleAllocateChannel(session: RMANSession, cmd: string): RMANResult {
  const match = cmd.match(/allocate\s+channel\s+(\w+)\s+(?:device\s+)?type\s+(\w+)/i);

  if (match) {
    session.channel = match[1];
    session.deviceType = match[2].toUpperCase();
    return { output: `allocated channel: ${session.channel}\nchannel ${session.channel}: SID=123 device type=${session.deviceType}` };
  }

  return { output: '', error: 'RMAN-00558: error encountered while parsing input command' };
}

/**
 * Handle RELEASE CHANNEL command
 */
function handleReleaseChannel(session: RMANSession, cmd: string): RMANResult {
  const match = cmd.match(/release\s+channel\s+(\w+)/i);

  if (match) {
    const channelName = match[1];
    return { output: `released channel: ${channelName}` };
  }

  session.channel = 'ORA_DISK_1';
  return { output: `released channel: ${session.channel}` };
}

/**
 * Handle RUN block
 */
function handleRun(session: RMANSession, cmd: string): RMANResult {
  // Extract commands from RUN block
  const match = cmd.match(/run\s*\{([^}]+)\}/is);

  if (!match) {
    return { output: '', error: 'RMAN-00558: error encountered while parsing input command\nRMAN-01005: syntax error: missing closing brace' };
  }

  const commands = match[1].split(';').filter(c => c.trim());
  const results: string[] = [];

  for (const command of commands) {
    const trimmedCmd = command.trim();
    if (!trimmedCmd) continue;

    const result = executeRMAN(session, trimmedCmd);
    if (result.output) {
      results.push(result.output);
    }
    if (result.error) {
      return { output: results.join('\n'), error: result.error };
    }
  }

  return { output: results.join('\n') };
}

/**
 * Handle SQL command
 */
function handleSQL(session: RMANSession, cmd: string): RMANResult {
  const match = cmd.match(/sql\s+['"]?(.+?)['"]?\s*;?$/i);

  if (!match) {
    return { output: '', error: 'RMAN-00558: error encountered while parsing input command' };
  }

  const sqlCmd = match[1];

  return { output: `sql statement: ${sqlCmd}\nPL/SQL procedure successfully completed.` };
}

/**
 * Handle SHUTDOWN command
 */
function handleShutdown(session: RMANSession, cmd: string): RMANResult {
  const upperCmd = cmd.toUpperCase();
  let mode = 'NORMAL';

  if (upperCmd.includes('IMMEDIATE')) {
    mode = 'IMMEDIATE';
  } else if (upperCmd.includes('ABORT')) {
    mode = 'ABORT';
  } else if (upperCmd.includes('TRANSACTIONAL')) {
    mode = 'TRANSACTIONAL';
  }

  const lines: string[] = [];
  lines.push('');
  lines.push(`database closed`);
  lines.push(`database dismounted`);
  lines.push(`Oracle instance shut down`);
  lines.push('');

  return { output: lines.join('\n') };
}

/**
 * Handle STARTUP command
 */
function handleStartup(session: RMANSession, cmd: string): RMANResult {
  const upperCmd = cmd.toUpperCase();
  const lines: string[] = [];

  lines.push('');
  lines.push(`Oracle instance started`);
  lines.push('');
  lines.push(`Total System Global Area    2147483648 bytes`);
  lines.push(`Fixed Size                     8901944 bytes`);
  lines.push(`Variable Size                553648088 bytes`);
  lines.push(`Database Buffers            1577058304 bytes`);
  lines.push(`Redo Buffers                   7876608 bytes`);

  if (upperCmd.includes('MOUNT')) {
    lines.push('');
    lines.push('database mounted');
  } else if (upperCmd.includes('NOMOUNT')) {
    // No additional output for NOMOUNT
  } else {
    lines.push('');
    lines.push('database mounted');
    lines.push('database opened');
  }

  lines.push('');

  return { output: lines.join('\n') };
}

// Helper functions

function formatRMANDate(date: Date): string {
  const day = date.getDate().toString().padStart(2, '0');
  const months = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
  const month = months[date.getMonth()];
  const year = date.getFullYear().toString().slice(-2);
  const hours = date.getHours().toString().padStart(2, '0');
  const minutes = date.getMinutes().toString().padStart(2, '0');
  const seconds = date.getSeconds().toString().padStart(2, '0');

  return `${day}-${month}-${year} ${hours}:${minutes}:${seconds}`;
}

function formatBackupDate(date: Date): string {
  const year = date.getFullYear();
  const month = (date.getMonth() + 1).toString().padStart(2, '0');
  const day = date.getDate().toString().padStart(2, '0');

  return `${year}_${month}_${day}`;
}

function formatBackupTag(date: Date): string {
  const year = date.getFullYear();
  const month = (date.getMonth() + 1).toString().padStart(2, '0');
  const day = date.getDate().toString().padStart(2, '0');
  const hours = date.getHours().toString().padStart(2, '0');
  const minutes = date.getMinutes().toString().padStart(2, '0');
  const seconds = date.getSeconds().toString().padStart(2, '0');

  return `${year}${month}${day}T${hours}${minutes}${seconds}`;
}

function formatElapsedTime(seconds: number): string {
  const hrs = Math.floor(seconds / 3600).toString().padStart(2, '0');
  const mins = Math.floor((seconds % 3600) / 60).toString().padStart(2, '0');
  const secs = (seconds % 60).toString().padStart(2, '0');

  return `${hrs}:${mins}:${secs}`;
}

function formatBytes(bytes: number): string {
  if (bytes >= 1073741824) {
    return (bytes / 1073741824).toFixed(2) + 'G';
  } else if (bytes >= 1048576) {
    return (bytes / 1048576).toFixed(2) + 'M';
  } else if (bytes >= 1024) {
    return (bytes / 1024).toFixed(2) + 'K';
  }
  return bytes + 'B';
}

function formatSQLDate(date: Date): string {
  return date.toISOString().slice(0, 19).replace('T', ' ');
}

function getRMANHelp(): string {
  return `
Recovery Manager: Release 19.0.0.0.0 - Production

RMAN commands:

BACKUP           - Back up database files, archived logs, and copies
CATALOG          - Add information about files to the recovery catalog
CONFIGURE        - Configure persistent RMAN settings
CONNECT          - Connect to target or recovery catalog database
CROSSCHECK       - Check whether backup pieces and copies exist
DELETE           - Delete backups and copies
DUPLICATE        - Create a duplicate database
EXIT/QUIT        - Exit RMAN
LIST             - List backups and copies
RECOVER          - Apply redo logs to restore files
REGISTER         - Register database in recovery catalog
REPORT           - Produce detailed reports on backup activities
RESET            - Reset database to a previous incarnation
RESTORE          - Restore database files from backup
RUN              - Execute a series of RMAN commands
SET              - Set RMAN options for the current session
SHOW             - Display current configuration settings
SHUTDOWN         - Shutdown the target database
SQL              - Execute a SQL statement
STARTUP          - Start the target database
SWITCH           - Switch to use a backup as the current file
VALIDATE         - Check for corrupt blocks

Enter HELP <command> for help on a specific command.
`.trim();
}

/**
 * Get RMAN prompt
 */
export function getRMANPrompt(session: RMANSession): string {
  return 'RMAN> ';
}
