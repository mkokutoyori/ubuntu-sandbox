import type { LinuxCommand } from '../LinuxCommand';
import type { LinuxCommandContext } from '../LinuxCommandContext';
import { netemIsActive, type NetemSpec } from '@/network/hardware/Netem';

const NETEM_USAGE =
  'Usage: ... netem\t[ limit PACKETS ]\n' +
  '\t\t\t[ delay TIME [ JITTER [CORRELATION]]]\n' +
  '\t\t\t[ distribution {uniform|normal|pareto|paretonormal} ]\n' +
  '\t\t\t[ corrupt PERCENT [CORRELATION]]\n' +
  '\t\t\t[ duplicate PERCENT [CORRELATION]]\n' +
  '\t\t\t[ loss random PERCENT [CORRELATION]]\n' +
  '\t\t\t[ loss state P13 [P31 [P32 [P23 P14]]]\n' +
  '\t\t\t[ loss gemodel PERCENT [R [1-H [1-K]]]\n' +
  '\t\t\t[ ecn ]\n' +
  '\t\t\t[ reorder PERCENT [CORRELATION] [ gap DISTANCE ]]\n' +
  '\t\t\t[ rate RATE [PACKETOVERHEAD] [CELLSIZE] [CELLOVERHEAD]]\n' +
  '\t\t\t[ slot MIN_DELAY [MAX_DELAY] [packets MAX_PACKETS] [bytes MAX_BYTES]]\n' +
  '\t\t[ slot distribution {uniform|normal|pareto|paretonormal|custom} DELAY JITTER' +
  ' [packets MAX_PACKETS] [bytes MAX_BYTES]]';

function findInterface(ctx: LinuxCommandContext, iface: string) {
  const port = ctx.net.getPorts().get(iface);
  if (!port) return { error: `Cannot find device "${iface}"` } as const;
  const cable = port.getCable();
  if (!cable) return { error: `Error: Interface "${iface}" is not connected to a cable.` } as const;
  return { port, cable } as const;
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

/** `delay <ms>ms` — real `netem` also accepts bare `<ms>` (no unit) and a
 *  jitter/correlation tail (`delay 200ms 10ms 25%`); only the base value
 *  is modelled, matching `loss`'s own scope. */
function parseDelayMs(args: string[]): number | null {
  const idx = args.findIndex((a) => a === 'delay');
  if (idx === -1) return null;
  const m = /^([\d.]+)(ms|s)?$/.exec(args[idx + 1] ?? '');
  if (!m) return null;
  const value = Number(m[1]);
  if (!Number.isFinite(value) || value < 0) return null;
  return m[2] === 's' ? value * 1000 : value;
}

function qdiscShowLine(iface: string, spec: NetemSpec | undefined): string {
  if (!netemIsActive(spec)) return `qdisc fq_codel 0: dev ${iface} root refcnt 2`;
  const parts: string[] = [];
  if (spec.delayMs > 0) parts.push(`delay ${spec.delayMs}ms`);
  if (spec.lossRate > 0) parts.push(`loss ${(spec.lossRate * 100).toFixed(1).replace(/\.0$/, '')}%`);
  const ecn = spec.ecn ? ' ecn ' : '';
  return `qdisc netem 8001: dev ${iface} root refcnt 2 limit 1000 ${parts.join(' ')}${ecn}`;
}

export const tcCommand: LinuxCommand = {
  name: 'tc',
  needsNetworkContext: true,
  manSection: 8,
  usage: 'tc qdisc {add|change|del|show} dev IFACE [root netem loss PCT% [ecn]]',
  help:
    'Show / manipulate traffic control settings.\n\n' +
    'Only `qdisc … netem loss <pct>% [ecn]` and `delay <ms>ms` are modelled,\n' +
    'on the EGRESS of the interface the command names: the frames this\n' +
    'interface sends are lost at that rate, or marked CE instead when they\n' +
    'carry ECT and `ecn` is given; the frames the peer sends are untouched.\n\n' +
    'Examples:\n' +
    '  tc qdisc add dev eth0 root netem loss 10%\n' +
    '  tc qdisc add dev eth0 root netem loss 10% ecn\n' +
    '  tc qdisc change dev eth0 root netem loss 25%\n' +
    '  tc qdisc del dev eth0 root\n' +
    '  tc qdisc show dev eth0',

  complete(ctx: LinuxCommandContext, args: string[]): string[] {
    const partial = args[args.length - 1] ?? '';
    if (args.length <= 1) return ['qdisc'].filter((c) => c.startsWith(partial));
    if (args[args.length - 2] === 'dev') return Array.from(ctx.net.getPorts().keys());
    return ['add', 'change', 'del', 'show', 'dev', 'root', 'netem', 'loss', 'ecn'].filter((c) => c.startsWith(partial));
  },

  run(ctx: LinuxCommandContext, args: string[]): string {
    if (args[0] !== 'qdisc') return `tc: unsupported object "${args[0] ?? ''}" (only "qdisc" is modelled)`;
    const sub = args[1];
    const devIdx = args.indexOf('dev');
    const iface = devIdx !== -1 ? args[devIdx + 1] : undefined;
    if (!iface) return 'Command line is not complete. Try option "help".';

    const resolved = findInterface(ctx, iface);
    if ('error' in resolved) return resolved.error;
    const { port, cable } = resolved;

    switch (sub) {
      case 'add':
      case 'change':
      case 'replace': {
        const spec: NetemSpec = {
          lossRate: parseLossPct(args) ?? 0,
          delayMs: parseDelayMs(args) ?? 0,
          ecn: args.includes('ecn'),
        };
        if (spec.ecn && spec.lossRate <= 0) return `ecn requested without loss model\n${NETEM_USAGE}`;
        cable.setEgressNetem(port, netemIsActive(spec) ? spec : null);
        return '';
      }
      case 'del': {
        cable.setEgressNetem(port, null);
        return '';
      }
      case 'show':
      case 'list':
        return qdiscShowLine(iface, cable.getEgressNetem(port));
      default:
        return `tc: unsupported qdisc subcommand "${sub ?? ''}"`;
    }
  },
};
