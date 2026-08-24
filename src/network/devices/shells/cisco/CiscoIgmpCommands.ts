import type { CommandTrie } from '../CommandTrie';
import type { CommandSpec } from '@/cli/CommandTable';
import type { ArgumentSpec } from '@/cli/ArgumentTypes';
import { specsFromTrieRegistrations } from '@/cli/commands/trieAdapter';
import type { Router } from '../../Router';
import type { IgmpAgent } from '../../../igmp/IgmpAgent';
import type { IgmpGroupRecord, IgmpInterfaceRuntime } from '../../../igmp/types';
import { isMulticastIpv4, isReservedMulticast, isV1CompatActive, isConfiguredGroup } from '../../../igmp/types';
import { iosInterfaceStatus } from '@/network/devices/inspection/InterfaceStatusView';
import { hms } from '@/lib/format';
import { MODES_INTERFACE } from './CiscoConfigCommands';

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

const IGMP_ARGUMENTS:
Readonly<Record<string, ArgumentSpec | readonly ArgumentSpec[] | null>> = {
  /*
   * Pas d'enumeration {1, 2} : IGMPv3 a son propre message, qui NOMME
   * ce qui n'est pas modelise (le filtrage par source de la RFC 3376).
   * Une place enumeree le remplacerait par un caret nu, c'est-a-dire
   * une information par une absence d'information.
   */
  'ip igmp version': {
    name: 'version', type: 'REST', description: 'IGMP version to run',
    alternatives: [{ keyword: '<1-3>', description: 'IGMP version number' }],
  },
  'ip igmp join-group': GROUPE_MULTICAST,
  'ip igmp static-group': GROUPE_MULTICAST,
  'ip igmp': { name: 'reste', type: 'REST', optional: true,
    description: 'IGMP interface parameters' },
};

export function igmpInterfaceSpecs(ctx: IfCtx): CommandSpec[] {
  return specsFromTrieRegistrations(
    (collector) => buildIgmpInterfaceCommands(collector as unknown as CommandTrie, ctx),
    {
      modes: MODES_INTERFACE, minPrivilege: 15,
      undoFromNegatedPaths: true,
      argumentFor: (path) => IGMP_ARGUMENTS[path],
    },
  );
}

export function buildIgmpInterfaceCommands(trie: CommandTrie, ctx: IfCtx): void {
  trie.registerGreedy('ip igmp version', 'Set IGMP version', (args) => {
    const a = agent(ctx.r());
    if (!a) return '';
    const v = parseInt(args[0], 10);
    if (v === 3) return '% IGMPv3 is not supported in this simulator (RFC 3376 INCLUDE/EXCLUDE source filtering — out of scope, v1/v2 only)';
    if (v !== 1 && v !== 2) return '% Invalid IGMP version';
    for (const port of ctx.selectedPorts()) a.enableInterface(port, v);
    return '';
  });

  trie.registerGreedy('no ip igmp version', 'Reset IGMP version to default', (args) => {
    void args;
    const a = agent(ctx.r());
    if (!a) return '';
    for (const port of ctx.selectedPorts()) {
      const rt = a.getInterfaceRuntime(port);
      if (rt && rt.enabled) a.enableInterface(port, 2);
    }
    return '';
  });

  for (const origin of ['join-group', 'static-group'] as const) {
    trie.registerGreedy(`ip igmp ${origin}`,
      origin === 'join-group' ? 'Join a multicast group' : 'Statically forward a multicast group',
      (args) => {
        const a = agent(ctx.r());
        if (!a) return '';
        const group = args[0];
        if (!group) return '% Incomplete command.';
        if (!isMulticastIpv4(group) || isReservedMulticast(group)) return '% Invalid group address';
        for (const port of ctx.selectedPorts()) a.configuredJoin(port, group, origin);
        return '';
      });

    trie.registerGreedy(`no ip igmp ${origin}`, 'Remove a configured multicast group', (args) => {
      const a = agent(ctx.r());
      if (!a) return '';
      const group = args[0];
      if (!group) return '% Incomplete command.';
      for (const port of ctx.selectedPorts()) a.configuredLeave(port, group, origin);
      return '';
    });
  }

  const subCommands = new Set(['version', 'join-group', 'static-group']);

  trie.registerGreedy('ip igmp', 'Enable IGMP', (args) => {
    const a = agent(ctx.r());
    if (!a) return '';
    if (subCommands.has(args[0])) return '';
    for (const port of ctx.selectedPorts()) a.enableInterface(port, 2);
    return '';
  });

  trie.registerGreedy('no ip igmp', 'Disable IGMP', (args) => {
    const a = agent(ctx.r());
    if (!a) return '';
    if (subCommands.has(args[0])) return '';
    for (const port of ctx.selectedPorts()) a.disableInterface(port);
    return '';
  });
}

export function registerIgmpShowCommands(trie: CommandTrie, ctx: ShowCtx): void {
  trie.registerGreedy('show ip igmp groups', 'Display IGMP group membership', (args) => {
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
        `${g.groupAddress.padEnd(17)}${g.iface.padEnd(25)}${hms(now - g.lastReportMs).padEnd(10)}${expiresIn(rt, g, now).padEnd(10)}${g.lastReporterIp ?? ''}`);
    }
    return rows.join('\n');
  });

  trie.registerGreedy('show ip igmp interface', 'Display IGMP interface state', (args) => {
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
  });
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
  return specsFromTrieRegistrations(
    (collector) => registerIgmpShowCommands(collector as unknown as CommandTrie, ctx),
    {
      modes: ['user', 'privileged'],
      minPrivilege: 1,
      restDescriptionFor: (path) => IGMP_SHOW_ARGUMENTS[path]?.[1],
      restLiteralFor: (path) => IGMP_SHOW_ARGUMENTS[path]?.[0],
      keywordsFor: (path) => IGMP_SHOW_KEYWORDS[path],
    },
  );
}
