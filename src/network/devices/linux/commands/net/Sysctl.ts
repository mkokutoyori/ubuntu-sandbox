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
      if (key === 'net.ipv4.ip_local_port_range') {
        const exec = ctx.executor as unknown as {
          applyEphemeralRange(min: number, max: number): void;
          socketTable?: { getEphemeralRange(): { min: number; max: number } };
        };
        let rawVal = (val ?? '').replace(/["']/g, '');
        if (rawVal.split(/\s+/).filter(Boolean).length < 2) {
          const idx = params.indexOf(param);
          const next = (params[idx + 1] ?? '').replace(/["']/g, '');
          if (/^\d+$/.test(next)) rawVal = `${rawVal} ${next}`;
        }
        const parts = rawVal.replace(/\s+/g, '\t').split('\t').filter(Boolean);
        const min = Number(parts[0]);
        const max = Number(parts[1] ?? parts[0]);
        if (val !== undefined && Number.isFinite(min) && Number.isFinite(max) && min > 0 && max <= 65535 && min <= max) {
          exec.applyEphemeralRange(min, max);
        }
        const r = exec.socketTable?.getEphemeralRange();
        outputs.push(`net.ipv4.ip_local_port_range = ${r?.min ?? 32768}\t${r?.max ?? 60999}`);
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
