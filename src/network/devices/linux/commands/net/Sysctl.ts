/**
 * `sysctl` — read/write kernel parameters.
 *
 * Only `net.ipv4.ip_forward` is modelled today. All other parameters
 * are silently accepted so scripts that probe `kernel.*` or
 * `net.core.*` values don't crash.
 *
 * Extracted from `LinuxPC.cmdSysctl`. See `linux_gap.md` §8.4 (PR 3).
 */

import type { LinuxCommand } from '../LinuxCommand';
import type { LinuxCommandContext } from '../LinuxCommandContext';

export const sysctlCommand: LinuxCommand = {
  name: 'sysctl',
  needsNetworkContext: true,
  manSection: 8,
  usage: 'sysctl [-w] variable[=value] ...',
  help:
    'Configure kernel parameters at runtime.\n\n' +
    'OPTIONS\n' +
    '  -w            Use this option when you want to change a sysctl setting.\n' +
    '  -a            Display all values currently available.\n\n' +
    'Supported parameters:\n' +
    '  net.ipv4.ip_forward  Enable/disable IPv4 packet forwarding (0 or 1).',

  complete(_ctx: LinuxCommandContext, args: string[]): string[] {
    const partial = args[args.length - 1] ?? '';
    if (partial.startsWith('-')) {
      return ['-w', '-a'].filter(f => f.startsWith(partial));
    }
    return ['net.ipv4.ip_forward'];
  },

  run(ctx: LinuxCommandContext, args: string[]): string {
    // sysctl -w key=value [key=value …]
    // sysctl key [key …]
    const wIdx = args.indexOf('-w');
    const params = wIdx !== -1 ? args.slice(wIdx + 1) : args.filter(a => !a.startsWith('-'));

    const outputs: string[] = [];
    for (const param of params) {
      const [key, val] = param.split('=');
      if (key === 'net.ipv4.ip_forward') {
        if (val !== undefined) ctx.net.setIpForward(val === '1');
        const current = ctx.net.isIpForwardEnabled() ? '1' : '0';
        outputs.push(`net.ipv4.ip_forward = ${val ?? current}`);
        continue;
      }
      if (key === 'net.ipv4.tcp_tw_reuse') {
        const st = (ctx.executor as unknown as { socketTable?: { setTcpTwReuse(v: boolean): void; getTcpTwReuse(): boolean } }).socketTable;
        if (val !== undefined && st) st.setTcpTwReuse(val === '1');
        const current = st?.getTcpTwReuse?.() ? '1' : '0';
        outputs.push(`net.ipv4.tcp_tw_reuse = ${val ?? current}`);
        continue;
      }
    }

    return outputs.join('\n');
  },
};
