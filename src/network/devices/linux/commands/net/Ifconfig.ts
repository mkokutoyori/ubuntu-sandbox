/**
 * `ifconfig` — display and configure network interfaces.
 *
 * Supported invocations:
 *   ifconfig                        — show every interface
 *   ifconfig <if>                   — show a single interface
 *   ifconfig <if> <ip> [netmask M]  — assign an IPv4 address/mask
 *
 * Output is produced by the shared `LinuxFormatHelpers.formatInterface`
 * so that `LinuxPC` and `LinuxServer` emit exactly the same bytes
 * (including RX/TX counters — fixes the `LinuxServer` regression noted
 * in `linux_gap.md` §3.3).
 *
 * Extracted from `LinuxPC.cmdIfconfig` / `LinuxServer.cmdIfconfig`.
 * See `linux_gap.md` §8.4 (PR 5).
 */

import type { LinuxCommand } from '../LinuxCommand';
import type { LinuxCommandContext } from '../LinuxCommandContext';
import { IPAddress, SubnetMask } from '../../../../core/types';

export const ifconfigCommand: LinuxCommand = {
  name: 'ifconfig',
  needsNetworkContext: true,
  manSection: 8,
  usage: 'ifconfig [interface] [address [netmask mask]]',
  help:
    'Configure a network interface.\n\n' +
    'If no arguments are given, ifconfig displays the status of all active\n' +
    'interfaces. If a single interface argument is given, it displays the\n' +
    'status of that interface only. If an address is also specified, it\n' +
    'configures the interface with the given IPv4 address and optional\n' +
    'netmask.',

  complete(ctx: LinuxCommandContext, args: string[]): string[] {
    // First arg: interface name. "netmask" keyword after an IP.
    if (args.length <= 1) {
      return Array.from(ctx.net.getPorts().keys());
    }
    const prev = args[args.length - 2];
    if (prev && /^\d+\.\d+\.\d+\.\d+$/.test(prev)) return ['netmask'];
    return [];
  },

  run(ctx: LinuxCommandContext, args: string[]): string {
    const ports = ctx.net.getPorts();

    // ── No argument: show every interface ─────────────────────
    if (args.length === 0) {
      const lines: string[] = [];
      for (const [, port] of ports) {
        lines.push(ctx.fmt.formatInterface(port));
        lines.push('');
      }
      return lines.join('\n');
    }

    const ifName = args[0];
    const port = ports.get(ifName);
    if (!port) return `ifconfig: interface ${ifName} not found`;

    // ── Single-interface show ─────────────────────────────────
    if (args.length === 1) return ctx.fmt.formatInterface(port);

    // ── ifconfig <if> <ip> [netmask M] ────────────────────────
    const ipStr = args[1];
    let maskStr = '255.255.255.0';
    const nmIdx = args.indexOf('netmask');
    if (nmIdx !== -1 && args[nmIdx + 1]) maskStr = args[nmIdx + 1];

    try {
      ctx.net.configureInterface(ifName, new IPAddress(ipStr), new SubnetMask(maskStr));
      return '';
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return `ifconfig: ${msg}`;
    }
  },
};
