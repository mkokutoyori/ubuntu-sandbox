import { DSCP_CODEPOINTS, DiffServField } from '../../../../../core/IpHeaderFields';
import { getoptDiagnostic, shortOptions } from '../../Getopt';
import { NETCAT_HELP, NETCAT_USAGE } from './NetcatText';

const OPTSTRING = '46bCDdFhI:i:klM:m:NnO:P:p:q:rSs:T:tUuV:vW:w:X:x:Zz';
const INT_MAX = 2147483647;
const INT_MIN = -2147483648;
const UINT_MAX = 4294967295;
const TCP_WINDOW_MAX = 65536 << 14;
const NOT_SET = -1;

export class NetcatExit extends Error {
  constructor(readonly lines: readonly string[], readonly exitCode = 1) {
    super(lines.join('\n'));
  }
}

export type NetcatFamily = 'unspec' | 'inet' | 'inet6' | 'unix';

export interface NetcatOptions {
  family: NetcatFamily;
  broadcast: boolean;
  crlf: boolean;
  debug: boolean;
  detach: boolean;
  passDescriptor: boolean;
  keep: boolean;
  listen: boolean;
  shutdownWrite: boolean;
  numeric: boolean;
  randomize: boolean;
  md5: boolean;
  telnet: boolean;
  udp: boolean;
  dccp: boolean;
  verbose: boolean;
  zero: boolean;
  intervalSeconds: number;
  quitSeconds: number;
  ttl: number;
  minimumTtl: number;
  typeOfService: number;
  receiveBuffer: number;
  sendBuffer: number;
  receiveLimit: number;
  timeoutMs: number;
  proxyUser: string | null;
  sourcePort: string | null;
  sourceAddress: string | null;
  proxyHost: string | null;
  proxyPort: string | null;
  proxyProtocol: 'connect' | 4 | 5;
  host: string | null;
  ports: readonly string[];
}

type NumberError = 'invalid' | 'too small' | 'too large';

export function strtonum(text: string, min: number, max: number): { value: number } | { error: NumberError } {
  if (!/^\s*[+-]?\d+$/.test(text)) return { error: 'invalid' };
  const value = Number(text.trim());
  if (value < min) return { error: 'too small' };
  if (value > max) return { error: 'too large' };
  return { value };
}

function numberOption(text: string, min: number, max: number, message: (reason: NumberError) => string): number {
  const parsed = strtonum(text, min, max);
  if ('error' in parsed) throw new NetcatExit([`nc: ${message(parsed.error)}`]);
  return parsed.value;
}

const TYPE_OF_SERVICE_KEYWORDS: Readonly<Record<string, number>> = {
  ...Object.fromEntries(
    Object.entries(DSCP_CODEPOINTS)
      .filter(([name]) => name !== 'default')
      .map(([name, dscp]) => [name, dscp << DiffServField.DSCP_SHIFT])),
  critical: 0xa0, inetcontrol: 0xc0, netcontrol: 0xe0, lowcost: 0x02, lowdelay: 0x10, reliability: 0x04, throughput: 0x08,
};

function typeOfServiceOf(text: string): number {
  if (Object.prototype.hasOwnProperty.call(TYPE_OF_SERVICE_KEYWORDS, text)) return TYPE_OF_SERVICE_KEYWORDS[text];
  const parsed = text.length > 1 && text.startsWith('0x')
    ? { value: parseInt(/^[0-9a-fA-F]*/.exec(text.slice(2))![0] || '0', 16) }
    : strtonum(text, 0, 255);
  if ('error' in parsed || parsed.value > 255) throw new NetcatExit([`nc: illegal tos value ${text}`]);
  return parsed.value;
}

export function usageFailure(before: readonly string[] = []): NetcatExit {
  return new NetcatExit([...before, ...NETCAT_USAGE]);
}

function defaults(): NetcatOptions {
  return {
    family: 'unspec', broadcast: false, crlf: false, debug: false, detach: false, passDescriptor: false, keep: false, listen: false,
    shutdownWrite: false, numeric: false, randomize: false, md5: false, telnet: false, udp: false, dccp: false, verbose: false, zero: false,
    intervalSeconds: 0, quitSeconds: NOT_SET, ttl: NOT_SET, minimumTtl: NOT_SET, typeOfService: NOT_SET, receiveBuffer: 0, sendBuffer: 0,
    receiveLimit: 0, timeoutMs: NOT_SET, proxyUser: null, sourcePort: null, sourceAddress: null, proxyHost: null, proxyPort: null, proxyProtocol: 5,
    host: null, ports: [],
  };
}

function applyOption(opts: NetcatOptions, letter: string, argument: string | undefined): string | null {
  const text = argument ?? '';
  let proxy: string | null = null;
  switch (letter) {
    case '4': opts.family = 'inet'; break;
    case '6': opts.family = 'inet6'; break;
    case 'b': opts.broadcast = true; break;
    case 'U': opts.family = 'unix'; break;
    case 'X':
      if (text.toLowerCase() === 'connect') opts.proxyProtocol = 'connect';
      else if (text === '4') opts.proxyProtocol = 4;
      else if (text === '5') opts.proxyProtocol = 5;
      else throw new NetcatExit(['nc: unsupported proxy protocol']);
      break;
    case 'C': opts.crlf = true; break;
    case 'd': opts.detach = true; break;
    case 'F': opts.passDescriptor = true; break;
    case 'h': throw new NetcatExit(NETCAT_HELP, 0);
    case 'i': opts.intervalSeconds = numberOption(text, 0, UINT_MAX, (reason) => `interval ${reason}: ${text}`); break;
    case 'k': opts.keep = true; break;
    case 'l': opts.listen = true; break;
    case 'M': opts.ttl = numberOption(text, 0, 255, (reason) => `ttl is ${reason}`); break;
    case 'm': opts.minimumTtl = numberOption(text, 0, 255, (reason) => `minttl is ${reason}`); break;
    case 'N': opts.shutdownWrite = true; break;
    case 'n': opts.numeric = true; break;
    case 'P': opts.proxyUser = text; break;
    case 'p': opts.sourcePort = text; break;
    case 'q':
      opts.quitSeconds = numberOption(text, INT_MIN, INT_MAX, (reason) => `quit timer ${reason}: ${text}`);
      if (opts.quitSeconds >= 0) opts.shutdownWrite = true;
      break;
    case 'r': opts.randomize = true; break;
    case 's': opts.sourceAddress = text; break;
    case 't': opts.telnet = true; break;
    case 'u': opts.udp = true; break;
    case 'Z': opts.dccp = true; break;
    case 'V': throw new NetcatExit(['nc: no alternate routing table support available']);
    case 'v': opts.verbose = true; break;
    case 'W': opts.receiveLimit = numberOption(text, 1, INT_MAX, (reason) => `receive limit ${reason}: ${text}`); break;
    case 'w': opts.timeoutMs = numberOption(text, 0, Math.floor(INT_MAX / 1000), (reason) => `timeout ${reason}: ${text}`) * 1000; break;
    case 'x': proxy = text; break;
    case 'z': opts.zero = true; break;
    case 'D': opts.debug = true; break;
    case 'I': opts.receiveBuffer = numberOption(text, 1, TCP_WINDOW_MAX, (reason) => `TCP receive window ${reason}: ${text}`); break;
    case 'O': opts.sendBuffer = numberOption(text, 1, TCP_WINDOW_MAX, (reason) => `TCP send window ${reason}: ${text}`); break;
    case 'S': throw new NetcatExit(['nc: Unable to read TCP MD5SIG password']);
    case 'T': opts.typeOfService = typeOfServiceOf(text); break;
    default: throw usageFailure();
  }
  return proxy;
}

function splitProxy(opts: NetcatOptions, proxy: string): void {
  if (proxy.startsWith('[')) {
    const close = proxy.indexOf(']');
    if (close < 0) throw new NetcatExit(['nc: missing closing bracket in proxy']);
    opts.proxyHost = proxy.slice(1, close);
    const rest = proxy.slice(close + 1);
    if (rest === '') opts.proxyPort = null;
    else if (rest.startsWith(':')) opts.proxyPort = rest.slice(1);
    else throw new NetcatExit(['nc: garbage proxy port delimiter']);
    return;
  }
  const colon = proxy.lastIndexOf(':');
  opts.proxyHost = colon < 0 ? proxy : proxy.slice(0, colon);
  opts.proxyPort = colon < 0 ? null : proxy.slice(colon + 1);
}

function destinationOf(opts: NetcatOptions, operands: readonly string[]): void {
  const unix = opts.family === 'unix';
  if (operands.length === 0 && opts.listen) {
    opts.host = opts.sourceAddress;
    opts.ports = opts.sourcePort === null ? [] : [opts.sourcePort];
  } else if (operands.length === 1 && opts.sourcePort === null && (opts.sourceAddress === null || (unix && opts.udp && !opts.listen))) {
    if (unix) opts.host = operands[0];
    else if (opts.listen) opts.ports = [operands[0]];
  } else if (operands.length >= 2) {
    if (opts.listen && (opts.sourcePort !== null || opts.sourceAddress !== null || operands.length > 2)) throw usageFailure();
    opts.host = operands[0];
    opts.ports = operands.slice(1);
  } else {
    throw usageFailure();
  }
}

export function parseNetcatArguments(args: readonly string[]): NetcatOptions {
  const opts = defaults();
  const operands: string[] = [];
  let proxy: string | null = null;
  for (const token of shortOptions(args, OPTSTRING)) {
    if (token.kind === 'operand') operands.push(token.value);
    else if (token.kind !== 'option') throw usageFailure([getoptDiagnostic('nc', token)]);
    else proxy = applyOption(opts, token.letter, token.argument) ?? proxy;
  }
  destinationOf(opts, operands);
  if (opts.family === 'unix') {
    if (opts.dccp) throw new NetcatExit(['nc: cannot use -Z and -U']);
    if (opts.ports.length > 0 && opts.ports[0] !== '') throw new NetcatExit(['nc: cannot use port with -U']);
    if (opts.host === null) throw new NetcatExit(['nc: missing socket pathname']);
  } else if (opts.ports.length === 0 || opts.ports[0] === '') {
    throw new NetcatExit(['nc: missing port number']);
  }
  if (opts.listen && opts.zero) throw new NetcatExit(['nc: cannot use -z and -l']);
  if (!opts.listen && opts.keep) throw new NetcatExit(['nc: must use -l with -k']);
  if (opts.family === 'unix' && opts.passDescriptor) throw new NetcatExit(['nc: cannot use -F and -U']);
  if (proxy !== null) {
    if (opts.udp) throw new NetcatExit(['nc: no proxy support for UDP mode']);
    if (opts.dccp) throw new NetcatExit(['nc: no proxy support for DCCP mode']);
    if (opts.listen) throw new NetcatExit(['nc: no proxy support for listen']);
    if (opts.family === 'unix') throw new NetcatExit(['nc: no proxy support for unix sockets']);
    if (opts.sourceAddress !== null) throw new NetcatExit(['nc: no proxy support for local source address']);
    splitProxy(opts, proxy);
  }
  return opts;
}
