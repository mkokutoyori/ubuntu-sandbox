/**
 * OracleSession — first-class domain entity representing a single user
 * session on the database.
 *
 * Every attribute that real Oracle surfaces through
 * `SYS_CONTEXT('USERENV', '…')`, `USERENV('…')`, or `V$SESSION` is held
 * here. The session is the single source of truth: views and built-in
 * functions read from it, and `DBMS_SESSION` / `DBMS_APPLICATION_INFO`
 * mutate it. Properties are grouped by the real-Oracle namespace so
 * code that "talks Oracle" can be written naturally.
 *
 * The class intentionally exposes every property a real DBA can query
 * — even attributes the simulator does not yet animate (proxy_user,
 * enterprise_identity, dblink_info). Defaults mirror Oracle's "not
 * configured" semantics (empty strings, NULL, FALSE) rather than fake
 * data, so monitoring scripts get truthful values.
 */

import type { OsSecurityContext } from './types';

/** USERENV `AUTHENTICATION_METHOD` values understood by real Oracle. */
export type AuthenticationMethod =
  | 'PASSWORD'         // IDENTIFIED BY <pwd>
  | 'EXTERNAL'         // IDENTIFIED EXTERNALLY (OS-authenticated)
  | 'GLOBAL'           // IDENTIFIED GLOBALLY (LDAP / Kerberos)
  | 'SYSDBA'           // CONNECT / AS SYSDBA
  | 'SYSOPER'          // CONNECT / AS SYSOPER
  | 'NONE';

/** Authentication "type" exposed by `USERENV('AUTHENTICATION_TYPE')`. */
export type AuthenticationType =
  | 'DATABASE'
  | 'OS'
  | 'NETWORK'
  | 'PROXY'
  | 'SERVER';

/** `IDENTIFICATION_TYPE` reflects how the schema is provisioned. */
export type IdentificationType =
  | 'LOCAL'
  | 'EXTERNAL'
  | 'GLOBAL SHARED'
  | 'GLOBAL PRIVATE';

export interface OracleSessionInit {
  sid: number;
  serial: number;
  username: string;
  schema?: string;
  osContext: OsSecurityContext;
  authenticationMethod: AuthenticationMethod;
  authenticationType?: AuthenticationType;
  identificationType?: IdentificationType;
  type?: 'USER' | 'BACKGROUND';
  service?: string;
  /** Optional proxy user (set when CONNECT <client>[<proxy>]). */
  proxyUser?: string;
  /** Optional externalised identity (kerberos@REALM / DN / etc.). */
  authenticatedIdentity?: string;
  enterpriseIdentity?: string;
  /** Read from the running OracleInstance — DB / instance identity. */
  instance: {
    instanceId: number;
    instanceName: string;
    dbName: string;
    dbUniqueName: string;
    dbDomain: string;
    serverHost: string;
  };
}

export class OracleSession {
  // ── Identity ────────────────────────────────────────────────────
  readonly sid: number;
  readonly serial: number;
  readonly type: 'USER' | 'BACKGROUND';
  /** Persistent — does NOT change across SET ROLE / ALTER SESSION. */
  readonly sessionUser: string;
  /** Schema in effect right now (mutated by ALTER SESSION SET CURRENT_SCHEMA). */
  currentSchema: string;
  /** User whose privileges are in effect — typically `sessionUser`,
   *  differs under definer-rights PL/SQL invocation. */
  currentUser: string;

  // ── Authentication ──────────────────────────────────────────────
  readonly authenticationMethod: AuthenticationMethod;
  readonly authenticationType: AuthenticationType;
  readonly identificationType: IdentificationType;
  readonly authenticatedIdentity: string;
  readonly enterpriseIdentity: string;
  readonly proxyUser: string | null;
  readonly isDba: boolean;

  // ── OS / network ────────────────────────────────────────────────
  readonly osUser: string;
  readonly hostName: string;
  readonly terminal: string;
  readonly program: string;
  readonly ipAddress: string;
  readonly networkProtocol: string;
  /** Source-side hostname (V$SESSION.MACHINE). */
  readonly machine: string;

  // ── Database & instance ─────────────────────────────────────────
  readonly instanceId: number;
  readonly instanceName: string;
  readonly dbName: string;
  readonly dbUniqueName: string;
  readonly dbDomain: string;
  readonly serverHost: string;
  readonly service: string;

  // ── Application info (set via DBMS_APPLICATION_INFO) ────────────
  module: string | null;
  action: string | null;
  clientInfo: string | null;
  clientIdentifier: string | null;

  // ── NLS settings (mutable via ALTER SESSION SET NLS_*) ──────────
  nlsLanguage: string;
  nlsTerritory: string;
  nlsCurrency: string;
  nlsCalendar: string;
  nlsDateFormat: string;
  nlsDateLanguage: string;
  nlsSort: string;
  nlsTimestampFormat: string;
  nlsTimestampTzFormat: string;
  nlsNumericCharacters: string;

  // ── Background-job metadata ─────────────────────────────────────
  bgJobId: number | null;
  fgJobId: number | null;

  // ── Timing ──────────────────────────────────────────────────────
  readonly logonTime: Date;
  /** Tracked for V$SESSION.LAST_CALL_ET. */
  lastCallAt: Date;

  // ── State (V$SESSION columns the simulator advances) ────────────
  status: 'ACTIVE' | 'INACTIVE' | 'KILLED' | 'SNIPED';
  event: string;
  waitClass: string;
  state: 'WAITING' | 'WAITED SHORT TIME' | 'WAITED KNOWN TIME' | 'WAITED UNKNOWN TIME';
  secondsInWait: number;
  blockingSession: number | null;
  sqlId: string | null;
  sqlExecStart: Date | null;
  sqlChildNumber: number | null;
  resourceConsumerGroup: string;

  constructor(init: OracleSessionInit) {
    this.sid = init.sid;
    this.serial = init.serial;
    this.type = init.type ?? 'USER';
    this.sessionUser = init.username.toUpperCase();
    this.currentSchema = (init.schema ?? init.username).toUpperCase();
    this.currentUser = this.sessionUser;

    this.authenticationMethod = init.authenticationMethod;
    this.authenticationType = init.authenticationType
      ?? OracleSession.deriveAuthenticationType(init.authenticationMethod);
    this.identificationType = init.identificationType
      ?? OracleSession.deriveIdentificationType(init.authenticationMethod);
    this.authenticatedIdentity = init.authenticatedIdentity ?? this.sessionUser;
    this.enterpriseIdentity = init.enterpriseIdentity ?? '';
    this.proxyUser = init.proxyUser ? init.proxyUser.toUpperCase() : null;
    this.isDba = init.authenticationMethod === 'SYSDBA' || this.sessionUser === 'SYS';

    this.osUser = init.osContext.osUser;
    this.hostName = init.osContext.hostname;
    this.machine = init.osContext.hostname;
    this.terminal = init.osContext.terminal;
    this.program = init.osContext.program;
    this.ipAddress = OracleSession.inferIpAddress(init.osContext.hostname);
    this.networkProtocol = OracleSession.inferNetworkProtocol(init.osContext.program);

    this.instanceId = init.instance.instanceId;
    this.instanceName = init.instance.instanceName;
    this.dbName = init.instance.dbName;
    this.dbUniqueName = init.instance.dbUniqueName;
    this.dbDomain = init.instance.dbDomain;
    this.serverHost = init.instance.serverHost;
    this.service = init.service ?? init.instance.dbName.toLowerCase();

    this.module = null;
    this.action = null;
    this.clientInfo = null;
    this.clientIdentifier = null;

    // NLS defaults align with the AMERICAN_AMERICA territory used by
    // the simulator. Mutating ALTER SESSION SET NLS_* updates these.
    this.nlsLanguage = 'AMERICAN';
    this.nlsTerritory = 'AMERICA';
    this.nlsCurrency = '$';
    this.nlsCalendar = 'GREGORIAN';
    this.nlsDateFormat = 'DD-MON-RR';
    this.nlsDateLanguage = 'AMERICAN';
    this.nlsSort = 'BINARY';
    this.nlsTimestampFormat = 'DD-MON-RR HH.MI.SSXFF AM';
    this.nlsTimestampTzFormat = 'DD-MON-RR HH.MI.SSXFF AM TZR';
    this.nlsNumericCharacters = '.,';

    this.bgJobId = null;
    this.fgJobId = null;

    this.logonTime = new Date();
    this.lastCallAt = new Date();

    this.status = 'ACTIVE';
    this.event = 'SQL*Net message from client';
    this.waitClass = 'Idle';
    this.state = 'WAITING';
    this.secondsInWait = 0;
    this.blockingSession = null;
    this.sqlId = null;
    this.sqlExecStart = null;
    this.sqlChildNumber = null;
    this.resourceConsumerGroup = 'DEFAULT_CONSUMER_GROUP';
  }

  // ── USERENV lookup ─────────────────────────────────────────────
  //
  // The full Oracle reference is consulted (see "SYS_CONTEXT — USERENV
  // Namespace" in the SQL Language Reference). Unknown parameters
  // return `null`, mirroring real Oracle's behaviour.

  userenv(parameter: string): string | number | null {
    switch (parameter.toUpperCase()) {
      // Identity
      case 'SESSION_USER':                   return this.sessionUser;
      case 'CURRENT_USER':                   return this.currentUser;
      case 'CURRENT_SCHEMA':                 return this.currentSchema;
      case 'SESSION_USERID':                 return this.sid;
      case 'CURRENT_USERID':                 return this.sid;
      case 'CURRENT_SCHEMAID':               return this.sid;
      case 'OS_USER':                        return this.osUser;

      // Authentication
      case 'AUTHENTICATION_TYPE':            return this.authenticationType;
      case 'AUTHENTICATION_METHOD':          return this.authenticationMethod;
      case 'AUTHENTICATED_IDENTITY':         return this.authenticatedIdentity;
      case 'IDENTIFICATION_TYPE':            return this.identificationType;
      case 'ENTERPRISE_IDENTITY':            return this.enterpriseIdentity;
      case 'PROXY_USER':                     return this.proxyUser;
      case 'PROXY_USERID':                   return this.proxyUser ? this.sid : null;
      case 'ISDBA':                          return this.isDba ? 'TRUE' : 'FALSE';

      // Session
      case 'SID':
      case 'SESSIONID':                      return this.sid;
      case 'BG_JOB_ID':                      return this.bgJobId;
      case 'FG_JOB_ID':                      return this.fgJobId;
      case 'SERVER_HOST':                    return this.serverHost;
      case 'SERVICE_NAME':                   return this.service;

      // Network / host
      case 'HOST':                           return this.hostName;
      case 'TERMINAL':                       return this.terminal;
      case 'IP_ADDRESS':                     return this.ipAddress;
      case 'NETWORK_PROTOCOL':               return this.networkProtocol;

      // Database
      case 'DB_NAME':                        return this.dbName;
      case 'DB_UNIQUE_NAME':                 return this.dbUniqueName;
      case 'DB_DOMAIN':                      return this.dbDomain;
      case 'INSTANCE':                       return this.instanceId;
      case 'INSTANCE_NAME':                  return this.instanceName;
      case 'CON_NAME':                       return 'CDB$ROOT';
      case 'CON_ID':                         return 1;

      // Application info
      case 'MODULE':                         return this.module;
      case 'ACTION':                         return this.action;
      case 'CLIENT_INFO':                    return this.clientInfo;
      case 'CLIENT_IDENTIFIER':              return this.clientIdentifier;

      // NLS
      case 'LANG':                           return OracleSession.languageAbbreviation(this.nlsLanguage);
      case 'LANGUAGE':                       return `${this.nlsLanguage}_${this.nlsTerritory}.AL32UTF8`;
      case 'NLS_TERRITORY':                  return this.nlsTerritory;
      case 'NLS_CURRENCY':                   return this.nlsCurrency;
      case 'NLS_CALENDAR':                   return this.nlsCalendar;
      case 'NLS_DATE_FORMAT':                return this.nlsDateFormat;
      case 'NLS_DATE_LANGUAGE':              return this.nlsDateLanguage;
      case 'NLS_SORT':                       return this.nlsSort;

      default:                               return null;
    }
  }

  // ── Application-info mutators ──────────────────────────────────

  setModule(module: string | null, action: string | null = null): void {
    this.module = module;
    this.action = action;
  }

  setAction(action: string | null): void { this.action = action; }
  setClientInfo(info: string | null): void { this.clientInfo = info; }
  setClientIdentifier(id: string | null): void { this.clientIdentifier = id; }

  setCurrentSchema(schema: string): void {
    this.currentSchema = schema.toUpperCase();
  }

  touch(): void { this.lastCallAt = new Date(); }

  // ── Helpers ────────────────────────────────────────────────────

  private static deriveAuthenticationType(m: AuthenticationMethod): AuthenticationType {
    switch (m) {
      case 'EXTERNAL': return 'OS';
      case 'GLOBAL':   return 'NETWORK';
      case 'SYSDBA':
      case 'SYSOPER':  return 'DATABASE';
      case 'NONE':     return 'DATABASE';
      default:         return 'DATABASE';
    }
  }

  private static deriveIdentificationType(m: AuthenticationMethod): IdentificationType {
    switch (m) {
      case 'EXTERNAL': return 'EXTERNAL';
      case 'GLOBAL':   return 'GLOBAL SHARED';
      default:         return 'LOCAL';
    }
  }

  private static inferIpAddress(hostname: string): string {
    // Loopback connections expose 127.0.0.1 in IP_ADDRESS.
    return hostname === 'localhost' || hostname === '127.0.0.1' ? '127.0.0.1' : '';
  }

  private static inferNetworkProtocol(program: string): string {
    // OS-side BEQ for "sqlplus@localhost", TCP otherwise.
    return /@localhost$/i.test(program) ? 'beq' : 'tcp';
  }

  private static languageAbbreviation(language: string): string {
    const map: Record<string, string> = {
      AMERICAN: 'US', FRENCH: 'F', GERMAN: 'D', ENGLISH: 'E',
      SPANISH: 'E', ITALIAN: 'I', PORTUGUESE: 'PT', JAPANESE: 'JA',
    };
    return map[language.toUpperCase()] ?? language.slice(0, 2).toUpperCase();
  }
}
