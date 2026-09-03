/**
 * HuaweiIgmpCommands - IGMP CLI commands for Huawei VRP Shell
 *
 * Counterpart of `cisco/CiscoIgmpCommands.ts`, driving the same
 * `IgmpAgent` through VRP's own grammar:
 *   - Interface view: "igmp enable", "undo igmp enable", "igmp version",
 *                     "igmp static-group", "undo igmp static-group"
 *   - Display commands: "display igmp group", "display igmp interface"
 *
 * VRP has no counterpart to Cisco's `ip igmp join-group` (a router-side
 * membership that answers Queries); `igmp static-group` — forwarding state
 * with no Report ever emitted — is the only configured-membership form the
 * VRP grammar offers, so it is the only one registered here.
 */
import type { CommandTrie } from '../CommandTrie';
import type { Router } from '../../Router';
import type { IgmpAgent } from '../../../igmp/IgmpAgent';
import { isMulticastIpv4, isReservedMulticast } from '../../../igmp/types';
import { hms } from '@/lib/format';
import { HUAWEI_ERRORS } from '../cli-utils';

export interface HuaweiIgmpContext {
  r(): Router;
  getSelectedInterface(): string | null;
}

function agent(router: Router): IgmpAgent | undefined {
  return (router as unknown as { getIgmpAgent?: () => IgmpAgent }).getIgmpAgent?.();
}

export function registerHuaweiIgmpInterfaceCommands(trie: CommandTrie, ctx: HuaweiIgmpContext): void {
  trie.registerGreedy('igmp', 'Configure IGMP on the interface', (args) => {
    const a = agent(ctx.r());
    const iface = ctx.getSelectedInterface();
    if (!a || !iface) return '';
    if (args[0] === undefined) {
      return HUAWEI_ERRORS.INCOMPLETE('igmp');
    }
    const sub = args[0].toLowerCase();

    if (sub === 'enable') {
      a.enableInterface(iface, a.getInterfaceRuntime(iface)?.version ?? 2);
      return '';
    }

    if (sub === 'version') {
      const v = parseInt(args[1] ?? '', 10);
      if (v === 3) {
        return 'Error: IGMPv3 is not supported in this simulator (RFC 3376 INCLUDE/EXCLUDE source filtering — out of scope, v1/v2 only)';
      }
      if (v !== 1 && v !== 2) return 'Error: Wrong parameter found at \'^\' position.';
      a.enableInterface(iface, v);
      return '';
    }

    if (sub === 'static-group') {
      const group = args[1];
      if (!group) return 'Error: Incomplete command.';
      if (!isMulticastIpv4(group) || isReservedMulticast(group)) {
        return 'Error: Invalid group address.';
      }
      a.configuredJoin(iface, group, 'static-group');
      return '';
    }

    return 'Error: Unrecognized command found at \'^\' position.';
  });

  trie.registerGreedy('undo igmp', 'Remove IGMP configuration from the interface', (args) => {
    const a = agent(ctx.r());
    const iface = ctx.getSelectedInterface();
    if (!a || !iface) return '';
    const sub = (args[0] ?? '').toLowerCase();

    if (sub === 'enable' || sub === '') {
      a.disableInterface(iface);
      return '';
    }
    if (sub === 'version') {
      const rt = a.getInterfaceRuntime(iface);
      if (rt?.enabled) a.enableInterface(iface, 2);
      return '';
    }
    if (sub === 'static-group') {
      const group = args[1];
      if (!group) return 'Error: Incomplete command.';
      a.configuredLeave(iface, group, 'static-group');
      return '';
    }
    return 'Error: Unrecognized command found at \'^\' position.';
  });
}

export function registerHuaweiIgmpDisplayCommands(trie: CommandTrie, getRouter: () => Router): void {
  trie.registerGreedy('display igmp group', 'Display IGMP group membership', (args) => {
    const r = getRouter();
    const a = agent(r);
    if (!a) return '';
    const now = a.nowMs();
    const requested = args.find(x => !x.startsWith('-'));
    const ifaces = Array.from(a.getConfig().interfaces.keys())
      .filter(n => !requested || n.toLowerCase() === requested.toLowerCase());
    const lines = ['Interface group report information of VPN-Instance: public net'];
    let reported = 0;
    for (const iface of ifaces) {
      const groups = a.groupsFor(iface);
      if (groups.length === 0) continue;
      reported += groups.length;
      const ip = r.getPort(iface)?.getIPAddress()?.toString() ?? '0.0.0.0';
      lines.push(` ${iface}(${ip}):`);
      lines.push(`  Total ${groups.length} IGMP Group reported`);
      lines.push('   Group Address   Last Reporter   Uptime      Expires');
      const rt = a.getInterfaceRuntime(iface);
      const intervalMs = rt
        ? (rt.robustness * rt.queryIntervalSec + Math.ceil(rt.queryResponseIntervalDs / 10)) * 1000
        : 0;
      for (const g of groups) {
        const expires = g.origin === 'dynamic'
          ? hms(intervalMs - (now - g.lastReportMs))
          : 'never';
        lines.push(
          `   ${g.groupAddress.padEnd(16)}${(g.lastReporterIp ?? '0.0.0.0').padEnd(16)}${hms(now - g.lastReportMs).padEnd(12)}${expires}`);
      }
    }
    if (reported === 0) return 'Info: No IGMP group information is found.';
    return lines.join('\n');
  });

  trie.registerGreedy('display igmp interface', 'Display IGMP interface state', (args) => {
    const r = getRouter();
    const a = agent(r);
    if (!a) return '';
    const requested = args.find(x => x.toLowerCase() !== 'verbose');
    const ifaces = Array.from(a.getConfig().interfaces.keys())
      .filter(n => !requested || n.toLowerCase() === requested.toLowerCase());
    if (ifaces.length === 0) return 'Info: No IGMP interface information is found.';
    const lines = [' Interface information of VPN-Instance: public net'];
    for (const iface of ifaces) {
      const rt = a.getInterfaceRuntime(iface);
      if (!rt) continue;
      const port = r.getPort(iface);
      const ip = port?.getIPAddress()?.toString() ?? '0.0.0.0';
      const up = port?.getIsUp() && port?.isConnected();
      lines.push(`  ${iface}(${ip}):`);
      lines.push(`    IGMP is ${rt.enabled ? 'enabled' : 'disabled'}`);
      lines.push(`    Current IGMP version is ${rt.version}`);
      lines.push(`    IGMP state: ${up ? 'up' : 'down'}`);
      lines.push(`    IGMP group policy: none`);
      lines.push(`    Value of query interval for IGMP: ${rt.queryIntervalSec} s`);
      lines.push(`    Value of other querier present interval for IGMP: ${rt.otherQuerierPresentSec} s`);
      lines.push(`    Value of maximum query response time for IGMP: ${Math.round(rt.queryResponseIntervalDs / 10)} s`);
      if (rt.querierIp) {
        lines.push(`    Querier for IGMP: ${rt.querierIp}${rt.querierIp === ip ? ' (this router)' : ''}`);
      }
      lines.push(`    Total ${a.groupsFor(iface).length} IGMP Group reported`);
    }
    lines.push('');

    return lines.join('\n');
  });
}
