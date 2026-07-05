/**
 * TFTP — observable read-model (Signal) over `events.ts`'s topics.
 * Mirrors `network/ftp/observables.ts`'s aggregate-counters shape.
 */
import type { IEventBus, Unsubscribe } from '@/events/EventBus';
import { WritableSignal, type Signal } from '@/events/Signal';

export interface TftpMetricsVM {
  readonly transfersStarted: number;
  readonly transfersCompleted: number;
  readonly transfersFailed: number;
}

const EMPTY_METRICS: TftpMetricsVM = { transfersStarted: 0, transfersCompleted: 0, transfersFailed: 0 };

export class TftpSignalStore {
  readonly metrics = new WritableSignal<TftpMetricsVM>(EMPTY_METRICS);

  private bump(patch: Partial<TftpMetricsVM>): void {
    const current = this.metrics.get();
    this.metrics.set({ ...current, ...patch });
  }

  incrementTransfersStarted(): void { this.bump({ transfersStarted: this.metrics.get().transfersStarted + 1 }); }
  incrementTransfersCompleted(): void { this.bump({ transfersCompleted: this.metrics.get().transfersCompleted + 1 }); }
  incrementTransfersFailed(): void { this.bump({ transfersFailed: this.metrics.get().transfersFailed + 1 }); }
}

export function tftpMetricsSignal(store: TftpSignalStore): Signal<TftpMetricsVM> {
  return { get: () => store.metrics.get(), subscribe: (listener) => store.metrics.subscribe(listener) };
}

export function subscribeTftpObservables(bus: IEventBus, store: TftpSignalStore): Unsubscribe {
  const unsubs: Unsubscribe[] = [
    bus.subscribe('tftp.transfer.started', () => store.incrementTransfersStarted()),
    bus.subscribe('tftp.transfer.completed', () => store.incrementTransfersCompleted()),
    bus.subscribe('tftp.transfer.failed', () => store.incrementTransfersFailed()),
  ];
  return () => unsubs.forEach((u) => u());
}
