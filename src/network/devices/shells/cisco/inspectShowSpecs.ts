import { simulationNowMs } from '@/network/core/SystemClock';
import type { ArgumentSpec } from '@/cli/ArgumentTypes';
import type { CommandSpec } from '@/cli/CommandTable';
import { CliInvalidInput } from '../cli/CliDiagnostic';
import type { CiscoSecurityConfig } from '../../router/security/CiscoSecurityConfig';
import type { InspectProtocolOptions, InspectRule } from '../../router/security/CbacFirewall';
import { INSPECT_PROTOCOLS, IP_TCP, IP_UDP, type FlowSession } from '../../router/security/FlowTable';

export interface InspectShowHost {
  security(): CiscoSecurityConfig;
  interfaceAcl(iface: string, direction: 'in' | 'out'): string | null;
  interfaceNames(): string[];
}

const EXEC = ['user', 'privileged'] as const;
const PRIVILEGED = ['privileged'] as const;

const RULE_NAME: ArgumentSpec = { name: 'name', type: 'WORD', description: 'Inspection rule name' };
const DETAIL: ArgumentSpec = {
  name: 'detail', type: 'ENUM', optional: true,
  values: [{ keyword: 'detail', description: 'Show the byte counts and the clock of each session' }],
};
const SESSION_ADDRESS: ArgumentSpec = {
  name: 'address', type: 'WORD', optional: true, description: 'Session address (0-FFFFFFFF)',
};

function clock(milliseconds: number): string {
  const total = Math.max(0, Math.floor(milliseconds / 1000));
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(Math.floor(total / 3600))}:${pad(Math.floor((total % 3600) / 60))}:${pad(total % 60)}`;
}

function elapsed(milliseconds: number | null): string {
  if (milliseconds === null) return 'never';
  const total = Math.floor(milliseconds / 1000);
  if (total >= 86400) return `${Math.floor(total / 86400)}d${Math.floor((total % 86400) / 3600)}h`;
  return clock(milliseconds);
}

function timeoutOf(sec: CiscoSecurityConfig, keyword: string, options: InspectProtocolOptions): number {
  if (options.timeoutSec !== undefined) return options.timeoutSec;
  const settings = sec.inspectSettings;
  const definitions = INSPECT_PROTOCOLS[keyword] ?? [];
  if (keyword === 'dns') return settings.dnsTimeoutSec;
  if (keyword === 'icmp') return 10;
  return definitions.every((definition) => definition.protocol === IP_UDP) ? settings.udpIdleSec
    : definitions.some((definition) => definition.protocol === IP_TCP) ? settings.tcpIdleSec : settings.udpIdleSec;
}

function protocolLines(sec: CiscoSecurityConfig, rule: InspectRule, indent: string): string[] {
  const settings = sec.inspectSettings;
  return [...rule.protocols].map(([keyword, options]) => {
    const alert = options.alert ?? !settings.alertOff;
    const audit = options.auditTrail ?? settings.auditTrail;
    return `${indent}${keyword} alert is ${alert ? 'on' : 'off'} audit-trail is ${audit ? 'on' : 'off'} timeout ${timeoutOf(sec, keyword, options)}`;
  });
}

function ruleBlock(sec: CiscoSecurityConfig, rule: InspectRule): string[] {
  return [` Inspection name ${rule.name}`,
    ...(rule.maxSessions !== undefined ? [`    Maximum number of sessions per interface: ${rule.maxSessions}`] : []),
    ...protocolLines(sec, rule, '    ')];
}

export function renderInspectConfig(sec: CiscoSecurityConfig): string {
  const s = sec.inspectSettings;
  const lines = [
    `Session audit trail is ${s.auditTrail ? 'enabled' : 'disabled'}`,
    `one-minute (sampling period) thresholds are [${s.oneMinuteLow}:${s.oneMinuteHigh}] connections`,
    `max-incomplete sessions thresholds are [${s.maxIncompleteLow}:${s.maxIncompleteHigh}]`,
    `max-incomplete tcp connections per host is ${s.hostMaxIncomplete}. Block-time ${s.hostBlockMinutes} minute.`,
    `tcp synwait-time is ${s.tcpSynwaitSec} sec -- tcp finwait-time is ${s.tcpFinwaitSec} sec`,
    `tcp idle-time is ${s.tcpIdleSec} sec -- udp idle-time is ${s.udpIdleSec} sec`,
    `dns-timeout is ${s.dnsTimeoutSec} sec`,
  ];
  if (sec.inspectRules.size > 0) {
    lines.push('Inspection Rule Configuration');
    for (const rule of sec.inspectRules.values()) lines.push(...ruleBlock(sec, rule));
  }
  return lines.join('\n');
}

export function renderInspectInterfaces(host: InspectShowHost): string {
  const sec = host.security();
  const lines = ['Interface Configuration'];
  for (const iface of host.interfaceNames()) {
    const flags = sec.interfaceFlags.get(iface);
    if (!flags?.inspectIn && !flags?.inspectOut) continue;
    lines.push(` Interface ${iface}`);
    for (const [label, name] of [['Inbound', flags.inspectIn], ['Outgoing', flags.inspectOut]] as const) {
      const rule = name === undefined ? undefined : sec.inspectRules.get(name);
      lines.push(name === undefined ? `  ${label} inspection rule is not set` : `  ${label} inspection rule is ${name}`);
      if (rule) lines.push(...protocolLines(sec, rule, '    '));
    }
    lines.push(`  Inbound access list is ${host.interfaceAcl(iface, 'in') ?? 'not set'}`,
      `  Outgoing access list is ${host.interfaceAcl(iface, 'out') ?? 'not set'}`);
  }
  return lines.join('\n');
}

function sessionLines(session: FlowSession, now: number, detail: boolean): string[] {
  const lines = [
    `Session ${session.id.toString(16).toUpperCase().padStart(7, '0')} (${session.initiator}:${session.initiatorPort})=>(${session.responder}:${session.responderPort}) ${session.label} ${session.state}`,
  ];
  if (detail) {
    lines.push(`Created ${clock(now - session.createdMs)}, Last heard ${clock(now - session.lastHeardMs)}`,
      `Bytes sent (initiator:responder) [${session.initiatorBytes}:${session.responderBytes}]`);
  }
  return lines;
}

export function renderInspectSessions(sec: CiscoSecurityConfig, detail: boolean): string {
  const now = simulationNowMs();
  const sessions = sec.cbac.sessionList();
  const lines: string[] = [];
  const established = sessions.filter((s) => s.state !== 'SIS_OPENING');
  const half = sessions.filter((s) => s.state === 'SIS_OPENING');
  if (established.length > 0) {
    lines.push('Established Sessions');
    for (const session of established) lines.push(...sessionLines(session, now, detail));
  }
  if (half.length > 0) {
    lines.push('Half-open Sessions');
    for (const session of half) lines.push(...sessionLines(session, now, detail));
  }
  return lines.join('\n');
}

export function renderInspectStatistics(sec: CiscoSecurityConfig): string {
  const view = sec.cbac.statisticsView();
  const now = simulationNowMs();
  const lines = ['Packet inspection statistics [process switch:fast switch]'];
  for (const [keyword, count] of view.packetsByProtocol) lines.push(`${keyword} packets: [${count}:0]`);
  lines.push(
    `Interfaces configured for inspection ${[...sec.interfaceFlags.values()].filter((f) => f.inspectIn || f.inspectOut).length}`,
    `Session creations since subsystem startup or last reset ${view.created}`,
    `Current session counts (estab/half-open/terminating) [${view.current.open}:${view.current.half}:${view.current.closing}]`,
    `Maxever session counts (estab/half-open/terminating) [${view.maxEstablished}:${view.maxHalfOpen}:${view.maxTerminating}]`,
    `Last session created ${elapsed(view.lastCreatedMs === null ? null : now - view.lastCreatedMs)}`,
    `Last statistic reset ${elapsed(view.resetMs === null ? null : now - view.resetMs)}`,
    `Last session creation rate ${view.rate}`,
    `Last half-open session total ${view.current.half}`);
  return lines.join('\n');
}

export function inspectShowSpecs(host: () => InspectShowHost): CommandSpec[] {
  const sec = () => host().security();
  return [
    {
      id: 'show-ip-inspect-name',
      path: ['show', 'ip', 'inspect', 'name', RULE_NAME],
      description: 'Show one set of inspection rules',
      modes: EXEC, minPrivilege: 1,
      run: (_session, args) => {
        const rule = sec().inspectRules.get(args.name);
        if (!rule) throw new CliInvalidInput({ token: args.name });
        return ['Inspection Rule Configuration', ...ruleBlock(sec(), rule)].join('\n');
      },
    },
    {
      id: 'show-ip-inspect-config',
      path: ['show', 'ip', 'inspect', 'config'],
      description: 'Show the CBAC configuration',
      modes: EXEC, minPrivilege: 1,
      run: () => renderInspectConfig(sec()),
    },
    {
      id: 'show-ip-inspect-interfaces',
      path: ['show', 'ip', 'inspect', 'interfaces'],
      description: 'Show the interfaces carrying an inspection rule',
      modes: EXEC, minPrivilege: 1,
      run: () => renderInspectInterfaces(host()),
    },
    {
      id: 'show-ip-inspect-sessions',
      path: ['show', 'ip', 'inspect', 'sessions', DETAIL],
      description: 'Show the existing inspection sessions',
      modes: EXEC, minPrivilege: 1,
      run: (_session, args) => renderInspectSessions(sec(), args.detail === 'detail'),
    },
    {
      id: 'show-ip-inspect-statistics',
      path: ['show', 'ip', 'inspect', 'statistics'],
      description: 'Show the inspection statistics',
      modes: EXEC, minPrivilege: 1,
      run: () => renderInspectStatistics(sec()),
    },
    {
      id: 'show-ip-inspect-all',
      path: ['show', 'ip', 'inspect', 'all'],
      description: 'Show the configuration, the interfaces and the sessions',
      modes: EXEC, minPrivilege: 1,
      run: () => [renderInspectConfig(sec()), renderInspectInterfaces(host()), renderInspectSessions(sec(), false)]
        .filter((block) => block !== '').join('\n'),
    },
    {
      id: 'clear-ip-inspect-session',
      path: ['clear', 'ip', 'inspect', 'session', SESSION_ADDRESS],
      description: 'Delete the inspection sessions',
      modes: PRIVILEGED, minPrivilege: 15,
      run: (_session, args) => {
        if (args.address === undefined) {
          sec().cbac.clearSessions();
          return '';
        }
        if (!/^[0-9a-fA-F]{1,8}$/.test(args.address)) throw new CliInvalidInput({ token: args.address });
        const id = parseInt(args.address, 16);
        if (!sec().cbac.sessionList().some((s) => s.id === id)) throw new CliInvalidInput({ token: args.address });
        sec().cbac.clearSessions(id);
        return '';
      },
    },
    {
      id: 'clear-ip-inspect-statistics',
      path: ['clear', 'ip', 'inspect', 'statistics'],
      description: 'Reset the inspection statistics',
      modes: PRIVILEGED, minPrivilege: 15,
      run: () => { sec().cbac.clearStatistics(); return ''; },
    },
  ];
}
