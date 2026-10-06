import { shortOptions, getoptDiagnostic, type LongOption } from '../../Getopt';
import {
  AF, DB, SS, SS_ALL, SS_CONN, SsError, SsFilter, parseDatabaseName, scanState,
} from './SsModel';
import { parseFilterExpression, type SsParseEnvironment } from './SsFilterExpression';

export const SS_VERSION = 'ss utility, iproute2-5.15.0';

export const SS_USAGE = [
  'Usage: ss [ OPTIONS ]',
  '       ss [ OPTIONS ] [ FILTER ]',
  '   -h, --help          this message',
  '   -V, --version       output version information',
  "   -n, --numeric       don't resolve service names",
  '   -r, --resolve       resolve host names',
  '   -a, --all           display all sockets',
  '   -l, --listening     display listening sockets',
  '   -o, --options       show timer information',
  '   -e, --extended      show detailed socket information',
  '   -m, --memory        show socket memory usage',
  '   -p, --processes     show process using socket',
  '   -i, --info          show internal TCP information',
  '       --tipcinfo      show internal tipc socket information',
  '   -s, --summary       show socket usage summary',
  '       --tos           show tos and priority information',
  '       --cgroup        show cgroup information',
  '   -b, --bpf           show bpf filter socket information',
  '   -E, --events        continually display sockets as they are destroyed',
  '   -Z, --context       display process SELinux security contexts',
  '   -z, --contexts      display process and socket SELinux security contexts',
  '   -N, --net           switch to the specified network namespace name',
  '',
  '   -4, --ipv4          display only IP version 4 sockets',
  '   -6, --ipv6          display only IP version 6 sockets',
  '   -0, --packet        display PACKET sockets',
  '   -t, --tcp           display only TCP sockets',
  '   -M, --mptcp         display only MPTCP sockets',
  '   -S, --sctp          display only SCTP sockets',
  '   -u, --udp           display only UDP sockets',
  '   -d, --dccp          display only DCCP sockets',
  '   -w, --raw           display only RAW sockets',
  '   -x, --unix          display only Unix domain sockets',
  '       --tipc          display only TIPC sockets',
  '       --vsock         display only vsock sockets',
  '   -f, --family=FAMILY display sockets of type FAMILY',
  '       FAMILY := {inet|inet6|link|unix|netlink|vsock|tipc|xdp|help}',
  '',
  '   -K, --kill          forcibly close sockets, display what was closed',
  '   -H, --no-header     Suppress header line',
  "   -O, --oneline       socket's data printed on a single line",
  '       --inet-sockopt  show various inet socket options',
  '',
  '   -A, --query=QUERY, --socket=QUERY',
  '       QUERY := {all|inet|tcp|mptcp|udp|raw|unix|unix_dgram|unix_stream|unix_seqpacket|packet|netlink|vsock_stream|vsock_dgram|tipc}[,QUERY]',
  '',
  '   -D, --diag=FILE     Dump raw information about TCP sockets to FILE',
  '   -F, --filter=FILE   read filter information from FILE',
  '       FILTER := [ state STATE-FILTER ] [ EXPRESSION ]',
  '       STATE-FILTER := {all|connected|synchronized|bucket|big|TCP-STATES}',
  '         TCP-STATES := {established|syn-sent|syn-recv|fin-wait-{1,2}|time-wait|closed|close-wait|last-ack|listening|closing}',
  '          connected := {established|syn-sent|syn-recv|fin-wait-{1,2}|time-wait|close-wait|last-ack|closing}',
  '       synchronized := {established|syn-recv|fin-wait-{1,2}|time-wait|close-wait|last-ack|closing}',
  '             bucket := {syn-recv|time-wait}',
  '                big := {established|syn-sent|fin-wait-{1,2}|closed|close-wait|last-ack|listening|closing}',
  '',
].join('\n');

const VSOCK = 'Ā';
const TIPC = 'ā';
const TIPC_INFO = 'Ă';
const TOS = 'ă';
const XDP = 'Ą';
const CGROUP = 'ą';
const INET_SOCKOPT = 'Ć';

const LONG_OPTIONS: readonly LongOption[] = [
  { name: 'numeric', letter: 'n', takesArgument: false },
  { name: 'resolve', letter: 'r', takesArgument: false },
  { name: 'options', letter: 'o', takesArgument: false },
  { name: 'extended', letter: 'e', takesArgument: false },
  { name: 'memory', letter: 'm', takesArgument: false },
  { name: 'info', letter: 'i', takesArgument: false },
  { name: 'processes', letter: 'p', takesArgument: false },
  { name: 'bpf', letter: 'b', takesArgument: false },
  { name: 'events', letter: 'E', takesArgument: false },
  { name: 'dccp', letter: 'd', takesArgument: false },
  { name: 'tcp', letter: 't', takesArgument: false },
  { name: 'sctp', letter: 'S', takesArgument: false },
  { name: 'udp', letter: 'u', takesArgument: false },
  { name: 'raw', letter: 'w', takesArgument: false },
  { name: 'unix', letter: 'x', takesArgument: false },
  { name: 'tipc', letter: TIPC, takesArgument: false },
  { name: 'vsock', letter: VSOCK, takesArgument: false },
  { name: 'all', letter: 'a', takesArgument: false },
  { name: 'listening', letter: 'l', takesArgument: false },
  { name: 'ipv4', letter: '4', takesArgument: false },
  { name: 'ipv6', letter: '6', takesArgument: false },
  { name: 'packet', letter: '0', takesArgument: false },
  { name: 'family', letter: 'f', takesArgument: true },
  { name: 'socket', letter: 'A', takesArgument: true },
  { name: 'query', letter: 'A', takesArgument: true },
  { name: 'summary', letter: 's', takesArgument: false },
  { name: 'diag', letter: 'D', takesArgument: true },
  { name: 'filter', letter: 'F', takesArgument: true },
  { name: 'version', letter: 'V', takesArgument: false },
  { name: 'help', letter: 'h', takesArgument: false },
  { name: 'context', letter: 'Z', takesArgument: false },
  { name: 'contexts', letter: 'z', takesArgument: false },
  { name: 'net', letter: 'N', takesArgument: true },
  { name: 'tipcinfo', letter: TIPC_INFO, takesArgument: false },
  { name: 'tos', letter: TOS, takesArgument: false },
  { name: 'cgroup', letter: CGROUP, takesArgument: false },
  { name: 'kill', letter: 'K', takesArgument: false },
  { name: 'no-header', letter: 'H', takesArgument: false },
  { name: 'xdp', letter: XDP, takesArgument: false },
  { name: 'mptcp', letter: 'M', takesArgument: false },
  { name: 'oneline', letter: 'O', takesArgument: false },
  { name: 'inet-sockopt', letter: INET_SOCKOPT, takesArgument: false },
];

const OPTION_LETTERS = 'dhaletuwxnro460spbEf:mMiA:D:F:vVzZN:KHSO';

export interface SsRequest {
  readonly filter: SsFilter;
  readonly numeric: boolean;
  readonly resolveHosts: boolean;
  readonly showOptions: boolean;
  readonly showDetails: number;
  readonly showUsers: boolean;
  readonly showTcpInfo: boolean;
  readonly showTos: boolean;
  readonly showCgroup: boolean;
  readonly showInetSockopt: boolean;
  readonly showHeader: boolean;
  readonly oneline: boolean;
  readonly summary: boolean;
  readonly summaryOnly: boolean;
}

export interface SsEarlyExit {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

export interface SsParseResult {
  readonly request: SsRequest | null;
  readonly exit: SsEarlyExit | null;
}

export interface SsArgumentEnvironment extends SsParseEnvironment {
  readFilterFile(path: string): string | null;
  readonly stdin: string | undefined;
  namespaceExists(name: string): boolean;
}

function usageFailure(message: string): SsError {
  return new SsError(`${message}\n${SS_USAGE}`, 255);
}

const INCOMPLETE_COMMAND = 'Command line is not complete. Try option "help"\n';

export function parseSsArguments(args: readonly string[], environment: SsArgumentEnvironment): SsParseResult {
  const filter = new SsFilter();
  const operands: string[] = [];
  let numeric = false;
  let resolveHosts = false;
  let showOptions = false;
  let showDetails = 0;
  let showUsers = false;
  let showTcpInfo = false;
  let showTos = false;
  let showCgroup = false;
  let showInetSockopt = false;
  let showHeader = true;
  let oneline = false;
  let summary = false;
  let sawQuery = false;
  let stateFilter = 0;
  let filterFile: string | null = null;

  try {
    for (const item of shortOptions(args, OPTION_LETTERS, LONG_OPTIONS)) {
      if (item.kind === 'operand') {
        operands.push(item.value);
        continue;
      }
      if (item.kind !== 'option') throw usageFailure(getoptDiagnostic('ss', item));
      switch (item.letter) {
        case 'n': numeric = true; break;
        case 'r': resolveHosts = true; break;
        case 'o': showOptions = true; break;
        case 'e': showOptions = true; showDetails++; break;
        case 'm':
          throw new SsError('ss: -m needs socket buffer accounting (sk_rcvbuf, sk_sndbuf, skb truesize), which this TCP stack does not keep\n', 255);
        case 'i': showTcpInfo = true; break;
        case 'p': showUsers = true; break;
        case 'b': showOptions = true; break;
        case 'E':
          throw new SsError('ss: -E (--events) needs a stream of socket events, which this terminal does not provide\n', 255);
        case 'd': filter.setDatabase(DB.DCCP, true); break;
        case 't': filter.setDatabase(DB.TCP, true); break;
        case 'S': filter.setDatabase(DB.SCTP, true); break;
        case 'u': filter.setDatabase(DB.UDP, true); break;
        case 'w': filter.setDatabase(DB.RAW, true); break;
        case 'x': filter.setFamily(AF.UNIX); break;
        case VSOCK: filter.setFamily(AF.VSOCK); break;
        case TIPC: filter.setFamily(AF.TIPC); break;
        case XDP: filter.setFamily(AF.XDP); break;
        case 'a': stateFilter = SS_ALL; break;
        case 'l': stateFilter = (1 << SS.LISTEN) | (1 << SS.CLOSE); break;
        case '4': filter.setFamily(AF.INET); break;
        case '6': filter.setFamily(AF.INET6); break;
        case '0': filter.setFamily(AF.PACKET); break;
        case 'M': filter.setDatabase(DB.MPTCP, true); break;
        case 'f': {
          const families: Record<string, number> = {
            inet: AF.INET, inet6: AF.INET6, link: AF.PACKET, unix: AF.UNIX, netlink: AF.NETLINK,
            tipc: AF.TIPC, vsock: AF.VSOCK, xdp: AF.XDP,
          };
          const argument = item.argument ?? '';
          if (argument === 'help') return { request: null, exit: { stdout: SS_USAGE, stderr: '', exitCode: 0 } };
          if (!(argument in families)) throw usageFailure(`ss: "${argument}" is invalid family`);
          filter.setFamily(families[argument]);
          break;
        }
        case 'A': {
          if (!sawQuery) {
            filter.databases = 0;
            stateFilter = stateFilter !== 0 ? stateFilter : SS_CONN;
            sawQuery = true;
            filter.doDefault = false;
          }
          for (const name of (item.argument ?? '').split(',')) {
            if (!parseDatabaseName(filter, name)) throw usageFailure(`ss: "${name}" is illegal socket table id`);
          }
          break;
        }
        case 's': summary = true; break;
        case 'D':
          throw new SsError('ss: raw netlink dumps (-D) are not available in this simulator\n', 255);
        case 'F':
          if (filterFile !== null) throw new SsError('More than one filter file\n', 255);
          filterFile = item.argument ?? '';
          break;
        case 'v': case 'V':
          return { request: null, exit: { stdout: `${SS_VERSION}\n`, stderr: '', exitCode: 0 } };
        case 'z': case 'Z':
          throw new SsError('ss: SELinux is not enabled.\n', 1);
        case 'N':
          if (environment.namespaceExists(item.argument ?? '')) {
            throw new SsError('ss: sockets of a network namespace are not available in this simulator\n', 1);
          }
          throw new SsError(`Cannot open network namespace "${item.argument}": No such file or directory\n`, 1);
        case TIPC_INFO: break;
        case TOS: showTos = true; break;
        case CGROUP: showCgroup = true; break;
        case 'K': filter.kill = true; break;
        case 'H': showHeader = false; break;
        case 'O': oneline = true; break;
        case INET_SOCKOPT: showInetSockopt = true; break;
        case 'h': return { request: null, exit: { stdout: SS_USAGE, stderr: '', exitCode: 0 } };
        default: throw usageFailure('ss: invalid option');
      }
    }

    const request: SsRequest = {
      filter, numeric, resolveHosts, showOptions, showDetails, showUsers, showTcpInfo, showTos, showCgroup,
      showInetSockopt, showHeader, oneline, summary,
      summaryOnly: summary && filter.doDefault && operands.length === 0,
    };
    if (request.summaryOnly) return { request, exit: null };
    let index = 0;
    let sawStates = false;
    while (index < operands.length) {
      const word = operands[index];
      if (word === 'state') {
        if (index + 1 >= operands.length) throw new SsError(INCOMPLETE_COMMAND, 255);
        if (!sawStates) stateFilter = 0;
        stateFilter |= scanState(operands[index + 1]);
        sawStates = true;
      } else if (word === 'exclude' || word === 'excl') {
        if (index + 1 >= operands.length) throw new SsError(INCOMPLETE_COMMAND, 255);
        if (!sawStates) stateFilter = SS_ALL;
        stateFilter &= ~scanState(operands[index + 1]);
        sawStates = true;
      } else {
        break;
      }
      index += 2;
    }
    const expressionWords = operands.slice(index);

    if (filter.doDefault) {
      stateFilter = stateFilter !== 0 ? stateFilter : SS_CONN;
      parseDatabaseName(filter, 'all');
    }
    filter.setStates(stateFilter);
    filter.mergeDefaults();

    if (filter.databases === 0) {
      return { request: null, exit: { stdout: '', stderr: 'ss: no socket tables to show with such filter.\n', exitCode: 0 } };
    }
    if (filter.families === 0n) {
      return { request: null, exit: { stdout: '', stderr: 'ss: no families to show with such filter.\n', exitCode: 0 } };
    }
    if (filter.states === 0) {
      return { request: null, exit: { stdout: '', stderr: 'ss: no socket states to show with such filter.\n', exitCode: 0 } };
    }

    let words = expressionWords;
    if (filterFile !== null) {
      const text = filterFile === '-' ? environment.stdin : environment.readFilterFile(filterFile);
      if (text === null || text === undefined) {
        throw new SsError(`fopen filter file: No such file or directory\n`, 255);
      }
      words = text.split('\n').filter((line) => line !== '' && line[0] !== '#' && line[0] !== '0');
    }
    try {
      filter.expression = parseFilterExpression(words, { filter, environment });
    } catch (error) {
      if (error instanceof SsError && error.exitCode === 255) throw usageFailure(error.stderr.replace(/\n$/, ''));
      throw error;
    }
    return { request, exit: null };
  } catch (error) {
    if (error instanceof SsError) {
      return { request: null, exit: { stdout: '', stderr: error.stderr, exitCode: error.exitCode } };
    }
    throw error;
  }
}
