import type { PacketContext } from '../pipeline/PacketContext';

export const TRACE_HISTORY = 32;

export class TraceRing {
  private readonly traces: PacketContext[] = [];

  constructor(private readonly capacity = TRACE_HISTORY) {}

  remember(context: PacketContext): void {
    this.traces.push(context);
    while (this.traces.length > this.capacity) this.traces.shift();
  }

  recent(limit = this.capacity): readonly PacketContext[] {
    return Object.freeze(this.traces.slice(-limit));
  }

  clear(): void {
    this.traces.length = 0;
  }
}
