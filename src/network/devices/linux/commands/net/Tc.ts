/**
 * `tc` — traffic control (subset: `qdisc … netem loss <pct>%`).
 *
 * Real `tc netem` also models delay/jitter/corruption/duplication/reordering;
 * only `loss` is wired here, onto the already-existing, already-tested
 * `Cable.setPacketLossRate()` (0..1, RNG-injectable, publishes
 * `cable.frame.lost` on the event bus). Other netem tokens (`delay`,
 * `duplicate`, `corrupt`, `reorder`, …) are accepted and ignored rather
 * than rejected, so a script combining them with `loss` doesn't error out —
 * they just have no effect yet.
 */

import type { LinuxCommand } from '../LinuxCommand';
import type { LinuxCommandContext } from '../LinuxCommandContext';

function findCable(ctx: LinuxCommandContext, iface: string) {
  const port = ctx.net.getPorts().get(iface);
  if (!port) return { error: `Cannot find device "${iface}"` } as const;
  const cable = port.getCable();
  if (!cable) return { error: `Error: Interface "${iface}" is not connected to a cable.` } as const;
  return { cable } as const;
}

function parseLossPct(args: string[]): number | null {
  const idx = args.findIndex((a) => a === 'loss');
  if (idx === -1) return null;
  // `loss [random] <pct>%` — skip an optional distribution keyword.
  let valueTok = args[idx + 1];
  if (valueTok === 'random' || valueTok === 'state' || valueTok === 'gemodel') valueTok = args[idx + 2];
  const m = /^([\d.]+)%$/.exec(valueTok ?? '');
  if (!m) return null;
  const pct = Number(m[1]);
  if (!Number.isFinite(pct) || pct < 0 || pct > 100) return null;
  return pct / 100;
}

function qdiscShowLine(iface: string, cable: { getPacketLossRate(): number }): string {
  const loss = cable.getPacketLossRate();
  if (loss <= 0) return `qdisc fq_codel 0: dev ${iface} root refcnt 2`;
  const pct = (loss * 100).toFixed(1).replace(/\.0$/, '');
  return `qdisc netem 8001: dev ${iface} root refcnt 2 limit 1000 loss ${pct}%`;
}

export const tcCommand: LinuxCommand = {
  name: 'tc',
  needsNetworkContext: true,
  manSection: 8,
  usage: 'tc qdisc {add|change|del|show} dev IFACE [root netem loss PCT%]',
  help:
    'Show / manipulate traffic control settings.\n\n' +
    'Only `qdisc … netem loss <pct>%` is modelled, backed by the cable\'s\n' +
    'real packet-loss simulation (same mechanism `show interfaces` and\n' +
    'TCP retransmission already exercise) — not just cosmetic state.\n\n' +
    'Examples:\n' +
    '  tc qdisc add dev eth0 root netem loss 10%\n' +
    '  tc qdisc change dev eth0 root netem loss 25%\n' +
    '  tc qdisc del dev eth0 root\n' +
    '  tc qdisc show dev eth0',

  complete(ctx: LinuxCommandContext, args: string[]): string[] {
    const partial = args[args.length - 1] ?? '';
    if (args.length <= 1) return ['qdisc'].filter((c) => c.startsWith(partial));
    if (args[args.length - 2] === 'dev') return Array.from(ctx.net.getPorts().keys());
    return ['add', 'change', 'del', 'show', 'dev', 'root', 'netem', 'loss'].filter((c) => c.startsWith(partial));
  },

  run(ctx: LinuxCommandContext, args: string[]): string {
    if (args[0] !== 'qdisc') return `tc: unsupported object "${args[0] ?? ''}" (only "qdisc" is modelled)`;
    const sub = args[1];
    const devIdx = args.indexOf('dev');
    const iface = devIdx !== -1 ? args[devIdx + 1] : undefined;
    if (!iface) return 'Command line is not complete. Try option "help".';

    const resolved = findCable(ctx, iface);
    if ('error' in resolved) return resolved.error;
    const { cable } = resolved;

    switch (sub) {
      case 'add':
      case 'change':
      case 'replace': {
        const loss = parseLossPct(args);
        if (loss === null) return '';  // netem with no recognised token (e.g. delay-only) — accepted, no-op
        cable.setPacketLossRate(loss);
        return '';
      }
      case 'del': {
        cable.setPacketLossRate(0);
        return '';
      }
      case 'show':
      case 'list':
        return qdiscShowLine(iface, cable);
      default:
        return `tc: unsupported qdisc subcommand "${sub ?? ''}"`;
    }
  },
};
