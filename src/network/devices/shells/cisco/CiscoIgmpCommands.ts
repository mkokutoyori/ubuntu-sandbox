import type { CommandTrie } from '../CommandTrie';
import type { Router } from '../../Router';
import type { IgmpAgent } from '../../../igmp/IgmpAgent';
import type { IgmpGroupRecord, IgmpInterfaceRuntime } from '../../../igmp/types';

interface IfCtx {
  selectedPorts(): string[];
  r(): Router;
}

interface ShowCtx {
  r(): Router;
}

function agent(router: Router): IgmpAgent | undefined {
  return (router as unknown as { getIgmpAgent?: () => IgmpAgent }).getIgmpAgent?.();
}

function hms(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function expiresIn(rt: IgmpInterfaceRuntime | undefined, g: IgmpGroupRecord): string {
  if (!rt) return '00:00:00';
  const intervalMs = (rt.robustness * rt.queryIntervalSec + Math.ceil(rt.queryResponseIntervalDs / 10)) * 1000;
  const remaining = intervalMs - (Date.now() - g.lastReportMs);
  return hms(remaining);
}

export function buildIgmpInterfaceCommands(trie: CommandTrie, ctx: IfCtx): void {
  trie.registerGreedy('ip igmp version', 'Set IGMP version', (args) => {
    const a = agent(ctx.r());
    if (!a) return '';
    const v = parseInt(args[0], 10);
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

  trie.registerGreedy('ip igmp', 'Enable IGMP', (args) => {
    const a = agent(ctx.r());
    if (!a) return '';
    if (args[0] === 'version') return '';
    for (const port of ctx.selectedPorts()) a.enableInterface(port, 2);
    return '';
  });

  trie.registerGreedy('no ip igmp', 'Disable IGMP', (args) => {
    const a = agent(ctx.r());
    if (!a) return '';
    if (args[0] === 'version') return '';
    for (const port of ctx.selectedPorts()) a.disableInterface(port);
    return '';
  });
}

export function registerIgmpShowCommands(trie: CommandTrie, ctx: ShowCtx): void {
  trie.registerGreedy('show ip igmp groups', 'Display IGMP group membership', (args) => {
    const a = agent(ctx.r());
    if (!a) return '';
    let iface: string | undefined;
    const ifIdx = args.findIndex((x) => x.toLowerCase() === 'interface');
    if (ifIdx >= 0 && args[ifIdx + 1]) iface = args[ifIdx + 1];
    const detail = args.includes('detail');
    const groups = iface ? a.groupsFor(iface) : a.listGroups();
    if (detail) {
      const blocks: string[] = [];
      for (const g of groups) {
        const rt = a.getInterfaceRuntime(g.iface);
        blocks.push([
          `Interface:\t\t${g.iface}`,
          `Group:\t\t\t${g.groupAddress}`,
          `Uptime:\t\t\t${hms(Date.now() - g.lastReportMs)}`,
          `Group mode:\t\tIGMPv${g.v1Compat ? 1 : (rt?.version ?? 2)}`,
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
        `${g.groupAddress.padEnd(17)}${g.iface.padEnd(25)}${hms(Date.now() - g.lastReportMs).padEnd(10)}${expiresIn(rt, g).padEnd(10)}${g.lastReporterIp ?? ''}`);
    }
    return rows.join('\n');
  });

  trie.registerGreedy('show ip igmp interface', 'Display IGMP interface state', (args) => {
    const a = agent(ctx.r());
    const r = ctx.r();
    if (!a) return '';
    const requested = args[0];
    const ifaces = requested
      ? [requested]
      : Array.from(a.getConfig().interfaces.keys());
    const lines: string[] = [];
    for (const ifaceName of ifaces) {
      const rt = a.getInterfaceRuntime(ifaceName);
      if (!rt) continue;
      const port = r.getPort(ifaceName);
      const up = port?.getIsUp() && port?.isConnected();
      const ip = port?.getIPAddress();
      const mask = port?.getSubnetMask();
      lines.push(`${ifaceName} is ${up ? 'up' : 'down'}, line protocol is ${up ? 'up' : 'down'}`);
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
      if (rt.querierIp) {
        lines.push(`  IGMP querying router is ${rt.querierIp}${rt.querierIp === myIp ? ' (this system)' : ''}`);
      }
      lines.push('');
    }
    while (lines.length && lines[lines.length - 1] === '') lines.pop();
    return lines.join('\n');
  });
}
