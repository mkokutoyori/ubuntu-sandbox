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

  run(ctx: LinuxCommandContext, args: string[]): string {
    // sysctl -w key=value [key=value …]
    // sysctl key [key …]
    const wIdx = args.indexOf('-w');
    const params = wIdx !== -1 ? args.slice(wIdx + 1) : args.filter(a => !a.startsWith('-'));

    for (const param of params) {
      const [key, val] = param.split('=');
      if (key === 'net.ipv4.ip_forward') {
        if (val !== undefined) {
          ctx.net.setIpForward(val === '1');
        }
        const current = ctx.net.isIpForwardEnabled() ? '1' : '0';
        return `net.ipv4.ip_forward = ${val ?? current}`;
      }
    }

    return '';
  },
};
