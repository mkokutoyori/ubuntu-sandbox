/**
 * PRD-FTP-SFTP.md §2.1.18/P17 — observable read-model (Signal) over
 * `events.ts`'s topics. Like `network/ftp/observables.ts`: packets and
 * handles are short-lived, high-cardinality events, so the useful
 * read-model is a single aggregate counters view, the same shape a
 * real metrics dashboard would show.
 */
import type { IEventBus, Unsubscribe } from '@/events/EventBus';
import { WritableSignal, type Signal } from '@/events/Signal';

export interface SftpMetricsVM {
  readonly packetsReceived: number;
  readonly packetsSent: number;
  readonly openHandles: number;
  readonly handlesOpened: number;
  readonly handlesClosed: number;
  readonly bytesTransferred: number;
}

const EMPTY_METRICS: SftpMetricsVM = {
  packetsReceived: 0, packetsSent: 0,
  openHandles: 0, handlesOpened: 0, handlesClosed: 0,
  bytesTransferred: 0,
};

export class SftpSignalStore {
  readonly metrics = new WritableSignal<SftpMetricsVM>(EMPTY_METRICS);

  private bump(patch: Partial<SftpMetricsVM>): void {
    const current = this.metrics.get();
    this.metrics.set({ ...current, ...patch });
  }

  incrementPacketsReceived(): void { this.bump({ packetsReceived: this.metrics.get().packetsReceived + 1 }); }
  incrementPacketsSent(): void { this.bump({ packetsSent: this.metrics.get().packetsSent + 1 }); }
  incrementHandlesOpened(): void {
    const m = this.metrics.get();
    this.bump({ handlesOpened: m.handlesOpened + 1, openHandles: m.openHandles + 1 });
  }
  incrementHandlesClosed(): void {
    const m = this.metrics.get();
    this.bump({ handlesClosed: m.handlesClosed + 1, openHandles: m.openHandles - 1 });
  }
  addBytesTransferred(bytes: number): void { this.bump({ bytesTransferred: this.metrics.get().bytesTransferred + bytes }); }
}

export function sftpMetricsSignal(store: SftpSignalStore): Signal<SftpMetricsVM> {
  return { get: () => store.metrics.get(), subscribe: (listener) => store.metrics.subscribe(listener) };
}

/** Wires an `SftpSignalStore` to an event bus's `sftp.*` topics; returns a single combined unsubscribe. */
export function subscribeSftpObservables(bus: IEventBus, store: SftpSignalStore): Unsubscribe {
  const unsubs: Unsubscribe[] = [
    bus.subscribe('sftp.packet.received', () => store.incrementPacketsReceived()),
    bus.subscribe('sftp.packet.sent', () => store.incrementPacketsSent()),
    bus.subscribe('sftp.handle.opened', () => store.incrementHandlesOpened()),
    bus.subscribe('sftp.handle.closed', () => store.incrementHandlesClosed()),
    bus.subscribe('sftp.transfer.progress', (e) => store.addBytesTransferred(e.payload.bytesTransferred)),
  ];
  return () => unsubs.forEach((u) => u());
}
