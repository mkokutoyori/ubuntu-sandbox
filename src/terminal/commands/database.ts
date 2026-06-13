/**
 * Database command handlers — manages Oracle instances per device.
 *
 * Each device that runs `sqlplus` gets a singleton OracleDatabase
 * automatically started (OPEN state) with demo schemas installed.
 */

import { OracleDatabase } from '@/database/oracle/OracleDatabase';
import { SQLPlusSession } from '@/database/oracle/commands/SQLPlusSession';
import type { OsSecurityContext } from '@/database/oracle/security/types';
import { installAllDemoSchemas } from '@/database/oracle/demo/DemoSchemas';
import { ORACLE_CONFIG } from '@/database/oracle/OracleConfig';
import { OracleFilesystemSync } from '@/adapters/OracleFilesystemSync';
import { OracleSystemdSync } from '@/adapters/OracleSystemdSync';
import { getDefaultEventBus } from '@/events/EventBus';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { DeviceCatalogRegistry } from '@/terminal/subshells/rman/catalog/DeviceCatalogRegistry';
import { resolveOracleConnectTarget, parseConnectIdentifier } from './oracleNet';
import { DeviceConfigRegistry } from '@/terminal/subshells/rman/session/DeviceConfigRegistry';

/** Per-device Oracle database instances. */
const oracleInstances: Map<string, OracleDatabase> = new Map();
/** Per-device FS sync adapter — Phase 7c replaces the manual *ToDevice helpers. */
const oracleFsSyncs: Map<string, OracleFilesystemSync> = new Map();
/** Per-device systemd sync adapter — wires oracle bus events to LinuxServiceManager. */
const oracleSystemdSyncs: Map<string, OracleSystemdSync> = new Map();

/**
 * Get or create an Oracle database for a device.
 * Automatically starts the instance and installs demo schemas on first access.
 */
export function getOracleDatabase(deviceId: string): OracleDatabase {
  let db = oracleInstances.get(deviceId);
  if (!db) {
    // Provision the Oracle home / datafiles / OS identity on the host
    // BEFORE the instance boots: the OPEN-time datafile check reads the
    // device VFS, so the disk must exist first. Idempotent — callers
    // that already ran initOracleFilesystem are unaffected.
    const dev = EquipmentRegistry.getInstance().getById(deviceId);
    if (dev) initOracleFilesystem(dev as import('@/network').HostCapableDevice);

    db = new OracleDatabase();
    // Phase 7c: wire bus + deviceId BEFORE startup so the boot sequence
    // (state-changed, background-process-started, alert log) is materialised
    // by the FS sync adapter without manual *ToDevice helper calls.
    db.instance.setEventBus(getDefaultEventBus());
    db.instance.setDeviceId(deviceId);
    // Device VFS reader for CREATE PFILE/SPFILE FROM … — injected here so
    // the database layer never imports network/Equipment directly.
    db.instance.setDeviceFileReader((path) => {
      const dev = EquipmentRegistry.getInstance().getById(deviceId);
      const read = (dev as unknown as { readFileForEditor?: (p: string) => string | null } | null)?.readFileForEditor;
      return typeof read === 'function' ? read.call(dev, path) ?? null : null;
    });
    // Existence probe for the MOUNT-time control file check and the
    // OPEN-time datafile check. Returns null (= skip the checks) when no
    // device with a filesystem backs this database — files can only go
    // missing from a disk that exists.
    db.instance.setHostFileProbe((path) => {
      const dev = EquipmentRegistry.getInstance().getById(deviceId);
      const read = (dev as unknown as { readFileForEditor?: (p: string) => string | null } | null)?.readFileForEditor;
      if (typeof read !== 'function') return null;
      return read.call(dev, path) !== null;
    });

    // Database links resolve their USING clause through the same Oracle
    // Net client as sqlplus@/tnsping — alias in this device's
    // tnsnames.ora or EZConnect, possibly to a remote topology host.
    db.setDbLinkResolver((connectString) => {
      const local = EquipmentRegistry.getInstance().getById(deviceId);
      if (!local) {
        return { ok: false, error: 'ORA-12154: TNS:could not resolve the connect identifier specified' };
      }
      return resolveOracleConnectTarget(
        local as import('@/network').HostCapableDevice, connectString, getOracleDatabase);
    });

    const sync = new OracleFilesystemSync(getDefaultEventBus(), {
      resolveDevice: (id) => EquipmentRegistry.getInstance().getById(id) ?? null,
      resolveDatabase: (id) => oracleInstances.get(id) ?? null,
    });
    sync.start();
    oracleFsSyncs.set(deviceId, sync);

    const systemd = new OracleSystemdSync(getDefaultEventBus(), {
      resolveDevice: (id) => EquipmentRegistry.getInstance().getById(id) ?? null,
      resolveDatabase: (id) => oracleInstances.get(id) ?? null,
    });
    systemd.start();
    oracleSystemdSyncs.set(deviceId, systemd);

    db.instance.startup('OPEN');
    // A freshly provisioned server boots with the listener running
    // (dbstart/systemd would have started it); `lsnrctl stop` still
    // takes it down realistically (ORA-12541 on @connects).
    db.instance.startListener();
    installAllDemoSchemas(db);
    oracleInstances.set(deviceId, db);
    // The boot provisioning (initOracleFilesystem) wrote the seed
    // datafiles before the database existed — tell the FS sync they are
    // materialised so it never recreates a file the user later deletes.
    sync.primeDatafiles(deviceId);
    sync.primeSgaMemory(deviceId);
  }
  return db;
}

/**
 * Create a SQL*Plus session for a device.
 * Parses the sqlplus command arguments to extract credentials.
 */
export function createSQLPlusSession(
  deviceId: string,
  args: string[],
  osCtx?: OsSecurityContext
): { session: SQLPlusSession; banner: string[]; loginOutput: string[] } {
  let db = getOracleDatabase(deviceId);
  const localDevice = EquipmentRegistry.getInstance().getById(deviceId) as
    import('@/network').HostCapableDevice | null;

  // `user/pass@identifier` — resolve through Oracle Net like a real
  // client (tnsnames.ora alias or EZConnect, possibly to a REMOTE host
  // across the simulated network) instead of silently using local.
  let username = '';
  let password = '';
  let asSysdba = false;
  let netError: string | null = null;

  const filtered = args.filter(a => !a.startsWith('-'));
  const asSysdbaIdx = filtered.findIndex(a => a.toUpperCase() === 'AS');
  if (asSysdbaIdx !== -1 && filtered[asSysdbaIdx + 1]?.toUpperCase() === 'SYSDBA') {
    asSysdba = true;
  }

  const connArg = filtered[0];
  let connectIdentifier: string | null = null;
  if (connArg && connArg !== '/' && connArg.includes('/')) {
    const at = connArg.indexOf('@');
    if (at >= 0) connectIdentifier = connArg.slice(at + 1);
  }
  let viaOracleNet = false;
  if (connectIdentifier && localDevice) {
    const res = resolveOracleConnectTarget(localDevice, connectIdentifier, getOracleDatabase);
    if (res.ok) { db = res.db; viaOracleNet = true; }
    else netError = res.error;
  }

  const session = new SQLPlusSession(db);
  // A connect identifier means the session came in through the listener:
  // its dedicated server process is forked LOCAL=NO, not bequeath.
  if (viaOracleNet) session.setTransport('tcp');
  // Bind the launching shell's OS identity so bequeath connections
  // (`/ as sysdba`) are gated by real dba-group membership and the audit
  // trail records the real OSUSER/MACHINE instead of a hardcoded default.
  if (osCtx) session.setOsContext(osCtx);
  // In-session CONNECT user/pass@X resolves through the same client.
  if (localDevice) {
    session.setTnsResolver((id) =>
      resolveOracleConnectTarget(localDevice, id, getOracleDatabase));
  }

  const banner = session.getBanner();
  let loginOutput: string[] = [];

  // Parse sqlplus arguments:
  //   sqlplus user/pass
  //   sqlplus user/pass@tns        (alias or EZConnect, local or remote)
  //   sqlplus / as sysdba
  //   sqlplus -s user/pass  (silent mode)
  //   sqlplus (no args — interactive login prompt, not supported yet)

  if (connArg) {
    if (connArg === '/' && asSysdba) {
      // sqlplus / as sysdba
    } else if (connArg.includes('/')) {
      // First slash only — EZConnect identifiers carry slashes
      // (user/pass@//host:port/service); the @-part was already
      // extracted above as the connect identifier.
      const slash = connArg.indexOf('/');
      username = connArg.slice(0, slash);
      password = connArg.slice(slash + 1).replace(/@.*$/, '');
    } else if (connArg !== 'AS') {
      username = connArg;
      // Would need password prompt — default to empty for now
    }
  }

  if (netError) {
    // The Oracle Net layer refused before any credential was checked —
    // exactly what a real client prints (ERROR: ORA-12541: …).
    loginOutput = ['ERROR:', netError];
  } else if (asSysdba || (connArg === '/' && asSysdba)) {
    loginOutput = session.login('SYS', '', true);
  } else if (username) {
    loginOutput = session.login(username, password);
  } else {
    // No credentials — just show banner, user can CONNECT later
    loginOutput = ['Not connected.'];
  }

  // Connecting through a PDB service lands the session in that container.
  if (connectIdentifier && localDevice && loginOutput.includes('Connected.')) {
    const service = parseConnectIdentifier(localDevice, connectIdentifier)?.service;
    if (service) session.enterContainerIfPdb(service);
  }

  return { session, banner, loginOutput };
}

/**
 * Remove the Oracle database for a device (cleanup).
 */
/**
 * Look up an existing Oracle database for a device WITHOUT creating one.
 * Returns undefined if no instance has been started yet — used by the
 * Oracle React hooks so they can safely return their empty fallback
 * before the user opens SQL*Plus.
 */
export function getRegisteredOracleDatabase(deviceId: string): OracleDatabase | undefined {
  return oracleInstances.get(deviceId);
}

export function removeOracleDatabase(deviceId: string): void {
  oracleFsSyncs.get(deviceId)?.stop();
  oracleFsSyncs.delete(deviceId);
  oracleSystemdSyncs.get(deviceId)?.stop();
  oracleSystemdSyncs.delete(deviceId);
  const db = oracleInstances.get(deviceId);
  if (db) {
    try { db.instance.shutdown('IMMEDIATE'); } catch { /* ignore */ }
  }
  oracleInstances.delete(deviceId);
  // Tear down the RMAN device-scoped catalog + config so a subsequent
  // getOracleDatabase(deviceId) starts fresh.
  DeviceCatalogRegistry.dispose(deviceId);
  DeviceConfigRegistry.dispose(deviceId);
}

/**
 * Reset all Oracle instances and filesystem state.
 * Intended for test isolation — clears both the instance map
 * and the filesystem-initialized tracking set.
 */
export function resetAllOracleInstances(): void {
  for (const sync of oracleFsSyncs.values()) sync.stop();
  oracleFsSyncs.clear();
  for (const sync of oracleSystemdSyncs.values()) sync.stop();
  oracleSystemdSyncs.clear();
  for (const db of oracleInstances.values()) {
    try { db.instance.shutdown('IMMEDIATE'); } catch { /* ignore */ }
  }
  oracleInstances.clear();
  oracleFilesystemInitialized.clear();
  DeviceCatalogRegistry._reset();
  DeviceConfigRegistry._reset();
}

/**
 * Initialize Oracle filesystem tree and environment on a Linux device.
 * Creates /u01/app/oracle/... directory structure and config files.
 * Safe to call multiple times — skips if already initialized.
 */
const oracleFilesystemInitialized = new Set<string>();

export function initOracleFilesystem(device: import('@/network').HostCapableDevice): void {
  const deviceId = device.id || 'default';
  if (oracleFilesystemInitialized.has(deviceId)) return;
  oracleFilesystemInitialized.add(deviceId);

  const oracleHome = ORACLE_CONFIG.HOME;
  const oracleBase = ORACLE_CONFIG.BASE;
  const sid = ORACLE_CONFIG.SID;
  const oradata = `${oracleBase}/oradata/${sid}`;

  // ── Configuration files ───────────────────────────────────────

  const files: Record<string, string> = {
    // tnsnames.ora — with both CDB and PDB entries
    [`${oracleHome}/network/admin/tnsnames.ora`]:
`ORCL =
  (DESCRIPTION =
    (ADDRESS = (PROTOCOL = TCP)(HOST = localhost)(PORT = 1521))
    (CONNECT_DATA =
      (SERVER = DEDICATED)
      (SERVICE_NAME = ORCL)
    )
  )

ORCLPDB =
  (DESCRIPTION =
    (ADDRESS = (PROTOCOL = TCP)(HOST = localhost)(PORT = 1521))
    (CONNECT_DATA =
      (SERVER = DEDICATED)
      (SERVICE_NAME = ORCLPDB)
    )
  )
`,
    // listener.ora
    [`${oracleHome}/network/admin/listener.ora`]:
`LISTENER =
  (DESCRIPTION_LIST =
    (DESCRIPTION =
      (ADDRESS = (PROTOCOL = TCP)(HOST = 0.0.0.0)(PORT = 1521))
    )
  )

SID_LIST_LISTENER =
  (SID_LIST =
    (SID_DESC =
      (GLOBAL_DBNAME = ORCL)
      (ORACLE_HOME = ${oracleHome})
      (SID_NAME = ORCL)
    )
  )

ADR_BASE_LISTENER = ${oracleBase}
`,
    // sqlnet.ora
    [`${oracleHome}/network/admin/sqlnet.ora`]:
`NAMES.DIRECTORY_PATH = (TNSNAMES, LDAP)
SQLNET.AUTHENTICATION_SERVICES = (NTS)
SQLNET.EXPIRE_TIME = 10
`,
    // init.ora — full parameter set matching BRD 4.1
    [`${oracleHome}/dbs/init${sid}.ora`]:
`db_name                  = ${sid}
db_domain                = localdomain
db_block_size            = 8192
db_cache_size            = 128M
shared_pool_size         = 256M
pga_aggregate_target     = 128M
sga_target               = 512M
sga_max_size             = 1G
processes                = 300
sessions                 = 472
open_cursors             = 300
undo_management          = AUTO
undo_tablespace          = UNDOTBS1
undo_retention           = 900
log_archive_dest_1       = 'LOCATION=${oracleBase}/archivelog'
log_archive_format       = 'arch_%t_%s_%r.arc'
db_recovery_file_dest    = '${oracleBase}/fast_recovery_area'
db_recovery_file_dest_size = 4G
audit_file_dest          = '${oracleBase}/admin/${sid}/adump'
audit_trail              = DB
diagnostic_dest          = ${oracleBase}
control_files            = ('${oradata}/control01.ctl',
                            '${oradata}/control02.ctl')
compatible               = 19.0.0
remote_login_passwordfile = EXCLUSIVE
`,
    // spfile — binary-format server parameter file (simulated text representation)
    [`${oracleHome}/dbs/spfile${sid}.ora`]:
`*.db_name='${sid}'
*.db_domain='localdomain'
*.db_block_size=8192
*.db_cache_size=128M
*.shared_pool_size=256M
*.pga_aggregate_target=128M
*.sga_target=512M
*.sga_max_size=1G
*.processes=300
*.sessions=472
*.open_cursors=300
*.undo_management='AUTO'
*.undo_tablespace='UNDOTBS1'
*.undo_retention=900
*.log_archive_dest_1='LOCATION=${oracleBase}/archivelog'
*.log_archive_format='arch_%t_%s_%r.arc'
*.db_recovery_file_dest='${oracleBase}/fast_recovery_area'
*.db_recovery_file_dest_size=4G
*.audit_file_dest='${oracleBase}/admin/${sid}/adump'
*.audit_trail='DB'
*.diagnostic_dest='${oracleBase}'
*.control_files='${oradata}/control01.ctl','${oradata}/control02.ctl'
*.compatible='19.0.0'
*.remote_login_passwordfile='EXCLUSIVE'
`,
    // orapwd — password file (stub binary)
    [`${oracleHome}/dbs/orapw${sid}`]:
`# Oracle password file (binary format simulated)
# Format: Oracle proprietary
# Users:   SYS (SYSDBA, SYSOPER)
# Created: ${new Date().toISOString().slice(0, 19)}
`,

    // ── /etc config ─────────────────────────────────────────────
    [`/etc/oratab`]: `${sid}:${oracleHome}:Y\n`,
    [`/etc/profile.d/oracle.sh`]:
`export ORACLE_HOME=${oracleHome}
export ORACLE_SID=${sid}
export ORACLE_BASE=${oracleBase}
export PATH=$ORACLE_HOME/bin:$PATH
export LD_LIBRARY_PATH=$ORACLE_HOME/lib
export TNS_ADMIN=$ORACLE_HOME/network/admin
`,

    // ── Stub binaries ($ORACLE_HOME/bin/) ─────────────────────
    [`${oracleHome}/bin/sqlplus`]: '#!/bin/bash\nexec $ORACLE_HOME/bin/.sqlplus "$@"\n',
    [`${oracleHome}/bin/lsnrctl`]: '#!/bin/bash\nexec $ORACLE_HOME/bin/.lsnrctl "$@"\n',
    [`${oracleHome}/bin/tnsping`]: '#!/bin/bash\nexec $ORACLE_HOME/bin/.tnsping "$@"\n',
    [`${oracleHome}/bin/dbca`]: '#!/bin/bash\nexec $ORACLE_HOME/bin/.dbca "$@"\n',
    [`${oracleHome}/bin/orapwd`]: '#!/bin/bash\nexec $ORACLE_HOME/bin/.orapwd "$@"\n',
    [`${oracleHome}/bin/rman`]: '#!/bin/bash\nexec $ORACLE_HOME/bin/.rman "$@"\n',
    [`${oracleHome}/bin/expdp`]: '#!/bin/bash\nexec $ORACLE_HOME/bin/.expdp "$@"\n',
    [`${oracleHome}/bin/impdp`]: '#!/bin/bash\nexec $ORACLE_HOME/bin/.impdp "$@"\n',
    [`${oracleHome}/bin/adrci`]: '#!/bin/bash\nexec $ORACLE_HOME/bin/.adrci "$@"\n',
    [`${oracleHome}/bin/srvctl`]: '#!/bin/bash\nexec $ORACLE_HOME/bin/.srvctl "$@"\n',
    [`${oracleHome}/bin/emctl`]: '#!/bin/bash\nexec $ORACLE_HOME/bin/.emctl "$@"\n',

    // ── Libraries ($ORACLE_HOME/lib/) ─────────────────────────
    [`${oracleHome}/lib/libclntsh.so`]: '# Oracle Client Shared Library (stub)\n',
    [`${oracleHome}/lib/libsqlplus.so`]: '# SQL*Plus Library (stub)\n',
    [`${oracleHome}/lib/libnnz19.so`]: '# Oracle Security Library (stub)\n',
    [`${oracleHome}/lib/libocci.so`]: '# Oracle C++ Call Interface Library (stub)\n',

    // ── Admin scripts ($ORACLE_HOME/rdbms/admin/) ─────────────
    [`${oracleHome}/rdbms/admin/catalog.sql`]:
`REM catalog.sql
REM Copyright (c) 1982, 2024, Oracle. All rights reserved.
REM
REM NAME
REM   catalog.sql - CATalog views
REM
REM DESCRIPTION
REM   Creates the data dictionary views.
REM   Must be run while connected AS SYSDBA.
REM
REM NOTES
REM   This is a simulated catalog script.

-- Data dictionary views would be created here
-- In this simulator, they are built-in to OracleCatalog.ts

SELECT 'Catalog creation complete.' FROM DUAL;
`,
    [`${oracleHome}/rdbms/admin/catproc.sql`]:
`REM catproc.sql
REM Copyright (c) 1992, 2024, Oracle. All rights reserved.
REM
REM NAME
REM   catproc.sql - CATalog PROCedural objects
REM
REM DESCRIPTION
REM   Creates the PL/SQL packages (DBMS_OUTPUT, DBMS_LOCK, UTL_FILE, etc.).
REM   Must be run while connected AS SYSDBA.
REM
REM NOTES
REM   This is a simulated catproc script.

-- PL/SQL packages would be created here
-- In this simulator, they are built-in to OracleDatabase.ts

SELECT 'Procedural option installation complete.' FROM DUAL;
`,
    [`${oracleHome}/rdbms/admin/utlrp.sql`]:
`REM utlrp.sql
REM Copyright (c) 2002, 2024, Oracle. All rights reserved.
REM
REM NAME
REM   utlrp.sql - UTiLity Recompile invalid objects
REM
REM DESCRIPTION
REM   Recompiles all invalid PL/SQL objects.

-- Recompilation logic simulated
SELECT 'All objects recompiled successfully.' FROM DUAL;
`,

    // ── Datafiles ($ORACLE_BASE/oradata/ORCL/) ────────────────
    [`${oradata}/system01.dbf`]: '[ORACLE DATAFILE - SYSTEM tablespace - 800M]',
    [`${oradata}/sysaux01.dbf`]: '[ORACLE DATAFILE - SYSAUX tablespace - 550M]',
    [`${oradata}/undotbs01.dbf`]: '[ORACLE DATAFILE - UNDO tablespace - 200M]',
    [`${oradata}/users01.dbf`]: '[ORACLE DATAFILE - USERS tablespace - 100M]',
    [`${oradata}/temp01.dbf`]: '[ORACLE TEMPFILE - TEMP tablespace - 100M]',
    [`${oradata}/redo01.log`]: '[ORACLE REDO LOG - Group 1 - 50M]',
    [`${oradata}/redo02.log`]: '[ORACLE REDO LOG - Group 2 - 50M]',
    [`${oradata}/redo03.log`]: '[ORACLE REDO LOG - Group 3 - 50M]',
    [`${oradata}/control01.ctl`]: '[ORACLE CONTROL FILE 1]',
    [`${oradata}/control02.ctl`]: '[ORACLE CONTROL FILE 2]',

    // ── Admin dump dirs ($ORACLE_BASE/admin/ORCL/) ────────────
    [`${oracleBase}/admin/${sid}/adump/.keep`]: '',
    [`${oracleBase}/admin/${sid}/bdump/.keep`]: '',
    [`${oracleBase}/admin/${sid}/cdump/.keep`]: '',
    [`${oracleBase}/admin/${sid}/udump/.keep`]: '',

    // ── Diagnostic trace dir ──────────────────────────────────
    [`${ORACLE_CONFIG.DIAG_TRACE}/alert_${sid}.log`]:
`${new Date().toISOString().replace('T', ' ').slice(0, 19)}
Starting ORACLE instance (normal)
LICENSE_MAX_SESSION = 0
LICENSE_SESSIONS_WARNING = 0
Shared memory segment for instance monitoring created
Picked latch-free SCN scheme 3
Using LOG_ARCHIVE_DEST_1 parameter default value as ${oracleBase}/archivelog
Thread 1 opened at log sequence 1
  Current log# 1 seq# 1 mem# 0: ${oradata}/redo01.log
Successful open of redo thread 1
MTTR advisory is disabled because FAST_START_MTTR_TARGET is not set
SMON: enabling cache recovery
Successfully onlined Undo Tablespace 2.
Verifying file header compatibility for 11g tablespace encryption..
Verifying 11g file header compatibility for tablespace encryption completed
SMON: enabling tx recovery
Database Characterset is AL32UTF8
No Resource Manager plan active
replication_dependency_tracking turned off (no async multimaster replication found)
Starting background process MMON
Starting background process MMNL
${new Date().toISOString().replace('T', ' ').slice(0, 19)}
Database ${sid} opened.
Completed: ALTER DATABASE OPEN
`,
    // ── Diagnostic incident dir ───────────────────────────────
    [`${ORACLE_CONFIG.DIAG_HOME}/incident/.keep`]: '',

    // ── Archived redo logs dir ────────────────────────────────
    [`${oracleBase}/archivelog/.keep`]: '',

    // ── Fast Recovery Area ────────────────────────────────────
    [`${oracleBase}/fast_recovery_area/.keep`]: '',
  };

  const install = (device as unknown as {
    installSystemFile?(path: string, content: string, uid?: number, gid?: number): boolean;
  }).installSystemFile?.bind(device);
  for (const [path, content] of Object.entries(files)) {
    if (install) {
      if (path.startsWith('/u01')) install(path, content, ORACLE_OS_UID, ORACLE_OS_GID);
      else install(path, content);
    } else {
      device.writeFileFromEditor?.(path, content);
    }
  }

  provisionOracleOsIdentity(device);

  // Register Oracle background processes so they appear in `ps aux`
  if (oracleInstances.has(deviceId)) {
    syncOracleProcessesToDevice(device, oracleInstances.get(deviceId)!);
  }
}

/**
 * Provision the OS identity a real Oracle installation requires
 * (oracle-database-preinstall): the oinstall/dba groups and the oracle
 * software owner. Runs through the device's own shell surface so
 * /etc/passwd, /etc/group and IAM events stay coherent.
 *
 * The pre-seeded operator cast (root, alice, bob, carl, dave) is added to
 * the dba group — this lab server is provisioned as if its admins were
 * DBA staff, so existing topologies keep working. Any *new* account is
 * outside dba and gets the real ORA-01031 on `sqlplus / as sysdba`.
 */
export const ORACLE_OS_UID = 54321;
export const ORACLE_OS_GID = 54321;

function provisionOracleOsIdentity(device: import('@/network').HostCapableDevice): void {
  const run = (device as unknown as {
    executeShellCommandSync?(command: string): string;
  }).executeShellCommandSync?.bind(device);
  if (!run) return;

  // Idempotent: groupadd/useradd answer "already exists" on re-init.
  run('groupadd -g 54321 oinstall');
  run('groupadd -g 54322 dba');
  run('useradd -u 54321 -g oinstall -G dba -m -d /home/oracle -s /bin/bash oracle');
  for (const u of ['root', 'alice', 'bob', 'carl', 'dave']) {
    run(`usermod -aG dba ${u}`);
  }
}

/**
 * Write updated spfile content to the VFS after ALTER SYSTEM SET ... SCOPE=SPFILE|BOTH.
 */
export function updateSpfileOnDevice(device: import('@/network').HostCapableDevice, parameters: Map<string, string>): void {
  const oracleHome = ORACLE_CONFIG.HOME;
  const sid = ORACLE_CONFIG.SID;
  const lines: string[] = [];
  for (const [name, value] of parameters) {
    const needsQuote = /[a-zA-Z]/.test(value) && !value.startsWith("'");
    lines.push(`*.${name}=${needsQuote ? `'${value}'` : value}`);
  }
  device.writeFileFromEditor?.(`${oracleHome}/dbs/spfile${sid}.ora`, lines.join('\n') + '\n');
}

/**
 * Write updated alert log to the VFS.
 */
export function syncAlertLogToDevice(device: import('@/network').HostCapableDevice, alertLogEntries: string[]): void {
  const sid = ORACLE_CONFIG.SID;
  const path = `${ORACLE_CONFIG.DIAG_TRACE}/alert_${sid}.log`;
  device.writeFileFromEditor?.(path, alertLogEntries.join('\n') + '\n');
}

/**
 * Sync tablespace datafiles from the Oracle storage layer to the VFS.
 * Creates stub files for new datafiles, removes files for dropped tablespaces.
 */
export function syncDatafilesToDevice(device: import('@/network').HostCapableDevice, db: OracleDatabase): void {
  const storage = db.storage as import('@/database/oracle/OracleStorage').OracleStorage;
  const tablespaces = storage.getAllTablespaces();

  // Create stub files for all datafiles in all tablespaces
  for (const ts of tablespaces) {
    for (const df of ts.datafiles) {
      const typeLabel = ts.type === 'TEMPORARY' ? 'TEMPFILE' : 'DATAFILE';
      const content = `[ORACLE ${typeLabel} - ${ts.name} tablespace - ${df.size}]`;
      device.writeFileFromEditor?.(df.path, content);
    }
  }

  // Sync redo log files from instance
  const redoGroups = db.instance.getRedoLogGroups();
  for (const group of redoGroups) {
    for (const member of group.members) {
      const sizeMB = Math.round(group.sizeBytes / 1048576);
      device.writeFileFromEditor?.(member, `[ORACLE REDO LOG - Group ${group.group} - ${sizeMB}M]`);
    }
  }

  // Sync control files from instance parameters
  const ctlFiles = (db.instance.getParameter('control_files') ?? '').split(',').map(f => f.trim()).filter(f => f);
  ctlFiles.forEach((f, i) => {
    device.writeFileFromEditor?.(f, `[ORACLE CONTROL FILE ${i + 1}]`);
  });
}

/**
 * Register Oracle background processes (PMON, SMON, etc.) in the device's process table
 * so they appear in `ps aux` output, like on a real Oracle server.
 */
export function syncOracleProcessesToDevice(device: import('@/network').HostCapableDevice, db: OracleDatabase): void {
  // Only register if the device supports it (LinuxServer)
  const dev = device as { registerProcess?: (pid: number, user: string, cmd: string) => void; clearSystemProcesses?: () => void };
  if (typeof dev.registerProcess !== 'function') return;

  dev.clearSystemProcesses!();

  if (db.instance.state === 'OPEN' || db.instance.state === 'MOUNT') {
    const sid = ORACLE_CONFIG.SID;
    const procs = db.instance.getBackgroundProcesses();
    for (const proc of procs) {
      // Oracle background processes appear as ora_<name>_<SID> in ps output
      dev.registerProcess(proc.pid, 'oracle', `ora_${proc.name.toLowerCase()}_${sid.toLowerCase()}`);
    }
    // Also register the listener if running
    if (db.instance.listenerStatus === 'running') {
      dev.registerProcess(procs.length > 0 ? procs[procs.length - 1].pid + 1 : 2000, 'oracle', `tnslsnr LISTENER -inherit`);
    }
  }
}
