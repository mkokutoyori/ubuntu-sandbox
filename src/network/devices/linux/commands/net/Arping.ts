import { IPAddress } from '@/network/core/types';
import type { LinuxCommand } from '../LinuxCommand';
import type { LinuxCommandContext } from '../LinuxCommandContext';
import { cmdArping } from '../../LinuxNetCommands';

const ARPING_USAGE = 'Usage: arping [-fqbDUAV] [-c count] [-w timeout] [-I device] destination';

interface ParsedArpingArgs {
  count: number;
  iface?: string;
  target: string;
  /** -A: gratuitous ARP REPLY. -U: gratuitous ARP REQUEST. Neither: unicast probe (existing behaviour). */
  gratuitous: 'reply' | 'request' | null;
}

function parseArpingArgs(args: string[]): ParsedArpingArgs {
  const result: ParsedArpingArgs = { count: 0, target: '', gratuitous: null };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-c') { result.count = parseInt(args[++i], 10) || 0; continue; }
    if (a === '-I' || a === '-i') { result.iface = args[++i]; continue; }
    if (a === '-s' || a === '-w') { i++; continue; }
    if (a === '-A') { result.gratuitous = 'reply'; continue; }
    if (a === '-U') { result.gratuitous = 'request'; continue; }
    if (!a.startsWith('-')) result.target = a;
  }
  return result;
}

/** RFC 5227 gratuitous ARP announcement — real `arping -A`/`-U`, distinct from the default unicast-probe mode. */
function runGratuitous(ctx: LinuxCommandContext, parsed: ParsedArpingArgs): { output: string; exitCode: number } {
  if (!IPAddress.isValid(parsed.target)) {
    return { output: `arping: unknown host ${parsed.target}`, exitCode: 2 };
  }
  const ports = ctx.net.getPorts();
  const iface = parsed.iface ?? [...ports.keys()].find((n) => n !== 'lo');
  if (!iface || !ports.has(iface)) {
    return { output: `arping: ${parsed.iface ?? iface}: invalid argument — device not found`, exitCode: 2 };
  }
  const probes = parsed.count > 0 ? parsed.count : 1;
  const targetIP = new IPAddress(parsed.target);
  let sent = 0;
  for (let i = 0; i < probes; i++) {
    if (ctx.net.sendGratuitousArp(iface, targetIP, parsed.gratuitous!)) sent++;
  }
  const lines = [`ARPING ${parsed.target}`, `Sent ${sent} probes (${sent} broadcast(s))`];
  return { output: lines.join('\n'), exitCode: sent > 0 ? 0 : 1 };
}

async function runArping(ctx: LinuxCommandContext, args: string[]): Promise<{ output: string; exitCode: number }> {
  const parsed = parseArpingArgs(args);
  if (!parsed.target) return { output: ARPING_USAGE, exitCode: 2 };

  if (parsed.gratuitous) return runGratuitous(ctx, parsed);

  const result = cmdArping(args, {
    mac: (ip) => ctx.net.getArpTable().get(ip)?.mac.toString() ?? null,
  });
  return result;
}

export const arpingCommand: LinuxCommand = {
  name: 'arping',
  needsNetworkContext: true,
  manSection: 8,
  usage: 'arping [-fqbDUAV] [-c count] [-w timeout] [-I device] destination',
  help: 'Send ARP requests/announcements to a neighbor on the local network.',
  options: [
    { flag: '-c', description: 'Stop after sending count packets.', takesArg: true, argName: 'count' },
    { flag: '-I', description: 'Bind to a specific interface.', takesArg: true, argName: 'device' },
    { flag: '-A', description: 'Send gratuitous ARP REPLY (unsolicited announcement).' },
    { flag: '-U', description: 'Send gratuitous ARP REQUEST (unsolicited announcement).' },
  ],

  async run(ctx: LinuxCommandContext, args: string[]): Promise<string> {
    const result = await runArping(ctx, args);
    return result.output;
  },

  runWithStatus(ctx: LinuxCommandContext, args: string[]): Promise<{ output: string; exitCode: number }> {
    return runArping(ctx, args);
  },
};
