import type { EthernetFrame, IPv4Packet } from '@/network/core/types';
import type { CapturePredicate } from '@/network/capture/EmbeddedCapture';
import type { CaptureFrame } from '@/network/devices/linux/network/tcpdump/CaptureFrame';
import { hexGroups, hexRows } from '@/network/capture/HexDump';
import { HUAWEI_ERRORS, resolveHuaweiInterfaceName } from '../cli-utils';

export interface CapturePacketPlan {
  readonly iface: string;
  readonly aclRef: string | null;
  readonly timeoutSeconds: number | null;
  readonly packetNumber: number | null;
  readonly packetLength: number;
}

export interface CapturePacketHost {
  resolveInterface(text: string): string | null;
  aclExists(reference: string): boolean;
}

export type CapturePacketParse =
  | { readonly ok: true; readonly plan: CapturePacketPlan }
  | { readonly ok: false; readonly error: string };

const DEFAULT_PACKET_LENGTH = 1500;

export const CAPTURE_NEEDS_TERMINAL = 'Info: capture-packet writes to the terminal as packets arrive and needs an interactive session.';

function wrong(line: string, token: string): CapturePacketParse {
  const at = line.indexOf(token);
  return { ok: false, error: HUAWEI_ERRORS.WRONG(line, at < 0 ? line.length : at) };
}

function incomplete(line: string): CapturePacketParse {
  return { ok: false, error: HUAWEI_ERRORS.INCOMPLETE(line) };
}

function numberIn(word: string | undefined, low: number, high: number): number | null {
  const value = Number(word);
  return word !== undefined && /^\d+$/.test(word) && value >= low && value <= high ? value : null;
}

export function parseCapturePacket(args: readonly string[], line: string, host: CapturePacketHost): CapturePacketParse {
  if (args[0] !== 'interface') return args.length === 0 ? incomplete(line) : wrong(line, args[0]);
  if (args[1] === undefined) return incomplete(line);
  let used = 2;
  let iface = host.resolveInterface(args[1]);
  if (iface === null && args[2] !== undefined) {
    iface = host.resolveInterface(`${args[1]}${args[2]}`);
    used = 3;
  }
  if (iface === null) return wrong(line, args[1]);

  let aclRef: string | null = null;
  let timeout: number | null = null;
  let packetNumber: number | null = null;
  let packetLength = DEFAULT_PACKET_LENGTH;
  let destinationSeen = false;
  for (let index = used; index < args.length; index++) {
    const key = args[index];
    const value = args[index + 1];
    if (key === 'acl') {
      if (value === undefined) return incomplete(line);
      if (!host.aclExists(value)) return wrong(line, value);
      aclRef = value;
      index++;
    } else if (key === 'destination') {
      if (value !== 'terminal') return value === undefined ? incomplete(line) : wrong(line, value);
      destinationSeen = true;
      index++;
    } else if (key === 'time-out') {
      timeout = numberIn(value, 1, 3600);
      if (timeout === null) return value === undefined ? incomplete(line) : wrong(line, value);
      index++;
    } else if (key === 'packet-num') {
      packetNumber = numberIn(value, 1, 65535);
      if (packetNumber === null) return value === undefined ? incomplete(line) : wrong(line, value);
      index++;
    } else if (key === 'packet-len') {
      const length = numberIn(value, 64, 9600);
      if (length === null) return value === undefined ? incomplete(line) : wrong(line, value);
      packetLength = length;
      index++;
    } else {
      return wrong(line, key);
    }
  }
  if (!destinationSeen) return incomplete(line);
  return { ok: true, plan: { iface, aclRef, timeoutSeconds: timeout, packetNumber, packetLength } };
}

export function aclPredicate(
  evaluate: (reference: string, packet: IPv4Packet) => 'permit' | 'deny' | null, reference: string,
): CapturePredicate {
  return (_frame: CaptureFrame, wire: EthernetFrame) => {
    const packet = wire.payload as IPv4Packet | undefined;
    return packet?.type === 'ipv4' && evaluate(reference, packet) === 'permit';
  };
}

export function captureBanner(plan: CapturePacketPlan): string {
  return `Info: Capture started on ${plan.iface}. Press Ctrl+C to stop.`;
}

export function captureTrailer(count: number): string {
  return `Info: Capture finished, ${count} packet${count === 1 ? '' : 's'} captured.`;
}

export function packetBlock(ordinal: number, frame: CaptureFrame): string[] {
  const direction = frame.direction === 'in' ? 'inbound' : 'outbound';
  const lines = [` Packet ${ordinal}: ${frame.at.toISOString().replace('T', ' ').replace('Z', '')} ${direction} ${frame.iface}, ${frame.length} bytes`];
  for (const row of hexRows(frame.raw)) {
    lines.push(`  ${row.offset.toString(16).padStart(4, '0')}  ${hexGroups(row.bytes, 1, ' ').padEnd(47, ' ')}  ${row.ascii}`);
  }
  return lines;
}

interface CaptureDevice {
  getPortNames(): Iterable<string>;
  _getACLEngineInternal?(): {
    findByName(name: string): unknown;
    findById(id: number): unknown;
    evaluateACLByName(name: string, packet: IPv4Packet, now?: Date, countMatches?: boolean): 'permit' | 'deny' | null;
  };
}

export function huaweiCaptureHost(device: () => unknown): CapturePacketHost & {
  filterFor(reference: string): CapturePredicate;
} {
  const target = (): CaptureDevice => device() as CaptureDevice;
  const engine = () => target()._getACLEngineInternal?.();
  return {
    resolveInterface: (text) => resolveHuaweiInterfaceName(target().getPortNames(), text),
    aclExists: (reference) => {
      const acls = engine();
      return acls !== undefined && (acls.findByName(reference) !== undefined || acls.findById(Number(reference)) !== undefined);
    },
    filterFor: (reference) => aclPredicate(
      (name, packet) => engine()?.evaluateACLByName(name, packet, undefined, false) ?? null, reference),
  };
}
