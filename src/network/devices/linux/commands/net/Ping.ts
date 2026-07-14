import type { LinuxCommand, LinuxCommandOption } from '../LinuxCommand';
import type { LinuxCommandContext } from '../LinuxCommandContext';

/**
 * L'exécution de ping/ping6 est migrée vers command-kernel
 * (`linux/command-kernel/commands/Ping.ts`) et le hook kernel est consulté
 * avant ce registre sur tous les chemins de dispatch : ces entrées ne
 * servent plus que `man`/`--help`/la complétion. Toute tentative
 * d'exécution ici est un bug de routage, signalé bruyamment.
 */

const PING_OPTIONS: readonly LinuxCommandOption[] = [
  { flag: '-c', description: 'Stop after sending count packets.', takesArg: true, argName: 'count' },
  { flag: '-s', description: 'Specifies the number of data bytes to be sent (default 56).', takesArg: true, argName: 'packetsize' },
  { flag: '-t', description: 'Set the IP Time to Live.', takesArg: true, argName: 'ttl' },
  { flag: '-W', description: 'Time to wait for a response, in seconds.', takesArg: true, argName: 'timeout' },
  { flag: '-i', description: 'Wait interval seconds between packets (default 1).', takesArg: true, argName: 'interval' },
  { flag: '-I', description: 'Bind to a specific interface address.', takesArg: true, argName: 'interface' },
  { flag: '-p', description: 'Fill ECHO_REQUEST packet with given hex pattern.', takesArg: true, argName: 'pattern' },
  { flag: '-M', description: 'Select Path MTU Discovery strategy (do/want/dont).', takesArg: true, argName: 'pmtudisc_opt' },
  { flag: '-q', description: 'Quiet output (only summary at end).' },
  { flag: '-D', description: 'Print Unix timestamp before each line.' },
  { flag: '-b', description: 'Allow pinging a broadcast address.' },
  { flag: '-f', description: 'Flood ping. Root privilege required.' },
  { flag: '-V', description: 'Print version and exit.' },
  { flag: '-4', description: 'Use IPv4.' },
  { flag: '-6', description: 'Use IPv6.' },
];

const PING_FLAGS_LIST = PING_OPTIONS.map((o) => o.flag);

function completePingFlags(_ctx: LinuxCommandContext, args: string[]): string[] {
  const partial = args[args.length - 1] ?? '';
  if (partial.startsWith('-')) {
    return PING_FLAGS_LIST.filter((f) => f.startsWith(partial));
  }
  return [];
}

function migratedToKernel(name: string): never {
  throw new Error(`${name}: exécution migrée vers command-kernel — cette entrée ne sert que man/help`);
}

export const pingCommand: LinuxCommand = {
  name: 'ping',
  needsNetworkContext: true,
  manSection: 8,
  usage: 'ping [-aAbBdDfhLnOqrRUvV64] [-c count] [-i interval] [-I interface] [-M pmtudisc_opt] [-p pattern] [-s packetsize] [-t ttl] [-W timeout] destination',
  help: 'Send ICMP ECHO_REQUEST packets to network hosts.',
  options: PING_OPTIONS,
  complete: completePingFlags,
  run: () => migratedToKernel('ping'),
  runWithStatus: () => migratedToKernel('ping'),
};

export const ping6Command: LinuxCommand = {
  name: 'ping6',
  needsNetworkContext: true,
  manSection: 8,
  usage: 'ping6 [-c count] [-s size] [-W timeout] [-i interval] <destination>',
  help: 'Send ICMPv6 ECHO_REQUEST packets to network hosts (alias for ping -6).',
  options: [
    { flag: '-c', description: 'Stop after sending count packets.', takesArg: true, argName: 'count' },
    { flag: '-s', description: 'ICMP payload size in bytes (default 56).', takesArg: true, argName: 'size' },
    { flag: '-W', description: 'Time to wait for a response, in seconds.', takesArg: true, argName: 'timeout' },
    { flag: '-i', description: 'Wait interval seconds between packets.', takesArg: true, argName: 'interval' },
  ],
  complete: completePingFlags,
  run: () => migratedToKernel('ping6'),
  runWithStatus: () => migratedToKernel('ping6'),
};
