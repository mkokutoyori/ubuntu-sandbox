import type { Unsubscribe } from '@/events/EventBus';

export type DebugLineListener = (line: string) => void;

export interface TerminalDebugSource {
  hasAnyFlag(): boolean;
  subscribe(listener: DebugLineListener): () => void;
}

export class DebugBroadcast {
  private readonly listeners = new Set<DebugLineListener>();
  private busSubs: Unsubscribe[] = [];
  attachedDeviceId: string | null = null;

  subscribe(listener: DebugLineListener): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  fan(line: string): void {
    for (const listener of this.listeners) listener(line);
  }

  track(unsubscribe: Unsubscribe): void {
    this.busSubs.push(unsubscribe);
  }

  detach(): void {
    for (const unsub of this.busSubs) unsub();
    this.busSubs = [];
    this.attachedDeviceId = null;
  }
}
