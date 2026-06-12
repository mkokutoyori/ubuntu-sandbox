/**
 * OracleDatabase — Main orchestrator that wires together all Oracle components.
 *
 * Provides a single entry point for SQL execution, combining:
 *   - OracleInstance (state machine, background processes)
 *   - OracleStorage (tables, tablespaces, DUAL)
 *   - OracleCatalog (users, roles, privileges, dictionary views)
 *   - OracleLexer + OracleParser (SQL parsing)
 *   - OracleExecutor (statement execution)
 */

import { OracleInstance } from './OracleInstance';
import { OracleStorage } from './OracleStorage';
import { OracleCatalog } from './OracleCatalog';
import { OracleLexer } from './OracleLexer';
import { OracleParser } from './OracleParser';
import type { SqlCommandHost } from './SqlCommandHost';
import type {
  LockTableStatement, CreateFlashbackArchiveStatement, DropFlashbackArchiveStatement,
  PluggableDatabaseStatement, CreateTypeStatement, AlterSessionStatement,
} from '../engine/parser/ASTNode';
import { OracleExecutor } from './OracleExecutor';
import { SecurityEngine } from './security/SecurityEngine';
import { provisionPredefinedProfiles } from './security/classicProfiles';
import { DEFAULT_OS_CONTEXT, type OsSecurityContext } from './security/types';
import { OracleSession, type AuthenticationMethod } from './security/OracleSession';
import type { ExecutionContext } from '../engine/executor/BaseExecutor';
import type { ResultSet } from '../engine/executor/ResultSet';
import { ORACLE_ERRORS } from './OracleConfig';
import { emptyResult } from '../engine/executor/ResultSet';
import type { OracleDatabaseConfig } from '../engine/types/DatabaseConfig';
import type { CellValue } from '../engine/storage/BaseStorage';
import { SodEvaluator } from './security/audit/SodEvaluator';
import { DormantAccountAnalyzer } from './security/audit/DormantAccountAnalyzer';
import { FraudScenarioSimulator } from './security/audit/FraudScenarioSimulator';
import { MetadataExtractor } from './metadata/MetadataExtractor';
import { builtinPackageRegistry } from './packages';
import { SystemTrigger } from './triggers/SystemTrigger';
import { ConsumerGroupSwitcher } from './resource/ConsumerGroupSwitcher';
import { PlanGenerator } from './plan/PlanGenerator';
import { PlsqlException, findPredefinedException } from './plsql/PlsqlException';
import { runAnonymousBlock, PlsqlInterpreter } from './plsql';
import type { PlsqlHost, StoredUnitLike, Scalar, PackageSection, PackageRuntimeHandle, PackageSessionState } from './plsql';
import { compilePackageSection, declarationNames } from './plsql';
import { compileStoredUnit } from './plsql/unitSource';
import { SchedulerManager } from './scheduler/SchedulerManager';
import { FlashbackArchive, FlashbackArchiveTablespace } from './flashback/FlashbackArchive';
import { InMemorySegment } from './resultcache/InMemoryManager';
import type { UserActivityTracker } from './security/audit/UserActivityTracker';
import { IdleSessionMonitor } from './security/audit/IdleSessionMonitor';
import { isOffHours } from './security/audit/SecurityPolicyConfig';
import type { OracleConnectionTracedPayload } from './events';

/** Runtime state for an explicit PL/SQL cursor */
export interface CursorState {
  query: string;
  params?: { name: string; type: string }[];
  rows: CellValue[][] | null;
  columns: string[];
  position: number; // -1 = before first row
  isOpen: boolean;
}

export interface ConnectionInfo {
  username: string;
  schema: string;
  connectedAt: Date;
  sid: number;
  serial: number;
}

/** Stored PL/SQL unit (procedure, function, or package) */
export interface StoredPLSQLUnit {
  schema: string;
  name: string;
  type: 'PROCEDURE' | 'FUNCTION' | 'PACKAGE' | 'PACKAGE BODY' | 'TRIGGER';
  parameters: Array<{ name: string; mode: 'IN' | 'OUT' | 'IN OUT'; dataType: string; defaultValue?: string }>;
  returnType?: string; // For functions only
  body: string; // Full PL/SQL source
  sourceLines: string[]; // Source split by lines (for DBA_SOURCE)
  created: Date;
  status: 'VALID' | 'INVALID';
}

/**
 * A user-defined package: spec and body compiled through the real
 * PL/SQL parser. `version` increments on every redefinition so that
 * per-session instantiation state can be discarded (ORA-04068).
 */
interface UserPackage {
  schema: string;
  name: string;
  version: number;
  spec: PackageSection;
  body: PackageSection | null;
  /** Members declared in the spec — the package's public surface. */
  publicNames: Set<string>;
}

export class OracleDatabase implements SqlCommandHost {
  readonly instance: OracleInstance;
  readonly storage: OracleStorage;
  readonly catalog: OracleCatalog;
  readonly securityEngine: SecurityEngine;
  private lexer: OracleLexer;
  private connections: Map<number, ConnectionInfo> = new Map();
  // SIDs 1-4 are reserved for simulated background processes (PMON/SMON/DBW0/LGWR)
  private sidCounter: number = 5;
  /** Stored PL/SQL units (procedures, functions, packages) */
  private storedUnits: Map<string, StoredPLSQLUnit> = new Map();
  /** User-defined packages, keyed "SCHEMA.NAME". */
  private userPackages: Map<string, UserPackage> = new Map();
  /** Per-session (per-executor) package instantiation state. */
  private packageSessionStates: WeakMap<object, Map<string, PackageSessionState>> = new WeakMap();
  /** Last unit compiled in this session — what SHOW ERRORS reports on. */
  private lastCompiledUnit: { schema: string; name: string; type: string } | null = null;
  /** Per-block partial line buffer for DBMS_OUTPUT.PUT (no implicit
   *  newline until PUT_LINE / NEW_LINE / DISABLE). Keyed by the
   *  `output: string[]` array the PL/SQL executor passes through. */
  private dbmsOutputBuffers: WeakMap<string[], string> = new WeakMap();

  /** Live OracleSession objects keyed by SID — the dictionary feeds
   *  V$SESSION, SYS_CONTEXT('USERENV', …) and DBMS_SESSION. */
  private sessions: Map<number, OracleSession> = new Map();

  /**
   * Build the instance-identity payload OracleSession needs.
   * Reads live values from `OracleInstance` parameters so renaming /
   * relocation is automatically reflected.
   */
  private buildInstanceIdentity(): {
    instanceId: number; instanceName: string;
    dbName: string; dbUniqueName: string; dbDomain: string; serverHost: string;
  } {
    const dbName = this.instance.getParameter('db_name') ?? 'orcl';
    return {
      instanceId: 1,
      instanceName: dbName,
      dbName,
      dbUniqueName: this.instance.getParameter('db_unique_name') ?? dbName,
      dbDomain: this.instance.getParameter('db_domain') ?? 'localdomain',
      serverHost: this.instance.getParameter('server_host') ?? 'localhost',
    };
  }

  /** Open OracleSession + register in the sessions map. */
  private openSession(args: {
    sid: number; serial: number; username: string; schema?: string;
    osCtx: OsSecurityContext; authenticationMethod: AuthenticationMethod;
    type?: 'USER' | 'BACKGROUND'; authenticatedIdentity?: string;
  }): OracleSession {
    const user = this.catalog.getUser(args.username.toUpperCase());
    const session = new OracleSession({
      sid: args.sid,
      serial: args.serial,
      username: args.username,
      schema: args.schema,
      osContext: args.osCtx,
      authenticationMethod: args.authenticationMethod,
      type: args.type,
      authenticatedIdentity: args.authenticatedIdentity ?? user?.externalName,
      instance: this.buildInstanceIdentity(),
    });
    this.sessions.set(args.sid, session);
    return session;
  }

  /**
   * Typed manager bundle handed to built-in package routines — replaces the
   * former hidden `_xxxManager` fields smuggled onto each OracleSession.
   */
  private packageServices(): import('./packages/PackageRegistry').PackageServices {
    return {
      awr: this.instance.awrManager,
      resourceManager: this.instance.resourceManager,
      statistics: this.instance.statistics,
      scheduler: this.scheduler,
      storage: this.storage,
      materializedViews: {
        refresh: (owner, name) => this.refreshMaterializedView(owner, name),
      },
    };
  }

  /**
   * Complete refresh of a materialized view, re-executing its defining
   * query with the MV owner's name resolution (definer semantics, like
   * the real DBMS_MVIEW.REFRESH). Throws ORA-12003 when unknown.
   */
  refreshMaterializedView(owner: string, name: string): void {
    const o = owner.toUpperCase();
    const context: ExecutionContext = {
      currentUser: o,
      currentSchema: o,
      autoCommit: false,
      serverOutput: false,
      feedback: false,
      timing: false,
    };
    const executor = new OracleExecutor(this.storage, this.catalog, this.instance, context);
    executor.setCommandHost(this);
    executor.setDatabaseRef(this);
    executor.refreshMaterializedView(o, name);
  }

  /** Close an OracleSession (called on disconnect). */
  closeSession(sid: number): void {
    this.sessions.delete(sid);
  }

  /** All currently-open sessions. */
  getOpenSessions(): readonly OracleSession[] {
    return [...this.sessions.values()];
  }

  /** Locate an open session by SID. */
  getSession(sid: number): OracleSession | undefined {
    return this.sessions.get(sid);
  }

  readonly sodEvaluator: SodEvaluator;
  readonly dormantAnalyzer: DormantAccountAnalyzer;
  readonly fraudSimulator: FraudScenarioSimulator;
  readonly metadata: MetadataExtractor;
  readonly idleMonitor: IdleSessionMonitor;
  /** Resource Manager — consumer-group switcher driven by the bus. */
  readonly consumerGroupSwitcher: ConsumerGroupSwitcher;
  readonly planGenerator: PlanGenerator;
  readonly scheduler: SchedulerManager;
  /** Reactive user-activity ledger. The instance owns the tracker so
   *  that setDeviceId triggers a rebind; expose it as a getter so the
   *  current tracker is always returned. */
  get userActivity(): UserActivityTracker {
    return this.instance.getUserActivityTracker()!;
  }

  constructor(config?: Partial<OracleDatabaseConfig>) {
    this.instance = new OracleInstance(config);
    this.storage = new OracleStorage();
    // The instance checks datafile existence at OPEN time but does not
    // own the storage layer — give it the canonical V$DATAFILE list.
    this.instance.setDatafileLister(() => this.storage.listDatafiles());
    this.catalog = new OracleCatalog(this.storage, this.instance);
    this.catalog.setStoredUnitsProvider(() => this.getStoredUnits());
    this.catalog.setPackageMembersProvider(() => this.getPackageMembers());
    this.securityEngine = new SecurityEngine(this.catalog);
    this.catalog.setSecurityEngine(this.securityEngine);
    // Provision the predefined non-DEFAULT profiles (MONITORING_PROFILE,
    // ORA_STIG_PROFILE) so a fresh instance matches a real 19c install.
    provisionPredefinedProfiles(this.securityEngine.profiles);
    this.lexer = new OracleLexer();

    // Wire the security-audit cooperators. The actor lives on the
    // instance (subscribed to the bus); these helpers read the catalog
    // and write through the actor so violations / dormant detections
    // are journaled and published on the same bus.
    const journal = this.instance.getAuditJournal();
    const actor = this.instance.getSecurityAuditActor()!;
    this.sodEvaluator = new SodEvaluator(this.catalog, this.securityEngine, journal, actor);
    this.dormantAnalyzer = new DormantAccountAnalyzer(this.catalog, journal, actor, this.securityEngine);
    this.fraudSimulator = new FraudScenarioSimulator(this, actor, this.sodEvaluator, this.dormantAnalyzer);
    this.metadata = new MetadataExtractor(this.storage, this.catalog);
    // Index usage monitor — must attach now that storage exists.
    this.instance.attachIndexUsageMonitor(this.storage);
    // Live-session provider — feeds V$SESSION_CONTEXT user-defined
    // contexts and any future view that needs the real OracleSession.
    this.instance.setLiveSessionProvider(() => [...this.sessions.values()]);
    // Resource Manager — active consumer-group switcher reacting to
    // session connect + SQL execution events.
    this.consumerGroupSwitcher = new ConsumerGroupSwitcher(
      this.instance.getBus(), this.instance.getDeviceId(),
      this.securityEngine, this.instance.resourceManager);
    this.consumerGroupSwitcher.start();
    // Statistics + plan generator — both need storage.
    this.instance.attachStatistics(this.storage);
    this.planGenerator = new PlanGenerator(this.storage, this.instance);
    this.instance.getRuntimeState().planProvider = (sqlText, parsingSchema) => {
      try {
        const tokens = new OracleLexer().tokenize(sqlText);
        const stmt = new OracleParser().parse(tokens);
        const plan = this.planGenerator.generate(stmt, '', sqlText, parsingSchema || 'SYS');
        return plan.nodes.map(n => ({
          lineId: n.id,
          depth: n.depth,
          operation: n.operation,
          options: n.options,
          objectOwner: n.objectOwner,
          objectName: n.objectName,
          cardinality: n.cardinality,
          cost: n.cost,
        }));
      } catch {
        return null;
      }
    };
    this.scheduler = new SchedulerManager(this);
    this.instance.attachScheduler(this.scheduler);
    // User-activity ledger lives on the instance (rebinds on setDeviceId);
    // the getter `userActivity` returns the current tracker on demand.
    // Idle-session PMON sweep (IDLE_TIME enforcement).
    this.idleMonitor = new IdleSessionMonitor(
      this.instance.getBus(), this.instance.getDeviceId(),
      this.instance.config.sid, this.securityEngine, this.catalog);

    // Reactive: re-scan SoD whenever a GRANT/REVOKE/CREATE USER crosses
    // the audit bus. The executor publishes `oracle.audit.recorded` for
    // every audited DCL statement (GRANT/REVOKE never fire `oracle.ddl
    // .executed` because they're DCL, not DDL).
    this.instance.getBus().subscribe('oracle.audit.recorded', (e) => {
      if (e.payload.deviceId !== this.instance.getDeviceId()) return;
      const a = e.payload.actionName.toUpperCase();
      if (a === 'GRANT' || a === 'REVOKE' || a === 'CREATE USER' || a === 'ALTER USER') {
        this.sodEvaluator.scanAll();
      }
    });
  }

  /**
   * Authenticate a user and create a new connection/session.
   * Returns a session ID or throws on auth failure.
   */
  connect(
    username: string,
    password: string,
    osCtx: OsSecurityContext = DEFAULT_OS_CONTEXT
  ): { sid: number; executor: OracleExecutor } {
    if (!this.instance.isOpen) {
      throw new Error(ORACLE_ERRORS.ORA_01034);
    }

    const upperUser = username.toUpperCase();
    const user = this.catalog.getUser(upperUser);

    /**
     * Wrap a failed-auth throw so every rejection path also leaves a
     * trace in the audit trail and alert log. SESSIONID 0 is the
     * canonical Oracle marker for "no session was ever opened".
     */
    const failLogon = (code: number, message: string): never => {
      this.catalog.recordLogon(upperUser, 0, code, osCtx.osUser, osCtx.hostname, osCtx.terminal);
      this.instance.logAlertEvent(`Failed logon: user=${upperUser} ORA-${String(code).padStart(5, '0')}`);
      this.publishConnectionTrace({
        username: upperUser, sessionId: 0, serial: 0, osCtx,
        authMethod: 'PASSWORD', role: 'NORMAL',
        outcome: 'FAILURE', returncode: code,
      });
      throw new Error(message);
    };

    // Dispatch on AUTHENTICATION_TYPE recorded at CREATE USER time.
    if (user?.authenticationType === 'EXTERNAL') {
      // OS-authenticated user: name must match `<os_prefix><osUser>` (default OPS$).
      // Real Oracle uses init parameter OS_AUTHENT_PREFIX; we simulate with 'OPS$'.
      const expected = `OPS$${osCtx.osUser.toUpperCase()}`;
      if (upperUser !== expected) {
        failLogon(1017, ORACLE_ERRORS.ORA_01017);
      }
    } else if (user?.authenticationType === 'GLOBAL') {
      // Directory-authenticated: no password path supported in this simulation.
      failLogon(1017, ORACLE_ERRORS.ORA_01017);
    } else {
      // Standard password authentication via SecurityEngine:
      // enforces lock, failed-login tracking, expiry.
      const storedPassword = this.catalog.getStoredPassword(upperUser);
      const authResult = this.securityEngine.authenticate(upperUser, password, this.catalog, storedPassword);
      if (!authResult.success) {
        failLogon(authResult.errorCode || 1017, authResult.message || ORACLE_ERRORS.ORA_01017);
      }
    }

    // Enforce CREATE SESSION privilege (direct or via role)
    if (!this.securityEngine.privileges.hasSystemPrivilege(upperUser, 'CREATE SESSION')) {
      failLogon(1045, 'ORA-01045: user ' + upperUser + ' lacks CREATE SESSION privilege; logon denied');
    }

    // RESTRICTED SESSION mode (STARTUP RESTRICT / ALTER SYSTEM ENABLE
    // RESTRICTED SESSION): only users holding the RESTRICTED SESSION
    // privilege may log on. SYSDBA connections bypass this entirely
    // (they use connectAsSysdba, not this path).
    if (this.instance.restrictedSession
        && !this.securityEngine.privileges.hasSystemPrivilege(upperUser, 'RESTRICTED SESSION')) {
      failLogon(1035, ORACLE_ERRORS.ORA_01035);
    }

    const sid = this.sidCounter++;
    const serial = Math.floor(Math.random() * 50000) + 1;

    const connInfo: ConnectionInfo = {
      username: upperUser,
      schema: upperUser,
      connectedAt: new Date(),
      sid,
      serial,
    };
    this.connections.set(sid, connInfo);

    // Register session in SecurityEngine with the same sid/serial used by OracleDatabase
    const sessionId = String(sid);
    const sessionResult = this.securityEngine.openSession(sessionId, upperUser, upperUser, osCtx, this.catalog, sid, serial);
    if (!sessionResult.ok) {
      this.connections.delete(sid);
      this.catalog.recordLogon(upperUser, sid, 2391, osCtx.osUser, osCtx.hostname, osCtx.terminal);
      throw new Error(sessionResult.error ?? 'ORA-02391: exceeded simultaneous SESSIONS_PER_USER limit');
    }
    this.catalog.recordLogon(upperUser, sid, 0, osCtx.osUser, osCtx.hostname, osCtx.terminal);
    this.instance.logAlertEvent(`Logon: user=${upperUser} sid=${sid}`);
    this.publishConnectionTrace({
      username: upperUser, sessionId: sid, serial, osCtx,
      authMethod: user?.authenticationType === 'EXTERNAL' ? 'EXTERNAL'
        : user?.authenticationType === 'GLOBAL' ? 'GLOBAL' : 'PASSWORD',
      role: 'NORMAL', outcome: 'SUCCESS', returncode: 0,
    });

    const authMethod: AuthenticationMethod =
      user?.authenticationType === 'EXTERNAL' ? 'EXTERNAL'
      : user?.authenticationType === 'GLOBAL' ? 'GLOBAL'
      : 'PASSWORD';
    const session = this.openSession({
      sid, serial, username: upperUser, osCtx, authenticationMethod: authMethod,
    });

    const context: ExecutionContext = {
      currentUser: upperUser,
      currentSchema: upperUser,
      autoCommit: false,
      serverOutput: false,
      feedback: true,
      timing: false,
      session,
    };

    const executor = new OracleExecutor(this.storage, this.catalog, this.instance, context);
    executor.setCommandHost(this);
    executor.setDatabaseRef(this);
    return { sid, executor };
  }

  /**
   * Reject a bequeath `AS SYSDBA`/`AS SYSOPER` attempt from an OS user
   * outside the dba group. Real Oracle leaves a trace of every refused
   * privileged logon (OS audit file + audit trail, SESSIONID 0) before
   * returning ORA-01031 — failures must be as observable as successes.
   */
  private rejectOsAuthentication(role: 'SYSDBA' | 'SYSOPER', osCtx: OsSecurityContext): never {
    this.catalog.recordAudit({
      sessionId: 0, username: 'SYS', actionName: 'LOGON', returncode: 1031,
      osUsername: osCtx.osUser, userhost: osCtx.hostname, terminal: osCtx.terminal,
      privUsed: role, statementType: 'LOGON',
    });
    this.instance.logAlertEvent(
      `Failed ${role} logon: os_user=${osCtx.osUser} not in dba group (ORA-01031)`);
    this.publishConnectionTrace({
      username: 'SYS', sessionId: 0, serial: 0, osCtx,
      authMethod: role, role, outcome: 'FAILURE', returncode: 1031,
    });
    throw new Error('ORA-01031: insufficient privileges');
  }

  /**
   * Connect as SYSDBA (no password check, sets user to SYS).
   */
  connectAsSysdba(osCtx: OsSecurityContext = DEFAULT_OS_CONTEXT): { sid: number; executor: OracleExecutor } {
    // OS-group enforcement: SYSDBA requires the OS user to be in the dba group.
    if (osCtx !== DEFAULT_OS_CONTEXT && !osCtx.isDbaGroup) {
      this.rejectOsAuthentication('SYSDBA', osCtx);
    }
    const sid = this.sidCounter++;
    const serial = Math.floor(Math.random() * 50000) + 1;

    const connInfo: ConnectionInfo = {
      username: 'SYS',
      schema: 'SYS',
      connectedAt: new Date(),
      sid,
      serial,
    };
    this.connections.set(sid, connInfo);

    // Register SYSDBA session with matching sid/serial
    const sessionId = String(sid);
    this.securityEngine.openSession(sessionId, 'SYS', 'SYS', { ...osCtx, program: osCtx.program ?? 'sqlplus@localhost' }, this.catalog, sid, serial);
    // Record audit + alert log — SYSDBA logons are first-class events.
    this.catalog.recordAudit({
      sessionId: sid, username: 'SYS', actionName: 'LOGON', returncode: 0,
      osUsername: osCtx.osUser, userhost: osCtx.hostname, terminal: osCtx.terminal,
      privUsed: 'SYSDBA', statementType: 'LOGON',
    });
    this.instance.logAlertEvent(`Logon: user=SYS sid=${sid} as SYSDBA`);
    this.publishConnectionTrace({
      username: 'SYS', sessionId: sid, serial, osCtx,
      authMethod: 'SYSDBA', role: 'SYSDBA', outcome: 'SUCCESS', returncode: 0,
    });

    const sysSession = this.openSession({
      sid, serial, username: 'SYS', osCtx: { ...osCtx, program: osCtx.program ?? 'sqlplus@localhost' },
      authenticationMethod: 'SYSDBA',
    });

    const context: ExecutionContext = {
      currentUser: 'SYS',
      currentSchema: 'SYS',
      autoCommit: false,
      serverOutput: false,
      feedback: true,
      timing: false,
      session: sysSession,
    };

    const executor = new OracleExecutor(this.storage, this.catalog, this.instance, context);
    executor.setCommandHost(this);
    executor.setDatabaseRef(this);
    return { sid, executor };
  }

  /**
   * Connect as SYSOPER — limited admin role (PUBLIC schema, no user-data access).
   * Like SYSDBA, requires OS dba group membership.
   */
  connectAsSysoper(osCtx: OsSecurityContext = DEFAULT_OS_CONTEXT): { sid: number; executor: OracleExecutor } {
    if (osCtx !== DEFAULT_OS_CONTEXT && !osCtx.isDbaGroup) {
      this.rejectOsAuthentication('SYSOPER', osCtx);
    }
    const sid = this.sidCounter++;
    const serial = Math.floor(Math.random() * 50000) + 1;

    const connInfo: ConnectionInfo = {
      username: 'PUBLIC',
      schema: 'PUBLIC',
      connectedAt: new Date(),
      sid,
      serial,
    };
    this.connections.set(sid, connInfo);

    const sessionId = String(sid);
    this.securityEngine.openSession(sessionId, 'PUBLIC', 'PUBLIC',
      { ...osCtx, program: osCtx.program ?? 'sqlplus@localhost' },
      this.catalog, sid, serial);

    const sysoperSession = this.openSession({
      sid, serial, username: 'PUBLIC', osCtx: { ...osCtx, program: osCtx.program ?? 'sqlplus@localhost' },
      authenticationMethod: 'SYSOPER',
    });
    this.publishConnectionTrace({
      username: 'PUBLIC', sessionId: sid, serial, osCtx,
      authMethod: 'SYSOPER', role: 'SYSOPER', outcome: 'SUCCESS', returncode: 0,
    });

    const context: ExecutionContext = {
      currentUser: 'PUBLIC',
      currentSchema: 'PUBLIC',
      autoCommit: false,
      serverOutput: false,
      feedback: true,
      timing: false,
      session: sysoperSession,
    };

    const executor = new OracleExecutor(this.storage, this.catalog, this.instance, context);
    executor.setCommandHost(this);
    executor.setDatabaseRef(this);
    return { sid, executor };
  }

  /**
   * Disconnect a session.
   */
  disconnect(sid: number): void {
    const conn = this.connections.get(sid);
    if (conn) {
      this.catalog.recordLogoff(conn.username, sid);
      this.instance.logAlertEvent(`Logoff: user=${conn.username} sid=${sid}`);
      this.publishConnectionTrace({
        username: conn.username, sessionId: sid, serial: conn.serial,
        osCtx: DEFAULT_OS_CONTEXT, authMethod: 'PASSWORD', role: 'NORMAL',
        outcome: 'LOGOFF', returncode: 0,
      });
    }
    this.connections.delete(sid);
    this.securityEngine.closeSession(String(sid));
  }

  /** Build and publish the rich oracle.security.connection-traced event. */
  private publishConnectionTrace(args: {
    username: string; sessionId: number; serial: number; osCtx: OsSecurityContext;
    authMethod: string; role: 'NORMAL' | 'SYSDBA' | 'SYSOPER';
    outcome: 'SUCCESS' | 'FAILURE' | 'LOGOFF'; returncode: number;
  }): void {
    const ip = args.osCtx.hostname === 'localhost' || args.osCtx.hostname === '127.0.0.1'
      ? '127.0.0.1' : '';
    const proto = /@localhost$/i.test(args.osCtx.program) ? 'beq' : 'tcp';
    const authType = args.role === 'SYSDBA' || args.role === 'SYSOPER' ? 'DATABASE'
      : args.authMethod === 'EXTERNAL' ? 'OS'
      : args.authMethod === 'GLOBAL' ? 'NETWORK' : 'DATABASE';
    const now = new Date();
    const payload: OracleConnectionTracedPayload = {
      deviceId: this.instance.getDeviceId(),
      sid: this.instance.config.sid,
      sessionId: args.sessionId,
      serial: args.serial,
      username: args.username,
      osUser: args.osCtx.osUser,
      userhost: args.osCtx.hostname,
      terminal: args.osCtx.terminal,
      program: args.osCtx.program,
      ipAddress: ip,
      networkProtocol: proto,
      authenticationMethod: args.authMethod,
      authenticationType: authType,
      returncode: args.returncode,
      outcome: args.outcome,
      role: args.role,
      timestamp: now,
      offHours: isOffHours(now),
    };
    this.instance.getBus().publish({ topic: 'oracle.security.connection-traced', payload });
  }

  /**
   * Single entry point that recognises PL/SQL constructs and routes them
   * to the PL/SQL subsystem. Returns the result when the statement is a
   * PL/SQL construct, or null when it is plain SQL (so the caller hands
   * it to the SQL parser). Centralises what used to be a dozen ad-hoc
   * regex checks scattered through executeSql.
   */
  private routePlsql(executor: OracleExecutor, trimmed: string, upper: string): ResultSet | null {
    if (upper.startsWith('BEGIN') || upper.startsWith('DECLARE')) {
      return this.executePLSQL(executor, trimmed);
    }
    if (/^CREATE\s+(OR\s+REPLACE\s+)?PROCEDURE\b/i.test(upper)) {
      return this.createStoredProcedure(executor, trimmed);
    }
    if (/^CREATE\s+(OR\s+REPLACE\s+)?FUNCTION\b/i.test(upper)) {
      return this.createStoredFunction(executor, trimmed);
    }
    if (/^CREATE\s+(OR\s+REPLACE\s+)?PACKAGE\s+BODY\b/i.test(upper)) {
      return this.createPackageBody(executor, trimmed);
    }
    if (/^CREATE\s+(OR\s+REPLACE\s+)?PACKAGE\b/i.test(upper)) {
      return this.createPackageSpec(executor, trimmed);
    }
    if (/^CREATE\s+(OR\s+REPLACE\s+)?TRIGGER\b/i.test(upper)) {
      return this.executeCreateTrigger(executor, trimmed);
    }
    if (/^EXEC(?:UTE)?\s+/i.test(upper)) {
      return this.executeProcedureCall(executor, trimmed);
    }
    if (/^DROP\s+PROCEDURE\b/i.test(upper)) {
      return this.dropStoredUnit(executor, trimmed, 'PROCEDURE');
    }
    if (/^DROP\s+FUNCTION\b/i.test(upper)) {
      return this.dropStoredUnit(executor, trimmed, 'FUNCTION');
    }
    if (/^DROP\s+PACKAGE\s+BODY\b/i.test(upper)) {
      return this.dropStoredUnit(executor, trimmed, 'PACKAGE BODY');
    }
    if (/^DROP\s+PACKAGE\b/i.test(upper)) {
      return this.dropPackage(executor, trimmed);
    }
    // Standalone procedure call: proc_name(args) or pkg.proc(args).
    if (/^[A-Za-z_]\w*(?:\.\w+)?\s*\(/.test(trimmed) && !upper.startsWith('SELECT') && !upper.startsWith('INSERT')) {
      const callResult = this.tryExecuteProcedureCall(executor, trimmed);
      if (callResult) return callResult;
    }
    return null;
  }

  /**
   * Parse and execute a SQL statement string.
   * Handles both regular SQL and PL/SQL anonymous blocks.
   */
  executeSql(executor: OracleExecutor, sql: string): ResultSet {
    const trimmed = sql.trim().replace(/;\s*$/, '');
    if (!trimmed) return emptyResult();

    const upper = trimmed.toUpperCase();

    // PL/SQL is a distinct language whose unit bodies contain semicolons
    // and cannot be tokenised by the SQL lexer, so PL/SQL constructs
    // (anonymous blocks, stored-unit DDL, triggers, EXEC, standalone
    // calls) are routed to the PL/SQL subsystem here, before SQL parsing.
    const plsql = this.routePlsql(executor, trimmed, upper);
    if (plsql) return plsql;

    // CREATE TABLE … ORGANIZATION EXTERNAL — the base CREATE TABLE parser
    // does not model the external-table clause, so it is registered here.
    if (/^CREATE\s+TABLE\b.*ORGANIZATION\s+EXTERNAL/is.test(upper)) {
      return this.createExternalTable(executor, trimmed);
    }

    const tokens = this.lexer.tokenize(trimmed);
    const parser = new OracleParser();
    const statements = parser.parseMultiple(tokens);

    if (statements.length === 0) return emptyResult();

    let result: ResultSet = emptyResult();
    for (const stmt of statements) {
      // Attach the source SQL so audit/journaling records the original
      // user text — the AST type alone is useless to a DBA.
      (stmt as unknown as { sourceText?: string }).sourceText = trimmed;
      result = executor.execute(stmt);
      try {
        this.maybeLockForUpdate(executor, stmt);
      } catch (e: unknown) {
        return emptyResult(e instanceof Error ? e.message : String(e));
      }
    }
    return result;
  }

  execLockTable(stmt: LockTableStatement, ctx: ExecutionContext): ResultSet {
    const owner = (stmt.schema ?? ctx.currentSchema).toUpperCase();
    const table = stmt.table.toUpperCase();
    if (!this.storage.getTableMeta(owner, table)) {
      return emptyResult('ORA-00942: table or view does not exist');
    }
    const modeMap: Record<LockTableStatement['lockMode'], 2 | 3 | 4 | 5 | 6> = {
      'ROW SHARE': 2, 'SHARE UPDATE': 2, 'ROW EXCLUSIVE': 3,
      'SHARE': 4, 'SHARE ROW EXCLUSIVE': 5, 'EXCLUSIVE': 6,
    };
    const sid = (ctx.session as { sid?: number } | undefined)?.sid ?? 0;
    try {
      this.instance.lockManager.lockTable({
        sessionId: String(sid), sid, schema: owner, table,
        mode: modeMap[stmt.lockMode], nowait: stmt.nowait,
      });
    } catch (e: unknown) {
      return emptyResult(e instanceof Error ? e.message : String(e));
    }
    return emptyResult('Table(s) Locked.');
  }

  execCreateFlashbackArchive(stmt: CreateFlashbackArchiveStatement, _ctx: ExecutionContext): ResultSet {
    const name = stmt.name.toUpperCase();
    const ts = stmt.tablespace.toUpperCase();
    this.instance.flashbackArchive.createArchive(new FlashbackArchive({
      flashbackArchiveName: name, retentionInDays: stmt.retentionDays, isDefault: stmt.isDefault,
      tablespaces: [new FlashbackArchiveTablespace(name, ts, stmt.quotaMb)],
    }));
    return emptyResult('Flashback archive created.');
  }

  execDropFlashbackArchive(stmt: DropFlashbackArchiveStatement, _ctx: ExecutionContext): ResultSet {
    this.instance.flashbackArchive.dropArchive(stmt.name.toUpperCase());
    return emptyResult('Flashback archive dropped.');
  }

  execPluggableDatabase(stmt: PluggableDatabaseStatement, _ctx: ExecutionContext): ResultSet {
    const name = stmt.name.toUpperCase();
    if (stmt.operation === 'CREATE') {
      this.instance.multitenant.createPdb(name);
      return emptyResult('Pluggable database created.');
    }
    if (stmt.operation === 'DROP') {
      this.instance.multitenant.dropPdb(name);
      return emptyResult('Pluggable database dropped.');
    }
    if (stmt.openMode) this.instance.multitenant.openPdb(name, stmt.openMode);
    else if (stmt.close) this.instance.multitenant.closePdb(name);
    return emptyResult('Pluggable database altered.');
  }

  private maybeLockForUpdate(executor: OracleExecutor, stmt: unknown): ResultSet | void {
    const s = stmt as { type?: string; from?: Array<{ type?: string; schema?: string; name?: string }>;
      forUpdate?: { wait?: number | 'NOWAIT' | 'SKIP_LOCKED' } };
    if (s.type !== 'SelectStatement' || !s.forUpdate || !s.from) return;
    const ctx = (executor as unknown as { context: ExecutionContext }).context;
    const sess = ctx.session;
    const sid = sess?.sid ?? 0;
    const nowait = s.forUpdate.wait === 'NOWAIT';
    for (const f of s.from) {
      if (f.type !== 'TableRef' || !f.name) continue;
      const owner = (f.schema ?? ctx.currentSchema).toUpperCase();
      const table = f.name.toUpperCase();
      if (!this.storage.getTableMeta(owner, table)) continue;
      this.instance.lockManager.lockRowsForUpdate({
        sessionId: String(sid), sid, schema: owner, table, txId: sid, nowait,
      });
    }
  }

  execAlterSession(stmt: AlterSessionStatement, ctx: ExecutionContext): ResultSet {
    if (stmt.param && stmt.value !== undefined) {
      if (stmt.param === 'SERVEROUTPUT') {
        ctx.serverOutput = stmt.value === 'ON';
      } else if (stmt.param === 'CURRENT_SCHEMA') {
        if (!this.catalog.userExists(stmt.value)) {
          return emptyResult('ORA-02248: invalid option for ALTER SESSION');
        }
        ctx.currentSchema = stmt.value;
        const sess = ctx.session as { setCurrentSchema?: (s: string) => void } | undefined;
        sess?.setCurrentSchema?.(stmt.value);
      }
    }
    return emptyResult('Session altered.');
  }

  /**
   * Execute a PL/SQL anonymous block.
   * Lightweight interpreter supporting:
   * - Variable declarations (DECLARE)
   * - DBMS_OUTPUT.PUT_LINE
   * - IF/ELSIF/ELSE/END IF
   * - FOR i IN a..b LOOP/END LOOP
   * - WHILE condition LOOP/END LOOP
   * - Assignment (:=)
   * - SELECT INTO
   * - DML (INSERT, UPDATE, DELETE)
   * - Exception handling (EXCEPTION WHEN ... THEN)
   */
  private executePLSQL(executor: OracleExecutor, sql: string): ResultSet {
    const ctx = (executor as { context: ExecutionContext }).context;
    const output: string[] = [];
    const { host, flush } = this.buildPlsqlHost(executor, output);

    const outcome = runAnonymousBlock(sql, host);
    if (outcome.parseError) {
      // Real Oracle reports compilation problems as ORA-06550 followed by
      // the PLS- diagnostic. There is deliberately no fallback interpreter:
      // the legacy regex-based engine was removed (it silently produced
      // different semantics from the AST interpreter on the same source).
      const detail = outcome.parseErrorMessage ?? 'PLS-00103: Encountered the symbol "end-of-file"';
      return emptyResult(`ORA-06550: line 1, column 1:\n${detail}`);
    }

    flush();
    if (!outcome.ok && outcome.error) {
      return emptyResult(`${outcome.error.message}\nORA-06512: at line 1`);
    }
    if (ctx.serverOutput && output.length > 0) {
      return emptyResult(output.join('\n') + '\n\nPL/SQL procedure successfully completed.');
    }
    return emptyResult('PL/SQL procedure successfully completed.');
  }

  /**
   * Build the PlsqlHost bridging the AST interpreter to this database:
   * SQL execution, DBMS_OUTPUT buffering, stored-unit lookup and builtin
   * package routing. `flush` pushes any pending DBMS_OUTPUT.PUT tail.
   */
  private buildPlsqlHost(executor: OracleExecutor, output: string[]): { host: PlsqlHost; flush: () => void } {
    const ctx = (executor as { context: ExecutionContext }).context;
    const buf = { pending: '' };
    const host: PlsqlHost = {
      runSql: (s: string) => {
        const r = this.executeSql(executor, s);
        if (!r.isQuery && r.message && /^\s*(ORA-|PLS-|SP2-)\d/.test(r.message)) {
          throw new Error(r.message);
        }
        return {
          rows: r.rows as Scalar[][],
          columns: r.columns.map(c => (c.alias ?? c.name)),
          isQuery: r.isQuery,
          affectedRows: r.affectedRows,
          message: r.message,
        };
      },
      putLine: (t: string) => { output.push(buf.pending + t); buf.pending = ''; },
      put: (t: string) => { buf.pending += t; },
      isServerOutput: () => !!ctx.serverOutput,
      currentSchema: () => ctx.currentSchema ?? 'SYS',
      lookupUnit: (name: string) => this.lookupUnitForPlsql(executor, name),
      resolvePackage: (name: string) => this.resolvePackageHandle(executor, name),
      callBuiltin: (name: string, rawArgs: string) =>
        this.routeBuiltinPackageCall(executor, rawArgs ? `${name}(${rawArgs})` : `${name}`, output),
    };
    return { host, flush: () => { if (buf.pending) { output.push(buf.pending); buf.pending = ''; } } };
  }

  /**
   * SQL→PL/SQL bridge: evaluate a stored FUNCTION referenced from a SQL
   * expression (SELECT pkg.fn(…) FROM dual, WHERE fn(col) = …). Returns
   * handled=false when the name does not resolve to a stored function so
   * the SQL engine can raise its own ORA-00904.
   */
  /**
   * Oracle Net resolver for database links — injected by the terminal
   * layer (which knows the device and the topology); the engine never
   * imports Equipment. Absent in engine-only tests: links then fail
   * with the resolution error, like a server with no network.
   */
  private dbLinkResolver:
    ((connectString: string) => { ok: true; db: OracleDatabase } | { ok: false; error: string }) | null = null;

  setDbLinkResolver(resolver: (connectString: string) =>
    { ok: true; db: OracleDatabase } | { ok: false; error: string }): void {
    this.dbLinkResolver = resolver;
  }

  private pendingLinkSessions = new Map<string, { remote: OracleDatabase; sid: number; executor: OracleExecutor }>();

  private resolveLinkRemote(currentUser: string, dbLink: string):
    { remote: OracleDatabase; username: string; password: string } {
    const linkName = dbLink.toUpperCase();
    const link = this.catalog.getDbLink(currentUser.toUpperCase(), linkName)
      ?? this.catalog.getDbLink('PUBLIC', linkName);
    if (!link) {
      throw new Error('ORA-02019: connection description for remote database not found');
    }
    if (!this.dbLinkResolver || !link.host) {
      throw new Error('ORA-12154: TNS:could not resolve the connect identifier specified');
    }
    const res = this.dbLinkResolver(link.host);
    if (!res.ok) throw new Error(res.error);
    return { remote: res.db, username: link.username ?? currentUser, password: link.password ?? '' };
  }

  fetchDbLinkRows(
    currentUser: string,
    dbLink: string,
    schema: string | undefined,
    table: string,
  ): { rows: import('../engine/storage/BaseStorage').CellValue[][]; columns: { name: string; dataType: string }[] } {
    const { remote, username, password } = this.resolveLinkRemote(currentUser, dbLink);
    const { sid, executor } = remote.connect(username, password);
    try {
      const qualified = schema ? `${schema}.${table}` : table;
      const result = remote.executeSql(executor, `SELECT * FROM ${qualified}`);
      return {
        rows: result.rows.map(r => [...r]),
        columns: result.columns.map(c => ({ name: c.name, dataType: c.dataType ?? 'VARCHAR2' })),
      };
    } finally {
      remote.disconnect(sid);
    }
  }

  execDbLinkDml(
    currentUser: string,
    dbLink: string,
    stmt: import('../engine/parser/ASTNode').Statement,
  ): import('../engine/executor/ResultSet').ResultSet {
    const key = `${currentUser.toUpperCase()}@${dbLink.toUpperCase()}`;
    let session = this.pendingLinkSessions.get(key);
    if (!session) {
      const { remote, username, password } = this.resolveLinkRemote(currentUser, dbLink);
      const { sid, executor } = remote.connect(username, password);
      session = { remote, sid, executor };
      this.pendingLinkSessions.set(key, session);
    }
    return session.executor.execute(stmt);
  }

  settleDbLinkTransactions(mode: 'COMMIT' | 'ROLLBACK'): void {
    if (this.pendingLinkSessions.size === 0) return;
    const sessions = [...this.pendingLinkSessions.values()];
    this.pendingLinkSessions.clear();
    const pos = { line: 1, column: 1 };
    for (const s of sessions) {
      try {
        const type = mode === 'COMMIT' ? 'CommitStatement' : 'RollbackStatement';
        s.executor.execute({ type, position: pos } as unknown as import('../engine/parser/ASTNode').Statement);
      } catch { /* settle best-effort */ }
      s.remote.disconnect(s.sid);
    }
  }

  execScalarFunctionCall(
    executor: import('../engine/executor/BaseExecutor').BaseExecutor,
    qualifiedName: string,
    args: import('../engine/storage/BaseStorage').CellValue[],
  ): { handled: boolean; value: import('../engine/storage/BaseStorage').CellValue } {
    const oraExecutor = executor as OracleExecutor;
    const schema = ((oraExecutor as { context?: { currentSchema?: string } }).context?.currentSchema ?? 'SYS').toUpperCase();

    // DBMS_OUTPUT produced by SQL-invoked functions is collected but not
    // surfaced — matching SQL*Plus, which only flushes the buffer after
    // top-level PL/SQL blocks.
    const output: string[] = [];

    // Package member function (pkg.fn / schema.pkg.fn) takes priority:
    // package state must come from the session's instance scope.
    const parts = qualifiedName.toUpperCase().split('.');
    if (parts.length >= 2) {
      const pkgName = parts.slice(0, -1).join('.');
      const member = parts[parts.length - 1];
      const handle = this.resolvePackageHandle(oraExecutor, pkgName);
      if (handle) {
        const { host } = this.buildPlsqlHost(oraExecutor, output);
        const interp = new PlsqlInterpreter(host);
        try {
          return { handled: true, value: this.scalarToCell(interp.callPackageFunction(handle, member, args as Scalar[])) };
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          // A private (or missing) member is invisible from SQL: real
          // Oracle raises ORA-00904 here, not the PL/SQL diagnostic.
          if (msg.includes('PLS-00302')) return { handled: false, value: null };
          // Other PL/SQL diagnostics (ORA-04067, ORA-04068, …) surface
          // as the SQL error for this expression, like real Oracle.
          throw e instanceof Error ? e : new Error(msg);
        }
      }
    }

    const unit = this.resolveStoredUnit(schema, qualifiedName);
    if (!unit || unit.type !== 'FUNCTION') return { handled: false, value: null };

    const { host } = this.buildPlsqlHost(oraExecutor, output);
    const interp = new PlsqlInterpreter(host);
    const value = interp.callStoredFunction(unit as StoredUnitLike, args as Scalar[]);
    if (value === null || value === undefined) return { handled: true, value: null };
    if (typeof value === 'number' || typeof value === 'string' || value instanceof Date) {
      return { handled: true, value };
    }
    if (typeof value === 'boolean') return { handled: true, value: value ? 'TRUE' : 'FALSE' };
    return { handled: true, value: String(value) };
  }

  /** Narrow a PL/SQL value to a SQL cell value. */
  private scalarToCell(value: unknown): import('../engine/storage/BaseStorage').CellValue {
    if (value === null || value === undefined) return null;
    if (typeof value === 'number' || typeof value === 'string' || value instanceof Date) return value;
    if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
    return String(value);
  }

  private lookupUnitForPlsql(executor: OracleExecutor, name: string): StoredUnitLike | undefined {
    const schema = (executor as { context?: { currentSchema?: string } }).context?.currentSchema ?? 'SYS';
    const up = name.toUpperCase();
    // Dotted names resolve as schema-qualified standalone units; package
    // members go through PlsqlHost.resolvePackage instead.
    const unit = up.includes('.')
      ? this.resolveStoredUnit(schema, up)
      : this.storedUnits.get(`${schema}.${up}`) ?? this.storedUnits.get(`SYS.${up}`);
    if (!unit) return undefined;
    return unit as StoredUnitLike;
  }

  private routeBuiltinPackageCall(executor: OracleExecutor, call: string, output: string[]): boolean {
    const upper = call.toUpperCase();
    const noVars = new Map<string, { type: string; value: import('../engine/storage/BaseStorage').CellValue }>();
    if (
      upper.startsWith('DBMS_SESSION.')
      || upper.startsWith('DBMS_APPLICATION_INFO.')
      || upper.startsWith('DBMS_WORKLOAD_REPOSITORY.')
      || upper.startsWith('DBMS_RESOURCE_MANAGER.')
      || upper.startsWith('DBMS_STATS.')
      || upper.startsWith('DBMS_SCHEDULER.')
      || upper.startsWith('DBMS_CRYPTO.')
      || upper.startsWith('DBMS_MVIEW.')
    ) {
      this.invokeBuiltinPackage(executor, call, noVars, output);
      return true;
    }
    if (upper.startsWith('DBMS_RLS.')) { this.executeDbmsRlsCall(executor, call); return true; }
    if (upper.startsWith('DBMS_FGA.')) { this.executeDbmsFgaCall(executor, call); return true; }
    if (upper.startsWith('DBMS_MACADM.')) { this.executeDbmsMacadmCall(call); return true; }
    if (
      upper.startsWith('DBMS_AUDIT_MGMT.')
      || upper.startsWith('DBMS_METADATA.')
      || upper.startsWith('UTL_FILE.')
      || upper.startsWith('DBMS_LOB.')
      || upper.startsWith('DBMS_FLASHBACK.')
      || upper.startsWith('DBMS_SPACE.')
      || upper.startsWith('DBMS_LOCK.')
      || upper.startsWith('DBMS_UTILITY.')
    ) {
      return true;
    }
    return false;
  }

  /**
   * Get active connections info (for V$SESSION).
   */
  getConnections(): ConnectionInfo[] {
    return Array.from(this.connections.values());
  }

  /**
   * Get the SID/service name for display.
   */
  getSid(): string {
    return this.instance.config.sid;
  }

  getServiceName(): string {
    return this.instance.config.serviceName;
  }

  // ═══════════════════════════════════════════════════════════════════
  // Stored PL/SQL Units (Procedures, Functions)
  // ═══════════════════════════════════════════════════════════════════

  /**
   * Parse a CREATE [OR REPLACE] TYPE and register it in the
   * TypeRegistry. Accepts:
   *   - CREATE TYPE owner.name AS OBJECT (col type, …)
   *   - CREATE TYPE owner.name AS [VARRAY(n) | TABLE] OF elem_type
   *
   * The form is intentionally narrow: enough to surface the type in
   * DBA_TYPES / DBA_TYPE_ATTRS / DBA_COLL_TYPES; PL/SQL bodies are
   * accepted but ignored (simulator does not run them).
   */
  execAlterTableStorage(schema: string, table: string, action: import('./SqlCommandHost').AlterTableStorageAction): ResultSet {
    const owner = schema.toUpperCase();
    const tbl = table.toUpperCase();
    switch (action.action) {
      case 'FLASHBACK_ARCHIVE':
        this.instance.flashbackArchive.enableTable(owner, tbl, action.archive);
        break;
      case 'NO_FLASHBACK_ARCHIVE':
        this.instance.flashbackArchive.disableTable(owner, tbl);
        break;
      case 'INMEMORY': {
        const meta = this.storage.getTableMeta(owner, tbl);
        if (meta) {
          const sz = Math.max(8388608, (meta.rowCount || 100) * 200);
          this.instance.inMemory.addSegment(new InMemorySegment({
            owner, segmentName: tbl, tablespaceName: meta.tablespace ?? 'USERS', inmemorySize: sz,
            inmemoryPriority: 'MEDIUM', inmemoryCompression: 'MEMCOMPRESS FOR QUERY LOW',
          }));
        }
        break;
      }
      case 'NO_INMEMORY':
        this.instance.inMemory.removeSegment(owner, tbl);
        break;
    }
    return emptyResult('Table altered.');
  }

  execCreateType(stmt: CreateTypeStatement, ctx: ExecutionContext): ResultSet {
    const owner = (stmt.schema ?? ctx.currentSchema).toUpperCase();
    const name = stmt.name.toUpperCase();
    if (stmt.form === 'collection') {
      this.instance.types.addCollectionType(owner, name, {
        collType: stmt.collKind === 'TABLE' ? 'TABLE' : 'VARRAY',
        upperBound: stmt.upperBound ?? null,
        elemTypeName: (stmt.elemType ?? '').toUpperCase(),
      });
      return emptyResult('Type created.');
    }
    this.instance.types.addObjectType(owner, name, stmt.attributes ?? [], { finalType: stmt.finalType ?? true });
    return emptyResult('Type created.');
  }

  /**
   * Parse a CREATE TABLE … ORGANIZATION EXTERNAL and register it in
   * the ExternalTableRegistry. Accepts a small but realistic subset:
   * the DEFAULT DIRECTORY, optional ACCESS PARAMETERS block, and the
   * LOCATION list.
   */
  private createExternalTable(executor: OracleExecutor, sql: string): ResultSet {
    const ctx = (executor as { context: ExecutionContext }).context;
    const head = sql.match(/^CREATE\s+TABLE\s+(?:(\w+)\s*\.\s*)?(\w+)\b/i);
    if (!head) return emptyResult('ORA-00942: table or view does not exist');
    const owner = (head[1] ?? ctx.currentSchema).toUpperCase();
    const name = head[2].toUpperCase();
    const typeMatch = sql.match(/ORGANIZATION\s+EXTERNAL\s*\(\s*TYPE\s+(ORACLE_LOADER|ORACLE_DATAPUMP|ORACLE_HIVE|ORACLE_HDFS|ORACLE_BIGDATA)/i);
    const type = (typeMatch?.[1] ?? 'ORACLE_LOADER').toUpperCase() as 'ORACLE_LOADER';
    const defDir = sql.match(/DEFAULT\s+DIRECTORY\s+(\w+)/i);
    const accessParams = sql.match(/ACCESS\s+PARAMETERS\s*\(([\s\S]*?)\)\s*LOCATION/i);
    const locs = sql.match(/LOCATION\s*\(([^)]+)\)/i);
    this.instance.externalTables.registerTable({
      owner, tableName: name, typeName: type,
      defaultDirectoryName: defDir?.[1] ?? 'DATA_PUMP_DIR',
      accessParameters: accessParams?.[1].trim() ?? '',
    });
    if (locs) {
      for (const raw of locs[1].split(',')) {
        const cleaned = raw.trim().replace(/^['"]|['"]$/g, '');
        if (cleaned) this.instance.externalTables.addLocation(owner, name, cleaned);
      }
    }
    return emptyResult('Table created.');
  }

  /** Parse and store a CREATE [OR REPLACE] PROCEDURE */
  private createStoredProcedure(executor: OracleExecutor, sql: string): ResultSet {
    // Accept `schema.name` as well as bare `name`. The qualified form
    // takes precedence over the connected schema (real Oracle behaviour).
    const match = sql.match(/^CREATE\s+(OR\s+REPLACE\s+)?PROCEDURE\s+(?:(\w+)\s*\.\s*)?(\w+)\s*(?:\(([\s\S]*?)\))?\s*(?:IS|AS)\s+([\s\S]+)$/i);
    if (!match) return emptyResult('ORA-24344: success with compilation error');

    const ctxSchema = (executor as { context?: { currentSchema?: string } }).context?.currentSchema ?? 'SYS';
    const schema = (match[2] ?? ctxSchema).toUpperCase();
    const name = match[3].toUpperCase();
    const paramStr = match[4] || '';
    const body = match[5].trim();

    const parameters = this.parseParameters(paramStr);
    const key = `${schema}.${name}`;

    return this.storeCompiledUnit(key, {
      schema,
      name,
      type: 'PROCEDURE',
      parameters,
      body,
      sourceLines: sql.split('\n'),
      created: new Date(),
      status: 'VALID',
    });
  }

  /**
   * Store a parsed PROCEDURE/FUNCTION after a real compilation pass: the
   * unit's PL/SQL source is parsed and ORA-24344/USER_ERRORS rows are
   * produced on failure, like real Oracle (SHOW ERRORS reads them back).
   */
  private storeCompiledUnit(key: string, unit: StoredPLSQLUnit): ResultSet {
    const compilation = compileStoredUnit(unit);
    unit.status = compilation.ok ? 'VALID' : 'INVALID';
    this.storedUnits.set(key, unit);
    this.lastCompiledUnit = { schema: unit.schema, name: unit.name, type: unit.type };
    if (compilation.ok) {
      this.catalog.clearCompilationErrors(unit.schema, unit.name);
      const label = unit.type === 'FUNCTION' ? 'Function' : 'Procedure';
      return emptyResult(`${label} created.`);
    }
    this.catalog.setCompilationErrors(unit.schema, unit.name, unit.type, compilation.errors);
    const label = unit.type === 'FUNCTION' ? 'Function' : 'Procedure';
    return emptyResult(`Warning: ${label} created with compilation errors.`);
  }

  getLastCompiledUnit(): { schema: string; name: string; type: string } | null {
    return this.lastCompiledUnit;
  }

  /** Parse and store a CREATE [OR REPLACE] FUNCTION */
  private createStoredFunction(executor: OracleExecutor, sql: string): ResultSet {
    const match = sql.match(/^CREATE\s+(OR\s+REPLACE\s+)?FUNCTION\s+(?:(\w+)\s*\.\s*)?(\w+)\s*(?:\(([\s\S]*?)\))?\s*RETURN\s+(\w+(?:\([^)]*\))?)\s*(?:IS|AS)\s+([\s\S]+)$/i);
    if (!match) return emptyResult('ORA-24344: success with compilation error');

    const ctxSchema = (executor as { context?: { currentSchema?: string } }).context?.currentSchema ?? 'SYS';
    const schema = (match[2] ?? ctxSchema).toUpperCase();
    const name = match[3].toUpperCase();
    const paramStr = match[4] || '';
    const returnType = match[5].toUpperCase();
    const body = match[6].trim();

    const parameters = this.parseParameters(paramStr);
    const key = `${schema}.${name}`;

    return this.storeCompiledUnit(key, {
      schema,
      name,
      type: 'FUNCTION',
      parameters,
      returnType,
      body,
      sourceLines: sql.split('\n'),
      created: new Date(),
      status: 'VALID',
    });
  }

  /** Parse parameter list like "p_id IN NUMBER, p_name IN VARCHAR2 DEFAULT 'X'" */
  private parseParameters(paramStr: string): StoredPLSQLUnit['parameters'] {
    if (!paramStr.trim()) return [];
    const params: StoredPLSQLUnit['parameters'] = [];
    // Split by comma but respect parentheses
    const parts = paramStr.split(',');
    for (const part of parts) {
      const trimmed = part.trim();
      if (!trimmed) continue;
      const m = trimmed.match(/^(\w+)\s+(IN\s+OUT|OUT|IN)?\s*(\w+(?:\([^)]*\))?)\s*(?:DEFAULT\s+(.+))?$/i);
      if (m) {
        params.push({
          name: m[1].toUpperCase(),
          mode: (m[2]?.toUpperCase().replace(/\s+/g, ' ') || 'IN') as 'IN' | 'OUT' | 'IN OUT',
          dataType: m[3].toUpperCase(),
          defaultValue: m[4]?.trim(),
        });
      }
    }
    return params;
  }

  /** Execute EXEC[UTE] procedure_name(args) */
  private executeProcedureCall(executor: OracleExecutor, sql: string): ResultSet {
    const cleaned = sql.replace(/^EXEC(?:UTE)?\s+/i, '').trim();

    const nameMatch = cleaned.match(/^(\w+(?:\.\w+){0,2})\s*(?:\(|;|$)/);
    if (nameMatch) {
      const schema = ((executor as { context?: { currentSchema?: string } }).context?.currentSchema || 'SYS').toUpperCase();
      if (this.resolveStoredUnit(schema, nameMatch[1])) {
        return this.callStoredUnit(executor, cleaned);
      }
    }

    const block = /;\s*$/.test(cleaned) ? `BEGIN ${cleaned} END;` : `BEGIN ${cleaned}; END;`;
    return this.executePLSQL(executor, block);
  }

  private tryExecuteProcedureCall(executor: OracleExecutor, sql: string): ResultSet | null {
    const match = sql.match(/^(\w+(?:\.\w+){0,2})\s*\(([\s\S]*)\)\s*$/);
    if (!match) return null;
    const schema = ((executor as { context?: { currentSchema?: string } }).context?.currentSchema || 'SYS').toUpperCase();
    if (!this.resolveStoredUnit(schema, match[1])) return null;
    return this.callStoredUnit(executor, sql);
  }

  private resolveStoredUnit(currentSchema: string, qualifiedName: string): StoredPLSQLUnit | undefined {
    const parts = qualifiedName.toUpperCase().split('.');

    if (parts.length === 1) {
      const [name] = parts;
      return this.storedUnits.get(`${currentSchema}.${name}`) ?? this.storedUnits.get(`SYS.${name}`);
    }

    // SCHEMA.UNIT — package members are not stored as standalone units;
    // they resolve through the package runtime (resolvePackageHandle).
    if (parts.length === 2) {
      const [a, b] = parts;
      return this.storedUnits.get(`${a}.${b}`);
    }

    return undefined;
  }

  private callStoredUnit(executor: OracleExecutor, callExpr: string): ResultSet {
    const match = callExpr.match(/^(\w+(?:\.\w+){0,2})(?:\s*\(([\s\S]*)\))?\s*$/);
    if (!match) return emptyResult(ORACLE_ERRORS.ORA_00900);

    const name = match[1].toUpperCase();
    const argsStr = match[2] || '';
    const schema = ((executor as { context?: { currentSchema?: string } }).context?.currentSchema || 'SYS').toUpperCase();

    const unit = this.resolveStoredUnit(schema, name);
    if (!unit) return emptyResult(`${ORACLE_ERRORS.ORA_00900}\nPLS-00201: identifier '${name}' must be declared`);

    const ctx = (executor as { context?: { currentUser?: string } }).context;
    const currentUser = (ctx?.currentUser || schema).toUpperCase();
    if (currentUser !== 'SYS' && currentUser !== unit.schema) {
      const engine = this.catalog.getSecurityEngine?.();
      const hasExecute = !!engine && (
        engine.privileges.isDba(currentUser)
        || engine.privileges.hasSystemPrivilege(currentUser, 'EXECUTE ANY PROCEDURE')
        || engine.privileges.hasObjectPrivilege(currentUser, 'EXECUTE', unit.schema, unit.name.split('.')[0])
      );
      if (!hasExecute) {
        return emptyResult(`${ORACLE_ERRORS.ORA_00900}\nPLS-00201: identifier '${name}' must be declared`);
      }
    }

    // Parse arguments
    const args = argsStr ? argsStr.split(',').map(a => a.trim()) : [];

    // Build variable map from parameters + arguments
    const body = unit.body;

    // Construct a PL/SQL block that declares params as variables and runs the body
    let block = 'DECLARE\n';
    for (let i = 0; i < unit.parameters.length; i++) {
      const p = unit.parameters[i];
      const argValue = args[i] ?? p.defaultValue ?? 'NULL';
      block += `  ${p.name} ${p.dataType} := ${argValue};\n`;
    }
    // A stored body is `[local declarations] BEGIN … END` (the DECLARE
    // keyword is implied by IS/AS in the unit header). Local declarations —
    // variables, cursors, PRAGMA AUTONOMOUS_TRANSACTION — must stay in the
    // declarative section of the wrapper block, never be wrapped as
    // executable statements.
    const upperBody = body.toUpperCase().trim();
    if (upperBody.startsWith('DECLARE')) {
      // Tolerated legacy form: merge into our open DECLARE section.
      block += body.replace(/^\s*DECLARE\b/i, '');
    } else if (upperBody.startsWith('BEGIN') || /\bBEGIN\b/i.test(body)) {
      block += body;
    } else {
      // Bare statement list without BEGIN…END (not valid Oracle, but
      // tolerated for units captured from loose sources).
      block += 'BEGIN\n' + body + '\nEND;';
    }

    if (ctx && unit.schema !== currentUser) {
      const savedUser = ctx.currentUser;
      const savedSchema = (ctx as { currentSchema?: string }).currentSchema;
      ctx.currentUser = unit.schema;
      (ctx as { currentSchema?: string }).currentSchema = unit.schema;
      try {
        return this.executePLSQL(executor, block);
      } finally {
        ctx.currentUser = savedUser;
        (ctx as { currentSchema?: string }).currentSchema = savedSchema;
      }
    }

    return this.executePLSQL(executor, block);
  }

  /** DROP PROCEDURE/FUNCTION/PACKAGE BODY */
  private dropStoredUnit(_executor: OracleExecutor, sql: string, type: 'PROCEDURE' | 'FUNCTION' | 'PACKAGE BODY'): ResultSet {
    const match = sql.match(/^DROP\s+(?:PROCEDURE|FUNCTION|PACKAGE\s+BODY)\s+(?:(\w+)\s*\.\s*)?(\w+)/i);
    if (!match) return emptyResult(ORACLE_ERRORS.ORA_00900);

    const ctxSchema = (_executor as { context?: { currentSchema?: string } }).context?.currentSchema ?? 'SYS';
    const schema = (match[1] ?? ctxSchema).toUpperCase();
    const name = match[2].toUpperCase();

    if (type === 'PACKAGE BODY') {
      const bodyKey = `${schema}.${name}.__BODY__`;
      if (!this.storedUnits.has(bodyKey)) {
        return emptyResult(`ORA-04043: object ${name} does not exist`);
      }
      this.storedUnits.delete(bodyKey);
      const pkg = this.userPackages.get(`${schema}.${name}`);
      if (pkg) {
        pkg.body = null;
        pkg.version += 1; // session state built on this body is now stale
      }
      return emptyResult('Package body dropped.');
    }

    const key = `${schema}.${name}`;
    if (!this.storedUnits.has(key)) {
      return emptyResult(`ORA-04043: object ${name} does not exist`);
    }
    this.storedUnits.delete(key);
    const typeLabel = type === 'PROCEDURE' ? 'Procedure' : 'Function';
    return emptyResult(`${typeLabel} dropped.`);
  }

  /** Get all stored PL/SQL units (for DBA_SOURCE, DBA_PROCEDURES, DBA_OBJECTS) */
  getStoredUnits(): StoredPLSQLUnit[] {
    return Array.from(this.storedUnits.values());
  }

  /** Get a specific stored unit by name */
  getStoredUnit(schema: string, name: string): StoredPLSQLUnit | undefined {
    return this.storedUnits.get(`${schema}.${name}`);
  }

  // ═══════════════════════════════════════════════════════════════════
  // PL/SQL Packages
  // ═══════════════════════════════════════════════════════════════════

  /** Compile and store a CREATE [OR REPLACE] PACKAGE (specification) */
  private createPackageSpec(executor: OracleExecutor, sql: string): ResultSet {
    const match = sql.match(/^CREATE\s+(OR\s+REPLACE\s+)?PACKAGE\s+(?:(\w+)\s*\.\s*)?(\w+)\s+(?:IS|AS)\s+([\s\S]+)$/i);
    if (!match) return emptyResult('ORA-24344: success with compilation error');

    const ctxSchema = (executor as { context?: { currentSchema?: string } }).context?.currentSchema ?? 'SYS';
    const schema = (match[2] ?? ctxSchema).toUpperCase();
    const name = match[3].toUpperCase();
    const source = match[4].trim();
    const key = `${schema}.${name}`;

    if (!match[1] && this.storedUnits.has(key)) {
      return emptyResult(`ORA-00955: name is already used by an existing object`);
    }

    const compilation = compilePackageSection(source);
    this.lastCompiledUnit = { schema, name, type: 'PACKAGE' };
    this.storedUnits.set(key, {
      schema, name, type: 'PACKAGE', parameters: [],
      body: source, sourceLines: sql.split('\n'),
      created: new Date(), status: compilation.ok ? 'VALID' : 'INVALID',
    });

    if (!compilation.ok) {
      this.catalog.setCompilationErrors(schema, name, 'PACKAGE', compilation.errors);
      return emptyResult('Warning: Package created with compilation errors.');
    }
    this.catalog.clearCompilationErrors(schema, name);

    // Redefining the spec discards session state (version bump) but keeps
    // an existing body — real Oracle marks it invalid and recompiles it
    // on next use; here the body source stays valid as compiled.
    const existing = this.userPackages.get(key);
    this.userPackages.set(key, {
      schema, name,
      version: (existing?.version ?? 0) + 1,
      spec: compilation.section,
      body: existing?.body ?? null,
      publicNames: declarationNames(compilation.section.declarations),
    });
    return emptyResult('Package created.');
  }

  /** Compile and store a CREATE [OR REPLACE] PACKAGE BODY */
  private createPackageBody(executor: OracleExecutor, sql: string): ResultSet {
    const match = sql.match(/^CREATE\s+(OR\s+REPLACE\s+)?PACKAGE\s+BODY\s+(?:(\w+)\s*\.\s*)?(\w+)\s+(?:IS|AS)\s+([\s\S]+)$/i);
    if (!match) return emptyResult('ORA-24344: success with compilation error');

    const ctxSchema = (executor as { context?: { currentSchema?: string } }).context?.currentSchema ?? 'SYS';
    const schema = (match[2] ?? ctxSchema).toUpperCase();
    const pkgName = match[3].toUpperCase();
    const source = match[4].trim();
    const key = `${schema}.${pkgName}`;
    const bodyUnitKey = `${schema}.${pkgName}.__BODY__`;

    const pkg = this.userPackages.get(key);
    this.lastCompiledUnit = { schema, name: pkgName, type: 'PACKAGE BODY' };

    const fail = (errors: { line: number; position: number; text: string }[]): ResultSet => {
      this.storedUnits.set(bodyUnitKey, {
        schema, name: pkgName, type: 'PACKAGE BODY', parameters: [],
        body: source, sourceLines: sql.split('\n'),
        created: new Date(), status: 'INVALID',
      });
      this.catalog.setCompilationErrors(schema, pkgName, 'PACKAGE BODY', errors);
      return emptyResult('Warning: Package Body created with compilation errors.');
    };

    // A body cannot compile without its specification (PLS-00304).
    if (!pkg) {
      return fail([{
        line: 1, position: 1,
        text: `PLS-00304: cannot compile body of '${pkgName}' without its specification`,
      }]);
    }

    const compilation = compilePackageSection(source);
    if (!compilation.ok) return fail(compilation.errors);

    this.storedUnits.set(bodyUnitKey, {
      schema, name: pkgName, type: 'PACKAGE BODY', parameters: [],
      body: source, sourceLines: sql.split('\n'),
      created: new Date(), status: 'VALID',
    });
    this.catalog.clearCompilationErrors(schema, pkgName);
    pkg.body = compilation.section;
    pkg.version += 1; // discard any session state built on the old body
    return emptyResult('Package body created.');
  }

  /** DROP PACKAGE — drops spec and body */
  private dropPackage(_executor: OracleExecutor, sql: string): ResultSet {
    const match = sql.match(/^DROP\s+PACKAGE\s+(?:(\w+)\s*\.\s*)?(\w+)/i);
    if (!match) return emptyResult(ORACLE_ERRORS.ORA_00900);

    const ctxSchema = (_executor as { context?: { currentSchema?: string } }).context?.currentSchema || 'SYS';
    const schema = (match[1] ?? ctxSchema).toUpperCase();
    const name = match[2].toUpperCase();

    const specKey = `${schema}.${name}`;
    const bodyKey = `${schema}.${name}.__BODY__`;

    if (!this.storedUnits.has(specKey) && !this.storedUnits.has(bodyKey)) {
      return emptyResult(`ORA-04043: object ${name} does not exist`);
    }

    this.storedUnits.delete(specKey);
    this.storedUnits.delete(bodyKey);
    this.userPackages.delete(specKey);
    this.catalog.clearCompilationErrors(schema, name);

    return emptyResult('Package dropped.');
  }

  /**
   * Resolve a package reference ("PKG" or "SCHEMA.PKG") for the PL/SQL
   * interpreter: visibility follows the stored-unit rules (current
   * schema, then SYS; non-owners need EXECUTE). Returns the runtime
   * handle bound to this session's instantiation state.
   */
  private resolvePackageHandle(executor: OracleExecutor, name: string): PackageRuntimeHandle | undefined {
    const ctx = (executor as { context?: { currentSchema?: string; currentUser?: string } }).context;
    const schema = (ctx?.currentSchema ?? 'SYS').toUpperCase();
    const parts = name.toUpperCase().split('.');

    let pkg: UserPackage | undefined;
    if (parts.length === 1) {
      pkg = this.userPackages.get(`${schema}.${parts[0]}`) ?? this.userPackages.get(`SYS.${parts[0]}`);
    } else if (parts.length === 2) {
      pkg = this.userPackages.get(`${parts[0]}.${parts[1]}`);
    }
    if (!pkg) return undefined;

    // EXECUTE privilege: same information-hiding rule as stored units —
    // a caller without rights simply does not see the package.
    const currentUser = (ctx?.currentUser || schema).toUpperCase();
    if (currentUser !== 'SYS' && currentUser !== pkg.schema) {
      const engine = this.catalog.getSecurityEngine?.();
      const hasExecute = !!engine && (
        engine.privileges.isDba(currentUser)
        || engine.privileges.hasSystemPrivilege(currentUser, 'EXECUTE ANY PROCEDURE')
        || engine.privileges.hasObjectPrivilege(currentUser, 'EXECUTE', pkg.schema, pkg.name)
      );
      if (!hasExecute) return undefined;
    }

    const key = `${pkg.schema}.${pkg.name}`;
    let states = this.packageSessionStates.get(executor);
    if (!states) {
      states = new Map();
      this.packageSessionStates.set(executor, states);
    }
    let state = states.get(key);
    if (!state) {
      state = { version: pkg.version, scope: null };
      states.set(key, state);
    }

    return {
      qualifiedName: key,
      version: pkg.version,
      declarations: [...pkg.spec.declarations, ...(pkg.body?.declarations ?? [])],
      initBody: pkg.body?.initBody ?? [],
      initHandlers: pkg.body?.initHandlers ?? [],
      publicNames: pkg.publicNames,
      hasBody: pkg.body !== null,
      state,
    };
  }

  /**
   * Public subprogram signatures of a package, for SQL*Plus DESCRIBE.
   * Returns undefined when the package does not exist.
   */
  describePackage(schema: string, name: string): {
    name: string; kind: 'PROCEDURE' | 'FUNCTION'; returnType?: string;
    parameters: { name: string; dataType: string; mode: 'IN' | 'OUT' | 'IN OUT'; hasDefault: boolean }[];
  }[] | undefined {
    const pkg = this.userPackages.get(`${schema.toUpperCase()}.${name.toUpperCase()}`);
    if (!pkg) return undefined;
    const typeText = (t: { name: string; args: number[] }): string =>
      t.args.length ? `${t.name}(${t.args.join(',')})` : t.name;
    const members: ReturnType<OracleDatabase['describePackage']> = [];
    for (const d of pkg.spec.declarations) {
      if (d.kind !== 'subprogram') continue;
      members!.push({
        name: d.name,
        kind: d.isFunction ? 'FUNCTION' : 'PROCEDURE',
        returnType: d.returnType ? typeText(d.returnType) : undefined,
        parameters: d.params.map(p => ({
          name: p.name, dataType: typeText(p.type), mode: p.mode, hasDefault: p.init !== null,
        })),
      });
    }
    return members;
  }

  /** Package members for the data dictionary (DBA_PROCEDURES). */
  getPackageMembers(): { schema: string; pkg: string; member: string; kind: 'PROCEDURE' | 'FUNCTION' }[] {
    const rows: { schema: string; pkg: string; member: string; kind: 'PROCEDURE' | 'FUNCTION' }[] = [];
    for (const pkg of this.userPackages.values()) {
      for (const d of pkg.spec.declarations) {
        if (d.kind === 'subprogram') {
          rows.push({ schema: pkg.schema, pkg: pkg.name, member: d.name, kind: d.isFunction ? 'FUNCTION' : 'PROCEDURE' });
        }
      }
    }
    return rows;
  }

  /** Parse and execute CREATE [OR REPLACE] TRIGGER using regex (body may contain semicolons) */
  private executeCreateTrigger(executor: OracleExecutor, sql: string): ResultSet {
    // System-level event triggers come first so the DML-trigger regex
    // does not steal them.
    const sys = sql.match(
      /^CREATE\s+(?:OR\s+REPLACE\s+)?TRIGGER\s+(?:(\w+)\.)?(\w+)\s+(BEFORE|AFTER)\s+(STARTUP|SHUTDOWN|LOGON|LOGOFF|SERVERERROR|CREATE|ALTER|DROP)\s+ON\s+(DATABASE|SCHEMA|(\w+)\.SCHEMA)\s+([\s\S]*)$/i,
    );
    if (sys) {
      const owner = (sys[1] || (executor as { context?: { currentSchema?: string } }).context?.currentSchema || 'SYS').toUpperCase();
      const name = sys[2].toUpperCase();
      const timing = sys[3].toUpperCase() as 'BEFORE' | 'AFTER';
      const event = sys[4].toUpperCase() as import('./triggers/SystemTrigger').TriggerEvent;
      const scope = sys[5].toUpperCase() === 'DATABASE' ? 'DATABASE' : 'SCHEMA';
      const scopeSchema = scope === 'SCHEMA' ? (sys[6] ?? owner).toUpperCase() : null;
      const body = (sys[7] || '').trim();
      this.instance.systemTriggers.register(new SystemTrigger({
        owner, name, timing, event, scope, scopeSchema, body, enabled: true,
      }));
      return emptyResult('Trigger created.');
    }
    const match = sql.match(
      /^CREATE\s+(OR\s+REPLACE\s+)?TRIGGER\s+(?:(\w+)\.)?(\w+)\s+(BEFORE|AFTER|INSTEAD\s+OF)\s+(INSERT|UPDATE|DELETE)(?:\s+OR\s+(INSERT|UPDATE|DELETE))?(?:\s+OR\s+(INSERT|UPDATE|DELETE))?\s+ON\s+(?:(\w+)\.)?(\w+)(?:\s+FOR\s+EACH\s+ROW)?\s*([\s\S]*)$/i
    );
    if (!match) return emptyResult('ORA-24344: success with compilation error');

    const orReplace = !!match[1];
    const schema = (match[2] || (executor as { context?: { currentSchema?: string } }).context?.currentSchema || 'SYS').toUpperCase();
    const name = match[3].toUpperCase();
    const timing = match[4].toUpperCase().replace(/\s+/g, ' ') as 'BEFORE' | 'AFTER' | 'INSTEAD OF';
    const events: Array<'INSERT' | 'UPDATE' | 'DELETE'> = [];
    for (const ev of [match[5], match[6], match[7]]) {
      if (ev) events.push(ev.toUpperCase() as 'INSERT' | 'UPDATE' | 'DELETE');
    }
    const tableSchema = (match[8] || schema).toUpperCase();
    const tableName = match[9].toUpperCase();
    const forEachRow = /FOR\s+EACH\s+ROW/i.test(sql);
    const body = (match[10] || '').trim();

    if (orReplace) {
      try { this.storage.dropTrigger(schema, name); } catch { /* ignore */ }
    }

    this.storage.createTrigger({
      schema, name, timing, events,
      tableName, tableSchema,
      forEachRow, body, enabled: true,
    });

    return emptyResult('Trigger created.');
  }

  // ═══════════════════════════════════════════════════════════════════
  // DBMS_RLS / DBMS_FGA / DBMS_MACADM dispatchers
  //
  // PL/SQL procedure calls are parsed with a permissive regex: the call
  // body is split on commas and each `name => value` pair is captured.
  // Positional arguments are tolerated by falling back on declaration
  // order, mirroring real PL/SQL invocation.
  // ═══════════════════════════════════════════════════════════════════

  /** Extract named arguments from a procedure call body like
   *  `object_schema=>'HR', policy_name=>'p1', statement_types=>'SELECT'`. */
  private parseNamedArgs(call: string): Record<string, string> {
    // Strip the leading `<PKG>.<PROC>(` and trailing `);`.
    const open = call.indexOf('(');
    const close = call.lastIndexOf(')');
    if (open < 0 || close < 0 || close <= open) return {};
    const body = call.slice(open + 1, close);
    const args: Record<string, string> = {};
    // Split on top-level commas only (so quoted commas survive).
    const parts: string[] = [];
    let depth = 0; let buf = ''; let inStr = false;
    for (let i = 0; i < body.length; i++) {
      const ch = body[i];
      if (ch === "'" && body[i - 1] !== '\\') inStr = !inStr;
      if (!inStr && ch === '(') depth++;
      if (!inStr && ch === ')') depth--;
      if (!inStr && ch === ',' && depth === 0) { parts.push(buf); buf = ''; continue; }
      buf += ch;
    }
    if (buf.trim()) parts.push(buf);
    for (const raw of parts) {
      const m = raw.match(/^\s*(\w+)\s*=>\s*([\s\S]+?)\s*$/);
      if (m) args[m[1].toUpperCase()] = OracleDatabase.unquote(m[2]);
    }
    return args;
  }

  private static unquote(value: string): string {
    const trimmed = value.trim();
    if ((trimmed.startsWith("'") && trimmed.endsWith("'")) || (trimmed.startsWith('"') && trimmed.endsWith('"'))) {
      return trimmed.slice(1, -1);
    }
    return trimmed;
  }

  /**
   * Dispatch a `package.routine(args)` call to the concrete
   * IPackageRoutine registered for it. The caller has already
   * verified the prefix; this method extracts the routine name and
   * positional argument list, then forwards.
   */
  private invokeBuiltinPackage(
    executor: OracleExecutor,
    call: string,
    _variables: Map<string, { type: string; value: import('../engine/storage/BaseStorage').CellValue }>,
    output: string[],
  ): void {
    const m = call.match(/^([A-Z_][A-Z0-9_]*\.[A-Z_][A-Z0-9_]*)\s*(?:\(([\s\S]*)\))?/i);
    if (!m) return;
    const fullName = m[1].toUpperCase();
    const argString = m[2] ?? '';
    const routine = builtinPackageRegistry.resolve(fullName);
    if (!routine) return;                  // unknown routine → swallow

    const args = this.splitTopLevelArgs(argString).map(a => this.unquoteLiteral(a));
    const session = (executor as { context: { session?: import('./security/OracleSession').OracleSession } }).context.session;
    if (!session) return;
    const result = routine.invoke(args, { session, rawCall: call, services: this.packageServices() });
    if (result !== null) output.push(result);
  }

  /** Split "a, 'b,c', d(e,f)" on top-level commas. */
  private splitTopLevelArgs(s: string): string[] {
    const out: string[] = [];
    let depth = 0, quote: string | null = null, buf = '';
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (quote) {
        buf += c;
        if (c === quote && s[i - 1] !== '\\') quote = null;
        continue;
      }
      if (c === "'" || c === '"') { quote = c; buf += c; continue; }
      if (c === '(') { depth++; buf += c; continue; }
      if (c === ')') { depth--; buf += c; continue; }
      if (c === ',' && depth === 0) { out.push(buf.trim()); buf = ''; continue; }
      buf += c;
    }
    if (buf.trim()) out.push(buf.trim());
    return out;
  }

  /** Strip the outer quotes of a literal arg; preserve bare identifiers. */
  private unquoteLiteral(s: string): string {
    const t = s.trim();
    if (t.length >= 2 && t.startsWith("'") && t.endsWith("'")) {
      return t.slice(1, -1).replace(/''/g, "'");
    }
    return t;
  }

  private executeDbmsRlsCall(_executor: OracleExecutor, call: string): void {
    const upper = call.toUpperCase();
    const args = this.parseNamedArgs(call);
    const get = (key: string): string => args[key] ?? '';
    if (upper.includes('.ADD_POLICY')) {
      this.catalog.addRlsPolicy({
        objectSchema: get('OBJECT_SCHEMA'),
        objectName: get('OBJECT_NAME'),
        policyName: get('POLICY_NAME'),
        functionSchema: get('FUNCTION_SCHEMA'),
        policyFunction: get('POLICY_FUNCTION'),
        statementTypes: get('STATEMENT_TYPES'),
        policyType: get('POLICY_TYPE'),
        secRelevantCols: get('SEC_RELEVANT_COLS'),
      });
    } else if (upper.includes('.ADD_GROUPED_POLICY')) {
      this.catalog.addRlsPolicy({
        objectSchema: get('OBJECT_SCHEMA'),
        objectName: get('OBJECT_NAME'),
        policyName: get('POLICY_NAME'),
        policyGroup: get('POLICY_GROUP'),
        functionSchema: get('FUNCTION_SCHEMA'),
        policyFunction: get('POLICY_FUNCTION'),
        statementTypes: get('STATEMENT_TYPES'),
      });
    } else if (upper.includes('.ENABLE_POLICY')) {
      // Positional: (object_schema, object_name, policy_name, enable)
      const positional = this.parsePositionalArgs(call);
      const enable = positional[3]?.toUpperCase() !== 'FALSE';
      this.catalog.enableRlsPolicy(positional[0] ?? '', positional[1] ?? '', positional[2] ?? '', enable);
    } else if (upper.includes('.DISABLE_POLICY')) {
      const positional = this.parsePositionalArgs(call);
      this.catalog.enableRlsPolicy(positional[0] ?? '', positional[1] ?? '', positional[2] ?? '', false);
    } else if (upper.includes('.DROP_POLICY') || upper.includes('.DROP_GROUPED_POLICY')) {
      const positional = this.parsePositionalArgs(call);
      // DROP_GROUPED_POLICY signature: (object_schema, object_name, policy_group, policy_name)
      const policyName = upper.includes('GROUPED') ? positional[3] ?? '' : positional[2] ?? '';
      this.catalog.dropRlsPolicy(positional[0] ?? '', positional[1] ?? '', policyName);
    }
  }

  private executeDbmsFgaCall(_executor: OracleExecutor, call: string): void {
    const upper = call.toUpperCase();
    const args = this.parseNamedArgs(call);
    const get = (key: string): string => args[key] ?? '';
    if (upper.includes('.ADD_POLICY')) {
      const types = (get('STATEMENT_TYPES') || 'SELECT').toUpperCase();
      this.catalog.addFgaPolicy({
        objectSchema: get('OBJECT_SCHEMA').toUpperCase(),
        objectName: get('OBJECT_NAME').toUpperCase(),
        policyName: get('POLICY_NAME').toUpperCase(),
        policyOwner: get('OBJECT_SCHEMA').toUpperCase(),
        policyText: get('AUDIT_CONDITION') || '',
        enabled: true,
        select: types.includes('SELECT'),
        insert: types.includes('INSERT'),
        update: types.includes('UPDATE'),
        delete: types.includes('DELETE'),
      });
    } else if (upper.includes('.ENABLE_POLICY') || upper.includes('.DISABLE_POLICY')) {
      const positional = this.parsePositionalArgs(call);
      const enable = upper.includes('.ENABLE_POLICY');
      const policies = this.catalog.getFgaPolicies();
      const p = policies.find(x => x.objectSchema === (positional[0] ?? '').toUpperCase()
                                && x.objectName === (positional[1] ?? '').toUpperCase()
                                && x.policyName === (positional[2] ?? '').toUpperCase());
      if (p) (p as { enabled: boolean }).enabled = enable;
    } else if (upper.includes('.DROP_POLICY')) {
      const positional = this.parsePositionalArgs(call);
      this.catalog.dropFgaPolicy(positional[0] ?? '', positional[1] ?? '', positional[2] ?? '');
    }
  }

  private executeDbmsMacadmCall(call: string): void {
    const upper = call.toUpperCase();
    const args = this.parseNamedArgs(call);
    const get = (key: string): string => args[key] ?? '';
    if (upper.includes('.CREATE_REALM')) {
      this.catalog.createDvRealm(get('REALM_NAME'), get('DESCRIPTION'), Number(get('AUDIT_OPTIONS') || '1'));
    } else if (upper.includes('.DELETE_REALM')) {
      // Best-effort removal — there's no dedicated DV remove in the catalog.
      const all = this.catalog.getDvRealms() as { name: string }[];
      const idx = all.findIndex(r => r.name === get('REALM_NAME').toUpperCase());
      if (idx >= 0) (all as { name: string }[]).splice(idx, 1);
    } else if (upper.includes('.ADD_OBJECT_TO_REALM') || upper.includes('.ADD_AUTH_TO_REALM')) {
      if (upper.includes('AUTH')) {
        this.catalog.addDvRealmAuth(get('REALM_NAME'), get('GRANTEE'), '', get('AUTH_OPTIONS') || 'PARTICIPANT');
      }
    } else if (upper.includes('.CREATE_ROLE')) {
      this.catalog.createDvRole(get('ROLE'), '');
    } else if (upper.includes('.DELETE_ROLE')) {
      const all = this.catalog.getDvRoles() as { name: string }[];
      const idx = all.findIndex(r => r.name === get('ROLE').toUpperCase());
      if (idx >= 0) (all as { name: string }[]).splice(idx, 1);
    } else if (upper.includes('.CREATE_COMMAND_RULE')) {
      this.catalog.createDvCommandRule(get('COMMAND'), get('RULE_SET_NAME'), get('OBJECT_OWNER'), get('OBJECT_NAME'));
    } else if (upper.includes('.DELETE_COMMAND_RULE')) {
      const all = this.catalog.getDvCommandRules() as { command: string; objectOwner: string; objectName: string }[];
      const idx = all.findIndex(r => r.command === get('COMMAND').toUpperCase()
                                  && r.objectOwner === get('OBJECT_OWNER').toUpperCase()
                                  && r.objectName === get('OBJECT_NAME').toUpperCase());
      if (idx >= 0) (all as unknown[]).splice(idx, 1);
    } else if (upper.includes('.CREATE_FACTOR')) {
      this.catalog.createDvFactor({
        name: get('FACTOR_NAME'),
        description: get('DESCRIPTION'),
        factorType: get('FACTOR_TYPE_NAME'),
        validateExpr: get('VALIDATE_EXPR'),
        identifyBy: get('IDENTIFY_BY'),
        labeledBy: get('LABELED_BY'),
        evalOptions: get('EVAL_OPTIONS'),
        auditOptions: Number(get('AUDIT_OPTIONS') || '1'),
        failOptions: Number(get('FAIL_OPTIONS') || '1'),
      });
    } else if (upper.includes('.DELETE_FACTOR')) {
      const all = this.catalog.getDvFactors() as { name: string }[];
      const idx = all.findIndex(r => r.name === get('FACTOR_NAME').toUpperCase());
      if (idx >= 0) (all as { name: string }[]).splice(idx, 1);
    }
  }

  /** Parse positional arguments — used for procedures like
   *  DBMS_RLS.DROP_POLICY('HR','EMPLOYEES','pol'). */
  private parsePositionalArgs(call: string): string[] {
    const open = call.indexOf('(');
    const close = call.lastIndexOf(')');
    if (open < 0 || close < 0) return [];
    const body = call.slice(open + 1, close);
    if (body.includes('=>')) return []; // Named-arg call — use parseNamedArgs.
    return body.split(',').map(p => OracleDatabase.unquote(p));
  }
}
