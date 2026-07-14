import type { LinuxCommand } from '../LinuxCommand';
import { makeArgCompleter } from '../completionHelpers';

/**
 * L'exécution de traceroute est migrée vers command-kernel
 * (`linux/command-kernel/commands/Traceroute.ts`) et le hook kernel est
 * consulté avant ce registre sur tous les chemins de dispatch : cette
 * entrée ne sert plus que `man`/`--help`/la complétion. Toute tentative
 * d'exécution ici est un bug de routage, signalé bruyamment.
 */

function migratedToKernel(): never {
  throw new Error('traceroute: exécution migrée vers command-kernel — cette entrée ne sert que man/help');
}

export const tracerouteCommand: LinuxCommand = {
  name: 'traceroute',
  needsNetworkContext: true,
  complete: makeArgCompleter({
    flags: ['-4', '-6', '-A', '-F', '-I', '-N', '-T', '-U', '-V', '-d', '-e',
      '-f', '-g', '-i', '-m', '-n', '-p', '-q', '-r', '-s', '-t', '-w', '-z',
      '--help', '--version'],
    interfacesAfter: ['-i'],
    hostsAtBarePosition: true,
  }),
  manSection: 8,
  usage: 'traceroute [-46dFInrUV] [-f first_ttl] [-g gate] [-i iface] [-m maxhops] [-p port] [-q nqueries] [-w waittime] host [packetlen]',
  help:
    'Print the route packets trace to network host.\n\n' +
    'Traces the path that an IP packet follows from the local host to a\n' +
    'remote destination by sending probe packets with increasing TTL values.',
  options: [
    { flag: '-n', description: 'Print numeric addresses without DNS lookup.', takesArg: false },
    { flag: '-I', description: 'Use ICMP ECHO for probes (default is UDP).', takesArg: false },
    { flag: '-U', description: 'Use UDP datagrams for probes.', takesArg: false },
    { flag: '-T', description: 'Use TCP SYN for probes.', takesArg: false },
    { flag: '-m', description: 'Maximum TTL value for outbound probes.', takesArg: true, argName: 'maxhops' },
    { flag: '-q', description: 'Number of probes per hop (default 3).', takesArg: true, argName: 'nqueries' },
    { flag: '-f', description: 'Start from the first_ttl hop (default 1).', takesArg: true, argName: 'first_ttl' },
    { flag: '-w', description: 'Seconds to wait for a response.', takesArg: true, argName: 'waittime' },
    { flag: '-p', description: 'Destination port.', takesArg: true, argName: 'port' },
    { flag: '-i', description: 'Bind to specific interface.', takesArg: true, argName: 'iface' },
    { flag: '-g', description: 'Loose source-routing gateway.', takesArg: true, argName: 'gateway' },
    { flag: '-V', description: 'Print version and exit.', takesArg: false },
  ],
  run: () => migratedToKernel(),
  runWithStatus: () => migratedToKernel(),
};
