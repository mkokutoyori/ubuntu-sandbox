import { attachOrderedCapture, type DetachTap, type FrameSource, type TappedFrame } from '@/network/hardware/PortTap';
import type { EthernetFrame } from '@/network/core/types';
import { decodeEthernetFrame, type CaptureFrame } from '@/network/devices/linux/network/tcpdump/CaptureFrame';
import { compileFilter } from '@/network/devices/linux/network/tcpdump/TcpdumpFilter';
import { expandFilterTokens } from '@/network/devices/linux/network/tcpdump/TcpdumpCli';
import { serializeCaptureFile } from '@/network/devices/linux/network/tcpdump/CaptureFileFormat';

export type CaptureWay = 'in' | 'out' | 'both';

export type CapturePredicate = (frame: CaptureFrame, wire: EthernetFrame) => boolean;

export interface BufferFilter {
  readonly label: string;
  readonly matches: CapturePredicate;
}

export interface BufferLimits {
  duration: number;
  packets: number;
  packetsPerSecond: number;
}

export interface StoredFrame {
  readonly frame: CaptureFrame;
  readonly point: string;
}

export interface CaptureBuffer {
  readonly name: string;
  sizeBytes: number;
  maxElementBytes: number;
  circular: boolean;
  limits: BufferLimits;
  filter: BufferFilter | null;
  frames: StoredFrame[];
  usedBytes: number;
  matched: number;
  dropped: number;
}

export interface CapturePoint {
  readonly name: string;
  readonly kind: string;
  readonly iface: string;
  readonly way: CaptureWay;
  buffer: string | null;
  active: boolean;
  startedAt: Date | null;
  stopReason: string | null;
}

export const DEFAULT_BUFFER_BYTES = 524288;
export const DEFAULT_ELEMENT_BYTES = 68;
export const ELEMENT_OVERHEAD_BYTES = 0;

export type CaptureOutcome = { readonly ok: true } | { readonly ok: false; readonly reason: string };

const OK: CaptureOutcome = { ok: true };

function refusal(reason: string): CaptureOutcome {
  return { ok: false, reason };
}

export function compileCaptureExpression(expression: string): BufferFilter | string {
  const tokens = expandFilterTokens([expression]);
  const compiled = compileFilter(tokens);
  if (compiled.ok === false) return compiled.message;
  return { label: expression, matches: (frame) => compiled.predicate(frame) };
}

export class EmbeddedCaptureService {
  private readonly buffers = new Map<string, CaptureBuffer>();
  private readonly points = new Map<string, CapturePoint>();
  private readonly taps = new Map<string, DetachTap>();
  private readonly windowStart = new Map<string, { second: number; count: number }>();

  constructor(
    private readonly source: FrameSource,
    private readonly now: () => Date,
  ) {}

  bufferNames(): readonly string[] { return [...this.buffers.keys()]; }

  pointNames(): readonly string[] { return [...this.points.keys()]; }

  buffer(name: string): CaptureBuffer | undefined { return this.buffers.get(name); }

  point(name: string): CapturePoint | undefined { return this.points.get(name); }

  pointsOf(bufferName: string): readonly CapturePoint[] {
    return [...this.points.values()].filter((point) => point.buffer === bufferName);
  }

  defineBuffer(name: string): CaptureBuffer {
    let buffer = this.buffers.get(name);
    if (buffer === undefined) {
      buffer = {
        name, sizeBytes: DEFAULT_BUFFER_BYTES, maxElementBytes: DEFAULT_ELEMENT_BYTES, circular: false,
        limits: { duration: 0, packets: 0, packetsPerSecond: 0 }, filter: null,
        frames: [], usedBytes: 0, matched: 0, dropped: 0,
      };
      this.buffers.set(name, buffer);
    }
    return buffer;
  }

  removeBuffer(name: string): CaptureOutcome {
    const buffer = this.buffers.get(name);
    if (buffer === undefined) return refusal(`Capture buffer ${name} does not exist`);
    if (this.pointsOf(name).some((point) => point.active)) return refusal(`Capture buffer ${name} is in use by an active capture point`);
    for (const point of this.pointsOf(name)) point.buffer = null;
    this.buffers.delete(name);
    return OK;
  }

  clear(name: string): CaptureOutcome {
    const buffer = this.buffers.get(name);
    if (buffer === undefined) return refusal(`Capture buffer ${name} does not exist`);
    buffer.frames = [];
    buffer.usedBytes = 0;
    buffer.matched = 0;
    buffer.dropped = 0;
    return OK;
  }

  definePoint(name: string, kind: string, iface: string, way: CaptureWay): CaptureOutcome {
    if (this.points.has(name)) return refusal(`Capture point ${name} already exists`);
    this.points.set(name, { name, kind, iface, way, buffer: null, active: false, startedAt: null, stopReason: null });
    return OK;
  }

  removePoint(name: string): CaptureOutcome {
    const point = this.points.get(name);
    if (point === undefined) return refusal(`Capture point ${name} does not exist`);
    if (point.active) return refusal(`Capture point ${name} is active; stop it first`);
    this.points.delete(name);
    return OK;
  }

  associate(pointName: string, bufferName: string): CaptureOutcome {
    const point = this.points.get(pointName);
    if (point === undefined) return refusal(`Capture point ${pointName} does not exist`);
    if (!this.buffers.has(bufferName)) return refusal(`Capture buffer ${bufferName} does not exist`);
    if (point.active) return refusal(`Capture point ${pointName} is active; stop it first`);
    point.buffer = bufferName;
    return OK;
  }

  disassociate(pointName: string): CaptureOutcome {
    const point = this.points.get(pointName);
    if (point === undefined) return refusal(`Capture point ${pointName} does not exist`);
    if (point.active) return refusal(`Capture point ${pointName} is active; stop it first`);
    point.buffer = null;
    return OK;
  }

  start(pointName: string): CaptureOutcome {
    const point = this.points.get(pointName);
    if (point === undefined) return refusal(`Capture point ${pointName} does not exist`);
    if (point.buffer === null) return refusal(`Capture point ${pointName} has no capture buffer associated`);
    if (point.active) return refusal(`Capture point ${pointName} is already started`);
    point.active = true;
    point.startedAt = this.now();
    point.stopReason = null;
    this.windowStart.delete(pointName);
    this.taps.set(pointName, attachOrderedCapture(this.source, (tapped) => this.accept(point, tapped), point.iface));
    return OK;
  }

  stop(pointName: string, reason: string | null = null): CaptureOutcome {
    const point = this.points.get(pointName);
    if (point === undefined) return refusal(`Capture point ${pointName} does not exist`);
    if (!point.active) return refusal(`Capture point ${pointName} is not started`);
    this.taps.get(pointName)?.();
    this.taps.delete(pointName);
    point.active = false;
    point.stopReason = reason;
    return OK;
  }

  exportFile(bufferName: string): string | null {
    const buffer = this.buffers.get(bufferName);
    if (buffer === undefined) return null;
    return serializeCaptureFile(buffer.frames.map((stored) => stored.frame));
  }

  private accept(point: CapturePoint, tapped: TappedFrame): void {
    if (!point.active || point.buffer === null) return;
    if (point.way !== 'both' && point.way !== tapped.direction) return;
    const buffer = this.buffers.get(point.buffer);
    if (buffer === undefined) return;
    const decoded = decodeEthernetFrame(tapped.frame, tapped.iface, tapped.direction, tapped.at, tapped.atMicros);
    if (buffer.filter !== null && !buffer.filter.matches(decoded, tapped.frame)) return;
    buffer.matched++;
    if (this.limitReached(point, buffer, tapped.at)) return;
    if (!this.withinRate(point, buffer, tapped.at)) { buffer.dropped++; return; }
    this.store(point, buffer, truncated(decoded, buffer.maxElementBytes));
  }

  private limitReached(point: CapturePoint, buffer: CaptureBuffer, at: Date): boolean {
    const { duration, packets } = buffer.limits;
    if (duration > 0 && point.startedAt !== null && (at.getTime() - point.startedAt.getTime()) / 1000 >= duration) {
      this.stop(point.name, 'duration limit reached');
      return true;
    }
    if (packets > 0 && buffer.frames.length >= packets) {
      this.stop(point.name, 'packet limit reached');
      return true;
    }
    return false;
  }

  private withinRate(point: CapturePoint, buffer: CaptureBuffer, at: Date): boolean {
    const limit = buffer.limits.packetsPerSecond;
    if (limit <= 0) return true;
    const second = Math.floor(at.getTime() / 1000);
    const window = this.windowStart.get(point.name);
    if (window === undefined || window.second !== second) {
      this.windowStart.set(point.name, { second, count: 1 });
      return true;
    }
    window.count++;
    return window.count <= limit;
  }

  private store(point: CapturePoint, buffer: CaptureBuffer, frame: CaptureFrame): void {
    const need = frame.raw.length + ELEMENT_OVERHEAD_BYTES;
    if (buffer.circular) {
      while (buffer.frames.length > 0 && buffer.usedBytes + need > buffer.sizeBytes) {
        buffer.usedBytes -= buffer.frames.shift()!.frame.raw.length + ELEMENT_OVERHEAD_BYTES;
      }
    } else if (buffer.usedBytes + need > buffer.sizeBytes) {
      this.stop(point.name, 'buffer full');
      return;
    }
    buffer.frames.push({ frame, point: point.name });
    buffer.usedBytes += need;
  }
}

function truncated(frame: CaptureFrame, maxElementBytes: number): CaptureFrame {
  if (frame.raw.length <= maxElementBytes) return frame;
  return { ...frame, raw: frame.raw.slice(0, maxElementBytes) };
}
