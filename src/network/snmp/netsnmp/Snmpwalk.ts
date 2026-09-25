import { IPAddress } from '../../core/types';
import { PortNumber } from '../../core/ports/PortNumber';
import type { SnmpClientSession } from '../SnmpClientSession';
import type { SnmpExchange, SnmpQuery, SnmpQueryPdu } from '../SnmpManager';
import {
  oidCompare, SNMP_ERROR_STATUS, UDP_PORT_SNMP,
  type SnmpErrorStatus, type SnmpVarBinding,
} from '../types';
import { formatObjectIdentifier, formatVariable, isExceptionValue } from './NetSnmpOutput';
import { netSnmpMibSearchPath, parseObjectIdentifier } from './NetSnmpOid';
import {
  parseNetSnmpArguments, type NetSnmpApplication, type NetSnmpOutcome,
} from './NetSnmpArguments';

export interface NetSnmpHost {
  resolveHostname(name: string): Promise<IPAddress | null>;
  openSession(processName: string): SnmpClientSession | null;
  homeDirectory(): string;
}

const DEFAULT_WALK_ROOT = '1.3.6.1.2.1';

const ERROR_STATUS_TEXT: readonly string[] = [
  '(noError) No Error',
  '(tooBig) Response message would have been too large.',
  '(noSuchName) There is no such variable name in this MIB.',
  '(badValue) The value given has the wrong type or length.',
  '(readOnly) The two parties used do not have access to use the specified SNMP PDU.',
  '(genError) A general failure occurred',
  'noAccess',
  'wrongType (The set datatype does not match the data type the agent expects)',
  'wrongLength (The set value has an illegal length from what the agent expects)',
  'wrongEncoding',
  'wrongValue (The set value is illegal or unsupported in some way)',
  'noCreation (That table does not support row creation or that object can not ever be created)',
  'inconsistentValue (The set value is illegal or unsupported in some way)',
  'resourceUnavailable (This is likely a out-of-memory failure within the agent)',
  'commitFailed',
  'undoFailed',
  'authorizationError (access denied to that object)',
  'notWritable (That object does not support modification)',
  'inconsistentName (That object can not currently be created)',
];

function errorStatusText(status: SnmpErrorStatus): string {
  return ERROR_STATUS_TEXT[SNMP_ERROR_STATUS[status]] ?? 'Unknown Error';
}

const SNMPWALK_APPLICATION_USAGE: readonly string[] = [
  '  -C APPOPTS\t\tSet various application specific behaviours:',
  '\t\t\t  p:  print the number of variables found',
  '\t\t\t  i:  include given OID in the search range',
  "\t\t\t  I:  don't include the given OID, even if no results are returned",
  '\t\t\t  c:  do not check returned OIDs are increasing',
  '\t\t\t  t:  Display wall-clock time to complete the walk',
  '\t\t\t  T:  Display wall-clock time to complete each request',
  '\t\t\t  E {OID}:  End the walk at the specified OID',
];

interface WalkBehaviour {
  includeRequested: boolean;
  dontGetRequested: boolean;
  printStatistics: boolean;
  dontCheckOrdering: boolean;
  timeResults: boolean;
  timeResultsSingle: boolean;
  endName: string | null;
}

type PeerAddress =
  | { readonly kind: 'udp'; readonly host: string; readonly port: PortNumber }
  | { readonly kind: 'unreadable' }
  | { readonly kind: 'refused'; readonly reason: string };

const OTHER_TRANSPORT_DOMAINS = new Set([
  'tcp', 'udp6', 'tcp6', 'udpv6', 'tcpv6', 'udpipv6', 'tcpipv6', 'unix', 'ipx',
  'aal5pvc', 'pvc', 'tls', 'dtls', 'dtlsudp', 'tlstcp', 'ssh', 'callback', 'alias',
]);

function parsePeer(peername: string): PeerAddress {
  let address = peername;
  const domain = /^([A-Za-z0-9]+):/.exec(peername)?.[1]?.toLowerCase();
  if (domain === 'udp' || domain === 'udpv4' || domain === 'udpipv4') {
    address = peername.slice(domain.length + 1);
  } else if (domain !== undefined && OTHER_TRANSPORT_DOMAINS.has(domain)) {
    return { kind: 'refused', reason: `the ${domain} transport domain is not simulated (SNMP travels over UDP/IPv4 here)` };
  }
  if (address.startsWith('[')) {
    return { kind: 'refused', reason: 'SNMP over IPv6 is not simulated (the agents listen on IPv4 only)' };
  }
  const colon = address.lastIndexOf(':');
  if (colon === -1) return address === '' ? { kind: 'unreadable' } : { kind: 'udp', host: address, port: PortNumber.of(UDP_PORT_SNMP) };
  const port = PortNumber.tryParse(address.slice(colon + 1));
  const host = address.slice(0, colon);
  if (!port || host === '' || host.includes(':')) return { kind: 'unreadable' };
  return { kind: 'udp', host, port };
}

function successorOf(oid: string): string {
  const subIds = oid.split('.');
  subIds[subIds.length - 1] = (BigInt(subIds[subIds.length - 1]) + 1n).toString();
  return subIds.join('.');
}

function seconds(elapsedMs: number): string {
  return (elapsedMs / 1000).toFixed(6);
}

export async function runSnmpwalk(host: NetSnmpHost, argv: readonly string[]): Promise<NetSnmpOutcome> {
  const walk: WalkBehaviour = {
    includeRequested: false, dontGetRequested: false, printStatistics: false,
    dontCheckOrdering: false, timeResults: false, timeResultsSingle: false, endName: null,
  };
  const application: NetSnmpApplication = {
    name: 'snmpwalk',
    operandsUsage: ' [OID]',
    optionLetters: 'C',
    applicationUsage: SNMPWALK_APPLICATION_USAGE,
    applicationOption: (_letter, flags, takeNext) => {
      for (const flag of flags) {
        switch (flag) {
          case 'i': walk.includeRequested = !walk.includeRequested; break;
          case 'I': walk.dontGetRequested = !walk.dontGetRequested; break;
          case 'p': walk.printStatistics = !walk.printStatistics; break;
          case 'c': walk.dontCheckOrdering = !walk.dontCheckOrdering; break;
          case 't': walk.timeResults = !walk.timeResults; break;
          case 'T': walk.timeResultsSingle = !walk.timeResultsSingle; break;
          case 'E': walk.endName = takeNext() ?? null; break;
          default: return `Unknown flag passed to -C: ${flag}`;
        }
      }
      return null;
    },
  };

  const home = host.homeDirectory();
  const parsed = parseNetSnmpArguments(argv, application, home);
  if (parsed.kind === 'finished') return parsed.outcome;
  const { options, peername, operands } = parsed;

  const stdout: string[] = [];
  const stderr: string[] = [];
  const log = (line: string): void => {
    if (options.log === 'stderr') stderr.push(line);
    else if (options.log === 'stdout') stdout.push(line);
  };
  const outcome = (exitCode: number): NetSnmpOutcome =>
    ({ stdout: stdout.join('\n'), stderr: stderr.join('\n'), exitCode });

  const mibSearchPath = netSnmpMibSearchPath(home);
  let root = DEFAULT_WALK_ROOT;
  if (operands.length > 0) {
    const requested = parseObjectIdentifier(operands[0], mibSearchPath);
    if (requested.kind === 'unknown') {
      requested.diagnostics.forEach(log);
      return outcome(1);
    }
    root = requested.oid;
  }
  let end = successorOf(root);
  if (walk.endName !== null) {
    const requested = parseObjectIdentifier(walk.endName, mibSearchPath);
    if (requested.kind === 'unknown') {
      requested.diagnostics.forEach(log);
      return outcome(1);
    }
    end = requested.oid;
  }

  if (options.version === 'v3') {
    stderr.push('snmpwalk: SNMPv3 is not simulated (no USM security model, no engine ID discovery); use -v 1 or -v 2c');
    return outcome(1);
  }
  const peer = parsePeer(peername);
  if (peer.kind === 'refused') {
    stderr.push(`snmpwalk: ${peer.reason}`);
    return outcome(1);
  }
  const server = peer.kind === 'udp' ? await host.resolveHostname(peer.host) : null;
  const session = server && peer.kind === 'udp' ? host.openSession('snmpwalk') : null;
  if (!server || !session || peer.kind !== 'udp') {
    log(`snmpwalk: Unknown host (${peername})`);
    return outcome(1);
  }

  const print = (binding: SnmpVarBinding, prefix = ''): void => {
    stdout.push(prefix + formatVariable(binding, options.output));
  };
  const request = (pduType: SnmpQueryPdu, oid: string): Promise<SnmpExchange> => {
    const query: SnmpQuery = {
      server, port: peer.port, community: options.community ?? '',
      version: options.version === 'v1' ? 'v1' : 'v2c', pduType, oids: [oid],
    };
    return session.exchange(query, { timeoutMs: options.timeoutMs, retries: options.retries });
  };
  let numberPrinted = 0;
  const getAndPrint = async (oid: string): Promise<void> => {
    const answer = await request('get-request', oid);
    if (answer.kind !== 'response' || answer.packet.errorStatus !== 'no-error') return;
    for (const binding of answer.packet.varBindings) {
      numberPrinted++;
      print(binding);
    }
  };

  let exitCode = 0;
  let last: SnmpExchange['kind'] = 'unsent';
  try {
    if (walk.includeRequested) await getAndPrint(root);
    const startedAt = session.now();
    let name = root;
    let running = true;
    while (running) {
      const askedAt = session.now();
      const answer = await request('get-next-request', name);
      last = answer.kind;
      if (answer.kind === 'timeout') {
        stderr.push(`Timeout: No Response from ${peername}`);
        exitCode = 1;
        break;
      }
      if (answer.kind !== 'response') {
        log('snmpwalk: Failure in sendto (Network is unreachable)');
        exitCode = 1;
        break;
      }
      const answeredAt = session.now();
      const response = answer.packet;
      if (response.errorStatus !== 'no-error') {
        running = false;
        if (response.errorStatus === 'no-such-name') {
          stdout.push('End of MIB');
        } else {
          stderr.push('Error in packet.');
          stderr.push(`Reason: ${errorStatusText(response.errorStatus)}`);
          if (response.errorIndex !== 0) {
            const failed = response.varBindings[response.errorIndex - 1];
            stderr.push(`Failed object: ${failed ? formatObjectIdentifier(failed.oid, options.output) : ''}`);
          }
          exitCode = 2;
        }
        continue;
      }
      for (const binding of response.varBindings) {
        if (oidCompare(end, binding.oid) <= 0) {
          running = false;
          continue;
        }
        numberPrinted++;
        print(binding, walk.timeResultsSingle ? `${seconds(answeredAt - askedAt)} s: ` : '');
        if (isExceptionValue(binding.value)) {
          running = false;
          continue;
        }
        if (!walk.dontCheckOrdering && oidCompare(name, binding.oid) >= 0) {
          stderr.push(`Error: OID not increasing: ${formatObjectIdentifier(name, options.output)} >= ${formatObjectIdentifier(binding.oid, options.output)}`);
          running = false;
          exitCode = 1;
        }
        name = binding.oid;
      }
    }
    const finishedAt = session.now();
    if (numberPrinted === 0 && last === 'response' && !walk.dontGetRequested) await getAndPrint(root);
    if (walk.printStatistics) stdout.push(`Variables found: ${numberPrinted}`);
    if (walk.timeResults) stderr.push(`Total traversal time = ${seconds(finishedAt - startedAt)} seconds`);
  } finally {
    session.close();
  }
  return outcome(exitCode);
}
