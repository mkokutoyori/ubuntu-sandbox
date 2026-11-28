import type { HostCapableDevice } from '@/network';
import type { OsSecurityContext } from '@/database/oracle/security/types';
import type { OracleInstance } from '@/database/oracle/OracleInstance';
import { StandbyDatabase, type ProtectionMode } from '@/database/oracle/dataguard/DataGuardConfiguration';
import { readArchiveDestinations } from '@/database/oracle/dataguard/ArchiveDestination';
import { OracleNetCallStatus } from '@/network/oracle-net/wire/OracleNetCall';
import { executeOverOracleNet, logonOverOracleNet } from '@/network/oracle-net/OracleNetSqlClient';
import { primaryIpv4, resolveOracleConnectTarget } from './oracleNet';
import { getDefaultScheduler } from '@/events/Scheduler';
import { startObserver } from './DgmgrlObserver';
import { ORACLE_ERRORS, oracleError } from '@/database/oracle/OracleConfig';
import { registerBrokerCommandRunner } from '@/adapters/OracleBrokerDmon';
import { BROKER_COMMAND_PARAMETER } from '@/database/oracle/executor/InstanceAdminExecutor';
import { encodeBrokerCommand } from '@/database/oracle/dataguard/BrokerCommandCodec';
import { createSQLPlusSession, getOracleDatabase } from './database';

const PROTECTION_WORDS: Readonly<Record<string, ProtectionMode>> = {
  MAXPERFORMANCE: 'MAXIMUM PERFORMANCE',
  MAXAVAILABILITY: 'MAXIMUM AVAILABILITY',
  MAXPROTECTION: 'MAXIMUM PROTECTION',
};

const PROTECTION_LABEL: Readonly<Record<ProtectionMode, string>> = {
  'MAXIMUM PERFORMANCE': 'MaxPerformance',
  'MAXIMUM AVAILABILITY': 'MaxAvailability',
  'MAXIMUM PROTECTION': 'MaxProtection',
};

const IDENTITY = { osUser: 'oracle', osGroup: 'dba', hostname: 'primary', terminal: 'unknown', program: 'dgmgrl' };

interface BrokerMember {
  identifier: string;
  logXptMode: 'SYNC' | 'ASYNC';
  needsReinstate?: boolean;
}

interface BrokerState {
  created: boolean;
  enabled: boolean;
  configurationName: string;
  primaryName: string;
  primaryIdentifier: string;
  divergenceScn: number;
  self: string;
  fsfo: { enabled: boolean; threshold: number; target: string | null; errors: number[]; health: Record<string, boolean>; lagLimit: number };
  observers: { name: string; host: string }[];
  protectionMode: ProtectionMode;
  members: Map<string, BrokerMember>;
}

const CONFIG_PARAMETER = '_dg_broker_config';

const DEFAULT_HEALTH_CONDITIONS: Record<string, boolean> = { 'Corrupted Controlfile': true, 'Corrupted Dictionary': true, 'Inaccessible Logfile': false, 'Stuck Archiver': false, 'Datafile Write Errors': true };

const alertCursors = new WeakMap<OracleInstance, number>();

function raisedCondition(instance: OracleInstance, state: BrokerState): boolean {
  const log = instance.getAlertLog();
  const from = alertCursors.get(instance) ?? log.length;
  alertCursors.set(instance, log.length);
  const stuck = (state.fsfo.health['Stuck Archiver'] && instance.archiverStuck) || (state.fsfo.health['Datafile Write Errors'] && instance.datafileWriteError) || (state.fsfo.health['Inaccessible Logfile'] && instance.logfileInaccessible) || (state.fsfo.health['Corrupted Controlfile'] && instance.controlfileCorrupt) || (state.fsfo.health['Corrupted Dictionary'] && instance.dictionaryCorrupt);
  return stuck || log.slice(from).some((line) => [...line.matchAll(/ORA-0*(\d+)/g)].some((found) => state.fsfo.errors.includes(Number(found[1]))));
}

const emptyState = (): BrokerState => ({ created: false, enabled: false, configurationName: '', primaryName: '', primaryIdentifier: '', divergenceScn: 0, self: '', fsfo: { enabled: false, threshold: 30, target: null, errors: [], health: { ...DEFAULT_HEALTH_CONDITIONS }, lagLimit: 30 }, observers: [], protectionMode: 'MAXIMUM PERFORMANCE', members: new Map() });

function stateOf(instance: OracleInstance): BrokerState {
  const stored = instance.getParameter(CONFIG_PARAMETER);
  if (stored === undefined || stored === '') return emptyState();
  const parsed = JSON.parse(stored) as Omit<BrokerState, 'members'> & { members: [string, BrokerMember][] };
  return { ...emptyState(), ...parsed, fsfo: { ...emptyState().fsfo, ...parsed.fsfo }, members: new Map(parsed.members) };
}

function serialize(state: BrokerState, self: string): string {
  return JSON.stringify({ ...state, self, members: [...state.members] });
}

function save(device: HostCapableDevice, instance: OracleInstance, state: BrokerState, formerMembers: ReadonlyMap<string, { identifier: string }>): string[] {
  state.protectionMode = instance.protectionMode;
  state.self = state.primaryName;
  instance.setParameter(CONFIG_PARAMETER, serialize(state, state.primaryName), 'BOTH');
  const cleared = serialize(emptyState(), '');
  const failures: string[] = [];
  const recipients = new Map<string, string>([...formerMembers].map(([name, member]) => [name, member.identifier]));
  for (const [name, member] of state.members) recipients.set(name, member.identifier);
  for (const [name, identifier] of recipients) {
    const sent = remoteExecute(device, identifier, [`ALTER SYSTEM SET "${CONFIG_PARAMETER}"='${state.members.has(name) ? serialize(state, name) : cleared}' SCOPE=BOTH`]);
    if (sent.ok === false) failures.push(`Error: ${sent.error}`);
  }
  return failures;
}

const MUTATING = /^(CREATE|ADD|ENABLE|DISABLE|REMOVE|EDIT|STOP|REGISTER|OBSERVER|REINSTATE)\b/i;

export function __resetBrokers(): void { /* the configuration lives in each instance's parameters */ }

const unquote = (text: string): string => text.trim().replace(/^['"]|['"]$/g, '');

function remoteExecute(localDevice: HostCapableDevice, identifier: string, statements: readonly string[]): { ok: true; outputs: string[] } | { ok: false; error: string } {
  const resolved = resolveOracleConnectTarget(localDevice, identifier, getOracleDatabase);
  if (resolved.ok === false) return { ok: false, error: resolved.error };
  if (resolved.remote === false) {
    if (resolved.db.instance.state === 'SHUTDOWN') return { ok: false, error: ORACLE_ERRORS.ORA_01034 };
    const own = createSQLPlusSession(localDevice.getId(), ['/', 'as', 'sysdba'], { ...IDENTITY, isDbaGroup: true });
    const outputs = statements.map((sql) => own.session.processLine(`${sql};`).output.join('\n'));
    own.session.disconnect();
    const unavailable = [...own.loginOutput, ...outputs].find((line) => /ORA-(01034|01033|01090|03113)\b/.test(line));
    if (unavailable !== undefined) return { ok: false, error: unavailable.trim() };
    return { ok: true, outputs };
  }
  const session = resolved.session as never;
  const entree = logonOverOracleNet(session, { username: 'SYS', password: 'oracle', asSysdba: true, identity: IDENTITY });
  if (entree.status === OracleNetCallStatus.Error) {
    resolved.session.close();
    return { ok: false, error: entree.error };
  }
  const outputs: string[] = [];
  for (const sql of statements) {
    const answer = executeOverOracleNet(session, sql);
    if (answer.status === OracleNetCallStatus.Error) {
      resolved.session.close();
      return { ok: false, error: answer.error };
    }
    outputs.push(answer.result?.message ?? '');
  }
  resolved.session.close();
  return { ok: true, outputs };
}

function roleLabel(role: string): string {
  return role === 'PRIMARY' ? 'Primary database' : 'Physical standby database';
}

function roleOf(instance: OracleInstance, state: BrokerState, name: string): string {
  if (instance.databaseRole === 'PRIMARY') return name === state.self ? 'PRIMARY' : 'PHYSICAL STANDBY';
  return name === state.primaryName && name !== state.self ? 'PRIMARY' : 'PHYSICAL STANDBY';
}

const FSFO_MODE_LABEL = (state: BrokerState): string => (state.protectionMode === 'MAXIMUM PERFORMANCE' ? 'Enabled in Potential Data Loss Mode' : 'Enabled in Zero Data Loss Mode');

function configurationProperties(state: BrokerState): [string, string][] {
  return [
    ['FastStartFailoverThreshold', String(state.fsfo.threshold)],
    ['OperationTimeout', '30'],
    ['TraceLevel', 'USER'],
    ['FastStartFailoverLagLimit', String(state.fsfo.lagLimit)],
    ['CommunicationTimeout', '180'],
    ['ObserverReconnect', '0'],
    ['FastStartFailoverAutoReinstate', 'TRUE'],
    ['FastStartFailoverPmyShutdown', 'TRUE'],
    ['BystandersFollowRoleChange', 'ALL'],
    ['ObserverOverride', 'FALSE'],
    ['ExternalDestination1', ''],
    ['ExternalDestination2', ''],
    ['PrimaryLostWriteAction', 'CONTINUE'],
    ['ConfigurationWideServiceName', `${state.primaryName}_CFG`],
  ];
}

function showConfiguration(device: HostCapableDevice, instance: OracleInstance, state: BrokerState, verbose = false): string[] {
  const needing = [...state.members].some(([, member]) => member.needsReinstate === true);
  const lacking = new Set([...state.members].filter(([name, member]) => member.needsReinstate !== true && standbyLogsOf(device, instance, state, name) === 0).map(([name]) => name));
  const lines = ['', `Configuration - ${state.configurationName.toLowerCase()}`, '', `  Protection Mode: ${PROTECTION_LABEL[instance.databaseRole === 'PRIMARY' ? instance.protectionMode : state.protectionMode]}`, '  Members:'];
  for (const name of [state.primaryName, ...state.members.keys()]) {
    lines.push(`  ${name} - ${verbose && state.fsfo.enabled && name === activeTarget(state) ? '(*) ' : ''}${roleLabel(roleOf(instance, state, name))}`);
    if (state.members.get(name)?.needsReinstate === true) lines.push(`    Error: ${ORACLE_ERRORS.ORA_16661}`);
    if (lacking.has(name)) lines.push(`    Error: ${SRL_MESSAGE}`);
    if (state.fsfo.enabled && state.observers.length === 0 && (name === state.primaryName || state.members.has(name))) lines.push(`    Warning: ${ORACLE_ERRORS.ORA_16819}`);
  }
  const failing = [...state.members.keys()].some((name) => {
    const dest = readArchiveDestinations(instance.getAllParameters()).find((d) => d.kind === 'SERVICE' && (d.dbUniqueName ?? d.target) === name);
    return dest !== undefined && instance.getTransportState(dest.destId)?.status === 'ERROR';
  });
  if (verbose) {
    if (state.fsfo.enabled) lines.push('  (*) Fast-Start Failover target');
    lines.push('  Properties:', ...configurationProperties(state).map(([property, value]) => `    ${property.padEnd(32)}= '${value}'`));
  }
  lines.push(state.fsfo.enabled ? `Fast-Start Failover: ${FSFO_MODE_LABEL(state)}` : 'Fast-Start Failover: DISABLED');
  if (verbose && state.fsfo.enabled) {
    const summary = showFastStartFailover(instance, state).slice(1);
    lines.push(...summary.slice(0, summary.indexOf('Configurable Failover Conditions')).filter((line) => !/^ {2}(Protection Mode|Ping Interval|Ping Retry):/.test(line)));
  }
  const unobserved = state.fsfo.enabled && state.observers.length === 0;
  lines.push('', 'Configuration Status:');
  if (!state.enabled) lines.push('DISABLED');
  else if (needing) lines.push('ERROR');
  else if (lacking.size > 0) lines.push(SRL_MESSAGE, 'ERROR');
  else if (unobserved) lines.push('WARNING');
  else if (failing) lines.push(`${ORACLE_ERRORS.ORA_16778}`, 'ERROR');
  else lines.push('SUCCESS   (status updated 0 seconds ago)');
  return lines;
}

function transportLagOf(instance: OracleInstance, name: string, nowMs: number): number {
  const dest = readArchiveDestinations(instance.getAllParameters()).find((d) => d.kind === 'SERVICE' && (d.dbUniqueName ?? d.target) === name);
  return dest === undefined ? 0 : instance.transportLagSeconds(dest.destId, nowMs);
}

function showDatabase(device: HostCapableDevice, instance: OracleInstance, state: BrokerState, name: string): string[] {
  const member = state.members.get(name);
  if (name !== state.primaryName && member === undefined) return [`${ORACLE_ERRORS.ORA_16541}`];
  const role = roleOf(instance, state, name);
  const lines = ['', `Database - ${name}`, '', `  Role:               ${role}`];
  lines.push(`  Intended State:     ${role === 'PRIMARY' ? 'TRANSPORT-ON' : 'APPLY-ON'}`);
  if (role !== 'PRIMARY') {
    const lag = instance.databaseRole === 'PRIMARY' ? transportLagOf(instance, name, getDefaultScheduler().now()) : Number(viaDatabase(device, state.primaryIdentifier, `EXPORT LAG ${name}`)[0]) || 0;
    lines.push(`  Transport Lag:      ${lag} seconds (computed 0 seconds ago)`, '  Apply Lag:          0 seconds (computed 0 seconds ago)');
    lines.push(`  Log Transport Mode: ${member?.logXptMode ?? 'ASYNC'}`);
  }
  const lacking = member !== undefined && standbyLogsOf(device, instance, state, name) === 0;
  lines.push('  Instance(s):', `    ${instance.config.sid.toUpperCase()}`, '', ...(lacking ? ['  Database Error(s):', `    ${SRL_MESSAGE}`, ''] : []), 'Database Status:', lacking ? 'ERROR' : state.enabled ? 'SUCCESS' : 'DISABLED');
  return lines;
}

const MAX_OBSERVERS = 3;

const SRL_MESSAGE = `${ORACLE_ERRORS.ORA_16789}`;

function standbyLogsOf(device: HostCapableDevice, instance: OracleInstance, state: BrokerState, name: string): number | null {
  if (name === state.self) return instance.getStandbyLogs().length;
  const member = state.members.get(name);
  if (member === undefined) return null;
  const sent = remoteExecute(device, member.identifier, [`ALTER SYSTEM SET "${BROKER_COMMAND_PARAMETER}"='${encodeBrokerCommand('EXPORT CONFIGURATION')}'`]);
  if (sent.ok === false) return null;
  try { return (JSON.parse(sent.outputs[0].trim()) as { standbyLogs?: number }).standbyLogs ?? 0; } catch { return null; }
}

function activeTarget(state: BrokerState): string | null {
  if (state.fsfo.target !== null && state.members.has(state.fsfo.target)) return state.fsfo.target;
  return state.members.size === 1 ? [...state.members.keys()][0] : null;
}

function potentialTargets(state: BrokerState): string[] {
  return [...state.members].filter(([, member]) => member.logXptMode === 'SYNC').map(([name]) => name);
}

function agoLabel(thenMs: number, nowMs: number): string {
  const seconds = Math.max(0, Math.round((nowMs - thenMs) / 1000));
  return `${seconds} second${seconds === 1 ? '' : 's'} ago`;
}

function showFastStartFailover(instance: OracleInstance, state: BrokerState): string[] {
  if (!state.fsfo.enabled) return ['Fast-Start Failover: DISABLED'];
  const target = activeTarget(state) ?? '';
  const potentials = potentialTargets(state);
  const observers = state.observers.map((observer) => observer.host);
  return [
    `Fast-Start Failover: ${FSFO_MODE_LABEL(state)}`,
    `  Protection Mode:    ${PROTECTION_LABEL[instance.databaseRole === 'PRIMARY' ? instance.protectionMode : state.protectionMode]}`,
    `  Lag Limit:          ${instance.protectionMode === 'MAXIMUM PERFORMANCE' ? state.fsfo.lagLimit : 0} seconds`,
    `  Threshold:          ${state.fsfo.threshold} seconds`,
    '  Ping Interval:      3000 milliseconds',
    '  Ping Retry:         0',
    `  Active Target:      ${target}`,
    `  Potential Targets:  "${potentials.join(', ')}"`,
    ...potentials.map((name) => `    ${name} valid`),
    observers.length === 0 ? '  Observer:           (none)' : observers.length === 1 ? `  Observer:           ${observers[0]}` : `  Observers:          ${observers.join(', ')}`,
    '  Shutdown Primary:   TRUE',
    '  Auto-reinstate:     TRUE',
    '  Observer Reconnect: (none)',
    '  Observer Override:  FALSE',
    'Configurable Failover Conditions',
    '  Health Conditions:',
    ...Object.entries(state.fsfo.health).map(([condition, on]) => `    ${condition.padEnd(31)}${on ? 'YES' : ' NO'}`),
    '  Oracle Error Conditions:',
    ...(state.fsfo.errors.length === 0 ? ['    (none)'] : state.fsfo.errors.map((code) => `    ORA-${String(code).padStart(5, '0')}`)),
  ];
}

function showObserver(instance: OracleInstance, state: BrokerState, nowMs: number): string[] {
  const target = activeTarget(state) ?? '';
  const lines = [`Configuration - ${state.configurationName.toLowerCase()}`, `Primary:               ${state.primaryName}`, `Active Target Standby: ${target}`];
  state.observers.forEach((observer, index) => {
    const pings = (instance.getParameter(`_dg_observer_${observer.name.toLowerCase()}`) ?? '').split(',').map(Number);
    lines.push(`Observer "${observer.name}" - ${index === 0 ? 'Master' : 'Backup'}`, `   Host Name:              ${observer.host}`);
    if (state.fsfo.enabled && Number.isFinite(pings[0])) lines.push(`   Last Ping to Primary:   ${agoLabel(pings[0], nowMs)}`, `   Last Ping to Target:    ${agoLabel(pings[1], nowMs)}`);
  });
  return lines;
}

function destinationFor(instance: OracleInstance, name: string, identifier: string, mode: 'SYNC' | 'ASYNC'): void {
  const params = instance.getAllParameters();
  const existing = readArchiveDestinations(params).find((d) => d.kind === 'SERVICE' && (d.dbUniqueName ?? d.target) === name);
  const slot = existing?.destId ?? readArchiveDestinations(params).find((d) => d.destId >= 2 && d.kind === 'UNSET')?.destId ?? 2;
  const transport = mode === 'SYNC' ? 'SYNC AFFIRM' : 'ASYNC';
  instance.setParameter(`log_archive_dest_${slot}`, `SERVICE=${identifier} ${transport} DB_UNIQUE_NAME=${name} VALID_FOR=(ONLINE_LOGFILES,PRIMARY_ROLE)`, 'BOTH');
  instance.setParameter(`log_archive_dest_state_${slot}`, 'ENABLE', 'BOTH');
}

function execute(device: HostCapableDevice, instance: OracleInstance, state: BrokerState, command: string): string[] {
  const text = command.trim().replace(/;$/, '').trim();
  const upper = text.toUpperCase();
  if (upper === '' || upper.startsWith('--')) return [];
  if (/^(EXIT|QUIT)$/.test(upper)) return [];
  const create = /^CREATE\s+CONFIGURATION\s+('[^']*'|"[^"]*"|\S+)\s+AS\s+PRIMARY\s+DATABASE\s+IS\s+('[^']*'|"[^"]*"|\S+)\s+CONNECT\s+IDENTIFIER\s+IS\s+(\S+)$/i.exec(text);
  if (create) {
    if (state.created) return [`Error: ${ORACLE_ERRORS.ORA_16603}`];
    const primary = unquote(create[2]).toUpperCase();
    if (primary !== instance.config.sid.toUpperCase()) return [`Error: ${ORACLE_ERRORS.ORA_16642}`];
    state.created = true;
    state.configurationName = unquote(create[1]).toUpperCase();
    state.primaryName = primary;
    state.primaryIdentifier = `${primaryIpv4(device) ?? 'localhost'}:1521/${instance.config.sid.toUpperCase()}`;
    instance.dataGuard.configurationName = state.configurationName;
    return [`Configuration "${unquote(create[1]).toLowerCase()}" created with primary database "${primary}"`];
  }
  if (!/^(CREATE|ADD|ENABLE|DISABLE|REMOVE|SHOW|EDIT|SWITCHOVER|FAILOVER|STOP|REGISTER|OBSERVER|EXPORT|REINSTATE)\b/.test(upper)) return [`DGM-16905: syntax error at or near "${text.split(/\s+/)[0]}"`];
  if (upper.startsWith('CREATE ')) return [`DGM-16905: syntax error`];
  const failover = /^(OBSERVER\s+)?FAILOVER\s+TO\s+('[^']*'|"[^"]*"|\S+)$/i.exec(text);
  if (failover) {
    const fastStart = failover[1] !== undefined;
    const target = unquote(failover[2]).toUpperCase();
    if (instance.databaseRole !== 'PHYSICAL STANDBY') return [`Error: ${ORACLE_ERRORS.ORA_16652}`];
    const answer = instance.failover();
    if (answer !== 'Database altered.') return ['Performing failover NOW, please wait...', `Error: ${answer}`];
    if (state.created) {
      state.members.delete(target);
      const lostPrimary = state.primaryName;
      state.members.set(lostPrimary, { identifier: state.primaryIdentifier, logXptMode: fastStart ? 'SYNC' : 'ASYNC', needsReinstate: true });
      state.primaryName = target;
      state.primaryIdentifier = `${primaryIpv4(device) ?? 'localhost'}:1521/${instance.config.sid.toUpperCase()}`;
      state.divergenceScn = instance.getCurrentScn();
      instance.dataGuard.protectionMode = state.protectionMode;
      state.self = target;
      state.fsfo.enabled = fastStart && state.fsfo.enabled;
      if (state.fsfo.enabled) state.fsfo.target = lostPrimary;
      instance.setParameter(CONFIG_PARAMETER, serialize(state, target), 'BOTH');
    }
    return ['Performing failover NOW, please wait...', `Failover succeeded, new primary is "${target}"`];
  }
  if (!state.created) return [`${ORACLE_ERRORS.ORA_16532}`];
  const add = /^ADD\s+DATABASE\s+('[^']*'|"[^"]*"|\S+)\s+AS\s+CONNECT\s+IDENTIFIER\s+IS\s+(\S+)(?:\s+MAINTAINED\s+AS\s+PHYSICAL)?$/i.exec(text);
  if (add) {
    const name = unquote(add[1]).toUpperCase();
    if (state.members.has(name)) return [`Error: ${ORACLE_ERRORS.ORA_16698}`];
    state.members.set(name, { identifier: add[2], logXptMode: 'ASYNC' });
    instance.dataGuard.addStandby(new StandbyDatabase({ dbUniqueName: name, host: add[2], role: 'PHYSICAL STANDBY' }));
    if (state.enabled) destinationFor(instance, name, add[2], 'ASYNC');
    return [`Database "${name}" added`];
  }
  if (upper === 'ENABLE CONFIGURATION') {
    if (state.members.size === 0) return [`Error: ${ORACLE_ERRORS.ORA_16626}`];
    state.enabled = true;
    const failures: string[] = [];
    for (const [name, member] of state.members) {
      destinationFor(instance, name, member.identifier, member.logXptMode);
      const started = remoteExecute(device, member.identifier, ['ALTER DATABASE RECOVER MANAGED STANDBY DATABASE DISCONNECT FROM SESSION']);
      if (started.ok === false) failures.push(`Error: ${started.error}`);
    }
    return failures.length > 0 ? failures : ['Enabled.'];
  }
  if (upper === 'DISABLE CONFIGURATION') {
    state.enabled = false;
    return ['Disabled.'];
  }
  if (upper === 'REMOVE CONFIGURATION' || upper === 'REMOVE CONFIGURATION PRESERVE DESTINATIONS') {
    state.created = false;
    state.enabled = false;
    state.members.clear();
    return ['Removed configuration'];
  }
  const remove = /^REMOVE\s+DATABASE\s+('[^']*'|"[^"]*"|\S+)$/i.exec(text);
  if (remove) {
    const name = unquote(remove[1]).toUpperCase();
    if (!state.members.delete(name)) return [`Error: ${ORACLE_ERRORS.ORA_16541}`];
    instance.dataGuard.removeStandby(name);
    return [`Succeeded.`];
  }
  if (upper === 'SHOW CONFIGURATION' || upper === 'SHOW CONFIGURATION VERBOSE') return showConfiguration(device, instance, state, upper.endsWith('VERBOSE'));
  const show = /^SHOW\s+DATABASE\s+(?:VERBOSE\s+)?('[^']*'|"[^"]*"|\S+)$/i.exec(text);
  if (show) return showDatabase(device, instance, state, unquote(show[1]).toUpperCase());
  const edit = /^EDIT\s+DATABASE\s+('[^']*'|"[^"]*"|\S+)\s+SET\s+PROPERTY\s+LogXptMode\s*=\s*('[^']*'|"[^"]*"|\S+)$/i.exec(text);
  if (edit) {
    const name = unquote(edit[1]).toUpperCase();
    const member = state.members.get(name);
    if (member === undefined) return [`Error: ${ORACLE_ERRORS.ORA_16541}`];
    const mode = unquote(edit[2]).toUpperCase();
    if (mode !== 'SYNC' && mode !== 'ASYNC') return [`Error: ${ORACLE_ERRORS.ORA_16596}`];
    member.logXptMode = mode;
    if (state.enabled) destinationFor(instance, name, member.identifier, mode);
    return ['Property "logxptmode" updated'];
  }
  const protection = /^EDIT\s+CONFIGURATION\s+SET\s+PROTECTION\s+MODE\s+AS\s+(\w+)$/i.exec(text);
  if (protection) {
    const mode = PROTECTION_WORDS[protection[1].toUpperCase()];
    if (mode === undefined) return [`Error: ${ORACLE_ERRORS.ORA_16596}`];
    const answer = instance.setProtectionMode(mode);
    if (answer === 'Database altered.') return ['Succeeded.'];
    if (/ORA-16072/.test(answer)) return [`Error: ${ORACLE_ERRORS.ORA_16627}`];
    return [`Error: ${answer}`];
  }
  const nowMs = getDefaultScheduler().now();
  const exportLag = /^EXPORT\s+LAG\s+(\S+)$/i.exec(text);
  if (exportLag) return [String(transportLagOf(instance, exportLag[1].toUpperCase(), nowMs))];
  if (upper === 'EXPORT CONFIGURATION') return [JSON.stringify({ ...JSON.parse(serialize(state, state.self)), standbyLogs: instance.getStandbyLogs().length })];
  const register = /^REGISTER\s+OBSERVER\s+(\S+)\s+(\S+)$/i.exec(text);
  if (register) {
    const name = register[1];
    if (state.observers.some((observer) => observer.name.toLowerCase() === name.toLowerCase())) return ['Error: Unable to open the observer file'];
    if (state.observers.length >= MAX_OBSERVERS) return [`Error: ${ORACLE_ERRORS.ORA_16647}`];
    state.observers.push({ name, host: register[2] });
    return ['Done.'];
  }
  const ping = /^OBSERVER\s+PING\s+(\S+)\s+(\d+)$/i.exec(text);
  if (ping) {
    const registered = state.observers.some((observer) => observer.name === ping[1]);
    if (registered) instance.setParameter(`_dg_observer_${ping[1].toLowerCase()}`, `${nowMs},${ping[2]}`, 'BOTH');
    if (registered && state.fsfo.enabled && raisedCondition(instance, state)) {
      instance.logAlertEvent('Data Guard broker: a fast-start failover condition was raised, shutting down the primary');
      instance.shutdown('ABORT');
      return ['condition'];
    }
    return [registered ? 'registered' : 'unknown'];
  }
  const condition = /^(ENABLE|DISABLE)\s+FAST_START\s+FAILOVER\s+CONDITION\s+('[^']*'|"[^"]*"|\S+)$/i.exec(text);
  if (condition) {
    const on = condition[1].toUpperCase() === 'ENABLE';
    const value = unquote(condition[2]);
    if (/^\d+$/.test(value)) {
      const code = Number(value);
      state.fsfo.errors = on ? [...new Set([...state.fsfo.errors, code])] : state.fsfo.errors.filter((known) => known !== code);
      if (on) alertCursors.set(instance, instance.getAlertLog().length);
      return ['Succeeded.'];
    }
    const health = Object.keys(state.fsfo.health).find((known) => known.toLowerCase() === value.toLowerCase());
    if (health === undefined) return [`Error: ${ORACLE_ERRORS.ORA_16524}`];
    state.fsfo.health[health] = on;
    return ['Succeeded.'];
  }
  if (upper === 'ENABLE FAST_START FAILOVER') {
    if (!state.enabled || state.members.size === 0) return [`Error: ${ORACLE_ERRORS.ORA_16844}`];
    const targetName = activeTarget(state);
    const target = targetName === null ? undefined : state.members.get(targetName);
    const logsReady = instance.getStandbyLogs().length > 0 && targetName !== null && (standbyLogsOf(device, instance, state, targetName) ?? 0) > 0;
    const potentialDataLoss = instance.protectionMode === 'MAXIMUM PERFORMANCE';
    if (target === undefined || !logsReady || !(potentialDataLoss || (instance.protectionMode === 'MAXIMUM AVAILABILITY' && target.logXptMode === 'SYNC'))) return [`Error: ${ORACLE_ERRORS.ORA_16693}`];
    state.fsfo.target = targetName;
    state.fsfo.enabled = true;
    return [...(instance.flashbackOn ? [] : [`Warning: ${ORACLE_ERRORS.ORA_16827}`]), `${FSFO_MODE_LABEL({ ...state, protectionMode: instance.protectionMode })}.`];
  }
  if (/^DISABLE\s+FAST_START\s+FAILOVER(\s+FORCE)?$/i.test(text)) {
    state.fsfo.enabled = false;
    return ['Disabled.'];
  }
  const stop = /^STOP\s+OBSERVER(?:\s+(\S+))?$/i.exec(text);
  if (stop) {
    const which = stop[1];
    if (state.observers.length === 0) return [`Error: ${ORACLE_ERRORS.ORA_16819}`];
    if (which === undefined && state.observers.length > 1) return ['Error: more than one observer is registered, name the observer or use ALL'];
    if (which !== undefined && which.toUpperCase() !== 'ALL' && !state.observers.some((observer) => observer.name.toLowerCase() === which.toLowerCase())) return [`Error: observer "${which}" is not registered`];
    state.observers = which === undefined || which.toUpperCase() === 'ALL' ? [] : state.observers.filter((observer) => observer.name.toLowerCase() !== which.toLowerCase());
    return ['Done.'];
  }
  const targetProperty = /^EDIT\s+DATABASE\s+('[^']*'|"[^"]*"|\S+)\s+SET\s+PROPERTY\s+'?FastStartFailoverTarget'?\s*=\s*('[^']*'|"[^"]*"|\S+)$/i.exec(text);
  if (targetProperty) {
    const owner = unquote(targetProperty[1]).toUpperCase();
    const wanted = unquote(targetProperty[2]).toUpperCase();
    if (owner !== state.primaryName) return [`Error: ${ORACLE_ERRORS.ORA_16596}`];
    const known = [...state.members.keys()].find((name) => name.toUpperCase() === wanted);
    if (known === undefined && wanted !== 'ANY') return [`Error: ${ORACLE_ERRORS.ORA_16844}`];
    if (state.fsfo.enabled) return [`Error: ${ORACLE_ERRORS.ORA_16654}`];
    state.fsfo.target = known ?? null;
    return [`Property "faststartfailovertarget" updated for member "${state.primaryName}".`];
  }
  const showTarget = /^SHOW\s+DATABASE\s+('[^']*'|"[^"]*"|\S+)\s+'?FastStartFailoverTarget'?$/i.exec(text);
  if (showTarget) {
    const owner = unquote(showTarget[1]).toUpperCase();
    const target = activeTarget(state) ?? '';
    const value = owner === state.primaryName ? target : state.fsfo.enabled && owner === target.toUpperCase() ? state.primaryName : '';
    return [`  FastStartFailoverTarget='${value}';`];
  }
  const threshold = /^EDIT\s+CONFIGURATION\s+SET\s+PROPERTY\s+FastStartFailoverThreshold\s*=\s*'?(\d+)'?$/i.exec(text);
  if (threshold) {
    state.fsfo.threshold = Number(threshold[1]);
    return ['Property "faststartfailoverthreshold" updated'];
  }
  const lagLimit = /^EDIT\s+CONFIGURATION\s+SET\s+PROPERTY\s+FastStartFailoverLagLimit\s*=\s*'?(\d+)'?$/i.exec(text);
  if (lagLimit) {
    state.fsfo.lagLimit = Number(lagLimit[1]);
    return ['Property "faststartfailoverlaglimit" updated'];
  }
  if (upper === 'SHOW FAST_START FAILOVER') return showFastStartFailover(instance, state);
  if (upper === 'SHOW OBSERVER') return showObserver(instance, state, nowMs);
  const reinstate = /^REINSTATE\s+DATABASE\s+('[^']*'|"[^"]*"|\S+)$/i.exec(text);
  if (reinstate) {
    const name = unquote(reinstate[1]).toUpperCase();
    const member = state.members.get(name);
    if (member === undefined) return [`Error: ${ORACLE_ERRORS.ORA_16541}`];
    const lines = [`Reinstating database "${name}", please wait...`];
    if (member.needsReinstate !== true) return [...lines, `Error: ${ORACLE_ERRORS.ORA_16653}`];
    for (const statement of [`FLASHBACK DATABASE TO BEFORE SCN ${state.divergenceScn}`, 'ALTER DATABASE CONVERT TO PHYSICAL STANDBY']) {
      const done = remoteExecute(device, member.identifier, [statement]);
      if (done.ok === false) {
        instance.logAlertEvent(`Data Guard broker: REINSTATE DATABASE ${name} failed on "${statement}": ${done.error}`);
        return [...lines, `Error: ${ORACLE_ERRORS.ORA_16653}`];
      }
      const refused = done.outputs[0].split('\n').find((line) => /^ORA-\d+/.test(line.trim()));
      if (refused !== undefined) {
        instance.logAlertEvent(`Data Guard broker: REINSTATE DATABASE ${name} failed on "${statement}": ${refused.trim()}`);
        return [...lines, `Error: ${ORACLE_ERRORS.ORA_16653}`];
      }
    }
    member.needsReinstate = false;
    destinationFor(instance, name, member.identifier, member.logXptMode);
    remoteExecute(device, member.identifier, ['ALTER DATABASE RECOVER MANAGED STANDBY DATABASE DISCONNECT FROM SESSION']);
    instance.switchLogfile();
    return [...lines, `Reinstatement of database "${name}" succeeded`];
  }
  const switchover = /^SWITCHOVER\s+TO\s+('[^']*'|"[^"]*"|\S+)$/i.exec(text);
  if (switchover) {
    const target = unquote(switchover[1]).toUpperCase();
    if (!state.members.has(target)) return [`Error: ${ORACLE_ERRORS.ORA_16642}`];
    const targetMember = state.members.get(target)!;
    const answer = instance.requestSwitchover(target);
    if (answer !== 'Database altered.') return ['Performing switchover NOW, please wait...', `Error: ${answer}`];
    const former = state.primaryName;
    state.members.delete(target);
    state.members.set(former, { identifier: `${primaryIpv4(device) ?? 'localhost'}:1521/${instance.config.sid.toUpperCase()}`, logXptMode: 'ASYNC' });
    state.primaryName = target;
    state.self = former;
    instance.setParameter(CONFIG_PARAMETER, serialize(state, former), 'BOTH');
    const failures: string[] = [];
    const recipients = [[target, targetMember.identifier], ...[...state.members].filter(([name]) => name !== former).map(([name, member]) => [name, member.identifier])];
    for (const [name, identifier] of recipients) {
      const sent = remoteExecute(device, identifier, [`ALTER SYSTEM SET "${CONFIG_PARAMETER}"='${serialize(state, name)}' SCOPE=BOTH`]);
      if (sent.ok === false) failures.push(`Error: ${sent.error}`);
    }
    return ['Performing switchover NOW, please wait...', ...failures, `New primary database "${target}" is opening...`, `Switchover succeeded, new primary is "${target}"`];
  }
  return [`DGM-16905: syntax error at or near "${text.split(/\s+/)[0]}"`];
}

function commandsOf(args: readonly string[], stdin: string | undefined): string[] {
  const fromArgs = args.filter((a) => !a.startsWith('-')).slice(1);
  const fromStdin = (stdin ?? '').split('\n').map((line) => line.trim()).filter((line) => line !== '');
  return [...fromArgs, ...fromStdin];
}

const START_OBSERVER = /^START\s+OBSERVER(?:\s+(?!IN\b)([^\s;]+))?(?:\s+IN\s+BACKGROUND(?:\s+CONNECT\s+IDENTIFIER\s+IS\s+(\S+))?)?\s*;?$/i;

function launchObserverFor(device: HostCapableDevice, instance: OracleInstance | null, remote: string | null, matched: RegExpExecArray): string[] {
  const connectedIdentifier = remote ?? `${primaryIpv4(device) ?? 'localhost'}:1521/${instance!.config.sid.toUpperCase()}`;
  const host = (device as { getHostname?: () => string }).getHostname?.() ?? device.getId();
  const name = matched[1] ?? host;
  const ask = (identifier: string, command: string): string[] | null => {
    const sent = remoteExecute(device, identifier, [`ALTER SYSTEM SET "${BROKER_COMMAND_PARAMETER}"='${encodeBrokerCommand(command)}'`]);
    return sent.ok === true ? sent.outputs[0].trim().split('\n') : null;
  };
  const exported = ask(connectedIdentifier, 'EXPORT CONFIGURATION');
  let primaryIdentifier = '';
  try { primaryIdentifier = (JSON.parse((exported ?? []).join('\n')) as { primaryIdentifier: string }).primaryIdentifier; } catch { primaryIdentifier = ''; }
  if (primaryIdentifier === '') return [`${ORACLE_ERRORS.ORA_16532}`];
  const registered = ask(connectedIdentifier, `REGISTER OBSERVER ${name} ${host}`) ?? ['Error: could not reach the database'];
  if (registered[0] !== 'Done.') return registered;
  startObserver(device.getId(), name, primaryIdentifier, {
    ask,
    sql: (identifier, statement) => remoteExecute(device, identifier, [statement]).ok === true,
  });
  return matched[0].toUpperCase().includes('IN BACKGROUND')
    ? [`Submitted command "START OBSERVER" using connect identifier "${matched[2] ?? connectedIdentifier}"`]
    : ['Observer started'];
}

function viaDatabase(device: HostCapableDevice, identifier: string, command: string): string[] {
  const sent = remoteExecute(device, identifier, [`ALTER SYSTEM SET "${BROKER_COMMAND_PARAMETER}"='${encodeBrokerCommand(command)}'`]);
  return sent.ok === true ? sent.outputs[0].trim().split('\n') : [`Error: ${sent.error}`];
}

export function runBrokerCommand(device: HostCapableDevice, instance: OracleInstance, command: string): string[] {
  const state = stateOf(instance);
  const mutating = MUTATING.test(command.trim()) && !/^OBSERVER\s+FAILOVER\b/i.test(command.trim());
  if (mutating && instance.databaseRole !== 'PRIMARY') {
    if (!state.created || state.primaryIdentifier === '') return [`${ORACLE_ERRORS.ORA_16532}`];
    return viaDatabase(device, state.primaryIdentifier, command);
  }
  const formerMembers = new Map(state.members);
  const lines = execute(device, instance, state, command);
  if (mutating) lines.push(...save(device, instance, state, formerMembers));
  return lines;
}

registerBrokerCommandRunner((device, database, command) => runBrokerCommand(device, database.instance, command).join('\n'));

export function runDgmgrl(device: HostCapableDevice, args: readonly string[], stdin: string | undefined, osContext: OsSecurityContext): string {
  const options = args.filter((a) => a.startsWith('-'));
  const silent = options.includes('-silent');
  const connection = args.find((a) => !a.startsWith('-')) ?? '/';
  const out: string[] = [];
  if (!silent) {
    out.push('', 'DGMGRL for Linux: Release 19.0.0.0.0 - Production', '', 'Copyright (c) 1982, 2019, Oracle and/or its affiliates.  All rights reserved.', '', 'Welcome to DGMGRL, type "help" for information.');
  }
  const bequeath = connection === '/' || connection.startsWith('/@');
  const remote = bequeath || !connection.includes('@') ? null : connection.slice(connection.indexOf('@') + 1);
  if (bequeath) {
    const probe = createSQLPlusSession(device.getId(), ['/', 'as', 'sysdba'], osContext);
    if (probe.loginOutput.some((line) => /ORA-01031/.test(line))) {
      probe.session.disconnect();
      return [...out, ORACLE_ERRORS.ORA_01031, `Error: ${ORACLE_ERRORS.ORA_01031}`].join('\n');
    }
    probe.session.disconnect();
  }
  const instance = remote === null ? getOracleDatabase(device.getId()).instance : null;
  const connectedTo = instance !== null ? instance.config.sid.toUpperCase() : (remote!.split('/').pop() ?? '').toUpperCase();
  out.push(`Connected to "${connectedTo}"`, 'Connected as SYSDBA.');
  for (const command of commandsOf(args, stdin)) {
    out.push(`DGMGRL> ${command.replace(/;$/, '')}`);
    const started = START_OBSERVER.exec(command.trim());
    if (started !== null) {
      out.push(...launchObserverFor(device, instance, remote, started));
      continue;
    }
    out.push(...(instance !== null ? runBrokerCommand(device, instance, command) : viaDatabase(device, remote!, command)));
  }
  return out.join('\n');
}
