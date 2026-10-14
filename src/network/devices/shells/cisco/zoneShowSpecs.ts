import { simulationNowMs } from '@/network/core/SystemClock';
import type { ArgumentSpec } from '@/cli/ArgumentTypes';
import type { CommandSpec } from '@/cli/CommandTable';
import { CliInvalidInput } from '../cli/CliDiagnostic';
import type { CiscoSecurityConfig, PolicyMapClass, ZonePair } from '../../router/security/CiscoSecurityConfig';
import type { ZoneSession } from '../../router/security/ZoneFirewall';

export interface ZoneShowHost {
  security(): CiscoSecurityConfig;
}

const EXEC = ['user', 'privileged'] as const;
const PRIVILEGED = ['privileged'] as const;

const ZONE: ArgumentSpec = { name: 'zone', type: 'WORD', optional: true, description: 'Security zone name' };
const PAIR_NAME: ArgumentSpec = { name: 'pair', type: 'WORD', optional: true, description: 'Zone-pair name' };
const SESSIONS: ArgumentSpec = {
  name: 'sessions', type: 'ENUM', optional: true,
  values: [{ keyword: 'sessions', description: 'Inspect sessions of the zone-pair' }],
};

function clock(milliseconds: number): string {
  const total = Math.max(0, Math.floor(milliseconds / 1000));
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(Math.floor(total / 3600))}:${pad(Math.floor((total % 3600) / 60))}:${pad(total % 60)}`;
}

export function renderZones(host: ZoneShowHost, name: string | undefined): string {
  const sec = host.security();
  if (name !== undefined && name !== 'self' && !sec.zones.has(name)) throw new CliInvalidInput({ token: name });
  const blocks: string[] = [];
  if (name === undefined || name === 'self') blocks.push('zone self\n  Description: System defined zone');
  for (const zone of sec.zones.values()) {
    if (name !== undefined && zone.name !== name) continue;
    const description = (zone as unknown as { description?: string }).description;
    const members = [...sec.interfaceFlags.entries()].filter(([, flags]) => flags.zoneMember === zone.name).map(([iface]) => iface);
    blocks.push([
      `zone ${zone.name}`,
      ...(description ? [`  Description: ${description}`] : []),
      ...(members.length > 0 ? ['  Member Interfaces:', ...members.map((iface) => `    ${iface}`)] : []),
    ].join('\n'));
  }
  return blocks.join('\n\n');
}

export function renderZonePairs(host: ZoneShowHost, source?: string, destination?: string): string {
  return [...host.security().zonePairs.values()]
    .filter((pair) => (source === undefined || pair.source === source) && (destination === undefined || pair.destination === destination))
    .map((pair) => [
      `Zone-pair name ${pair.name}`,
      `    Source-Zone ${pair.source}  Destination-Zone ${pair.destination} `,
      ...(pair.servicePolicy ? [`    service-policy ${pair.servicePolicy}`] : []),
    ].join('\n')).join('\n\n');
}

function matchLines(sec: CiscoSecurityConfig, cls: PolicyMapClass): string[] {
  if (cls.kind === 'class-default') return ['      Match: any'];
  const map = sec.classMaps.get(cls.className);
  return (map?.matches ?? []).map((match) => {
    if (match.kind === 'any') return '      Match: any';
    if (match.kind === 'protocol') return `      Match: protocol ${match.value}`;
    return `      Match: access-group ${match.kind === 'access-group-name' ? `name ${match.value}` : match.value}`;
  });
}

function sessionLines(session: ZoneSession, now: number): string[] {
  return [
    `        Session ${session.id.toString(16).toUpperCase().padStart(7, '0')} (${session.initiator}:${session.initiatorPort})=>(${session.responder}:${session.responderPort}) ${protocolName(session.protocol)} ${session.state}`,
    `          Created ${clock(now - session.createdMs)}, Last heard ${clock(now - session.lastHeardMs)}`,
    `          Bytes sent (initiator:responder) [${session.initiatorBytes}:${session.responderBytes}]`,
  ];
}

function protocolName(protocol: number): string {
  return protocol === 6 ? 'tcp' : protocol === 17 ? 'udp' : protocol === 1 ? 'icmp' : `ip-${protocol}`;
}

function pairBlock(host: ZoneShowHost, pair: ZonePair, withSessions: boolean): string[] {
  const sec = host.security();
  const firewall = sec.zoneFirewall;
  const now = simulationNowMs();
  const lines = [`Zone-pair: ${pair.name}`, ''];
  const policy = pair.servicePolicy ? sec.policyMaps.get(pair.servicePolicy) : undefined;
  if (!policy) return [...lines, '  Service-policy inspect : (none)'];
  lines.push(`  Service-policy inspect : ${policy.name}`, '');
  const sessions = firewall.sessionList(pair.name);
  for (const cls of policy.classes) {
    const map = cls.kind === 'class-default' ? undefined : sec.classMaps.get(cls.className);
    lines.push(`    Class-map: ${cls.className} (${cls.kind === 'class-default' || map?.matchAll !== true ? 'match-any' : 'match-all'})`);
    lines.push(...matchLines(sec, cls));
    const counter = firewall.counterOf(pair.name, cls.className);
    const action = cls.actions.find((a) => a.kind === 'inspect' || a.kind === 'pass' || a.kind === 'drop');
    if (action?.kind === 'inspect') {
      const mine = sessions.filter((s) => s.className === cls.className);
      const estab = mine.filter((s) => s.state === 'SIS_OPEN').length;
      const half = mine.filter((s) => s.state === 'SIS_OPENING').length;
      const ending = mine.filter((s) => s.state === 'SIS_CLOSING').length;
      lines.push('      Inspect',
        `        Session creations since subsystem startup or last reset ${counter.sessionsCreated}`,
        `        Current session counts (estab/half-open/terminating) [${estab}:${half}:${ending}]`,
        `        Maxever session counts (estab/half-open/terminating) [${counter.peakEstablished}:0:0]`,
        `        Last session created ${counter.lastSessionMs === null ? 'never' : clock(now - counter.lastSessionMs)}`,
        `        Last statistic reset ${counter.resetMs === null ? 'never' : clock(now - counter.resetMs)}`,
        `        Last session creation rate ${firewall.creationRate(counter)}`,
        `        half-open session total ${half}`);
      if (withSessions) {
        lines.push(`        Number of Established Sessions = ${mine.length}`, '        Established Sessions');
        for (const session of mine) lines.push(...sessionLines(session, now));
      }
    } else {
      lines.push(action?.kind === 'pass' ? '      Pass' : '      Drop',
        `        ${counter.matchedPackets} packets, ${counter.matchedBytes} bytes`);
    }
    lines.push('');
  }
  return lines;
}

export function renderPolicyMapZonePairs(host: ZoneShowHost, name: string | undefined, sessions: boolean): string {
  const sec = host.security();
  const pairs = [...sec.zonePairs.values()].filter((pair) => name === undefined || pair.name === name);
  if (name !== undefined && pairs.length === 0) throw new CliInvalidInput({ token: name });
  const lines: string[] = [];
  for (const pair of pairs) lines.push(...pairBlock(host, pair, sessions));
  return lines.join('\n').trimEnd();
}

export function zoneShowSpecs(host: () => ZoneShowHost): CommandSpec[] {
  return [
    {
      id: 'show-zone-security',
      path: ['show', 'zone', 'security', ZONE],
      description: 'Display zone security information',
      modes: EXEC, minPrivilege: 1,
      run: (_session, args) => renderZones(host(), args.zone),
    },
    {
      id: 'show-zone-pair-security',
      path: ['show', 'zone-pair', 'security'],
      description: 'Display the zone-pairs and their policy',
      modes: PRIVILEGED, minPrivilege: 15,
      options: [
        { keyword: 'source', description: 'Source zone', argument: { name: 'source', type: 'WORD', description: 'Source zone name' } },
        { keyword: 'destination', description: 'Destination zone', argument: { name: 'destination', type: 'WORD', description: 'Destination zone name' } },
      ],
      run: (_session, args) => renderZonePairs(host(), args.source, args.destination),
    },
    {
      id: 'show-policy-map-type-inspect-zone-pair',
      path: ['show', 'policy-map', 'type', 'inspect', 'zone-pair', PAIR_NAME, SESSIONS],
      description: 'Display the runtime statistics of the inspect policies',
      modes: PRIVILEGED, minPrivilege: 15,
      run: (_session, args) => {
        const asSessions = args.sessions === 'sessions' || args.pair === 'sessions';
        const name = args.pair === 'sessions' ? undefined : args.pair;
        return renderPolicyMapZonePairs(host(), name, asSessions);
      },
    },
    ...(['', 'named'] as const).flatMap((variant) => (['counter', 'inspect-session'] as const).map((what): CommandSpec => ({
      id: `clear-zone-pair-${what}${variant === 'named' ? '-named' : ''}`,
      path: ['clear', 'zone-pair',
        ...(variant === 'named' ? [{ name: 'pair', type: 'WORD', description: 'Zone-pair name' } as ArgumentSpec] : []),
        ...(what === 'counter' ? ['counter'] : ['inspect', 'session'])],
      description: what === 'counter' ? 'Clear the policy-map counters' : 'Delete the inspect sessions',
      modes: PRIVILEGED, minPrivilege: 15,
      run: (_session, args) => {
        const firewall = host().security().zoneFirewall;
        if (args.pair !== undefined && !host().security().zonePairs.has(args.pair)) throw new CliInvalidInput({ token: args.pair });
        if (what === 'counter') firewall.clearCounters(args.pair);
        else firewall.clearSessions(args.pair);
        return '';
      },
    }))),
  ];
}
