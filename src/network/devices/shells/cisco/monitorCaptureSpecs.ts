import type { ArgumentSpec, EnumValue } from '@/cli/ArgumentTypes';
import type { CommandSpec } from '@/cli/CommandTable';
import {
  compileCaptureExpression, type CapturePredicate, type CaptureWay, type EmbeddedCaptureService,
  type CaptureBuffer, type CapturePoint,
} from '@/network/capture/EmbeddedCapture';
import type { CaptureFrame } from '@/network/devices/linux/network/tcpdump/CaptureFrame';
import { iosShortInterfaceName } from '@/network/devices/inspection/InterfaceStatusView';
import { CliInvalidInput } from '../cli/CliDiagnostic';

export interface MonitorCaptureHost {
  service(): EmbeddedCaptureService;
  resolveInterface(text: string): string | null;
  accessListFilter(name: string): CapturePredicate | null;
  exportCapture(destination: string, content: string): string;
  clockText(at: Date): string;
}

const PRIVILEGED = Object.freeze(['privileged']);

const NAME = (description: string): ArgumentSpec => ({ name: 'name', type: 'WORD', description });

const WAYS: readonly EnumValue[] = [
  { keyword: 'both', description: 'Monitor in both directions' },
  { keyword: 'in', description: 'Monitor input traffic' },
  { keyword: 'out', description: 'Monitor output traffic' },
];

const PROCESS_WAYS: readonly EnumValue[] = [
  { keyword: 'both', description: 'Monitor in both directions' },
  { keyword: 'from-us', description: 'Monitor traffic originated by this device' },
  { keyword: 'to-us', description: 'Monitor traffic destined to this device' },
];

const EXPLAIN = (message: string): string => `% ${message}`;

function wayOf(word: string): CaptureWay {
  if (word === 'from-us') return 'out';
  if (word === 'to-us') return 'in';
  return word as CaptureWay;
}

function outcomeText(outcome: { ok: true } | { ok: false; reason: string }): string {
  return outcome.ok === false ? EXPLAIN(outcome.reason) : '';
}

function integerOf(word: string | undefined, low: number, high: number): number {
  const value = Number(word);
  if (word === undefined || !Number.isInteger(value) || value < low || value > high) {
    throw new CliInvalidInput({ token: word });
  }
  return value;
}

function applyBufferWords(buffer: CaptureBuffer, words: string[], host: MonitorCaptureHost): string {
  for (let index = 0; index < words.length; index++) {
    const word = words[index];
    const next = words[index + 1];
    switch (word) {
      case 'size': buffer.sizeBytes = integerOf(next, 1, 100000) * 1024; index++; break;
      case 'max-size': buffer.maxElementBytes = integerOf(next, 1, 9500); index++; break;
      case 'circular': buffer.circular = true; break;
      case 'linear': buffer.circular = false; break;
      case 'clear': host.service().clear(buffer.name); break;
      case 'filter': index = applyFilter(buffer, words, index, host); break;
      case 'limit': index = applyLimits(buffer, words, index); break;
      default: throw new CliInvalidInput({ token: word });
    }
  }
  return '';
}

function applyFilter(buffer: CaptureBuffer, words: string[], at: number, host: MonitorCaptureHost): number {
  const kind = words[at + 1];
  if (kind === 'access-list') {
    const name = words[at + 2];
    if (name === undefined) throw new CliInvalidInput({ token: undefined });
    const predicate = host.accessListFilter(name);
    if (predicate === null) throw new CliInvalidInput({ token: name });
    buffer.filter = { label: `access-list ${name}`, matches: predicate };
    return at + 2;
  }
  if (kind === 'pcap') {
    const expression = words.slice(at + 2).join(' ');
    const compiled = compileCaptureExpression(expression);
    if (typeof compiled === 'string') throw new CliInvalidInput({ token: words[at + 2] });
    buffer.filter = compiled;
    return words.length;
  }
  throw new CliInvalidInput({ token: kind });
}

function applyLimits(buffer: CaptureBuffer, words: string[], at: number): number {
  let index = at + 1;
  for (; index < words.length; index += 2) {
    const key = words[index];
    const value = words[index + 1];
    if (key === 'duration') buffer.limits.duration = integerOf(value, 1, 2147483);
    else if (key === 'packets') buffer.limits.packets = integerOf(value, 1, 2147483647);
    else if (key === 'pps') buffer.limits.packetsPerSecond = integerOf(value, 1, 1000000);
    else if (key === 'packet-len') buffer.maxElementBytes = integerOf(value, 64, 9500);
    else break;
  }
  return index - 1;
}

function bufferKind(buffer: CaptureBuffer): string {
  return buffer.circular ? 'circular buffer' : 'linear buffer';
}

function parametersText(buffer: CaptureBuffer, service: EmbeddedCaptureService): string[] {
  const lines = [
    `Capture buffer ${buffer.name} (${bufferKind(buffer)})`,
    `Buffer Size : ${buffer.sizeBytes} bytes, Max Element Size : ${buffer.maxElementBytes} bytes, Packets : ${buffer.frames.length}`,
    `Allow-nth-pak : 0, Duration : ${buffer.limits.duration} (seconds), Max packets : ${buffer.limits.packets}, pps : ${buffer.limits.packetsPerSecond}`,
  ];
  if (buffer.filter !== null) lines.push(`Associated Filter: ${buffer.filter.label}`);
  lines.push('Associated Capture Points:');
  for (const point of service.pointsOf(buffer.name)) {
    lines.push(`Name : ${point.name}, Status : ${point.active ? 'Active' : 'Inactive'}`);
  }
  lines.push('Configuration:', configurationOf(buffer));
  for (const point of service.pointsOf(buffer.name)) {
    lines.push(`monitor capture point associate ${point.name} ${buffer.name}`);
  }
  return lines;
}

function configurationOf(buffer: CaptureBuffer): string {
  const parts = [`monitor capture buffer ${buffer.name}`, `size ${Math.round(buffer.sizeBytes / 1024)}`,
    `max-size ${buffer.maxElementBytes}`, buffer.circular ? 'circular' : 'linear'];
  return parts.join(' ');
}

const ASCII = (bytes: readonly number[]): string =>
  bytes.map((byte) => (byte >= 0x20 && byte <= 0x7e ? String.fromCharCode(byte) : '.')).join('');

function dumpFrame(stored: { frame: CaptureFrame }, host: MonitorCaptureHost, ordinal: number): string[] {
  const frame = stored.frame;
  const bytes = frame.raw.slice(frame.rawLinkOffset);
  const family = frame.l3 === 'ipv4' ? 'IPv4' : frame.l3 === 'ipv6' ? 'IPv6' : frame.l3 === 'arp' ? 'ARP' : 'Other';
  const ingress = frame.direction === 'in' ? iosShortInterfaceName(frame.iface) : 'None';
  const egress = frame.direction === 'out' ? iosShortInterfaceName(frame.iface) : 'None';
  const lines = [`${host.clockText(frame.at)} : ${family} | CEF   : ${ingress} None => ${egress} None`, ''];
  for (let offset = 0; offset < bytes.length; offset += 16) {
    const row = bytes.slice(offset, offset + 16);
    const words: string[] = [];
    for (let index = 0; index < 16; index += 4) {
      const group = row.slice(index, index + 4);
      words.push(group.map((byte) => byte.toString(16).padStart(2, '0')).join('').toUpperCase().padEnd(8, ' '));
    }
    const address = (0x0F7CF5D0 + ordinal * 0x100 + offset).toString(16).toUpperCase().padStart(8, '0');
    lines.push(`${address}: ${words.join(' ')}  ${ASCII(row)}`);
  }
  lines.push('');
  return lines;
}

function bufferViews(host: MonitorCaptureHost, name: string | undefined, view: string | undefined): string {
  const service = host.service();
  const selected = name === undefined || name === 'all' ? service.bufferNames() : [name];
  const lines: string[] = [];
  for (const bufferName of selected) {
    const buffer = service.buffer(bufferName);
    if (buffer === undefined) return EXPLAIN(`Capture buffer ${bufferName} does not exist`);
    if (view === 'dump') {
      buffer.frames.forEach((stored, index) => lines.push(...dumpFrame(stored, host, index)));
    } else if (view === 'detail') {
      lines.push(...parametersText(buffer, service));
      buffer.frames.forEach((stored, index) => lines.push(...dumpFrame(stored, host, index)));
    } else {
      lines.push(...parametersText(buffer, service));
    }
  }
  return lines.join('\n');
}

function pointText(point: CapturePoint, service: EmbeddedCaptureService): string[] {
  const way = point.way;
  const lines = [
    `Status Information for Capture Point ${point.name}`,
    point.kind === 'ip process-switched' ? 'IPv4 Process' : 'IPv4 CEF',
    `Switch Path: ${point.kind === 'ip process-switched' ? 'IPv4 Process' : 'IPv4 CEF'}            , Applied Interface: ${point.iface}, Direction: ${way}`,
    `Status : ${point.active ? 'Active' : 'Inactive'}`,
  ];
  if (point.buffer !== null && service.buffer(point.buffer) !== undefined) lines.push(`Associated Buffer: ${point.buffer}`);
  if (point.stopReason !== null) lines.push(`Last stop reason: ${point.stopReason}`);
  lines.push('Configuration:', point.kind === 'ip process-switched'
    ? `monitor capture point ip process-switched ${point.name} ${way === 'out' ? 'from-us' : way === 'in' ? 'to-us' : 'both'}`
    : `monitor capture point ip cef ${point.name} ${point.iface} ${way}`);
  return lines;
}

function pointViews(host: MonitorCaptureHost, name: string | undefined): string {
  const service = host.service();
  const selected = name === undefined || name === 'all' ? service.pointNames() : [name];
  const lines: string[] = [];
  for (const pointName of selected) {
    const point = service.point(pointName);
    if (point === undefined) return EXPLAIN(`Capture point ${pointName} does not exist`);
    lines.push(...pointText(point, service), '');
  }
  return lines.join('\n').trimEnd();
}

function forEachPoint(host: MonitorCaptureHost, name: string, act: (point: string) => string): string {
  const service = host.service();
  if (name !== 'all') return act(name);
  const messages = service.pointNames().map(act).filter((message) => message !== '');
  return messages.join('\n');
}

export function monitorCaptureSpecs(host: () => MonitorCaptureHost): CommandSpec[] {
  const service = (): EmbeddedCaptureService => host().service();
  return [
    {
      id: 'monitor-capture-buffer',
      path: ['monitor', 'capture', 'buffer', NAME('Capture buffer name'),
        { name: 'options', type: 'REST', optional: true, literal: 'LINE', description: 'size, max-size, circular, linear, filter, limit, clear' }],
      description: 'Configure a capture buffer',
      modes: PRIVILEGED, minPrivilege: 15,
      run: (_session, args) => {
        const buffer = service().defineBuffer(args.name);
        const words = (args.options ?? '').trim().split(/\s+/).filter(Boolean);
        return applyBufferWords(buffer, words, host());
      },
      undo: (_session, args) => outcomeText(service().removeBuffer(args.name)),
    },
    {
      id: 'monitor-capture-buffer-export',
      path: ['monitor', 'capture', 'buffer', NAME('Capture buffer name'), 'export',
        { name: 'destination', type: 'WORD', description: 'Destination URL or file (flash:, tftp:)' }],
      description: 'Export a capture buffer to a file or a server',
      modes: PRIVILEGED, minPrivilege: 15,
      run: (_session, args) => {
        const content = service().exportFile(args.name);
        if (content === null) return EXPLAIN(`Capture buffer ${args.name} does not exist`);
        return host().exportCapture(args.destination, content);
      },
    },
    {
      id: 'monitor-capture-point-ip-cef',
      path: ['monitor', 'capture', 'point', 'ip', 'cef', NAME('Capture point name'),
        { name: 'interface', type: 'WORD', description: 'Interface to capture on' },
        { name: 'way', type: 'WORD', description: 'Direction', alternatives: WAYS, formsAreExhaustive: true }],
      description: 'Define a CEF capture point',
      modes: PRIVILEGED, minPrivilege: 15,
      run: (_session, args) => {
        const iface = host().resolveInterface(args.interface);
        if (iface === null) throw new CliInvalidInput({ token: args.interface });
        return outcomeText(service().definePoint(args.name, 'ip cef', iface, wayOf(args.way)));
      },
    },
    {
      id: 'monitor-capture-point-ip-cef-undo',
      path: ['monitor', 'capture', 'point', 'ip', 'cef', NAME('Capture point name')],
      description: 'Remove a CEF capture point',
      modes: PRIVILEGED, minPrivilege: 15,
      existsOnlyNegated: true,
      run: () => '',
      undo: (_session, args) => outcomeText(service().removePoint(args.name)),
    },
    {
      id: 'monitor-capture-point-ip-process-switched',
      path: ['monitor', 'capture', 'point', 'ip', 'process-switched', NAME('Capture point name'),
        { name: 'way', type: 'WORD', description: 'Direction', alternatives: PROCESS_WAYS, formsAreExhaustive: true }],
      description: 'Define a process-switched capture point',
      modes: PRIVILEGED, minPrivilege: 15,
      run: (_session, args) => outcomeText(service().definePoint(args.name, 'ip process-switched', 'any', wayOf(args.way))),
    },
    {
      id: 'monitor-capture-point-ip-process-switched-undo',
      path: ['monitor', 'capture', 'point', 'ip', 'process-switched', NAME('Capture point name')],
      description: 'Remove a process-switched capture point',
      modes: PRIVILEGED, minPrivilege: 15,
      existsOnlyNegated: true,
      run: () => '',
      undo: (_session, args) => outcomeText(service().removePoint(args.name)),
    },
    {
      id: 'monitor-capture-point-associate',
      path: ['monitor', 'capture', 'point', 'associate', NAME('Capture point name'),
        { name: 'buffer', type: 'WORD', description: 'Capture buffer name' }],
      description: 'Associate a capture point with a capture buffer',
      modes: PRIVILEGED, minPrivilege: 15,
      run: (_session, args) => outcomeText(service().associate(args.name, args.buffer)),
    },
    {
      id: 'monitor-capture-point-disassociate',
      path: ['monitor', 'capture', 'point', 'disassociate', NAME('Capture point name')],
      description: 'Remove the association of a capture point',
      modes: PRIVILEGED, minPrivilege: 15,
      run: (_session, args) => outcomeText(service().disassociate(args.name)),
    },
    {
      id: 'monitor-capture-point-start',
      path: ['monitor', 'capture', 'point', 'start', NAME('Capture point name, or all')],
      description: 'Start a capture point',
      modes: PRIVILEGED, minPrivilege: 15,
      run: (_session, args) => forEachPoint(host(), args.name, (point) => outcomeText(service().start(point))),
    },
    {
      id: 'monitor-capture-point-stop',
      path: ['monitor', 'capture', 'point', 'stop', NAME('Capture point name, or all')],
      description: 'Stop a capture point',
      modes: PRIVILEGED, minPrivilege: 15,
      run: (_session, args) => forEachPoint(host(), args.name, (point) => outcomeText(service().stop(point))),
    },
    {
      id: 'show-monitor-capture-buffer',
      path: ['show', 'monitor', 'capture', 'buffer',
        { name: 'name', type: 'WORD', optional: true, description: 'Capture buffer name, or all' },
        { name: 'view', type: 'WORD', optional: true, description: 'View',
          alternatives: [
            { keyword: 'parameters', description: 'Buffer parameters' },
            { keyword: 'dump', description: 'Hexadecimal dump of the captured packets' },
            { keyword: 'detail', description: 'Parameters and dump' },
          ], formsAreExhaustive: true }],
      description: 'Show a capture buffer',
      modes: PRIVILEGED, minPrivilege: 1,
      run: (_session, args) => bufferViews(host(), args.name, args.view),
    },
    {
      id: 'show-monitor-capture-point',
      path: ['show', 'monitor', 'capture', 'point',
        { name: 'name', type: 'WORD', optional: true, description: 'Capture point name, or all' }],
      description: 'Show a capture point',
      modes: PRIVILEGED, minPrivilege: 1,
      run: (_session, args) => pointViews(host(), args.name),
    },
  ];
}
