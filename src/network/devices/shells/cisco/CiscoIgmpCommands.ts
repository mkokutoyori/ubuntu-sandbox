import type { CommandSpec } from '@/cli/CommandTable';
import type { ArgumentSpec } from '@/cli/ArgumentTypes';
import type { Router } from '../../Router';
import type { IgmpAgent } from '../../../igmp/IgmpAgent';
import type { IgmpGroupRecord, IgmpInterfaceRuntime } from '../../../igmp/types';
import { isMulticastIpv4, isReservedMulticast, isV1CompatActive, isConfiguredGroup } from '../../../igmp/types';
import { iosInterfaceStatus } from '@/network/devices/inspection/InterfaceStatusView';
import { hms } from '@/lib/format';
import { MODES_INTERFACE } from './CiscoConfigCommands';
import { padToWidth } from '@/network/devices/shells/cli/TextTable';

interface IfCtx {
  selectedPorts(): string[];
  r(): Router;
}

interface ShowCtx {
  r(): Router;
  resolveInterfaceName?(input: string): string | null;
}

function namedInterface(ctx: ShowCtx, input: string | undefined): string | undefined {
  if (!input) return undefined;
  return ctx.resolveInterfaceName?.(input) ?? input;
}

function agent(router: Router): IgmpAgent | undefined {
  return (router as unknown as { getIgmpAgent?: () => IgmpAgent }).getIgmpAgent?.();
}

function expiresIn(rt: IgmpInterfaceRuntime | undefined, g: IgmpGroupRecord, nowMs: number): string {
  // A locally configured membership is held by the running-config, not by
  // a host's Report — IOS prints "never" for it.
  if (isConfiguredGroup(g)) return 'never';
  if (!rt) return '00:00:00';
  const intervalMs = (rt.robustness * rt.queryIntervalSec + Math.ceil(rt.queryResponseIntervalDs / 10)) * 1000;
  const remaining = intervalMs - (nowMs - g.lastReportMs);
  return hms(remaining);
}

/** IGMP lines for one interface in `show running-config`. */
export function igmpInterfaceRunningConfigLines(router: Router, iface: string): string[] {
  const a = agent(router);
  if (!a) return [];
  const lines: string[] = [];
  const rt = a.getInterfaceRuntime(iface);
  if (rt?.enabled && rt.version !== 2) lines.push(` ip igmp version ${rt.version}`);
  for (const { group, origin } of a.listConfiguredGroups(iface)) {
    lines.push(` ip igmp ${origin} ${group}`);
  }
  return lines;
}

const GROUPE_MULTICAST: ArgumentSpec = {
  name: 'groupe', type: 'REST', description: 'Multicast group address',
  alternatives: [{ keyword: 'A.B.C.D', description: 'Multicast group address' }],
};


export function igmpInterfaceSpecs(ctx: IfCtx): CommandSpec[] {
  const base = { modes: MODES_INTERFACE, minPrivilege: 15 };
  const withAgent = (run: (a: IgmpAgent, ports: string[]) => string): string => {
    const a = agent(ctx.r());
    return a ? run(a, ctx.selectedPorts()) : '';
  };
  const version = (args: Record<string, string>): string => withAgent((a, ports) => {
    const v = parseInt(args.version, 10);
    if (v === 3) return '% IGMPv3 is not supported in this simulator (RFC 3376 INCLUDE/EXCLUDE source filtering — out of scope, v1/v2 only)';
    if (v !== 1 && v !== 2) return '% Invalid IGMP version';
    for (const port of ports) a.enableInterface(port, v);
    return '';
  });
  const resetVersion = (): string => withAgent((a, ports) => {
    for (const port of ports) {
      const rt = a.getInterfaceRuntime(port);
      if (rt && rt.enabled) a.enableInterface(port, 2);
    }
    return '';
  });
  const membership = (origin: 'join-group' | 'static-group'): CommandSpec => ({
    ...base, id: `ip-igmp-${origin}`, path: ['ip', 'igmp', origin, GROUPE_MULTICAST],
    description: origin === 'join-group' ? 'Join a multicast group' : 'Statically forward a multicast group',
    undoDescription: 'Remove a configured multicast group',
    run: (_session, args) => withAgent((a, ports) => {
      const group = args.groupe?.trim();
      if (!group) return '% Incomplete command.';
      if (!isMulticastIpv4(group) || isReservedMulticast(group)) return '% Invalid group address';
      for (const port of ports) a.configuredJoin(port, group, origin);
      return '';
    }),
    undo: (_session, args) => withAgent((a, ports) => {
      const group = args.groupe?.trim();
      if (!group) return '% Incomplete command.';
      for (const port of ports) a.configuredLeave(port, group, origin);
      return '';
    }),
  });
  return [
    {
      ...base, id: 'ip-igmp', path: ['ip', 'igmp'], description: 'Enable IGMP',
      undoDescription: 'Disable IGMP',
      run: () => withAgent((a, ports) => {
        for (const port of ports) a.enableInterface(port, 2);
        return '';
      }),
      undo: () => withAgent((a, ports) => {
        for (const port of ports) a.disableInterface(port);
        return '';
      }),
    },
    {
      ...base, id: 'ip-igmp-version',
      path: ['ip', 'igmp', 'version', {
        name: 'version', type: 'REST', description: 'IGMP version to run',
        alternatives: [{ keyword: '<1-3>', description: 'IGMP version number' }],
      }],
      description: 'Set IGMP version', undoDescription: 'Reset IGMP version to default',
      run: (_session, args) => version(args),
      undo: () => resetVersion(),
    },
    {
      ...base, id: 'ip-igmp-version-undo', path: ['ip', 'igmp', 'version'],
      description: 'Set IGMP version', undoDescription: 'Reset IGMP version to default',
      existsOnlyNegated: true,
      run: () => '% Incomplete command.', undo: () => resetVersion(),
    },
    membership('join-group'),
    membership('static-group'),
  ];
}

function showIgmpGroups(ctx: ShowCtx, args: readonly string[]): string {
    const a = agent(ctx.r());
    if (!a) return '';
    const detail = args.includes('detail');
    const ifIdx = args.findIndex((x) => x.toLowerCase() === 'interface');
    const premier = args[0] && args[0].toLowerCase() !== 'detail'
      && args[0].toLowerCase() !== 'interface' ? args[0] : undefined;
    const groupe = premier && /^\d+\.\d+\.\d+\.\d+$/.test(premier) ? premier : undefined;
    const iface = ifIdx >= 0
      ? namedInterface(ctx, args[ifIdx + 1])
      : (groupe ? undefined : namedInterface(ctx, premier));
    const groups = (iface ? a.groupsFor(iface) : a.listGroups())
      .filter((g) => !groupe || g.groupAddress === groupe);
    const now = a.nowMs();
    if (detail) {
      const blocks: string[] = [];
      for (const g of groups) {
        const rt = a.getInterfaceRuntime(g.iface);
        blocks.push([
          `Interface:\t\t${g.iface}`,
          `Group:\t\t\t${g.groupAddress}`,
          `Uptime:\t\t\t${hms(now - g.lastReportMs)}`,
          `Group mode:\t\tIGMPv${isV1CompatActive(g, now) ? 1 : (rt?.version ?? 2)}`,
          `Last reporter:\t\t${g.lastReporterIp ?? ''}`,
          `Source list is empty`,
        ].join('\n'));
      }
      return blocks.join('\n\n');
    }
    const rows = ['IGMP Connected Group Membership',
      'Group Address    Interface                Uptime    Expires   Last Reporter'];
    for (const g of groups) {
      const rt = a.getInterfaceRuntime(g.iface);
      rows.push(
        `${padToWidth(g.groupAddress, 17)}${padToWidth(g.iface, 25)}${padToWidth(hms(now - g.lastReportMs), 10)}${padToWidth(expiresIn(rt, g, now), 10)}${g.lastReporterIp ?? ''}`);
    }
    return rows.join('\n');
}

function showIgmpInterface(ctx: ShowCtx, args: readonly string[]): string {
    const a = agent(ctx.r());
    const r = ctx.r();
    if (!a) return '';
    const requested = namedInterface(ctx, args[0]);
    const ifaces = requested
      ? [requested]
      : Array.from(a.getConfig().interfaces.keys());
    const lines: string[] = [];
    for (const ifaceName of ifaces) {
      const rt = a.getInterfaceRuntime(ifaceName);
      if (!rt) continue;
      const ports = r._getPortsInternal();
      const port = ports.get(ifaceName) ?? r.getPort(ifaceName);
      const st = port
        ? iosInterfaceStatus(port, ifaceName, ports)
        : { status: 'up' as const, protocol: 'up' as const };
      const up = st.protocol === 'up';
      const ip = port?.getIPAddress();
      const mask = port?.getSubnetMask();
      lines.push(`${ifaceName} is ${st.status}, line protocol is ${st.protocol}`);
      if (ip) lines.push(`  Internet address is ${ip.toString()}/${mask ? mask.toCIDR() : 24}`);
      lines.push(`  IGMP is ${rt.enabled ? 'enabled' : 'disabled'} on interface`);
      lines.push(`  Current IGMP host version is ${rt.version}`);
      lines.push(`  Current IGMP router version is ${rt.version}`);
      lines.push(`  IGMP query interval is ${rt.queryIntervalSec} seconds`);
      lines.push(`  IGMP querier timeout is ${rt.otherQuerierPresentSec} seconds`);
      lines.push(`  IGMP max query response time is ${Math.round(rt.queryResponseIntervalDs / 10)} seconds`);
      lines.push(`  Last member query count is ${rt.lastMemberQueryCount}`);
      lines.push(`  Last member query response interval is ${rt.lastMemberQueryIntervalDs * 100} ms`);
      lines.push(`  Inbound IGMP access group is not set`);
      const groups = a.groupsFor(ifaceName);
      lines.push(`  IGMP activity: ${groups.length} joins, 0 leaves`);
      const myIp = ip?.toString();
      if (rt.querierIp && up) {
        lines.push(`  IGMP querying router is ${rt.querierIp}${rt.querierIp === myIp ? ' (this system)' : ''}`);
      }
      lines.push('');
    }
    while (lines.length && lines[lines.length - 1] === '') lines.pop();
    if (lines.length > 0) {
      lines.push('');

    }
    return lines.join('\n');
}

const IGMP_SHOW_ARGUMENTS: Readonly<Record<string, [string, string]>> = {
  'show ip igmp groups': ['A.B.C.D', 'Multicast group address'],
  'show ip igmp interface': ['WORD', 'Interface name'],
};

const IGMP_SHOW_KEYWORDS:
Readonly<Record<string, ReadonlyArray<{ keyword: string; description: string }>>> = {
  'show ip igmp groups': [{ keyword: 'detail', description: 'Detailed output' }],
};

export function igmpShowSpecs(ctx: ShowCtx): CommandSpec[] {
  const base = { modes: ['user', 'privileged'], minPrivilege: 1 };
  const words = (value: string | undefined): string[] =>
    (value ?? '').trim().split(/\s+/).filter(Boolean);
  return [
    {
      ...base, id: 'show-ip-igmp-groups',
      path: ['show', 'ip', 'igmp', 'groups', {
        name: 'selection', type: 'REST', optional: true, literal: 'A.B.C.D',
        description: 'Multicast group address',
        alternatives: [{ keyword: 'detail', description: 'Detailed output' }],
      }],
      description: 'Display IGMP group membership',
      run: (_session, args) => showIgmpGroups(ctx, words(args.selection)),
    },
    {
      ...base, id: 'show-ip-igmp-interface',
      path: ['show', 'ip', 'igmp', 'interface', {
        name: 'interface', type: 'REST', optional: true, literal: 'WORD', description: 'Interface name',
      }],
      description: 'Display IGMP interface state',
      run: (_session, args) => showIgmpInterface(ctx, words(args.interface)),
    },
  ];
}
