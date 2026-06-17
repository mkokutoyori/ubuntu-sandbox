import type { IEventBus, Unsubscribe } from '@/events/EventBus';

export type DebugLineListener = (line: string) => void;

export interface TerminalDebugSource {
  hasAnyFlag(): boolean;
  subscribe(listener: DebugLineListener): () => void;
}

export class DebugBroadcast {
  private readonly listeners = new Set<DebugLineListener>();
  private busSubs: Unsubscribe[] = [];
  private attachedBus: IEventBus | null = null;
  private attachedDeviceId: string | null = null;

  subscribe(listener: DebugLineListener): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  fan(line: string): void {
    for (const listener of this.listeners) listener(line);
  }

  /**
   * Returns true when the caller must (re)create its bus subscriptions:
   * either nothing was attached yet, or the bus/device changed. Existing
   * subscriptions are torn down first so a bus swap never double-delivers.
   */
  beginAttach(bus: IEventBus, deviceId: string): boolean {
    if (this.attachedBus === bus && this.attachedDeviceId === deviceId) return false;
    this.detach();
    this.attachedBus = bus;
    this.attachedDeviceId = deviceId;
    return true;
  }

  track(unsubscribe: Unsubscribe): void {
    this.busSubs.push(unsubscribe);
  }

  detach(): void {
    for (const unsub of this.busSubs) unsub();
    this.busSubs = [];
    this.attachedBus = null;
    this.attachedDeviceId = null;
  }
}
