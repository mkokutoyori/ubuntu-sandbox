import type { SocketDestroyOutcome } from '../../../network/KernelSocketDestroy';
import type { KernelSocketRow } from '../../../network/KernelSocketRows';
import { AF, DB, familyMask } from './SsModel';
import { evaluateExpression } from './SsFilterExpression';
import { parseSsArguments, type SsArgumentEnvironment, type SsRequest } from './SsArguments';
import {
  SsRowPrinter, filterSubjectOf, socketViewOf, type SsOutputHost, type SsSocketView,
} from './SsOutput';
import { COLUMN, SsTable } from './SsTable';

export interface SsHost extends SsArgumentEnvironment, SsOutputHost {
  rows(): readonly KernelSocketRow[];
  procFile(path: string): string | null;
  destroy(row: KernelSocketRow): SocketDestroyOutcome;
  screenWidth(): number | null;
}

export interface SsResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

interface SockstatSummary {
  sockets: number;
  tcp4: number;
  tcp6: number;
  orphans: number;
  timeWait: number;
  tcpAllocated: number;
  udp4: number;
  udp6: number;
  raw4: number;
  raw6: number;
  frag4: number;
  frag6: number;
}

function emptySummary(): SockstatSummary {
  return {
    sockets: 0, tcp4: 0, tcp6: 0, orphans: 0, timeWait: 0, tcpAllocated: 0,
    udp4: 0, udp6: 0, raw4: 0, raw6: 0, frag4: 0, frag6: 0,
  };
}

function numbersIn(text: string): number[] {
  return (text.match(/-?\d+/g) ?? []).map(Number);
}

function readSockstat(text: string, summary: SockstatSummary): void {
  for (const line of text.split('\n')) {
    const space = line.indexOf(' ');
    if (space < 0) continue;
    const id = line.slice(0, space);
    const values = numbersIn(line.slice(space + 1));
    const first = values[0] ?? 0;
    switch (id) {
      case 'sockets:': summary.sockets = first; break;
      case 'UDP:': summary.udp4 = first; break;
      case 'UDP6:': summary.udp6 = first; break;
      case 'RAW:': summary.raw4 = first; break;
      case 'RAW6:': summary.raw6 = first; break;
      case 'TCP6:': summary.tcp6 = first; break;
      case 'FRAG:': summary.frag4 = first; break;
      case 'FRAG6:': summary.frag6 = first; break;
      case 'TCP:':
        summary.tcp4 = first;
        summary.orphans = values[1] ?? 0;
        summary.timeWait = values[2] ?? 0;
        summary.tcpAllocated = values[3] ?? 0;
        break;
    }
  }
}

function currentEstablished(snmp: string): number | null {
  const lines = snmp.split('\n').filter((line) => line.startsWith('Tcp:'));
  if (lines.length < 2) return null;
  const index = lines[0].split(' ').indexOf('CurrEstab');
  if (index < 0) return null;
  const value = Number(lines[1].split(' ')[index]);
  return Number.isFinite(value) ? value : null;
}

function summaryText(host: SsHost): { stdout: string; stderr: string } {
  const summary = emptySummary();
  let stderr = '';
  const sockstat = host.procFile('/proc/net/sockstat');
  if (sockstat === null) stderr += 'ss: get_sockstat: No such file or directory\n';
  else readSockstat(sockstat, summary);
  const sockstat6 = host.procFile('/proc/net/sockstat6');
  if (sockstat6 !== null) readSockstat(sockstat6, summary);
  const snmp = host.procFile('/proc/net/snmp');
  const established = snmp === null ? null : currentEstablished(snmp);
  if (established === null) stderr += 'ss: get_snmpstat: No such file or directory\n';
  const cell = (value: number): string => String(value).padEnd(9);
  const hashed = summary.tcp4 + summary.tcp6;
  const inet4 = summary.raw4 + summary.udp4 + summary.tcp4;
  const inet6 = summary.raw6 + summary.udp6 + summary.tcp6;
  const stdout = [
    `Total: ${summary.sockets}`,
    `TCP:   ${summary.tcpAllocated + summary.timeWait} (estab ${established ?? 0}, closed ${summary.tcpAllocated - (hashed - summary.timeWait)}, orphaned ${summary.orphans}, timewait ${summary.timeWait})`,
    '',
    'Transport Total     IP        IPv6',
    `RAW\t  ${cell(summary.raw4 + summary.raw6)} ${cell(summary.raw4)} ${cell(summary.raw6)}`,
    `UDP\t  ${cell(summary.udp4 + summary.udp6)} ${cell(summary.udp4)} ${cell(summary.udp6)}`,
    `TCP\t  ${cell(hashed)} ${cell(summary.tcp4)} ${cell(summary.tcp6)}`,
    `INET\t  ${cell(inet4 + inet6)} ${cell(inet4)} ${cell(inet6)}`,
    `FRAG\t  ${cell(summary.frag4 + summary.frag6)} ${cell(summary.frag4)} ${cell(summary.frag6)}`,
    '',
    '',
  ].join('\n');
  return { stdout, stderr };
}

const SOCK_DESTROY_DENIED = 'SOCK_DESTROY answers: Operation not permitted\n';

function singleBit(mask: number): boolean {
  return (mask & (mask - 1)) === 0;
}

function tablesToShow(request: SsRequest): Array<{ protocol: 'tcp' | 'udp'; database: number }> {
  const tables: Array<{ protocol: 'tcp' | 'udp'; database: number }> = [];
  const wanted = (database: number): boolean => (request.filter.databases & (1 << database)) !== 0;
  if (wanted(DB.UDP)) tables.push({ protocol: 'udp', database: DB.UDP });
  if (wanted(DB.TCP)) tables.push({ protocol: 'tcp', database: DB.TCP });
  return tables;
}

function familiesToWalk(request: SsRequest): Array<4 | 6> {
  if (request.filter.preferredFamily === AF.INET6) return [6];
  if (request.filter.preferredFamily === AF.INET) return [4];
  return [4, 6];
}

export function runSs(args: readonly string[], host: SsHost): SsResult {
  const parsed = parseSsArguments(args, host);
  if (parsed.exit !== null) return parsed.exit;
  const request = parsed.request as SsRequest;
  let stdout = '';
  let stderr = '';
  if (request.summary) {
    const summary = summaryText(host);
    stdout += summary.stdout;
    stderr += summary.stderr;
    if (request.summaryOnly) return { stdout, stderr, exitCode: 0 };
  }

  const table = new SsTable();
  if (singleBit(request.filter.databases)) table.disable(COLUMN.NETID);
  if (singleBit(request.filter.states)) table.disable(COLUMN.STATE);
  if (request.showHeader) table.printHeader();

  const printer = new SsRowPrinter(table, request, host);
  const rows = host.rows();
  for (const { protocol } of tablesToShow(request)) {
    let killDenied = false;
    for (const family of familiesToWalk(request)) {
      const familyBit = familyMask(family === 6 ? AF.INET6 : AF.INET);
      if ((request.filter.families & familyBit) === 0n) continue;
      for (const row of rows) {
        const view = socketViewOf(row);
        if (view === null || view.protocol !== protocol || view.family !== family) continue;
        if (!selected(view, request, host)) continue;
        if (request.filter.kill && !killDenied) {
          const outcome = host.destroy(row);
          if (outcome === 'unsupported' || outcome === 'gone') continue;
          if (outcome === 'denied') {
            stderr += SOCK_DESTROY_DENIED.repeat(2);
            killDenied = true;
          }
        }
        printer.printRow(view);
      }
    }
  }
  stdout += table.render(host.screenWidth());
  return { stdout, stderr, exitCode: 0 };
}

function selected(view: SsSocketView, request: SsRequest, host: SsHost): boolean {
  if ((request.filter.states & (1 << view.state)) === 0) return false;
  if (request.filter.expression === null) return true;
  const { low, high } = host.ephemeralPorts();
  return evaluateExpression(
    request.filter.expression, filterSubjectOf(view, (name) => host.interfaceIndex(name)),
    (port) => port >= low && port <= high,
  );
}

