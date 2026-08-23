import { IP_PROTO_TCP } from '../../../core/types';
import type { FlowKey } from '../session/FlowKey';

export const DEFAULT_OVERSIZE_LIMIT_MB = 10;
export const MIN_OVERSIZE_LIMIT_MB = 1;
export const MAX_OVERSIZE_LIMIT_MB = 383;

const BYTES_PER_MB = 1024 * 1024;
const DEFAULT_MAX_STREAMS = 4096;

export interface AssembledStream {
  readonly payload: string;
  readonly oversize: boolean;
}

export interface StreamAssemblerOptions {
  readonly limitBytes?: number;
  readonly maxStreams?: number;
}

export function oversizeLimitBytes(megabytes: number): number {
  return Math.max(MIN_OVERSIZE_LIMIT_MB, megabytes) * BYTES_PER_MB;
}

function streamId(key: FlowKey): string {
  return `${key.protocol}|${key.sourceIP}:${key.sourcePort}`
    + `>${key.destIP}:${key.destPort}`;
}

interface StreamState {
  buffer: string;
  oversize: boolean;
}

export class StreamAssembler {
  private readonly streams = new Map<string, StreamState>();
  private readonly limitBytes: number;
  private readonly maxStreams: number;

  constructor(options: StreamAssemblerOptions = {}) {
    this.limitBytes = options.limitBytes
      ?? oversizeLimitBytes(DEFAULT_OVERSIZE_LIMIT_MB);
    this.maxStreams = options.maxStreams ?? DEFAULT_MAX_STREAMS;
  }

  append(key: FlowKey, chunk: string, limitBytes = this.limitBytes): AssembledStream {
    if (key.protocol !== IP_PROTO_TCP) {
      return Object.freeze({ payload: chunk, oversize: false });
    }

    const id = streamId(key);
    const state = this.streams.get(id) ?? { buffer: '', oversize: false };
    this.streams.delete(id);

    const room = limitBytes - state.buffer.length;
    if (chunk.length > room) {
      state.oversize = true;
      state.buffer += chunk.slice(0, Math.max(0, room));
    } else {
      state.buffer += chunk;
    }

    this.streams.set(id, state);
    this.evict();
    return Object.freeze({ payload: state.buffer, oversize: state.oversize });
  }

  forget(key: FlowKey): void {
    this.streams.delete(streamId(key));
    this.streams.delete(streamId(reversed(key)));
  }

  size(): number {
    return this.streams.size;
  }

  clear(): void {
    this.streams.clear();
  }

  private evict(): void {
    while (this.streams.size > this.maxStreams) {
      const oldest = this.streams.keys().next();
      if (oldest.done === true) return;
      this.streams.delete(oldest.value);
    }
  }
}

function reversed(key: FlowKey): FlowKey {
  return Object.freeze({
    sourceIP: key.destIP,
    sourcePort: key.destPort,
    destIP: key.sourceIP,
    destPort: key.sourcePort,
    protocol: key.protocol,
  });
}
