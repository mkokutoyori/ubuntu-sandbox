import type { HostCapableDevice } from '@/network';
import type { OsSecurityContext } from '@/database/oracle/security/types';
import type { OracleInstance } from '@/database/oracle/OracleInstance';
import { StandbyDatabase, type ProtectionMode } from '@/database/oracle/dataguard/DataGuardConfiguration';
import { readArchiveDestinations } from '@/database/oracle/dataguard/ArchiveDestination';
import { OracleNetCallStatus } from '@/network/oracle-net/wire/OracleNetCall';
import { executeOverOracleNet, logonOverOracleNet } from '@/network/oracle-net/OracleNetSqlClient';
import { resolveOracleConnectTarget } from './oracleNet';
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

interface BrokerState {
  created: boolean;
  enabled: boolean;
  members: Map<string, { identifier: string; logXptMode: 'SYNC' | 'ASYNC' }>;
}

const brokers = new Map<string, BrokerState>();

function stateOf(instance: OracleInstance): BrokerState {
  const key = instance.config.sid.toUpperCase() + ':' + instance.getDbId();
  let state = brokers.get(key);
  if (state === undefined) {
    state = { created: false, enabled: false, members: new Map() };
    brokers.set(key, state);
  }
  return state;
}

export function __resetBrokers(): void { brokers.clear(); }

const unquote = (text: string): string => text.trim().replace(/^['"]|['"]$/g, '');

function remoteExecute(local: HostCapableDevice, identifier: string, statements: readonly string[]): { ok: true; outputs: string[] } | { ok: false; error: string } {
  const resolved = resolveOracleConnectTarget(local, identifier, getOracleDatabase);
  if (resolved.ok === false) return { ok: false, error: resolved.error };
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

function showConfiguration(instance: OracleInstance, state: BrokerState): string[] {
  const dg = instance.dataGuard;
  const primary = instance.config.sid.toUpperCase();
  const lines = ['', `Configuration - ${dg.configurationName.toLowerCase()}`, '', `  Protection Mode: ${PROTECTION_LABEL[instance.protectionMode]}`, '  Members:'];
  lines.push(`  ${primary} - ${roleLabel(instance.databaseRole)}`);
  for (const name of state.members.keys()) lines.push(`    ${name} - ${roleLabel('PHYSICAL STANDBY')}`);
  const failing = [...state.members.keys()].some((name) => {
    const dest = readArchiveDestinations(instance.getAllParameters()).find((d) => d.kind === 'SERVICE' && (d.dbUniqueName ?? d.target) === name);
    return dest !== undefined && instance.getTransportState(dest.destId)?.status === 'ERROR';
  });
  lines.push('', 'Fast-Start Failover:  Disabled', '', 'Configuration Status:');
  if (!state.enabled) lines.push('DISABLED');
  else if (failing) lines.push('ORA-16778: redo transport error for one or more members', 'ERROR');
  else lines.push('SUCCESS   (status updated 0 seconds ago)');
  return lines;
}

function showDatabase(instance: OracleInstance, state: BrokerState, name: string): string[] {
  const primary = instance.config.sid.toUpperCase();
  const member = state.members.get(name);
  if (name !== primary && member === undefined) return [`ORA-16541: member is not enabled`];
  const role = name === primary ? instance.databaseRole : 'PHYSICAL STANDBY';
  const lines = ['', `Database - ${name}`, '', `  Role:               ${role}`];
  lines.push(`  Intended State:     ${role === 'PRIMARY' ? 'TRANSPORT-ON' : 'APPLY-ON'}`);
  if (role !== 'PRIMARY') {
    lines.push('  Transport Lag:      0 seconds (computed 0 seconds ago)', '  Apply Lag:          0 seconds (computed 0 seconds ago)');
    lines.push(`  Log Transport Mode: ${member?.logXptMode ?? 'ASYNC'}`);
  }
  lines.push('  Instance(s):', `    ${primary}`, '', 'Database Status:', state.enabled ? 'SUCCESS' : 'DISABLED');
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
    if (state.created) return ['Error: ORA-16603: detected configuration already exists'];
    const primary = unquote(create[2]).toUpperCase();
    if (primary !== instance.config.sid.toUpperCase()) return [`Error: ORA-16642: DB_UNIQUE_NAME mismatch`];
    state.created = true;
    instance.dataGuard.configurationName = unquote(create[1]).toUpperCase();
    return [`Configuration "${unquote(create[1]).toLowerCase()}" created with primary database "${primary}"`];
  }
  if (!/^(CREATE|ADD|ENABLE|DISABLE|REMOVE|SHOW|EDIT|SWITCHOVER|FAILOVER)\b/.test(upper)) return [`DGM-16905: syntax error at or near "${text.split(/\s+/)[0]}"`];
  if (upper.startsWith('CREATE ')) return [`DGM-16905: syntax error`];
  const failover = /^FAILOVER\s+TO\s+('[^']*'|"[^"]*"|\S+)$/i.exec(text);
  if (failover) {
    const target = unquote(failover[1]).toUpperCase();
    if (instance.databaseRole !== 'PHYSICAL STANDBY') return ['Error: ORA-16652: Fast-Start Failover target standby not found'];
    const answer = instance.failover();
    if (answer !== 'Database altered.') return ['Performing failover NOW, please wait...', `Error: ${answer}`];
    return ['Performing failover NOW, please wait...', `Failover succeeded, new primary is "${target}"`];
  }
  if (!state.created) return ['ORA-16532: Oracle Data Guard broker configuration does not exist'];
  const add = /^ADD\s+DATABASE\s+('[^']*'|"[^"]*"|\S+)\s+AS\s+CONNECT\s+IDENTIFIER\s+IS\s+(\S+)(?:\s+MAINTAINED\s+AS\s+PHYSICAL)?$/i.exec(text);
  if (add) {
    const name = unquote(add[1]).toUpperCase();
    if (state.members.has(name)) return [`Error: ORA-16698: member has a LOG_ARCHIVE_DEST_n parameter setting conflict`];
    state.members.set(name, { identifier: add[2], logXptMode: 'ASYNC' });
    instance.dataGuard.addStandby(new StandbyDatabase({ dbUniqueName: name, host: add[2], role: 'PHYSICAL STANDBY' }));
    if (state.enabled) destinationFor(instance, name, add[2], 'ASYNC');
    return [`Database "${name}" added`];
  }
  if (upper === 'ENABLE CONFIGURATION') {
    if (state.members.size === 0) return ['Error: ORA-16626: failed to enable specified member'];
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
    if (!state.members.delete(name)) return [`Error: ORA-16541: member is not enabled`];
    instance.dataGuard.removeStandby(name);
    return [`Succeeded.`];
  }
  if (upper === 'SHOW CONFIGURATION' || upper === 'SHOW CONFIGURATION VERBOSE') return showConfiguration(instance, state);
  const show = /^SHOW\s+DATABASE\s+(?:VERBOSE\s+)?('[^']*'|"[^"]*"|\S+)$/i.exec(text);
  if (show) return showDatabase(instance, state, unquote(show[1]).toUpperCase());
  const edit = /^EDIT\s+DATABASE\s+('[^']*'|"[^"]*"|\S+)\s+SET\s+PROPERTY\s+LogXptMode\s*=\s*('[^']*'|"[^"]*"|\S+)$/i.exec(text);
  if (edit) {
    const name = unquote(edit[1]).toUpperCase();
    const member = state.members.get(name);
    if (member === undefined) return [`Error: ORA-16541: member is not enabled`];
    const mode = unquote(edit[2]).toUpperCase();
    if (mode !== 'SYNC' && mode !== 'ASYNC') return [`Error: ORA-16596: property value is invalid`];
    member.logXptMode = mode;
    if (state.enabled) destinationFor(instance, name, member.identifier, mode);
    return ['Property "logxptmode" updated'];
  }
  const protection = /^EDIT\s+CONFIGURATION\s+SET\s+PROTECTION\s+MODE\s+AS\s+(\w+)$/i.exec(text);
  if (protection) {
    const mode = PROTECTION_WORDS[protection[1].toUpperCase()];
    if (mode === undefined) return ['Error: ORA-16596: property value is invalid'];
    const answer = instance.setProtectionMode(mode);
    if (answer === 'Database altered.') return ['Succeeded.'];
    if (/ORA-16072/.test(answer)) return ['Error: ORA-16627: operation disallowed since no standby databases would remain to support protection mode'];
    return [`Error: ${answer}`];
  }
  const switchover = /^SWITCHOVER\s+TO\s+('[^']*'|"[^"]*"|\S+)$/i.exec(text);
  if (switchover) {
    const target = unquote(switchover[1]).toUpperCase();
    if (!state.members.has(target)) return [`Error: ORA-16642: DB_UNIQUE_NAME mismatch`];
    const answer = instance.requestSwitchover(target);
    if (answer !== 'Database altered.') return ['Performing switchover NOW, please wait...', `Error: ${answer}`];
    return ['Performing switchover NOW, please wait...', `New primary database "${target}" is opening...`, `Switchover succeeded, new primary is "${target}"`];
  }
  return [`DGM-16905: syntax error at or near "${text.split(/\s+/)[0]}"`];
}

function commandsOf(args: readonly string[], stdin: string | undefined): string[] {
  const fromArgs = args.filter((a) => !a.startsWith('-')).slice(1);
  const fromStdin = (stdin ?? '').split('\n').map((line) => line.trim()).filter((line) => line !== '');
  return [...fromArgs, ...fromStdin];
}

export function runDgmgrl(device: HostCapableDevice, args: readonly string[], stdin: string | undefined, osContext: OsSecurityContext): string {
  const options = args.filter((a) => a.startsWith('-'));
  const silent = options.includes('-silent');
  const connection = args.find((a) => !a.startsWith('-')) ?? '/';
  const out: string[] = [];
  if (!silent) {
    out.push('', 'DGMGRL for Linux: Release 19.0.0.0.0 - Production', '', 'Copyright (c) 1982, 2019, Oracle and/or its affiliates.  All rights reserved.', '', 'Welcome to DGMGRL, type "help" for information.');
  }
  const database = getOracleDatabase(device.getId());
  const bequeath = connection === '/' || connection.startsWith('/@');
  if (bequeath) {
    const probe = createSQLPlusSession(device.getId(), ['/', 'as', 'sysdba'], osContext);
    if (probe.loginOutput.some((line) => /ORA-01031/.test(line))) {
      probe.session.disconnect();
      return [...out, 'ORA-01031: insufficient privileges', 'Error: ORA-01031: insufficient privileges'].join('\n');
    }
    probe.session.disconnect();
  }
  const instance = database.instance;
  out.push(`Connected to "${instance.config.sid.toUpperCase()}"`, 'Connected as SYSDBA.');
  const state = stateOf(instance);
  for (const command of commandsOf(args, stdin)) {
    out.push(`DGMGRL> ${command.replace(/;$/, '')}`);
    out.push(...execute(device, instance, state, command));
  }
  return out.join('\n');
}
