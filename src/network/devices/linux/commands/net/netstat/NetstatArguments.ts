import { shortOptions, getoptDiagnostic, type LongOption } from '../../Getopt';
import { NET_TOOLS_VERSION } from '../NetToolsVersion';

const NETSTAT_USAGE_HEAD = [
  'usage: netstat [-vWeenNcCF] [<Af>] -r         netstat {-V|--version|-h|--help}',
  '       netstat [-vWnNcaeol] [<Socket> ...]',
  '       netstat { [-vWeenNac] -i | [-cnNe] -M | -s [-6tuw] }',
  '',
  '        -r, --route              display routing table',
  '        -i, --interfaces         display interface table',
  '        -g, --groups             display multicast group memberships',
  '        -s, --statistics         display networking statistics (like SNMP)',
  '        -M, --masquerade         display masqueraded connections',
  '',
  '        -v, --verbose            be verbose',
  '        -W, --wide               don\'t truncate IP addresses',
  '        -n, --numeric            don\'t resolve names',
  '        --numeric-hosts          don\'t resolve host names',
  '        --numeric-ports          don\'t resolve port names',
  '        --numeric-users          don\'t resolve user names',
  '        -N, --symbolic           resolve hardware names',
  '        -e, --extend             display other/more information',
  '        -p, --programs           display PID/Program name for sockets',
  '        -o, --timers             display timers',
  '        -c, --continuous         continuous listing',
  '',
  '        -l, --listening          display listening server sockets',
  '        -a, --all                display all sockets (default: connected)',
  '        -F, --fib                display Forwarding Information Base (default)',
  '        -C, --cache              display routing cache instead of FIB',
  '        -Z, --context            display SELinux security context for sockets',
  '',
  '  <Socket>={-t|--tcp} {-u|--udp} {-U|--udplite} {-S|--sctp} {-w|--raw}',
  '           {-x|--unix} --ax25 --ipx --netrom',
  '  <AF>=Use \'-6|-4\' or \'-A <af>\' or \'--<af>\'; default: inet',
  '  List of possible address families (which support routing):',
  '',
].join('\n');

const NETSTAT_USAGE_FAMILIES = [
  '    inet (DARPA Internet) inet6 (IPv6) ax25 (AMPR AX.25) ',
  '    netrom (AMPR NET/ROM) rose (AMPR ROSE) ipx (Novell IPX) ',
  '    ddp (Appletalk DDP) x25 (CCITT X.25) ',
  '',
].join('\n');

export const NETSTAT_USAGE = NETSTAT_USAGE_HEAD + NETSTAT_USAGE_FAMILIES;

export const NETSTAT_VERSION = [
  NET_TOOLS_VERSION,
  'Fred Baumgarten, Alan Cox, Bernd Eckenfels, Phil Blundell, Tuan Hoang, Brian Micek and others',
  '+NEW_ADDRT +RTF_IRTT +RTF_REJECT +FW_MASQUERADE +I18N +SELINUX',
  'AF: (inet) +UNIX +INET +INET6 +IPX +AX25 +NETROM +X25 +ATALK +ECONET +ROSE -BLUETOOTH',
  'HW:  +ETHER +ARC +SLIP +PPP +TUNNEL -TR +AX25 +NETROM +X25 +FR +ROSE +ASH +SIT +FDDI +HIPPI +HDLC/LAPB +EUI64',
  '',
].join('\n');

const E_OPTERR = 3;

const FAMILY_ALIASES: ReadonlyMap<string, string> = new Map([
  ['ax25', 'ax25'], ['ip', 'inet'], ['ip6', 'inet6'], ['ipx', 'ipx'], ['rose', 'rose'], ['appletalk', 'ddp'],
  ['netrom', 'netrom'], ['inet', 'inet'], ['inet6', 'inet6'], ['ddp', 'ddp'], ['unix', 'unix'], ['tcpip', 'inet'],
  ['econet', 'ec'], ['x25', 'x25'], ['ash', 'ash'], ['bluetooth', 'bluetooth'],
]);

const FAMILY_LONG_OPTION_NAMES = [
  'ax25', 'x25', 'ip', 'ipx', 'appletalk', 'netrom', 'inet', 'inet6', 'ddp', 'rose', 'unix', 'bluetooth',
] as const;

const FAMILY_LETTER_BASE = 1;

const FAMILY_BY_LETTER: ReadonlyMap<string, string> = new Map(
  FAMILY_LONG_OPTION_NAMES.map((name, index) => [String.fromCharCode(FAMILY_LETTER_BASE + index), name] as const),
);

const FAMILY_LONG_OPTIONS: readonly LongOption[] = [...FAMILY_BY_LETTER].map(([letter, name]) => ({
  name, letter, takesArgument: false,
}));

const LONG_OPTIONS: readonly LongOption[] = [
  ...FAMILY_LONG_OPTIONS,
  { name: 'version', letter: 'V', takesArgument: false },
  { name: 'interfaces', letter: 'i', takesArgument: false },
  { name: 'help', letter: 'h', takesArgument: false },
  { name: 'route', letter: 'r', takesArgument: false },
  { name: 'masquerade', letter: 'M', takesArgument: false },
  { name: 'protocol', letter: 'A', takesArgument: true },
  { name: 'tcp', letter: 't', takesArgument: false },
  { name: 'sctp', letter: 'S', takesArgument: false },
  { name: 'udp', letter: 'u', takesArgument: false },
  { name: 'udplite', letter: 'U', takesArgument: false },
  { name: 'raw', letter: 'w', takesArgument: false },
  { name: 'l2cap', letter: '2', takesArgument: false },
  { name: 'rfcomm', letter: 'f', takesArgument: false },
  { name: 'listening', letter: 'l', takesArgument: false },
  { name: 'all', letter: 'a', takesArgument: false },
  { name: 'timers', letter: 'o', takesArgument: false },
  { name: 'continuous', letter: 'c', takesArgument: false },
  { name: 'extend', letter: 'e', takesArgument: false },
  { name: 'programs', letter: 'p', takesArgument: false },
  { name: 'verbose', letter: 'v', takesArgument: false },
  { name: 'statistics', letter: 's', takesArgument: false },
  { name: 'wide', letter: 'W', takesArgument: false },
  { name: 'numeric', letter: 'n', takesArgument: false },
  { name: 'numeric-hosts', letter: '!', takesArgument: false },
  { name: 'numeric-ports', letter: '@', takesArgument: false },
  { name: 'numeric-users', letter: '#', takesArgument: false },
  { name: 'symbolic', letter: 'N', takesArgument: false },
  { name: 'cache', letter: 'C', takesArgument: false },
  { name: 'fib', letter: 'F', takesArgument: false },
  { name: 'groups', letter: 'g', takesArgument: false },
  { name: 'context', letter: 'Z', takesArgument: false },
];

const OPTION_LETTERS = 'A:CFMacdeghilnNoprsStuUvVWw2fx64?Z';

export interface NetstatOptions {
  readonly all: boolean;
  readonly listening: boolean;
  readonly extended: number;
  readonly programs: boolean;
  readonly wide: boolean;
  readonly numericHosts: boolean;
  readonly numericPorts: boolean;
  readonly numericUsers: boolean;
  readonly timers: boolean;
  readonly verbose: boolean;
  readonly routes: boolean;
  readonly interfaces: boolean;
  readonly statistics: boolean;
  readonly masquerade: boolean;
  readonly groups: boolean;
  readonly routingCache: boolean;
  readonly tcp: boolean;
  readonly udp: boolean;
  readonly udpLite: boolean;
  readonly sctp: boolean;
  readonly raw: boolean;
  readonly unix: boolean;
  readonly inet: boolean;
  readonly inet6: boolean;
  readonly noProtocol: boolean;
  readonly addressFamily: string;
  readonly unsupportedFamilies: readonly string[];
  readonly argumentCount: number;
}

export interface NetstatEarlyExit {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

export interface NetstatParseResult {
  readonly options: NetstatOptions | null;
  readonly exit: NetstatEarlyExit | null;
}

export function parseNetstatArguments(args: readonly string[]): NetstatParseResult {
  const flags = {
    all: 0, listening: 0, extended: 0, programs: 0, wide: 0, timers: 0, verbose: 0,
    routes: 0, interfaces: 0, statistics: 0, masquerade: 0, groups: 0, routingCache: 0,
    tcp: 0, udp: 0, udpLite: 0, sctp: 0, raw: 0, unix: 0, inet: 0, inet6: 0, l2cap: 0, rfcomm: 0,
    numericHosts: false, numericPorts: false, numericUsers: false,
  };
  const unsupportedFamilies: string[] = [];
  const familyNames: string[] = [];
  const failure = (stderr: string): NetstatParseResult => ({
    options: null, exit: { stdout: '', stderr, exitCode: 1 },
  });
  const takeFamily = (alias: string): string | null => {
    const name = FAMILY_ALIASES.get(alias);
    if (name === undefined) return alias;
    familyNames.push(name);
    if (name === 'inet') flags.inet++;
    else if (name === 'inet6') flags.inet6++;
    else if (name === 'unix') flags.unix++;
    else unsupportedFamilies.push(alias);
    return null;
  };

  for (const item of shortOptions(args, OPTION_LETTERS, LONG_OPTIONS)) {
    if (item.kind === 'operand') continue;
    if (item.kind !== 'option') {
      return { options: null, exit: { stdout: '', stderr: `${getoptDiagnostic('netstat', item)}\n${NETSTAT_USAGE}`, exitCode: E_OPTERR } };
    }
    const familyOption = FAMILY_BY_LETTER.get(item.letter);
    if (familyOption !== undefined) {
      takeFamily(familyOption);
      continue;
    }
    switch (item.letter) {
      case 'A': {
        for (const name of (item.argument ?? '').split(',')) {
          const unknown = takeFamily(name);
          if (unknown !== null) return failure(`Unknown address family \`${unknown}'.\n`);
        }
        break;
      }
      case 'M': flags.masquerade++; break;
      case 'a': flags.all++; break;
      case 'l': flags.listening++; break;
      case 'c': break;
      case 'd': break;
      case 'g': flags.groups++; break;
      case 'e': flags.extended++; break;
      case 'p': flags.programs++; break;
      case 'i': flags.interfaces++; break;
      case 'W': flags.wide++; break;
      case 'n': flags.numericHosts = flags.numericPorts = flags.numericUsers = true; break;
      case '!': flags.numericHosts = true; break;
      case '@': flags.numericPorts = true; break;
      case '#': flags.numericUsers = true; break;
      case 'N': break;
      case 'C': flags.routingCache++; break;
      case 'F': break;
      case 'o': flags.timers++; break;
      case '6': takeFamily('inet6'); break;
      case '4': takeFamily('inet'); break;
      case 'V': return { options: null, exit: { stdout: NETSTAT_VERSION, stderr: '', exitCode: 0 } };
      case 'v': flags.verbose++; break;
      case 'r': flags.routes++; break;
      case 't': flags.tcp++; break;
      case 'S': flags.sctp++; break;
      case 'u': flags.udp++; break;
      case 'U': flags.udpLite++; break;
      case 'w': flags.raw++; break;
      case '2': flags.l2cap++; break;
      case 'f': flags.rfcomm++; break;
      case 'x': takeFamily('unix'); break;
      case 'Z':
        return failure('SELinux is not enabled on this machine.\n');
      case 'h': return { options: null, exit: { stdout: NETSTAT_USAGE_HEAD, stderr: NETSTAT_USAGE_FAMILIES, exitCode: 0 } };
      case 's': flags.statistics++; break;
      default: return { options: null, exit: { stdout: '', stderr: NETSTAT_USAGE, exitCode: E_OPTERR } };
    }
  }

  if (flags.interfaces + flags.routes + flags.masquerade + flags.statistics > 1) {
    return { options: null, exit: { stdout: '', stderr: NETSTAT_USAGE, exitCode: E_OPTERR } };
  }

  let noProtocol = false;
  const anyProtocol = (): boolean => flags.tcp + flags.sctp + flags.udp + flags.udpLite + flags.raw > 0;
  if ((flags.inet > 0 || flags.inet6 > 0 || flags.statistics > 0) && !anyProtocol()) {
    noProtocol = true;
    flags.tcp = flags.sctp = flags.udp = flags.udpLite = flags.raw = 1;
  }
  if ((anyProtocol() || flags.groups > 0) && flags.inet === 0 && flags.inet6 === 0) {
    flags.inet = flags.inet6 = 1;
  }
  const argumentCount = flags.tcp + flags.sctp + flags.udpLite + flags.udp + flags.raw + flags.unix
    + flags.groups + flags.l2cap + flags.rfcomm + unsupportedFamilies.length;

  return {
    options: {
      all: flags.all > 0, listening: flags.listening > 0,
      extended: 1 + flags.extended, programs: flags.programs > 0, wide: flags.wide > 0,
      numericHosts: flags.numericHosts, numericPorts: flags.numericPorts, numericUsers: flags.numericUsers,
      timers: flags.timers > 0, verbose: flags.verbose > 0, routes: flags.routes > 0,
      interfaces: flags.interfaces > 0, statistics: flags.statistics > 0, masquerade: flags.masquerade > 0,
      groups: flags.groups > 0, routingCache: flags.routingCache > 0,
      tcp: flags.tcp > 0, udp: flags.udp > 0, udpLite: flags.udpLite > 0, sctp: flags.sctp > 0,
      raw: flags.raw > 0, unix: flags.unix > 0, inet: flags.inet > 0, inet6: flags.inet6 > 0,
      noProtocol, addressFamily: familyNames.join(','), unsupportedFamilies, argumentCount,
    },
    exit: null,
  };
}
