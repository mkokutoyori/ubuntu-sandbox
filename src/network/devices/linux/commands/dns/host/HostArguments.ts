import { DnsClass, RRType } from '@/network/dns/wire/RRType';
import { rrClassFromName, rrTypeFromName } from '@/network/dns/compat/DnsWireCompat';
import { bindVersion } from '../BindVersion';

export const HOST_USAGE = [
  'Usage: host [-aCdilrTvVw] [-c class] [-N ndots] [-t type] [-W time]',
  '            [-R number] [-m flag] [-p port] hostname [server]',
  '       -a is equivalent to -v -t ANY',
  '       -A is like -a but omits RRSIG, NSEC, NSEC3',
  '       -c specifies query class for non-IN data',
  '       -C compares SOA records on authoritative nameservers',
  '       -d is equivalent to -v',
  '       -l lists all hosts in a domain, using AXFR',
  '       -m set memory debugging flag (trace|record|usage)',
  '       -N changes the number of dots allowed before root lookup is done',
  '       -p specifies the port on the server to query',
  '       -r disables recursive processing',
  '       -R specifies number of retries for UDP packets',
  '       -s a SERVFAIL response should stop query',
  '       -t specifies the query type',
  '       -T enables TCP/IP mode',
  '       -U enables UDP mode',
  '       -v enables verbose output',
  '       -V print version number and exit',
  '       -w specifies to wait forever for a reply',
  '       -W specifies how long to wait for a reply',
  '       -4 use IPv4 query transport only',
  '       -6 use IPv6 query transport only',
  '',
].join('\n');

const OPTIONS_WITH_ARGUMENT = new Set(['c', 'm', 'p', 'N', 'R', 't', 'W']);
const OPTIONS_WITHOUT_ARGUMENT = new Set(['4', '6', 'a', 'A', 'd', 'i', 'l', 'n', 'r', 's', 'v', 'V', 'w', 'C', 'D', 'T', 'U']);
const DEFAULT_TRIES = 2;
const IXFR_PREFIX = 'ixfr=';
const PORT_MASK = 0xffff;
const EXIT_INVALID_NAME = 2;
const EXIT_LIST_FAILURE = 3;

export interface HostOptions {
  readonly verbose: boolean;
  readonly recurse: boolean;
  readonly rdtype: number | null;
  readonly rdclass: number;
  readonly ixfrSerial: number;
  readonly tcp: boolean;
  readonly tcpExplicit: boolean;
  readonly listAddresses: boolean;
  readonly listAlmostAll: boolean;
  readonly listType: number;
  readonly defaultLookups: boolean;
  readonly servfailStops: boolean;
  readonly nameserverSearch: boolean;
  readonly timeoutSeconds: number | null;
  readonly tries: number;
  readonly ndots: number | null;
  readonly port: number | null;
  readonly ipv4Only: boolean;
  readonly ipv6Only: boolean;
  readonly fatalExit: number;
  readonly hostname: string;
  readonly server: string | null;
}

export type HostArguments =
  | { readonly kind: 'options'; readonly options: HostOptions }
  | { readonly kind: 'exit'; readonly stdout: string; readonly stderr: string; readonly status: number };

interface ParsedOption {
  readonly letter: string;
  readonly value: string;
}

interface Scan {
  readonly parsed: readonly ParsedOption[];
  readonly operands: readonly string[];
  readonly failure: string | null;
}

function scanArguments(args: readonly string[]): Scan {
  const parsed: ParsedOption[] = [];
  let index = 0;
  while (index < args.length) {
    const word = args[index];
    if (word[0] !== '-' || word.length === 1) break;
    if (word === '--') {
      index += 1;
      break;
    }
    index += 1;
    for (let position = 1; position < word.length; position++) {
      const letter = word[position];
      if (OPTIONS_WITH_ARGUMENT.has(letter)) {
        const attached = word.slice(position + 1);
        if (attached !== '') {
          parsed.push({ letter, value: attached });
        } else if (index < args.length) {
          parsed.push({ letter, value: args[index] });
          index += 1;
        } else {
          return { parsed, operands: [], failure: `host: option requires an argument -- ${letter}\n` };
        }
        break;
      }
      if (!OPTIONS_WITHOUT_ARGUMENT.has(letter)) return { parsed, operands: [], failure: `host: illegal option -- ${letter}\n` };
      parsed.push({ letter, value: '' });
    }
  }
  return { parsed, operands: args.slice(index), failure: null };
}

function atoi(text: string): number {
  const match = /^\s*[+-]?\d+/.exec(text);
  return match === null ? 0 : Number.parseInt(match[0], 10);
}

const exited = (stderr: string, status: number): HostArguments => ({ kind: 'exit', stdout: '', stderr, status });
const fatal = (message: string, status: number): HostArguments => exited(`host: ${message}\n`, status);

export interface HostEnvironment {
  readonly ipv6: boolean;
}

export function parseHostArguments(args: readonly string[], environment: HostEnvironment): HostArguments {
  const scan = scanArguments(args);
  let ipv4Only = false;
  let ipv6Only = false;
  for (const { letter } of scan.parsed) {
    if (letter === '4') {
      if (ipv6Only) return fatal('only one of -4 and -6 allowed', 1);
      ipv4Only = true;
    } else if (letter === '6') {
      if (ipv4Only) return fatal('only one of -4 and -6 allowed', 1);
      ipv6Only = true;
    } else if (letter === 'V') {
      return exited(`host ${bindVersion()}\n`, 0);
    }
  }
  if (scan.failure !== null) return exited(`${scan.failure}${HOST_USAGE}`, 1);
  if (ipv6Only && !environment.ipv6) return fatal("can't find IPv6 networking", 1);

  let verbose = false;
  let recurse = true;
  let rdtype: number | null = null;
  let rdclass: number = DnsClass.IN;
  let ixfrSerial = 0;
  let tcp = false;
  let tcpExplicit = false;
  let listAddresses = true;
  let listAlmostAll = false;
  let listType: number = RRType.A;
  let defaultLookups = true;
  let servfailStops = false;
  let nameserverSearch = false;
  let timeoutSeconds: number | null = null;
  let tries = DEFAULT_TRIES;
  let ndots: number | null = null;
  let port: number | null = null;
  let fatalExit = 1;

  for (const { letter, value } of scan.parsed) {
    switch (letter) {
      case 'l':
        tcp = true;
        rdtype = RRType.AXFR;
        fatalExit = EXIT_LIST_FAILURE;
        break;
      case 'v':
      case 'd':
        verbose = true;
        break;
      case 'r':
        recurse = false;
        break;
      case 't': {
        let type: number | null;
        if (value.toLowerCase().startsWith(IXFR_PREFIX)) {
          type = RRType.IXFR;
          ixfrSerial = atoi(value.slice(IXFR_PREFIX.length)) >>> 0;
        } else {
          type = rrTypeFromName(value);
        }
        if (type === null) return fatal(`invalid type: ${value}\n`, EXIT_INVALID_NAME);
        if (rdtype === null || rdtype !== RRType.AXFR) rdtype = type;
        if (type === RRType.AXFR) {
          listType = RRType.ANY;
          verbose = true;
          tcp = true;
        } else if (type === RRType.IXFR) {
          tcp = true;
          listType = type;
        } else if (type === RRType.ANY) {
          if (!tcpExplicit) tcp = true;
        } else {
          listType = type;
        }
        listAddresses = false;
        defaultLookups = false;
        break;
      }
      case 'c': {
        const parsedClass = rrClassFromName(value);
        if (parsedClass === null) return fatal(`invalid class: ${value}\n`, EXIT_INVALID_NAME);
        rdclass = parsedClass;
        defaultLookups = false;
        break;
      }
      case 'A':
      case 'a':
        if (letter === 'A') listAlmostAll = true;
        if (rdtype === null || rdtype !== RRType.AXFR) rdtype = RRType.ANY;
        listType = RRType.ANY;
        listAddresses = false;
        verbose = true;
        defaultLookups = false;
        break;
      case 'w':
        timeoutSeconds = Number.POSITIVE_INFINITY;
        break;
      case 'W':
        timeoutSeconds = Math.max(1, atoi(value));
        break;
      case 'R':
        tries = Math.max(DEFAULT_TRIES, atoi(value) + 1);
        break;
      case 'T':
        tcp = true;
        tcpExplicit = true;
        break;
      case 'U':
        tcp = false;
        tcpExplicit = true;
        break;
      case 'C':
        rdtype = RRType.NS;
        rdclass = DnsClass.IN;
        nameserverSearch = true;
        defaultLookups = false;
        break;
      case 'N': {
        const dots = atoi(value);
        ndots = dots === -1 ? null : dots;
        break;
      }
      case 's':
        servfailStops = true;
        break;
      case 'p':
        port = atoi(value) & PORT_MASK;
        break;
      default:
        break;
    }
  }

  if (scan.operands.length === 0) return exited(HOST_USAGE, 1);
  return {
    kind: 'options',
    options: {
      verbose, recurse, rdtype, rdclass, ixfrSerial, tcp, tcpExplicit, listAddresses, listAlmostAll, listType, defaultLookups,
      servfailStops, nameserverSearch, timeoutSeconds, tries, ndots, port, ipv4Only, ipv6Only, fatalExit,
      hostname: scan.operands[0], server: scan.operands[1] ?? null,
    },
  };
}
